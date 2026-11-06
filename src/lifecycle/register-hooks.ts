import * as path from "node:path"
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type AgentBeforeSettleEventResult,
  type BeforeAgentStartEventResult,
  type ExtensionAPI,
  type InputEventResult,
  type SessionBoundaryDraft,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent"
import { Effect, Option } from "effect"
import type { RealgoalError } from "../domain/errors.ts"
import type { WorkItemState } from "../domain/models.ts"
import {
  blockWorkItem,
  decideBeforeSettle,
  findAuthorization,
  isPlanningPhase,
  pauseWorkItem,
  recordOperationFailure,
  selectNextEligibleTodo,
} from "../domain/reducer.ts"
import type { RealgoalRuntime, RealgoalServices } from "../bridge/pi-wrapper.ts"
import { ControllerService } from "../services/controller-service.ts"
import { PersistenceService, type LoadedWorkItemResult } from "../services/persistence.ts"
import { PreviewService } from "../services/preview-service.ts"
import {
  extractHintsFromCustomMessage,
  RealtasksAdapter,
  type ExtractedRealtasksHint,
} from "../services/realtasks-adapter.ts"
import { checkWorkerWriteAllowed } from "../services/worker-service.ts"
import {
  REALGOAL_CONTINUATION_MESSAGE_TYPE,
  REALGOAL_ENTRY_TYPE,
  REALGOAL_NOTICE_MESSAGE_TYPE,
} from "../ui/presentation.ts"

const REALGOAL_CONTEXT_MESSAGE_TYPE = "realgoal-context"

const MUTATING_SHELL_PATTERN =
  /\b(git\s+(?:commit|push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--)|rm\s+-rf|Remove-Item\b.*-Recurse)\b/i

const isKickoffBanner = (text: string): boolean =>
  text.startsWith("[Realgoal /goal started") ||
  text.startsWith("[Realgoal /plan started") ||
  text.startsWith("[Realgoal execution authorized") ||
  text.startsWith("[Realgoal resumed") ||
  text.startsWith("Question ") ||
  text.startsWith("Stop user-authorized cancelled")

export const registerRealgoalHooks = (pi: ExtensionAPI, runtime: RealgoalRuntime): void => {
  // ---------------------------------------------------------------------------
  // 1. session_start (§12.2, D08, D09)
  // ---------------------------------------------------------------------------
  pi.on("session_start", (event, ctx) =>
    runtime.runEventEffect(
      Effect.Do.pipe(
        Effect.bind("controller", () => ControllerService.useSync((s) => s)),
        Effect.bind("persistence", () => PersistenceService.useSync((s) => s)),
        Effect.let("sessionId", () => {
          const sm = ctx.sessionManager as { getSessionId?: () => string } | undefined
          return typeof sm?.getSessionId === "function" ? sm.getSessionId() : "session-default"
        }),
        Effect.let("agentDir", () => {
          try {
            return getAgentDir()
          } catch {
            return path.join(process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".", CONFIG_DIR_NAME, "agent")
          }
        }),
        Effect.let("isFork", () => event.reason === "fork"),
        Effect.bind("mem", ({ controller, sessionId, agentDir, isFork }) =>
          controller.updateMemory((cur) => ({
            ...cur,
            sessionId,
            workspaceCwd: ctx.cwd,
            globalAgentDir: agentDir,
            configDirName: CONFIG_DIR_NAME,
            hostMode: ctx.mode,
            isProjectTrusted: ctx.isProjectTrusted(),
            readOnlyAttachment: isFork,
            activeWorkItemId: isFork ? cur.activeWorkItemId : Option.none(),
            uiPromptWaiting: false,
            hadQualifyingProgressSinceLastSettle: false,
            pendingScopeChangeMessage: Option.none(),
          })),
        ),
        Effect.bind("allSaved", ({ persistence, mem }) =>
          persistence.listAllWorkItems(mem.workspaceCwd, mem.configDirName),
        ),
        Effect.flatMap(({ controller, mem, allSaved, isFork }): Effect.Effect<void, RealgoalError, RealgoalServices> => {
          const validItems = allSaved.filter((i): i is LoadedWorkItemResult => !("error" in i))
          const unfinished = validItems.filter(
            (i) => !i.state.archived && i.state.runStatus !== "finished" && i.state.runStatus !== "cancelled",
          )

          if (isFork) {
            if (unfinished.length > 0 && ctx.hasUI) {
              ctx.ui.notify(
                `Forked session attached read-only to Realgoal workspace (${unfinished.length} active item(s)). Run /realgoal resume or start a new /goal or /plan to mutate.`,
                "info",
              )
            }
            return Effect.void
          }

          const matchingSessionItem = unfinished.find(
            (i) => i.state.originatingSessionId === mem.sessionId,
          )

          const reattachEff: Effect.Effect<void, RealgoalError> = matchingSessionItem
            ? (() => {
                const nowIso = new Date().toISOString()
                const wasRunning = matchingSessionItem.state.runStatus === "running"
                const stabilized: WorkItemState = wasRunning
                  ? pauseWorkItem(
                      matchingSessionItem.state,
                      `Session ${event.reason}: auto-resume disabled until /realgoal resume`,
                      "recovery",
                      nowIso,
                    )
                  : matchingSessionItem.state

                return controller
                  .updateMemory((cur) => ({
                    ...cur,
                    activeWorkItemId: Option.some(stabilized.id),
                  }))
                  .pipe(
                    Effect.flatMap(() =>
                      wasRunning
                        ? controller
                            .saveUpdatedState(matchingSessionItem.state, stabilized)
                            .pipe(Effect.asVoid, Effect.catch(() => Effect.void))
                        : Effect.void,
                    ),
                  )
              })()
            : Effect.void

          return reattachEff.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (unfinished.length > 0 && ctx.hasUI) {
                  const summary = unfinished
                    .map((u) => `${u.state.id} ("${u.state.displayName}": ${u.state.phase}/${u.state.runStatus})`)
                    .join(", ")
                  ctx.ui.notify(
                    `Recoverable Realgoal work item(s): ${summary}. Run /realgoal resume to continue.`,
                    "info",
                  )
                }
              }),
            ),
          )
        }),
      ),
      undefined,
      ctx.signal,
    ).then(() => runtime.refreshUi(ctx)),
  )

  // ---------------------------------------------------------------------------
  // 3. input (§12.2, W10 — scope change detection on user message)
  // ---------------------------------------------------------------------------
  pi.on("input", (event): Promise<InputEventResult> => {
    const trimmed = event.text.trim()
    if (
      event.source === "extension" ||
      trimmed.length === 0 ||
      trimmed.startsWith("/") ||
      isKickoffBanner(trimmed)
    ) {
      return Promise.resolve({ action: "continue" })
    }

    return runtime.runEventEffect(
      Effect.Do.pipe(
        Effect.bind("controller", () => ControllerService.useSync((s) => s)),
        Effect.bind("activeOpt", ({ controller }) => controller.getActiveWorkItem()),
        Effect.tap(({ controller, activeOpt }) =>
          Option.match(activeOpt, {
            onNone: () => Effect.void,
            onSome: ({ state }) => {
              if (
                state.runStatus === "running" ||
                state.runStatus === "waiting_task" ||
                state.runStatus === "awaiting_user"
              ) {
                return controller
                  .updateMemory((cur) => ({
                    ...cur,
                    pendingScopeChangeMessage: Option.some(trimmed),
                  }))
                  .pipe(Effect.asVoid)
              }
              return Effect.void
            },
          }),
        ),
        Effect.as<InputEventResult>({ action: "continue" }),
      ),
      { action: "continue" },
    )
  })

  // ---------------------------------------------------------------------------
  // 4. before_agent_start (inject compact authoritative workflow state)
  // ---------------------------------------------------------------------------
  pi.on("before_agent_start", (_event, ctx): Promise<BeforeAgentStartEventResult | undefined> =>
    runtime.runEventEffect(
      Effect.Do.pipe(
        Effect.bind("controller", () => ControllerService.useSync((s) => s)),
        Effect.bind("mem", ({ controller }) => controller.getMemory()),
        Effect.bind("activeOpt", ({ controller }) => controller.getActiveWorkItem()),
        Effect.flatMap(({ controller, mem, activeOpt }): Effect.Effect<
          BeforeAgentStartEventResult | undefined,
          RealgoalError
        > =>
          Option.match(activeOpt, {
            onNone: () => Effect.succeed(undefined),
            onSome: ({ state, paths }) => {
              if (state.archived || state.runStatus === "cancelled" || state.runStatus === "finished") {
                return Effect.succeed(undefined)
              }

              return controller
                .updateMemory((cur) => ({
                  ...cur,
                  isProjectTrusted: ctx.isProjectTrusted(),
                  pendingScopeChangeMessage: Option.none(),
                }))
                .pipe(
                  Effect.map(() => {
                    const nextTodo = selectNextEligibleTodo(state.todos)
                    const done = state.todos.filter((t) => t.status === "done").length
                    const pendingQs = state.questions.filter((q) => q.status === "pending")
                    const planningGuardLine = isPlanningPhase(state)
                      ? `PLANNING BOUNDARY ACTIVE: Do NOT edit or write repository files outside ${paths.draftDir} until the user explicitly authorizes execution via /realgoal execute.`
                      : `EXECUTION DRIVERS: execution=${Option.getOrElse(state.executionDriver, () => "direct")}, verification=${state.verificationDriver}.`

                    const scopeChangeNotice = Option.match(mem.pendingScopeChangeMessage, {
                      onNone: () => "",
                      onSome: (msg) =>
                        `\nUSER INTERJECTION DETECTED: "${msg.slice(0, 240)}". Reconcile any scope/priority/requirement changes via realgoal_control(checkpoint) or clarify via realgoal_question BEFORE continuing autonomous work.`,
                    })

                    const readOnlyNotice = mem.readOnlyAttachment
                      ? `\nREAD-ONLY FORK ATTACHMENT: Do not mutate work item ${state.id} unless user runs /realgoal resume.`
                      : ""

                    const contextLines = [
                      `[Realgoal Active Work Item · id=${state.id} · rev=${state.revision}]`,
                      `Kind: ${state.kind} | Phase: ${state.phase} | Status: ${state.runStatus} | Scope: ${state.completionScope}`,
                      `Objective: ${state.objective}`,
                      `Draft Directory: ${paths.draftDir}`,
                      `TODOs: ${done}/${state.todos.length} done${Option.match(nextTodo, {
                        onNone: () => "",
                        onSome: (t) => ` | Next eligible: ${t.id} [${t.status}] "${t.title}"`,
                      })}`,
                      ...(pendingQs.length > 0
                        ? [`Pending Questions: ${pendingQs.map((q) => `${q.id} ("${q.title}")`).join(", ")}`]
                        : []),
                      `Next Action: ${state.nextAction}`,
                      planningGuardLine,
                      `Completion Rule: Prose like [DONE] NEVER completes a workflow; record fresh evidence via realgoal_todo(record_evidence) and finish only via realgoal_finish.`,
                    ].join("\n") + scopeChangeNotice + readOnlyNotice

                    return {
                      message: {
                        customType: REALGOAL_CONTEXT_MESSAGE_TYPE,
                        content: contextLines,
                        display: false,
                      },
                    }
                  }),
                )
            },
          }),
        ),
      ),
      undefined,
      ctx.signal,
    ),
  )

  // ---------------------------------------------------------------------------
  // 5. tool_call (planning boundary & fork read-only guard — §7.3, P01, D09)
  // ---------------------------------------------------------------------------
  pi.on("tool_call", (event, ctx): Promise<ToolCallEventResult | undefined> =>
    runtime.runEventEffect(
      Effect.Do.pipe(
        Effect.bind("controller", () => ControllerService.useSync((s) => s)),
        Effect.bind("mem", ({ controller }) => controller.getMemory()),
        Effect.bind("activeOpt", ({ controller }) => controller.getActiveWorkItem()),
        Effect.flatMap(({ mem, activeOpt }): Effect.Effect<ToolCallEventResult | undefined, RealgoalError> => {
          if (
            mem.readOnlyAttachment &&
            event.toolName.startsWith("realgoal_") &&
            !(event.toolName === "realgoal_control" && event.input["action"] === "status") &&
            !(event.toolName === "realgoal_todo" && event.input["action"] === "list")
          ) {
            return Effect.succeed<ToolCallEventResult>({
              block: true,
              reason:
                "Forked session is attached read-only to the parent's Realgoal work item. Run /realgoal resume (or start a new /goal or /plan) before mutating workflow state.",
            })
          }

          return Option.match(activeOpt, {
            onNone: () => Effect.succeed(undefined),
            onSome: ({ state, paths }): Effect.Effect<ToolCallEventResult | undefined, never> => {
              if (!isPlanningPhase(state) || state.runStatus === "cancelled" || state.runStatus === "finished") {
                return Effect.succeed(undefined)
              }
              const hasSpikeAuth = Option.isSome(findAuthorization(state, "spike_approval"))
              if (hasSpikeAuth) {
                return Effect.succeed(undefined)
              }

              if (event.toolName === "write" || event.toolName === "edit") {
                const targetPath = typeof event.input["path"] === "string" ? event.input["path"] : ""
                if (targetPath.length === 0) {
                  return Effect.succeed<ToolCallEventResult>({
                    block: true,
                    reason: "Blocked empty file path during Realgoal planning phase.",
                  })
                }
                return checkWorkerWriteAllowed(mem.workspaceCwd, [paths.draftDir], targetPath).pipe(
                  Effect.map((insideDraft): ToolCallEventResult | undefined =>
                    insideDraft
                      ? undefined
                      : {
                          block: true,
                          reason: `Realgoal planning boundary: writing to '${targetPath}' outside draft folder '${paths.draftDir}' is forbidden during phase '${state.phase}'. Complete planning, publish if desired, and await user authorization via /realgoal execute.`,
                        },
                  ),
                )
              }

              if (event.toolName === "bash" || event.toolName === "powershell") {
                const cmd = typeof event.input["command"] === "string" ? event.input["command"] : ""
                if (MUTATING_SHELL_PATTERN.test(cmd)) {
                  return Effect.succeed<ToolCallEventResult>({
                    block: true,
                    reason: `Realgoal planning boundary: destructive/repository-mutating shell command blocked during planning phase '${state.phase}'.`,
                  })
                }
              }

              return Effect.succeed(undefined)
            },
          })
        }),
      ),
      undefined,
      ctx.signal,
    ),
  )

  // ---------------------------------------------------------------------------
  // 6. tool_execution_start & tool_execution_end (realtasks + freshness + stall)
  // ---------------------------------------------------------------------------
  pi.on("tool_execution_start", (event) =>
    runtime.runEventEffect(
      RealtasksAdapter.use((rt) =>
        rt.recordToolExecutionStart({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          parentToolCallId: event.parentToolCallId,
        }),
      ),
      undefined,
    ),
  )

  pi.on("tool_execution_end", (event, ctx) =>
    runtime.runEventEffect(
      Effect.Do.pipe(
        Effect.bind("controller", () => ControllerService.useSync((s) => s)),
        Effect.bind("realtasks", () => RealtasksAdapter.useSync((s) => s)),
        Effect.bind("mem", ({ controller }) => controller.getMemory()),
        Effect.bind("observedMeta", ({ realtasks, mem }) =>
          realtasks.recordToolExecutionEnd({
            sessionId: mem.sessionId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
            parentToolCallId: event.parentToolCallId,
            nowIso: new Date().toISOString(),
          }),
        ),
        Effect.bind("activeOpt", ({ controller }) => controller.getActiveWorkItem()),
        Effect.flatMap(({ controller, mem, activeOpt }): Effect.Effect<void, RealgoalError> => {
          if (mem.readOnlyAttachment) return Effect.void
          return Option.match(activeOpt, {
            onNone: () => Effect.void,
            onSome: ({ state }) => {
              const nowIso = new Date().toISOString()

              if (!event.isError && (event.toolName === "write" || event.toolName === "edit")) {
                const trackedPaths = Object.keys(state.artifactHashes)
                if (trackedPaths.length === 0) return Effect.void
                return controller.refreshTrackedFileHashes(state, trackedPaths).pipe(
                  Effect.flatMap((refreshed) => {
                    const changed = Object.keys(refreshed.artifactHashes).some(
                      (k) => refreshed.artifactHashes[k] !== state.artifactHashes[k],
                    )
                    if (!changed) return Effect.void
                    return controller
                      .saveUpdatedState(state, {
                        ...refreshed,
                        revision: state.revision + 1,
                        updatedAt: nowIso,
                      })
                      .pipe(Effect.asVoid)
                  }),
                )
              }

              if (event.isError && !event.toolName.startsWith("realgoal_") && state.runStatus === "running") {
                return controller.getEffectiveConfig(Option.some(state)).pipe(
                  Effect.flatMap((effCfg) => {
                    const afterFail = recordOperationFailure(
                      state,
                      `tool_error:${event.toolName}`,
                      `Tool '${event.toolName}' failed`,
                      effCfg.config,
                      nowIso,
                    )
                    return afterFail.runStatus !== state.runStatus ||
                      afterFail.progress.repeatedFailureCount !== state.progress.repeatedFailureCount
                      ? controller.saveUpdatedState(state, afterFail).pipe(Effect.asVoid)
                      : Effect.void
                  }),
                )
              }

              return Effect.void
            },
          })
        }),
      ),
      undefined,
      ctx.signal,
    ).then(() => runtime.refreshUi(ctx)),
  )

  // ---------------------------------------------------------------------------
  // 7. message_end (task-notification / task-event & provider error — R03, W06)
  // ---------------------------------------------------------------------------
  pi.on("message_end", (event, ctx) =>
    runtime.runEventEffect(
      Effect.Do.pipe(
        Effect.bind("controller", () => ControllerService.useSync((s) => s)),
        Effect.bind("realtasks", () => RealtasksAdapter.useSync((s) => s)),
        Effect.bind("mem", ({ controller }) => controller.getMemory()),
        Effect.bind("activeOpt", ({ controller }) => controller.getActiveWorkItem()),
        Effect.flatMap(({ controller, realtasks, mem, activeOpt }): Effect.Effect<void, RealgoalError> => {
          if (mem.readOnlyAttachment) return Effect.void
          return Option.match(activeOpt, {
            onNone: () => Effect.void,
            onSome: ({ state }) => {
              const msg = event.message as unknown as Record<string, unknown>
              const nowIso = new Date().toISOString()

              if (msg["role"] === "custom" && typeof msg["customType"] === "string") {
                const hints = extractHintsFromCustomMessage(
                  msg["customType"],
                  msg["details"],
                  state.revision,
                )
                if (hints.length === 0) return Effect.void
                return realtasks
                  .applyNotificationHints({ state, hints, nowIso })
                  .pipe(
                    Effect.flatMap(({ state: afterHints }) =>
                      controller.reconcileFinishedWorkerJobs({ state: afterHints, nowIso }),
                    ),
                    Effect.flatMap((afterWorkers) =>
                      afterWorkers.revision !== state.revision
                        ? controller.saveUpdatedState(state, afterWorkers).pipe(Effect.asVoid)
                        : Effect.void,
                    ),
                  )
              }

              if (msg["role"] === "assistant" && msg["stopReason"] === "error" && state.runStatus === "running") {
                const errText =
                  typeof msg["errorMessage"] === "string" && msg["errorMessage"].length > 0
                    ? msg["errorMessage"]
                    : "Assistant turn ended with stopReason='error'"
                const blocked = blockWorkItem(state, errText, "recovery", nowIso)
                return controller.saveUpdatedState(state, blocked).pipe(Effect.asVoid)
              }

              return Effect.void
            },
          })
        }),
      ),
      undefined,
      ctx.signal,
    ).then(() => runtime.refreshUi(ctx)),
  )

  // ---------------------------------------------------------------------------
  // 8. ui_prompt_start & ui_prompt_end (transient UI prompt indicator)
  // ---------------------------------------------------------------------------
  pi.on("ui_prompt_start", (_event, ctx) =>
    runtime
      .runEventEffect(
        ControllerService.use((c) =>
          c.updateMemory((cur) => ({ ...cur, uiPromptWaiting: true })),
        ).pipe(Effect.asVoid),
        undefined,
      )
      .then(() => runtime.refreshUi(ctx)),
  )

  pi.on("ui_prompt_end", (_event, ctx) =>
    runtime
      .runEventEffect(
        ControllerService.use((c) =>
          c.updateMemory((cur) => ({ ...cur, uiPromptWaiting: false })),
        ).pipe(Effect.asVoid),
        undefined,
      )
      .then(() => runtime.refreshUi(ctx)),
  )

  // ---------------------------------------------------------------------------
  // 9. turn_end (refresh status; prose never finishes — W02)
  // ---------------------------------------------------------------------------
  pi.on("turn_end", (_event, ctx) => runtime.refreshUi(ctx).then(() => undefined))

  // ---------------------------------------------------------------------------
  // 10. agent_before_settle (§12.3, W01-W09, R03 — sole continuation boundary)
  // ---------------------------------------------------------------------------
  pi.on("agent_before_settle", (event, ctx): Promise<AgentBeforeSettleEventResult | undefined> =>
    runtime
      .runEventEffect(
        Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("realtasks", () => RealtasksAdapter.useSync((s) => s)),
          Effect.bind("mem", ({ controller }) => controller.getMemory()),
          Effect.bind("activeOpt", ({ controller }) => controller.getActiveWorkItem()),
          Effect.flatMap(({ controller, realtasks, mem, activeOpt }): Effect.Effect<
            AgentBeforeSettleEventResult | undefined,
            RealgoalError
          > => {
            if (mem.readOnlyAttachment) {
              return Effect.succeed(undefined)
            }
            return Option.match(activeOpt, {
              onNone: () => Effect.succeed(undefined),
              onSome: ({ state: initialState }) => {
                if (
                  initialState.archived ||
                  initialState.runStatus === "finished" ||
                  initialState.runStatus === "cancelled"
                ) {
                  return Effect.succeed(undefined)
                }

                const nowIso = new Date().toISOString()

                const entryHints: ExtractedRealtasksHint[] = []
                event.entries.forEach((draftEntry, idx) => {
                  if (draftEntry.type === "custom_message") {
                    const extracted = extractHintsFromCustomMessage(
                      draftEntry.customType,
                      draftEntry.details,
                      initialState.revision * 100 + idx,
                    )
                    entryHints.push(...extracted)
                  }
                })

                const afterEntryHintsEff: Effect.Effect<WorkItemState, RealgoalError> =
                  entryHints.length > 0
                    ? realtasks
                        .applyNotificationHints({ state: initialState, hints: entryHints, nowIso })
                        .pipe(
                          Effect.flatMap(({ state: s1 }) =>
                            controller.reconcileFinishedWorkerJobs({ state: s1, nowIso }),
                          ),
                        )
                    : Effect.succeed(initialState)

                return afterEntryHintsEff.pipe(
                  Effect.flatMap((reconciledState) =>
                    controller.getEffectiveConfig(Option.some(reconciledState)).pipe(
                      Effect.flatMap((effCfg) => {
                        const contextEntries = event.context?.contextEntries ?? []
                        const contextLen = contextEntries.length
                        const lastEntry = contextEntries[contextLen - 1] as { id?: string } | undefined
                        const lastEntryId = typeof lastEntry?.id === "string" ? lastEntry.id : "none"
                        const boundaryKey = `${reconciledState.id}:ctx:${contextLen}:${lastEntryId}:${event.outcome}`

                        const decision = decideBeforeSettle(reconciledState, {
                          currentSessionId: mem.sessionId,
                          currentRuntimeId: mem.runtimeId,
                          outcome: event.outcome,
                          boundaryKey,
                          config: effCfg.config,
                          hadQualifyingProgressSinceLastContinuation:
                            mem.hadQualifyingProgressSinceLastSettle ||
                            reconciledState.revision !== initialState.revision,
                          nowIso,
                        })

                        const persistEff: Effect.Effect<void, RealgoalError> =
                          decision.nextState.revision !== initialState.revision
                            ? controller.saveUpdatedState(initialState, decision.nextState).pipe(Effect.asVoid)
                            : Effect.void

                        return persistEff.pipe(
                          Effect.flatMap(() =>
                            controller.updateMemory((cur) => ({
                              ...cur,
                              hadQualifyingProgressSinceLastSettle: false,
                              lastProgressRevisionSeenAtSettle: decision.nextState.revision,
                            })),
                          ),
                          Effect.map((): AgentBeforeSettleEventResult | undefined => {
                            if (!decision.shouldContinue || Option.isNone(decision.reminderMessage)) {
                              return undefined
                            }

                            const continuationMessage: SessionBoundaryDraft = {
                              type: "custom_message",
                              customType: REALGOAL_CONTINUATION_MESSAGE_TYPE,
                              content: decision.reminderMessage.value,
                              display: true,
                              details: {
                                workItemId: decision.nextState.id,
                                revision: decision.nextState.revision,
                                phase: decision.nextState.phase,
                              },
                            }
                            const continuationAudit: SessionBoundaryDraft = {
                              type: "custom",
                              customType: REALGOAL_ENTRY_TYPE,
                              data: {
                                summary: `${decision.nextState.kind}:${decision.nextState.displayName} continuation #${decision.nextState.progress.totalContinuations} (${decision.nextState.phase})`,
                                workItemId: decision.nextState.id,
                                revision: decision.nextState.revision,
                              },
                            }

                            return {
                              entries: [...event.entries, continuationAudit, continuationMessage],
                              continue: true,
                            }
                          }),
                        )
                      }),
                    ),
                  ),
                )
              },
            })
          }),
        ),
        undefined,
        ctx.signal,
      )
      .then((res) => runtime.refreshUi(ctx).then(() => res)),
  )

  // ---------------------------------------------------------------------------
  // 11. agent_settled (notification-only cleanup; Esc abort -> paused — W05)
  // ---------------------------------------------------------------------------
  pi.on("agent_settled", (event, ctx) =>
    runtime
      .runEventEffect(
        Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("mem", ({ controller }) => controller.getMemory()),
          Effect.bind("activeOpt", ({ controller }) => controller.getActiveWorkItem()),
          Effect.flatMap(({ controller, mem, activeOpt }): Effect.Effect<void, RealgoalError> => {
            if (!event.aborted || mem.readOnlyAttachment) return Effect.void
            return Option.match(activeOpt, {
              onNone: () => Effect.void,
              onSome: ({ state }) => {
                if (state.runStatus !== "running") return Effect.void
                const paused = pauseWorkItem(
                  state,
                  "Interrupted by user abort (Escape)",
                  "user",
                  new Date().toISOString(),
                )
                return controller.saveUpdatedState(state, paused).pipe(Effect.asVoid)
              },
            })
          }),
        ),
        undefined,
      )
      .then(() => runtime.refreshUi(ctx)),
  )

  // ---------------------------------------------------------------------------
  // 12. session_before_switch / session_before_fork / session_shutdown (§8.5, P07)
  // ---------------------------------------------------------------------------
  const releaseAndStopPreviewEff = (clearActive: boolean): Effect.Effect<void, RealgoalError, RealgoalServices> =>
    Effect.Do.pipe(
      Effect.bind("controller", () => ControllerService.useSync((s) => s)),
      Effect.bind("persistence", () => PersistenceService.useSync((s) => s)),
      Effect.bind("previewSvc", () => PreviewService.useSync((s) => s)),
      Effect.bind("mem", ({ controller }) => controller.getMemory()),
      Effect.bind("activeOpt", ({ controller }) => controller.getActiveWorkItem()),
      Effect.tap(({ controller, persistence, mem, activeOpt }) =>
        !mem.readOnlyAttachment && Option.isSome(activeOpt)
          ? persistence.releaseOwnership(
              mem.workspaceCwd,
              mem.configDirName,
              activeOpt.value.state.safeDirName,
              controller.makeOwnerToken(mem),
            )
          : Effect.void,
      ),
      Effect.tap(({ previewSvc }) => previewSvc.invalidateGenerationAndStop()),
      Effect.tap(({ controller }) =>
        clearActive
          ? controller
              .updateMemory((cur) => ({ ...cur, activeWorkItemId: Option.none() }))
              .pipe(Effect.asVoid)
          : Effect.void,
      ),
      Effect.asVoid,
    )

  pi.on("session_before_switch", () =>
    runtime.runEventEffect(releaseAndStopPreviewEff(true), undefined).then(() => undefined),
  )

  pi.on("session_before_fork", () =>
    runtime
      .runEventEffect(
        PreviewService.use((p) => p.invalidateGenerationAndStop()),
        undefined,
      )
      .then(() => undefined),
  )

  pi.on("session_shutdown", (event) =>
    runtime
      .runEventEffect(releaseAndStopPreviewEff(true), undefined)
      .then(() => (event.reason === "quit" || event.reason === "reload" ? runtime.dispose() : undefined))
      .then(() => undefined),
  )
}

export { REALGOAL_NOTICE_MESSAGE_TYPE }
