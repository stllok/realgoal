import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { Effect, Option } from "effect"
import {
  InvalidTransitionError,
  OwnershipConflictError,
  PersistenceError,
  type RealgoalError,
} from "../domain/errors.ts"
import type {
  ExecutionDriver,
  QuestionAnswer,
  VerificationDriver,
  WorkItemState,
  WorkflowKind,
} from "../domain/models.ts"
import {
  advancePhase,
  cancelWorkItem,
  pauseWorkItem,
  resolveQuestionCAS,
  resumeWorkItem,
} from "../domain/reducer.ts"
import {
  openUrlInSystemBrowser,
  type RealgoalRuntime,
  type RealgoalServices,
} from "../bridge/pi-wrapper.ts"
import { ControllerService } from "../services/controller-service.ts"
import { DoctorService } from "../services/doctor-service.ts"
import { PersistenceService, type LoadedWorkItemResult } from "../services/persistence.ts"
import { PreviewService } from "../services/preview-service.ts"
import {
  formatDetailedStatusReport,
  REALGOAL_NOTICE_MESSAGE_TYPE,
} from "../ui/presentation.ts"

export const REALGOAL_SUBCOMMANDS = [
  "goal",
  "plan",
  "status",
  "list",
  "resume",
  "pause",
  "stop",
  "cancel",
  "todo",
  "answer",
  "preview",
  "review",
  "publish",
  "execute",
  "config",
  "doctor",
  "archive",
] as const

export interface RegisterCommandsOptions {
  readonly customBrowserLauncher?: (url: string) => Promise<boolean>
  readonly piExecutable?: string
}

const deriveShortDisplayName = (objective: string, kind: WorkflowKind): string => {
  const firstLine = objective.split(/\r?\n/)[0]?.trim() ?? ""
  if (firstLine.length === 0) return `${kind}-task`
  return firstLine.length <= 48 ? firstLine : `${firstLine.slice(0, 48).trimEnd()}`
}

const emitNoticeMessage = (pi: ExtensionAPI, text: string): Effect.Effect<void, never> =>
  Effect.sync(() => {
    pi.sendMessage(
      {
        customType: REALGOAL_NOTICE_MESSAGE_TYPE,
        content: text,
        display: true,
      },
      { triggerTurn: false },
    )
  })

const triggerWorkflowKickoff = (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  promptText: string,
): Effect.Effect<void, never> =>
  Effect.sync(() => {
    if (ctx.isIdle()) {
      pi.sendUserMessage(promptText)
    } else {
      pi.sendUserMessage(promptText, { deliverAs: "followUp" })
    }
  })

const fileExists = (filePath: string): Effect.Effect<boolean, never> =>
  Effect.tryPromise({
    try: () => fs.access(filePath).then(() => true),
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false))

export const registerRealgoalCommands = (
  pi: ExtensionAPI,
  runtime: RealgoalRuntime,
  opts: RegisterCommandsOptions = {},
): void => {
  const handleStartWorkflow = (
    kind: WorkflowKind,
    rawObjective: string,
    ctx: ExtensionCommandContext,
  ): Effect.Effect<Option.Option<string>, RealgoalError, RealgoalServices> =>
    Effect.Do.pipe(
      Effect.bind("controller", () => ControllerService.useSync((s) => s)),
      Effect.tap(({ controller }) => controller.assertNotChildWorker(`command:${kind}`)),
      Effect.bind("activeOpt", ({ controller }) => controller.getActiveWorkItem()),
      Effect.bind("guardDecision", ({ controller, activeOpt }) =>
        Option.match(activeOpt, {
          onNone: () => Effect.succeed("proceed" as "proceed" | "aborted"),
          onSome: (activeLoaded): Effect.Effect<"proceed" | "aborted", RealgoalError> => {
            const st = activeLoaded.state
            if (st.runStatus === "finished" || st.runStatus === "cancelled" || st.archived) {
              return Effect.succeed("proceed")
            }
            if (!ctx.hasUI) {
              return Effect.fail(
                new InvalidTransitionError({
                  workItemId: st.id,
                  fromPhase: st.phase,
                  toPhase: "intake",
                  fromStatus: st.runStatus,
                  toStatus: "running",
                  reason: `Active ${st.kind} "${st.displayName}" (${st.id}) is currently ${st.runStatus}. Pause or cancel it first before starting a new objective.`,
                  missingConditions: ["Pause (/realgoal pause) or cancel (/realgoal cancel) the active objective"],
                }),
              )
            }
            const RESUME_OPT = `Resume active ${st.kind}: "${st.displayName}" (${st.runStatus})`
            const PAUSE_NEW_OPT = `Pause "${st.displayName}" and create new ${kind}`
            const CANCEL_NEW_OPT = `Cancel "${st.displayName}" and create new ${kind}`
            return Effect.tryPromise({
              try: () =>
                ctx.ui.select(
                  `Active Realgoal work item "${st.displayName}" is ${st.runStatus}. Choose how to proceed:`,
                  [RESUME_OPT, PAUSE_NEW_OPT, CANCEL_NEW_OPT],
                  ctx.signal ? { signal: ctx.signal } : undefined,
                ),
              catch: () => undefined,
            }).pipe(
              Effect.orElseSucceed(() => undefined),
              Effect.flatMap((picked): Effect.Effect<"proceed" | "aborted", RealgoalError> => {
                if (picked === undefined) {
                  return Effect.succeed("aborted")
                }
                const nowIso = new Date().toISOString()
                if (picked === RESUME_OPT) {
                  return controller
                    .createUserAuthorization({
                      state: st,
                      kind: "resume",
                      summary: "Resumed via active objective guard",
                      nowIso,
                    })
                    .pipe(
                      Effect.flatMap(({ state: withAuth, auth }) =>
                        resumeWorkItem(withAuth, auth, Option.none(), nowIso),
                      ),
                      Effect.flatMap((resumed) => controller.saveUpdatedState(st, resumed)),
                      Effect.tap(() =>
                        triggerWorkflowKickoff(
                          pi,
                          ctx,
                          `Resume active ${st.kind} "${st.displayName}" (${st.id}) in phase '${st.phase}'. Next action: ${st.nextAction}`,
                        ),
                      ),
                      Effect.as("aborted" as const),
                    )
                }
                if (picked === PAUSE_NEW_OPT) {
                  const paused = pauseWorkItem(
                    st,
                    `Paused by user to start new ${kind}`,
                    "user",
                    nowIso,
                  )
                  return controller.saveUpdatedState(st, paused).pipe(Effect.as("proceed" as const))
                }
                const cancelled = cancelWorkItem(
                  st,
                  `Cancelled by user to start new ${kind}`,
                  nowIso,
                )
                return controller.saveUpdatedState(st, cancelled).pipe(Effect.as("proceed" as const))
              }),
            )
          },
        }),
      ),
      Effect.flatMap(({ controller, guardDecision }): Effect.Effect<
        Option.Option<string>,
        RealgoalError,
        RealgoalServices
      > => {
        if (guardDecision === "aborted") {
          return Effect.succeed(Option.none())
        }
        const trimmed = rawObjective.trim()
        const resolveObjectiveEff: Effect.Effect<Option.Option<string>, never> =
          trimmed.length > 0
            ? Effect.succeed(Option.some(trimmed))
            : ctx.hasUI
              ? Effect.tryPromise({
                  try: () =>
                    ctx.ui.input(
                      `Enter ${kind === "goal" ? "Goal" : "Plan"} objective:`,
                      kind === "goal"
                        ? "e.g., Fix failing auth token refresh test and verify suite"
                        : "e.g., Design and implement resumable webhook retry pipeline",
                      ctx.signal ? { signal: ctx.signal } : undefined,
                    ),
                  catch: () => undefined,
                }).pipe(
                  Effect.orElseSucceed(() => undefined),
                  Effect.map((val) =>
                    val && val.trim().length > 0 ? Option.some(val.trim()) : Option.none(),
                  ),
                )
              : Effect.succeed(Option.none())

        return resolveObjectiveEff.pipe(
          Effect.flatMap((objOpt): Effect.Effect<Option.Option<string>, RealgoalError> =>
            Option.match(objOpt, {
              onNone: () =>
                ctx.hasUI
                  ? Effect.succeed(Option.none())
                  : Effect.fail(
                      new InvalidTransitionError({
                        workItemId: "none",
                        fromPhase: "none",
                        toPhase: "intake",
                        fromStatus: "none",
                        toStatus: "running",
                        reason: `Objective text is required when invoking /${kind} without interactive UI.`,
                        missingConditions: [`Provide objective text: /${kind} <objective>`],
                      }),
                    ),
              onSome: (objective) => {
                const nowIso = new Date().toISOString()
                const displayName = deriveShortDisplayName(objective, kind)
                return controller
                  .startNewWorkItem({
                    kind,
                    displayName,
                    objective,
                    nowIso,
                  })
                  .pipe(
                    Effect.tap(({ state, paths }) =>
                      triggerWorkflowKickoff(
                        pi,
                        ctx,
                        kind === "goal"
                          ? `[Realgoal /goal started · id=${state.id} · draft=${paths.draftDir}]\nObjective: ${objective}\nAdvance intake -> explore|analyze -> process -> verify via realgoal_control, track/verify T001 via realgoal_todo, and finish via realgoal_finish(recordGoalLevelVerification: true).`
                          : `[Realgoal /plan started · id=${state.id} · draft=${paths.draftDir}]\nObjective: ${objective}\nPlanning boundary is active: advance intake -> discovery|design|analysis -> finalization via realgoal_control, clarify ambiguities with realgoal_question / realgoal_preview, write ${paths.finalizedPath} and call realgoal_control(action: "finalize"), and do NOT modify repository files outside ${paths.draftDir} until user authorizes execution.`,
                      ),
                    ),
                    Effect.map(({ state }) =>
                      Option.some(`Started ${kind.toUpperCase()} "${state.displayName}" (${state.id}).`),
                    ),
                  )
              },
            }),
          ),
        )
      }),
    )

  const handlePublishMenuOrArg = (
    arg: string,
    ctx: ExtensionCommandContext,
  ): Effect.Effect<Option.Option<string>, RealgoalError, RealgoalServices> =>
    Effect.Do.pipe(
      Effect.bind("controller", () => ControllerService.useSync((s) => s)),
      Effect.bind("persistence", () => PersistenceService.useSync((s) => s)),
      Effect.bind("loaded", ({ controller }) => controller.requireWorkItem()),
      Effect.bind("mem", ({ controller }) => controller.getMemory()),
      Effect.bind("effCfg", ({ controller, loaded }) =>
        controller.getEffectiveConfig(Option.some(loaded.state)),
      ),
      Effect.flatMap(({ controller, persistence, loaded, mem, effCfg }) => {
        const state = loaded.state
        const specDefaultPath = path.join(
          effCfg.config.publication.specDirectory,
          `${state.safeDirName}.md`,
        )
        const planDefaultPath = path.join(
          effCfg.config.publication.planDirectory,
          `${state.safeDirName}.md`,
        )

        const OPT_SPEC = `1. Write specification to ${specDefaultPath}`
        const OPT_PLAN = `2. Write implementation plan to ${planDefaultPath}`
        const OPT_BOTH = `3. Write both specification and implementation plan`
        const OPT_REFINE = `4. Continue refining before writing anything`
        const OPT_STOP = `5. Stop here and keep draft only`

        const trimmed = arg.trim().toLowerCase()
        const resolveChoiceEff: Effect.Effect<
          Option.Option<"spec" | "plan" | "both" | "refine" | "stop">,
          never
        > =
          trimmed === "spec" || trimmed === "plan" || trimmed === "both" || trimmed === "refine" || trimmed === "stop"
            ? Effect.succeed(Option.some(trimmed))
            : !ctx.hasUI
              ? Effect.succeed(Option.none())
              : Effect.tryPromise({
                  try: () =>
                    ctx.ui.select(
                      `Publish finalized artifacts for "${state.displayName}" (${state.safeDirName}):`,
                      [OPT_SPEC, OPT_PLAN, OPT_BOTH, OPT_REFINE, OPT_STOP],
                      ctx.signal ? { signal: ctx.signal } : undefined,
                    ),
                  catch: () => undefined,
                }).pipe(
                  Effect.orElseSucceed(() => undefined),
                  Effect.map((picked) => {
                    if (picked === OPT_SPEC) return Option.some("spec" as const)
                    if (picked === OPT_PLAN) return Option.some("plan" as const)
                    if (picked === OPT_BOTH) return Option.some("both" as const)
                    if (picked === OPT_REFINE) return Option.some("refine" as const)
                    if (picked === OPT_STOP) return Option.some("stop" as const)
                    return Option.none()
                  }),
                )

        return resolveChoiceEff.pipe(
          Effect.flatMap((choiceOpt): Effect.Effect<Option.Option<string>, RealgoalError, RealgoalServices> =>
            Option.match(choiceOpt, {
              onNone: () => Effect.succeed(Option.none()),
              onSome: (choice): Effect.Effect<Option.Option<string>, RealgoalError, RealgoalServices> => {
                const nowIso = new Date().toISOString()
                if (choice === "refine") {
                  return advancePhase(state, {
                    expectedRevision: state.revision,
                    operationId: `cmd_pub_refine_${Date.now()}`,
                    targetPhase: "design",
                    reason: "User selected 'Continue refining' at publication menu",
                    nextAction: "Refine finalized.md based on user feedback, then re-finalize.",
                    origin: "user",
                    draftGateEnabled: effCfg.config.verification.draftGate.enabled,
                    nowIso,
                  }).pipe(
                    Effect.flatMap((nextState) =>
                      controller.saveUpdatedState(state, nextState).pipe(
                        Effect.tap(() =>
                          triggerWorkflowKickoff(
                            pi,
                            ctx,
                            `[Realgoal resumed · id=${nextState.id}]\nUser selected 'Continue refining' at publication menu. Refine ${loaded.paths.finalizedPath} in phase 'design', then re-run realgoal_control(action: "finalize").`,
                          ),
                        ),
                        Effect.as(Option.some("Returned to design phase for further refinement.")),
                      ),
                    ),
                  )
                }

                if (choice === "stop") {
                  const parked = pauseWorkItem(
                    state,
                    "User selected 'Stop here and keep draft only' at publication menu",
                    "user",
                    nowIso,
                  )
                  return controller.saveUpdatedState(state, parked).pipe(
                    Effect.as(
                      Option.some(
                        `Stopped and kept draft at ${loaded.paths.draftDir} (status: paused, not marked finished).`,
                      ),
                    ),
                  )
                }

                const finalizedPath = path.join(loaded.paths.draftDir, "finalized.md")
                return Effect.tryPromise({
                  try: () => fs.readFile(finalizedPath, "utf8"),
                  catch: (err) =>
                    new PersistenceError({
                      operation: "readFinalized",
                      path: finalizedPath,
                      message: `Cannot publish: ${finalizedPath} is missing (${(err as Error).message}).`,
                      corrupted: false,
                    }),
                }).pipe(
                  Effect.flatMap((markdown) => {
                    const targets: ReadonlyArray<"spec" | "plan"> =
                      choice === "both" ? ["spec", "plan"] : [choice]
                    const authKind =
                      choice === "both"
                        ? ("publish_both" as const)
                        : choice === "spec"
                          ? ("publish_spec" as const)
                          : ("publish_plan" as const)

                    return controller
                      .createUserAuthorization({
                        state,
                        kind: authKind,
                        summary: `User authorized ${authKind} via /realgoal publish`,
                        artifactHash: state.finalizedCandidateHash,
                        nowIso,
                      })
                      .pipe(
                        Effect.flatMap(({ state: stateWithAuth, auth }) =>
                          Effect.reduce(
                            targets,
                            () => ({ curState: stateWithAuth, written: [] as ReadonlyArray<string> }),
                            (acc, target) => {
                              const destDir =
                                target === "spec"
                                  ? effCfg.config.publication.specDirectory
                                  : effCfg.config.publication.planDirectory
                              const candidateFile = path.resolve(
                                mem.workspaceCwd,
                                destDir,
                                `${acc.curState.safeDirName}.md`,
                              )
                              return fileExists(candidateFile).pipe(
                                Effect.flatMap((exists) => {
                                  if (!exists) {
                                    return Effect.succeed({ allowOverwrite: false, skip: false })
                                  }
                                  if (!ctx.hasUI) {
                                    return Effect.succeed({ allowOverwrite: true, skip: false })
                                  }
                                  return Effect.tryPromise({
                                    try: () =>
                                      ctx.ui.confirm(
                                        `Overwrite existing ${target} file?`,
                                        `${candidateFile} already exists. Overwrite it?`,
                                      ),
                                    catch: () => false,
                                  }).pipe(
                                    Effect.orElseSucceed(() => false),
                                    Effect.map((confirmed) => ({
                                      allowOverwrite: confirmed,
                                      skip: !confirmed,
                                    })),
                                  )
                                }),
                                Effect.flatMap(({ allowOverwrite, skip }) => {
                                  if (skip) {
                                    return Effect.succeed(acc)
                                  }
                                  return persistence
                                    .publishMarkdownArtifact({
                                      workspaceCwd: mem.workspaceCwd,
                                      configDirName: mem.configDirName,
                                      state: acc.curState,
                                      callerOwner: controller.makeOwnerToken(mem),
                                      target,
                                      destinationDir: destDir,
                                      content: markdown,
                                      authorizationId: auth.id,
                                      allowOverwrite,
                                      draftGateEnabled: effCfg.config.verification.draftGate.enabled,
                                      nowIso,
                                    })
                                    .pipe(
                                      Effect.map((res) => ({
                                        curState: res.state,
                                        written: [...acc.written, res.writtenPath],
                                      })),
                                    )
                                }),
                              )
                            },
                          ),
                        ),
                        Effect.flatMap(({ curState, written }): Effect.Effect<Option.Option<string>, RealgoalError, RealgoalServices> => {
                          if (written.length === 0) {
                            return Effect.succeed(Option.some("Publication cancelled (existing file not overwritten)."))
                          }
                          if (curState.completionScope === "artifact") {
                            return emitNoticeMessage(
                              pi,
                              `Published: ${written.join(", ")}. Artifact-only scope ready for realgoal_finish or /realgoal execute.`,
                            ).pipe(
                              Effect.as(Option.some(`Published: ${written.join(", ")}`)),
                            )
                          }
                          const toExecChoice: WorkItemState = {
                            ...curState,
                            revision: curState.revision + 1,
                            phase: "execution_choice",
                            runStatus: "awaiting_user",
                            nextAction: "Await user execution choice (/realgoal execute): Direct-driven, Subagent-driven, or Stop here.",
                            updatedAt: nowIso,
                          }
                          return controller.saveUpdatedState(curState, toExecChoice).pipe(
                            Effect.flatMap(() => {
                              if (trimmed === "" && ctx.hasUI && (choice === "plan" || choice === "both")) {
                                return handleExecuteMenuOrArg("", ctx).pipe(
                                  Effect.map((execResOpt) =>
                                    Option.isSome(execResOpt)
                                      ? Option.some(`Published ${written.join(", ")}. ${execResOpt.value}`)
                                      : Option.some(
                                          `Published ${written.join(", ")}. Run /realgoal execute to choose Direct-driven, Subagent-driven, or Stop here.`,
                                        ),
                                  ),
                                )
                              }
                              return Effect.succeed(
                                Option.some(
                                  `Published ${written.join(", ")}. Run /realgoal execute to choose Direct-driven, Subagent-driven, or Stop here.`,
                                ),
                              )
                            }),
                          )
                        }),
                      )
                  }),
                )
              },
            }),
          ),
        )
      }),
    )

  const handleExecuteMenuOrArg = (
    rawArgs: string,
    ctx: ExtensionCommandContext,
  ): Effect.Effect<Option.Option<string>, RealgoalError, RealgoalServices> =>
    Effect.Do.pipe(
      Effect.bind("controller", () => ControllerService.useSync((s) => s)),
      Effect.bind("loaded", ({ controller }) => controller.requireWorkItem()),
      Effect.bind("effCfg", ({ controller, loaded }) =>
        controller.getEffectiveConfig(Option.some(loaded.state)),
      ),
      Effect.flatMap(({ controller, loaded, effCfg }) => {
        const state = loaded.state
        const tokens = rawArgs.trim().toLowerCase().split(/\s+/).filter(Boolean)
        const argExec = tokens[0]
        const argVerify = tokens.find((t) => t.startsWith("verify:"))?.slice("verify:".length)

        const OPT_DIRECT = "1. Execute now: Direct-driven (current session implements sequentially)"
        const OPT_SUBAGENT = "2. Execute now: Subagent-driven (isolated worker per TODO)"
        const OPT_STOP = "3. Stop here (keep published plan/spec without implementing)"

        const resolveExecChoice: Effect.Effect<
          Option.Option<{ readonly exec: ExecutionDriver | "stop"; readonly verify: VerificationDriver }>,
          never
        > =
          argExec === "direct" || argExec === "subagent" || argExec === "stop"
            ? Effect.succeed(
                Option.some({
                  exec: argExec,
                  verify:
                    argVerify === "subagent"
                      ? ("subagent" as const)
                      : argVerify === "direct"
                        ? ("direct" as const)
                        : effCfg.config.verification.executionDriver,
                }),
              )
            : !ctx.hasUI
              ? Effect.succeed(Option.none())
              : Effect.tryPromise({
                  try: async () => {
                    const picked = await ctx.ui.select(
                      `Choose execution mode for "${state.displayName}":`,
                      [OPT_DIRECT, OPT_SUBAGENT, OPT_STOP],
                      ctx.signal ? { signal: ctx.signal } : undefined,
                    )
                    if (picked === undefined) return Option.none()
                    if (picked === OPT_STOP) {
                      return Option.some({
                        exec: "stop" as const,
                        verify: state.verificationDriver,
                      })
                    }
                    const execMode: ExecutionDriver = picked === OPT_SUBAGENT ? "subagent" : "direct"
                    const V_DIRECT = "Verification: Direct (parent session verifies each TODO)"
                    const V_SUB = "Verification: Subagent (independent read-only reviewer per TODO)"
                    const verifyPicked = await ctx.ui.select(
                      `Choose verification driver for "${state.displayName}":`,
                      effCfg.config.verification.executionDriver === "subagent"
                        ? [V_SUB, V_DIRECT]
                        : [V_DIRECT, V_SUB],
                      ctx.signal ? { signal: ctx.signal } : undefined,
                    )
                    if (verifyPicked === undefined) return Option.none()
                    const verifyMode: VerificationDriver = verifyPicked === V_SUB ? "subagent" : "direct"
                    return Option.some({ exec: execMode, verify: verifyMode })
                  },
                  catch: () => Option.none(),
                }).pipe(Effect.orElseSucceed(() => Option.none()))

        return resolveExecChoice.pipe(
          Effect.flatMap((choiceOpt): Effect.Effect<Option.Option<string>, RealgoalError> =>
            Option.match(choiceOpt, {
              onNone: () => Effect.succeed(Option.none()),
              onSome: ({ exec, verify }): Effect.Effect<Option.Option<string>, RealgoalError> => {
                const nowIso = new Date().toISOString()
                if (exec === "stop") {
                  const parked = pauseWorkItem(
                    state,
                    "User selected 'Stop here' at execution menu; implementation not started",
                    "user",
                    nowIso,
                  )
                  return controller.saveUpdatedState(state, parked).pipe(
                    Effect.as(
                      Option.some(
                        `Stopped before implementation (status: paused; artifacts preserved at ${loaded.paths.draftDir}).`,
                      ),
                    ),
                  )
                }

                const authKind = exec === "subagent" ? ("execute_subagent" as const) : ("execute_direct" as const)
                return controller
                  .createUserAuthorization({
                    state,
                    kind: authKind,
                    summary: `User authorized ${exec} execution + ${verify} verification`,
                    artifactHash: state.finalizedCandidateHash,
                    nowIso,
                  })
                  .pipe(
                    Effect.flatMap(({ state: withAuth }) => {
                      const prepped: WorkItemState = {
                        ...withAuth,
                        phase:
                          withAuth.phase === "execution_choice" ||
                          withAuth.phase === "publication" ||
                          withAuth.phase === "publication_choice"
                            ? "execution_choice"
                            : withAuth.phase,
                        runStatus: "running",
                        executionDriver: Option.some(exec),
                        verificationDriver: verify,
                      }
                      return advancePhase(prepped, {
                        expectedRevision: prepped.revision,
                        operationId: `cmd_exec_${Date.now()}`,
                        targetPhase: "lookup",
                        reason: `Authorized ${exec} execution + ${verify} verification`,
                        nextAction: `Populate/confirm ordered TODOs in lookup, then implement (${exec}) and verify (${verify}).`,
                        origin: "user",
                        draftGateEnabled: effCfg.config.verification.draftGate.enabled,
                        nowIso,
                      })
                    }),
                    Effect.flatMap((nextState) =>
                      controller.saveUpdatedState(state, nextState).pipe(
                        Effect.tap(() =>
                          triggerWorkflowKickoff(
                            pi,
                            ctx,
                            `[Realgoal execution authorized · id=${nextState.id} · execution=${exec} · verification=${verify}]\nProceed from phase 'lookup': ensure ordered TODOs are recorded via realgoal_todo, execute each TODO via ${exec} driver, verify with fresh evidence (${verify} driver), and finish via realgoal_finish.`,
                          ),
                        ),
                        Effect.as(
                          Option.some(
                            `Authorized execution=${exec}, verification=${verify}. Transitioned to 'lookup'.`,
                          ),
                        ),
                      ),
                    ),
                  )
              },
            }),
          ),
        )
      }),
    )

  const handleRealgoalAction = (
    rawArgs: string,
    ctx: ExtensionCommandContext,
  ): Effect.Effect<Option.Option<string>, RealgoalError, RealgoalServices> => {
    const trimmed = rawArgs.trim()
    const spaceIdx = trimmed.indexOf(" ")
    const subcommand = (spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase()
    const restArgs = spaceIdx < 0 ? "" : trimmed.slice(spaceIdx + 1).trim()

    if (subcommand === "") {
      if (!ctx.hasUI) {
        return ControllerService.use((c) => c.getActiveWorkItem()).pipe(
          Effect.flatMap((activeOpt) =>
            Option.match(activeOpt, {
              onNone: () => emitNoticeMessage(pi, "No active Realgoal work item. Use /goal or /plan.").pipe(Effect.as(Option.none())),
              onSome: (loaded) =>
                emitNoticeMessage(pi, formatDetailedStatusReport(loaded.state, loaded.paths.draftDir)).pipe(
                  Effect.as(Option.none()),
                ),
            }),
          ),
        )
      }

      return ControllerService.use((c) => c.getActiveWorkItem()).pipe(
        Effect.flatMap((activeOpt): Effect.Effect<Option.Option<string>, RealgoalError, RealgoalServices> => {
          const menuItems: string[] = Option.match(activeOpt, {
            onNone: () => [
              "Start new /goal",
              "Start new /plan",
              "Resume saved work item",
              "List saved work items",
              "Run /realgoal doctor",
              "View /realgoal config",
            ],
            onSome: ({ state }) => {
              const items: string[] = ["Show status"]
              if (state.runStatus === "paused" || state.runStatus === "blocked") {
                items.push("Resume active work item")
              }
              if (state.runStatus === "running" || state.runStatus === "waiting_task" || state.runStatus === "awaiting_user") {
                items.push("Pause active work item")
              }
              if (state.questions.some((q) => q.status === "pending")) {
                items.push("Answer pending question")
                items.push("Open browser preview")
              }
              if (state.kind === "plan" && (state.phase === "publication_choice" || state.phase === "publication" || Option.isSome(state.finalizedCandidateHash))) {
                items.push("Publish specification / implementation plan")
              }
              if (state.kind === "plan" && (state.phase === "execution_choice" || state.publications.length > 0)) {
                items.push("Execute published plan (Direct / Subagent)")
              }
              if (state.kind === "plan" && state.phase === "draft_review") {
                items.push("Inspect or waive draft review gate")
              }
              items.push(
                "View TODO items",
                "List all work items",
                "Run /realgoal doctor",
                "View /realgoal config",
                "Cancel active work item",
              )
              if (state.runStatus === "finished" || state.runStatus === "cancelled") {
                items.push("Archive work item")
              }
              return items
            },
          })

          return Effect.tryPromise({
            try: () =>
              ctx.ui.select(
                "Realgoal Actions (Esc to dismiss):",
                menuItems,
                ctx.signal ? { signal: ctx.signal } : undefined,
              ),
            catch: () => undefined,
          }).pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.flatMap((picked): Effect.Effect<Option.Option<string>, RealgoalError, RealgoalServices> => {
              if (picked === undefined) return Effect.succeed(Option.none())
              switch (picked) {
                case "Start new /goal":
                  return handleStartWorkflow("goal", "", ctx)
                case "Start new /plan":
                  return handleStartWorkflow("plan", "", ctx)
                case "Show status":
                  return handleRealgoalAction("status", ctx)
                case "Resume saved work item":
                case "Resume active work item":
                  return handleRealgoalAction("resume", ctx)
                case "Pause active work item":
                  return handleRealgoalAction("pause", ctx)
                case "Answer pending question":
                  return handleRealgoalAction("answer", ctx)
                case "Open browser preview":
                  return handleRealgoalAction("preview", ctx)
                case "Publish specification / implementation plan":
                  return handlePublishMenuOrArg("", ctx)
                case "Execute published plan (Direct / Subagent)":
                  return handleExecuteMenuOrArg("", ctx)
                case "Inspect or waive draft review gate":
                  return handleRealgoalAction("review", ctx)
                case "View TODO items":
                  return handleRealgoalAction("todo", ctx)
                case "List saved work items":
                case "List all work items":
                  return handleRealgoalAction("list", ctx)
                case "Run /realgoal doctor":
                  return handleRealgoalAction("doctor", ctx)
                case "View /realgoal config":
                  return handleRealgoalAction("config", ctx)
                case "Cancel active work item":
                  return handleRealgoalAction("cancel", ctx)
                case "Archive work item":
                  return handleRealgoalAction("archive", ctx)
                default:
                  return Effect.succeed(Option.none())
              }
            }),
          )
        }),
      )
    }

    switch (subcommand) {
      case "goal":
        return handleStartWorkflow("goal", restArgs, ctx)

      case "plan":
        return handleStartWorkflow("plan", restArgs, ctx)

      case "status":
        return ControllerService.use((c) => c.requireWorkItem(restArgs ? Option.some(restArgs) : Option.none())).pipe(
          Effect.flatMap((loaded) => {
            const report = formatDetailedStatusReport(loaded.state, loaded.paths.draftDir)
            return emitNoticeMessage(pi, report).pipe(Effect.as(Option.none()))
          }),
        )

      case "list":
        return Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("persistence", () => PersistenceService.useSync((s) => s)),
          Effect.bind("mem", ({ controller }) => controller.getMemory()),
          Effect.bind("items", ({ persistence, mem }) =>
            persistence.listAllWorkItems(mem.workspaceCwd, mem.configDirName),
          ),
          Effect.flatMap(({ mem, items }) => {
            if (items.length === 0) {
              return emitNoticeMessage(pi, "No saved Realgoal work items in this workspace.").pipe(
                Effect.as(Option.none()),
              )
            }
            const lines = items.map((entry) => {
              if ("error" in entry) {
                return `- [CORRUPTED] (${entry.safeDirName}): ${entry.error.message}`
              }
              const s = entry.state
              const isActive = Option.contains(mem.activeWorkItemId, s.id) ? " *ACTIVE*" : ""
              const done = s.todos.filter((t) => t.status === "done").length
              const div = entry.projectionDivergences.length > 0 ? " [projection-diverged]" : ""
              const rec = entry.recoveredFromHistory ? " [recovered]" : ""
              return `- ${s.id}${isActive} · ${s.kind.toUpperCase()} "${s.displayName}" · phase=${s.phase} · status=${s.runStatus} · todos=${done}/${s.todos.length}${div}${rec} (${s.safeDirName})`
            })
            return emitNoticeMessage(pi, `Saved Realgoal Work Items:\n${lines.join("\n")}`).pipe(
              Effect.as(Option.none()),
            )
          }),
        )

      case "pause":
      case "stop":
        return Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("loaded", ({ controller }) => controller.requireWorkItem()),
          Effect.flatMap(({ controller, loaded }) => {
            const nowIso = new Date().toISOString()
            const reason = restArgs.length > 0 ? restArgs : `Paused by user (/realgoal ${subcommand})`
            const paused = pauseWorkItem(loaded.state, reason, "user", nowIso)
            return controller.saveUpdatedState(loaded.state, paused).pipe(
              Effect.as(
                Option.some(
                  `Paused "${paused.displayName}" (${paused.id}). Draft preserved at ${loaded.paths.draftDir}.`,
                ),
              ),
            )
          }),
        )

      case "resume":
        return Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("persistence", () => PersistenceService.useSync((s) => s)),
          Effect.bind("mem", ({ controller }) => controller.getMemory()),
          Effect.bind("targetLoaded", ({ controller, persistence, mem }): Effect.Effect<
            Option.Option<LoadedWorkItemResult>,
            RealgoalError
          > => {
            const parts = restArgs.split(/\s+/).filter(Boolean)
            const firstToken = parts[0]
            if (firstToken) {
              return persistence.loadWorkItemById(mem.workspaceCwd, mem.configDirName, firstToken).pipe(
                Effect.flatMap((byId) =>
                  Option.isSome(byId)
                    ? Effect.succeed(byId)
                    : persistence
                        .loadWorkItemBySafeDir(mem.workspaceCwd, mem.configDirName, firstToken)
                        .pipe(
                          Effect.map(Option.some),
                          Effect.catch(() => controller.getActiveWorkItem()),
                        ),
                ),
              )
            }
            return controller.getActiveWorkItem().pipe(
              Effect.flatMap((activeOpt) => {
                if (Option.isSome(activeOpt)) return Effect.succeed(activeOpt)
                return persistence.listAllWorkItems(mem.workspaceCwd, mem.configDirName).pipe(
                  Effect.flatMap((all) => {
                    const loadedOnly = all.filter(
                      (i): i is LoadedWorkItemResult => !("error" in i),
                    )
                    const resumable = loadedOnly.filter(
                      (i) => !i.state.archived && i.state.runStatus !== "finished" && i.state.runStatus !== "cancelled",
                    )
                    if (resumable.length === 0) return Effect.succeed(Option.none())
                    if (resumable.length === 1 || !ctx.hasUI) return Effect.succeed(Option.some(resumable[0]!))
                    const labels = resumable.map(
                      (r) => `${r.state.id}: [${r.state.kind}] "${r.state.displayName}" (${r.state.phase} · ${r.state.runStatus})`,
                    )
                    return Effect.tryPromise({
                      try: () => ctx.ui.select("Select work item to resume:", labels),
                      catch: () => undefined,
                    }).pipe(
                      Effect.orElseSucceed(() => undefined),
                      Effect.map((picked) => {
                        if (!picked) return Option.none()
                        const idx = labels.indexOf(picked)
                        return idx >= 0 ? Option.fromUndefinedOr(resumable[idx]) : Option.none()
                      }),
                    )
                  }),
                )
              }),
            )
          }),
          Effect.flatMap(({ controller, persistence, mem, targetLoaded }): Effect.Effect<
            Option.Option<string>,
            RealgoalError
          > =>
            Option.match(targetLoaded, {
              onNone: () => Effect.succeed(Option.some("No resumable Realgoal work item found.")),
              onSome: (loaded) => {
                const nowIso = new Date().toISOString()
                const callerOwner = controller.makeOwnerToken({ ...mem, readOnlyAttachment: false })
                return persistence
                  .acquireOrVerifyOwnership(
                    mem.workspaceCwd,
                    mem.configDirName,
                    loaded.state,
                    callerOwner,
                    false,
                  )
                  .pipe(
                    Effect.catchTag("OwnershipConflictError", (conflict: OwnershipConflictError) => {
                      if (!ctx.hasUI) return Effect.fail(conflict)
                      return Effect.tryPromise({
                        try: () =>
                          ctx.ui.confirm(
                            "Work item ownership conflict",
                            `${conflict.reason}\nForce-transfer ownership to this session?`,
                          ),
                        catch: () => false,
                      }).pipe(
                        Effect.orElseSucceed(() => false),
                        Effect.flatMap((confirmed) =>
                          confirmed
                            ? persistence.acquireOrVerifyOwnership(
                                mem.workspaceCwd,
                                mem.configDirName,
                                loaded.state,
                                callerOwner,
                                true,
                              )
                            : Effect.fail(conflict),
                        ),
                      )
                    }),
                    Effect.flatMap((ownedState) =>
                      controller
                        .updateMemory((cur) => ({
                          ...cur,
                          readOnlyAttachment: false,
                          activeWorkItemId: Option.some(ownedState.id),
                        }))
                        .pipe(
                          Effect.flatMap(() =>
                            controller.createUserAuthorization({
                              state: ownedState,
                              kind: "resume",
                              summary: "User resumed work item via /realgoal resume",
                              nowIso,
                            }),
                          ),
                          Effect.flatMap(({ state: withAuth, auth }) =>
                            resumeWorkItem(
                              withAuth,
                              auth,
                              restArgs.length > 0 ? Option.some(restArgs) : Option.none(),
                              nowIso,
                            ),
                          ),
                          Effect.flatMap((resumed) =>
                            controller.saveUpdatedState(ownedState, resumed).pipe(
                              Effect.tap(() =>
                                resumed.runStatus === "running"
                                  ? triggerWorkflowKickoff(
                                      pi,
                                      ctx,
                                      `[Realgoal resumed · id=${resumed.id} · phase=${resumed.phase}]\nNext action: ${resumed.nextAction}`,
                                    )
                                  : Effect.void,
                              ),
                              Effect.as(
                                Option.some(
                                  `Resumed "${resumed.displayName}" (${resumed.id}) -> status=${resumed.runStatus}, phase=${resumed.phase}.`,
                                ),
                              ),
                            ),
                          ),
                        ),
                    ),
                  )
              },
            }),
          ),
        )

      case "cancel":
        return Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("previewSvc", () => PreviewService.useSync((s) => s)),
          Effect.bind("loaded", ({ controller }) => controller.requireWorkItem()),
          Effect.flatMap(({ controller, previewSvc, loaded }) => {
            const nowIso = new Date().toISOString()
            const reason = restArgs.length > 0 ? restArgs : "Cancelled by user (/realgoal cancel)"
            const runningOwned = loaded.state.trackedTasks.filter(
              (t) => t.ownership === "owned" && (t.lastStatus === "running" || t.lastStatus === "ready"),
            )
            const cancelled = cancelWorkItem(loaded.state, reason, nowIso)
            return previewSvc.invalidateGenerationAndStop().pipe(
              Effect.flatMap(() => controller.saveUpdatedState(loaded.state, cancelled)),
              Effect.flatMap(() => {
                if (runningOwned.length === 0) {
                  return Effect.succeed(
                    Option.some(
                      `Cancelled "${cancelled.displayName}" (${cancelled.id}). Artifacts retained at ${loaded.paths.draftDir}.`,
                    ),
                  )
                }
                const idsText = runningOwned.map((t) => t.taskId).join(", ")
                if (!ctx.hasUI) {
                  const warn = `Cancelled "${cancelled.displayName}". WARNING: Tracked background task(s) [${idsText}] remain running because cleanup was not confirmed.`
                  return emitNoticeMessage(pi, warn).pipe(Effect.as(Option.some(warn)))
                }
                return Effect.tryPromise({
                  try: () =>
                    ctx.ui.confirm(
                      "Stop tracked background tasks?",
                      `Work item "${cancelled.displayName}" has running owned realtasks [${idsText}]. Authorize stopping these exact task IDs?`,
                    ),
                  catch: () => false,
                }).pipe(
                  Effect.orElseSucceed(() => false),
                  Effect.flatMap((confirmed) => {
                    if (!confirmed) {
                      const warn = `Cancelled "${cancelled.displayName}". WARNING: Tracked task(s) [${idsText}] left running per user choice.`
                      return emitNoticeMessage(pi, warn).pipe(Effect.as(Option.some(warn)))
                    }
                    return controller
                      .createUserAuthorization({
                        state: cancelled,
                        kind: "cleanup_tasks",
                        summary: `User confirmed cleanup of [${idsText}] on cancel`,
                        taskIds: runningOwned.map((t) => t.taskId),
                        nowIso,
                      })
                      .pipe(
                        Effect.tap(({ auth }) =>
                          triggerWorkflowKickoff(
                            pi,
                            ctx,
                            `Stop user-authorized cancelled work item tasks [${idsText}] via realgoal_control(action="cleanup", authorizationId="${auth.id}", cleanupTaskIds=${JSON.stringify(
                              runningOwned.map((t) => t.taskId),
                            )}). Never call task_stop("all").`,
                          ),
                        ),
                        Effect.as(
                          Option.some(
                            `Cancelled "${cancelled.displayName}" and authorized cleanup of [${idsText}].`,
                          ),
                        ),
                      )
                  }),
                )
              }),
            )
          }),
        )

      case "todo":
        return ControllerService.use((c) => c.requireWorkItem()).pipe(
          Effect.flatMap((loaded) => {
            const lines =
              loaded.state.todos.length === 0
                ? ["No TODO items recorded."]
                : loaded.state.todos.map(
                    (t) =>
                      `- [${t.status}] ${t.id} (${t.difficulty}) ${t.title} — deps:[${t.dependencyIds.join(",")}] ev:[${t.evidenceIds.join(",")}]`,
                  )
            return emitNoticeMessage(
              pi,
              `TODOs for "${loaded.state.displayName}" (${loaded.state.id}):\n${lines.join("\n")}`,
            ).pipe(Effect.as(Option.none()))
          }),
        )

      case "answer":
        return Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("previewSvc", () => PreviewService.useSync((s) => s)),
          Effect.bind("loaded", ({ controller }) => controller.requireWorkItem()),
          Effect.flatMap(({ controller, previewSvc, loaded }): Effect.Effect<
            Option.Option<string>,
            RealgoalError
          > => {
            const state = loaded.state
            const pending = state.questions.filter((q) => q.status === "pending")
            if (pending.length === 0) {
              return Effect.succeed(Option.some("No pending questions on active work item."))
            }
            const parts = restArgs.split(/\s+/).filter(Boolean)
            const explicitQId = parts[0] && pending.some((q) => q.id === parts[0]) ? parts[0] : undefined
            const answerTextFromArgs = explicitQId ? parts.slice(1).join(" ") : restArgs

            const targetQ = explicitQId
              ? pending.find((q) => q.id === explicitQId)!
              : pending[0]!

            const resolveAnsEff: Effect.Effect<Option.Option<QuestionAnswer>, never> =
              answerTextFromArgs.length > 0
                ? Effect.succeed(
                    Option.some<QuestionAnswer>({
                      selectedOptionIds: targetQ.options.some((o) => o.id === answerTextFromArgs)
                        ? [answerTextFromArgs]
                        : [],
                      customText: targetQ.options.some((o) => o.id === answerTextFromArgs)
                        ? Option.none()
                        : Option.some(answerTextFromArgs),
                      comments: Option.none(),
                      source: "command",
                      answeredAt: new Date().toISOString(),
                      previewRevision: Option.none(),
                    }),
                  )
                : !ctx.hasUI
                  ? Effect.succeed(Option.none())
                  : Effect.tryPromise({
                      try: async (): Promise<Option.Option<QuestionAnswer>> => {
                        if (targetQ.options.length > 0) {
                          const labels = targetQ.options.map((o) => `${o.id}: ${o.label} — ${o.description}`)
                          const CUSTOM = "Type custom answer…"
                          const picked = await ctx.ui.select(
                            `${targetQ.id} · ${targetQ.title}: ${targetQ.prompt}`,
                            [...labels, ...(targetQ.allowFreeText ? [CUSTOM] : [])],
                          )
                          if (!picked) return Option.none()
                          if (picked === CUSTOM) {
                            const txt = await ctx.ui.input(`${targetQ.id} · Custom answer`, targetQ.prompt)
                            if (!txt || txt.trim().length === 0) return Option.none()
                            return Option.some({
                              selectedOptionIds: [],
                              customText: Option.some(txt.trim()),
                              comments: Option.none(),
                              source: "command",
                              answeredAt: new Date().toISOString(),
                              previewRevision: Option.none(),
                            })
                          }
                          const idx = labels.indexOf(picked)
                          const opt = idx >= 0 ? targetQ.options[idx] : undefined
                          if (!opt) return Option.none()
                          return Option.some({
                            selectedOptionIds: [opt.id],
                            customText: Option.none(),
                            comments: Option.none(),
                            source: "command",
                            answeredAt: new Date().toISOString(),
                            previewRevision: Option.none(),
                          })
                        }
                        const txt = await ctx.ui.input(`${targetQ.id} · ${targetQ.title}`, targetQ.prompt)
                        if (!txt || txt.trim().length === 0) return Option.none()
                        return Option.some({
                          selectedOptionIds: [],
                          customText: Option.some(txt.trim()),
                          comments: Option.none(),
                          source: "command",
                          answeredAt: new Date().toISOString(),
                          previewRevision: Option.none(),
                        })
                      },
                      catch: () => Option.none(),
                    }).pipe(Effect.orElseSucceed(() => Option.none()))

            return resolveAnsEff.pipe(
              Effect.flatMap((ansOpt): Effect.Effect<Option.Option<string>, RealgoalError> =>
                Option.match(ansOpt, {
                  onNone: () => Effect.succeed(Option.none()),
                  onSome: (answer) => {
                    const nowIso = new Date().toISOString()
                    return resolveQuestionCAS(state, {
                      questionId: targetQ.id,
                      expectedQuestionRevision: targetQ.revision,
                      answer,
                      nowIso,
                    }).pipe(
                      Effect.flatMap((nextState) =>
                        controller.saveUpdatedState(state, nextState).pipe(
                          Effect.tap(() =>
                            previewSvc.resolveQuestionWaiter(state.id, targetQ.id, answer),
                          ),
                          Effect.tap(() =>
                            nextState.runStatus === "running"
                              ? triggerWorkflowKickoff(
                                  pi,
                                  ctx,
                                  `Question ${targetQ.id} answered by user. Continue ${nextState.phase}: ${nextState.nextAction}`,
                                )
                              : Effect.void,
                          ),
                          Effect.as(Option.some(`Answered ${targetQ.id} (rev ${nextState.revision}).`)),
                        ),
                      ),
                    )
                  },
                }),
              ),
            )
          }),
        )

      case "preview":
        return Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("previewSvc", () => PreviewService.useSync((s) => s)),
          Effect.bind("loaded", ({ controller }) => controller.requireWorkItem()),
          Effect.bind("effCfg", ({ controller, loaded }) =>
            controller.getEffectiveConfig(Option.some(loaded.state)),
          ),
          Effect.flatMap(({ controller, previewSvc, loaded, effCfg }): Effect.Effect<
            Option.Option<string>,
            RealgoalError
          > => {
            const state = loaded.state
            const qOpt = restArgs
              ? Option.fromUndefinedOr(state.questions.find((q) => q.id === restArgs))
              : Option.fromUndefinedOr(
                  state.questions.find((q) => q.status === "pending") ?? state.questions[state.questions.length - 1],
                )
            return Option.match(qOpt, {
              onNone: () => Effect.succeed(Option.some("No question available to preview.")),
              onSome: (q) =>
                previewSvc
                  .ensureServerAndCreateLaunchUrl({
                    host: effCfg.config.browser.host,
                    questionId: q.id,
                    binding: {
                      workItemId: state.id,
                      safeDirName: state.safeDirName,
                      draftPrevewsRoot: loaded.paths.previewsDir,
                      externalAssetsAllowed: effCfg.config.browser.externalAssets,
                      getStateSnapshot: () =>
                        controller
                          .requireWorkItem(Option.some(state.id))
                          .pipe(
                            Effect.map((r) => Option.some(r.state)),
                            Effect.orElseSucceed(() => Option.none()),
                          ),
                      onBrowserSubmit: (sub) =>
                        controller.requireWorkItem(Option.some(sub.workItemId)).pipe(
                          Effect.flatMap((fresh) =>
                            resolveQuestionCAS(fresh.state, {
                              questionId: sub.questionId,
                              expectedQuestionRevision: sub.expectedQuestionRevision,
                              answer: sub.answer,
                              nowIso: new Date().toISOString(),
                            }).pipe(
                              Effect.flatMap((ns) =>
                                controller.saveUpdatedState(fresh.state, ns).pipe(Effect.as(ns)),
                              ),
                              Effect.tap((ns) => {
                                if (ns.runStatus === "running" && ctx.isIdle()) {
                                  pi.sendUserMessage(
                                    `Browser preview answer submitted for ${sub.questionId}. Continue ${ns.phase}.`,
                                  )
                                }
                                return previewSvc.resolveQuestionWaiter(sub.workItemId, sub.questionId, sub.answer)
                              }),
                            ),
                          ),
                        ),
                    },
                  })
                  .pipe(
                    Effect.tap(({ launchUrl }) =>
                      effCfg.config.browser.open !== "never"
                        ? openUrlInSystemBrowser(launchUrl, opts.customBrowserLauncher)
                        : Effect.void,
                    ),
                    Effect.flatMap(({ launchUrl }) =>
                      emitNoticeMessage(pi, `Preview ready for ${q.id}: ${launchUrl}`).pipe(
                        Effect.as(Option.some(`Preview URL: ${launchUrl}`)),
                      ),
                    ),
                  ),
            })
          }),
        )

      case "review":
        return Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("loaded", ({ controller }) => controller.requireWorkItem()),
          Effect.flatMap(({ controller, loaded }): Effect.Effect<Option.Option<string>, RealgoalError> => {
            const state = loaded.state
            const waiveRequested = restArgs.toLowerCase() === "waive"
            const doWaive = (): Effect.Effect<Option.Option<string>, RealgoalError> => {
              const nowIso = new Date().toISOString()
              return controller
                .createUserAuthorization({
                  state,
                  kind: "waive_draft_gate",
                  summary: "User explicitly waived independent draft review gate via /realgoal review",
                  artifactHash: state.finalizedCandidateHash,
                  nowIso,
                })
                .pipe(
                  Effect.flatMap(({ state: withAuth, auth }) => {
                    const updated: WorkItemState = {
                      ...withAuth,
                      revision: withAuth.revision + 1,
                      phase: withAuth.phase === "draft_review" ? "publication_choice" : withAuth.phase,
                      runStatus: withAuth.phase === "draft_review" ? "awaiting_user" : withAuth.runStatus,
                      draftGateWaiverId: Option.some(auth.id),
                      nextAction: "Draft review gate waived by user; select publication choice (/realgoal publish).",
                      updatedAt: nowIso,
                    }
                    return controller
                      .saveUpdatedState(withAuth, updated)
                      .pipe(Effect.as(Option.some(`Waived draft review gate (auth ${auth.id}).`)))
                  }),
                )
            }

            if (waiveRequested) return doWaive()

            const summaryLines =
              state.reviews.length === 0
                ? ["No draft review reports recorded yet."]
                : state.reviews.map(
                    (r) =>
                      `- ${r.id} [${r.verdict}] (${r.timestamp}): ${r.summary} (${r.findings.length} finding(s))`,
                  )

            if (!ctx.hasUI || state.phase !== "draft_review") {
              return emitNoticeMessage(pi, `Draft Reviews:\n${summaryLines.join("\n")}`).pipe(
                Effect.as(Option.none()),
              )
            }

            return Effect.tryPromise({
              try: () =>
                ctx.ui.select(
                  `Draft Review Gate (${state.reviews.length} report(s)):`,
                  ["Show review details only", "Waive draft review gate and proceed to publication"],
                ),
              catch: () => undefined,
            }).pipe(
              Effect.orElseSucceed(() => undefined),
              Effect.flatMap((picked) =>
                picked === "Waive draft review gate and proceed to publication"
                  ? doWaive()
                  : emitNoticeMessage(pi, `Draft Reviews:\n${summaryLines.join("\n")}`).pipe(
                      Effect.as(Option.none()),
                    ),
              ),
            )
          }),
        )

      case "publish":
        return handlePublishMenuOrArg(restArgs, ctx)

      case "execute":
        return handleExecuteMenuOrArg(restArgs, ctx)

      case "config":
        return Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("activeOpt", ({ controller }) => controller.getActiveWorkItem()),
          Effect.bind("effCfg", ({ controller, activeOpt }) =>
            controller.getEffectiveConfig(Option.map(activeOpt, (l) => l.state)),
          ),
          Effect.flatMap(({ effCfg }) => {
            const c = effCfg.config
            const src = (k: string) => effCfg.sources[k] ?? "default"
            const lines = [
              `Effective Realgoal Configuration:`,
              `- continuation.enabled = ${c.continuation.enabled} (${src("continuation.enabled")})`,
              `- continuation.maxNoProgressContinuations = ${c.continuation.maxNoProgressContinuations} (${src("continuation.maxNoProgressContinuations")})`,
              `- continuation.maxRepeatedFailureAttempts = ${c.continuation.maxRepeatedFailureAttempts} (${src("continuation.maxRepeatedFailureAttempts")})`,
              `- continuation.maxTotalTurns = ${Option.getOrElse(Option.map(c.continuation.maxTotalTurns, String), () => "null")} (${src("continuation.maxTotalTurns")})`,
              `- verification.draftGate.enabled = ${c.verification.draftGate.enabled} (${src("verification.draftGate.enabled")})`,
              `- verification.executionDriver = ${c.verification.executionDriver} (${src("verification.executionDriver")})`,
              `- execution.driver = ${Option.getOrElse(c.execution.driver, () => "ask")} (${src("execution.driver")})`,
              `- execution.maxConcurrentWriters = ${c.execution.maxConcurrentWriters} (${src("execution.maxConcurrentWriters")})`,
              `- models.light = ${c.models.light.model} / thinking:${c.models.light.thinking} (${src("models.light.thinking")})`,
              `- models.medium = ${c.models.medium.model} / thinking:${c.models.medium.thinking} (${src("models.medium.thinking")})`,
              `- models.heavy = ${c.models.heavy.model} / thinking:${c.models.heavy.thinking} (${src("models.heavy.thinking")})`,
              `- browser.enabled = ${c.browser.enabled} (${src("browser.enabled")})`,
              `- browser.open = ${c.browser.open} (${src("browser.open")})`,
              `- browser.host = ${c.browser.host} (${src("browser.host")})`,
              `- browser.externalAssets = ${c.browser.externalAssets} (${src("browser.externalAssets")})`,
              `- publication.specDirectory = ${c.publication.specDirectory} (${src("publication.specDirectory")})`,
              `- publication.planDirectory = ${c.publication.planDirectory} (${src("publication.planDirectory")})`,
              ...(effCfg.warnings.length > 0 ? [`Warnings: ${effCfg.warnings.join("; ")}`] : []),
            ]
            return emitNoticeMessage(pi, lines.join("\n")).pipe(Effect.as(Option.none()))
          }),
        )

      case "doctor":
        return Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("doctor", () => DoctorService.useSync((s) => s)),
          Effect.bind("mem", ({ controller }) => controller.getMemory()),
          Effect.bind("effCfg", ({ controller }) => controller.getEffectiveConfig()),
          Effect.bind("report", ({ doctor, mem, effCfg }) => {
            const allTools = pi.getAllTools()
            const toolNames = allTools.map((t) => t.name)
            const bashTool = allTools.find((t) => t.name === "bash")
            const bashProps = (bashTool?.parameters as { properties?: Record<string, unknown> } | undefined)
              ?.properties
            const bashSupportsBg = Boolean(
              bashProps && ("run_in_background" in bashProps || "ready" in bashProps),
            )
            return doctor.runDiagnostics({
              workspaceCwd: mem.workspaceCwd,
              configDirName: mem.configDirName,
              registeredToolNames: toolNames,
              bashSupportsBackground: bashSupportsBg,
              commandCollisions: mem.commandCollisions,
              previewHost: effCfg.config.browser.host,
              piExecutable: opts.piExecutable,
            })
          }),
          Effect.flatMap(({ report }) => {
            const rows = report.checks.map(
              (chk) => `- [${chk.status.toUpperCase()}] ${chk.label}: ${chk.detail}`,
            )
            const text = `Realgoal Doctor (${report.overallStatus.toUpperCase()}):\n${rows.join("\n")}`
            return emitNoticeMessage(pi, text).pipe(
              Effect.as(Option.some(`Doctor overall status: ${report.overallStatus}`)),
            )
          }),
        )

      case "archive":
        return Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("loaded", ({ controller }) =>
            controller.requireWorkItem(restArgs ? Option.some(restArgs) : Option.none()),
          ),
          Effect.flatMap(({ controller, loaded }): Effect.Effect<Option.Option<string>, RealgoalError> => {
            const st = loaded.state
            if (st.runStatus !== "finished" && st.runStatus !== "cancelled") {
              return Effect.fail(
                new InvalidTransitionError({
                  workItemId: st.id,
                  fromPhase: st.phase,
                  toPhase: st.phase,
                  fromStatus: st.runStatus,
                  toStatus: st.runStatus,
                  reason: `Only finished or cancelled work items can be archived (current: ${st.runStatus}).`,
                  missingConditions: ["Finish or cancel the work item before archiving"],
                }),
              )
            }
            const archivedState: WorkItemState = {
              ...st,
              revision: st.revision + 1,
              archived: true,
              updatedAt: new Date().toISOString(),
            }
            return controller.saveUpdatedState(st, archivedState).pipe(
              Effect.tap(() =>
                controller.updateMemory((cur) => ({
                  ...cur,
                  activeWorkItemId: Option.contains(cur.activeWorkItemId, st.id)
                    ? Option.none()
                    : cur.activeWorkItemId,
                })),
              ),
              Effect.as(Option.some(`Archived work item "${st.displayName}" (${st.id}).`)),
            )
          }),
        )

      default:
        return emitNoticeMessage(
          pi,
          `Unknown /realgoal action '${subcommand}'. Supported: ${REALGOAL_SUBCOMMANDS.join(", ")}.`,
        ).pipe(Effect.as(Option.none()))
    }
  }

  // Action methods such as getCommands() are unavailable in the factory.
  // Wait until every extension has loaded and Pi has bound the runtime.
  let commandsRegistered = false
  pi.on("session_start", () => {
    if (commandsRegistered) return
    const existingCommandNames = new Set(pi.getCommands().map((c) => c.name))
    const collisions = ["goal", "plan", "realgoal"].filter((name) => existingCommandNames.has(name))

    if (!existingCommandNames.has("goal")) {
      pi.registerCommand("goal", {
        description: "Start a lightweight iterative Realgoal /goal workflow",
        handler: (args, ctx) => runtime.runCommandEffect(ctx, handleStartWorkflow("goal", args, ctx)),
      })
    }

    if (!existingCommandNames.has("plan")) {
      pi.registerCommand("plan", {
        description: "Start a structured Realgoal /plan discovery, review, publication, and execution workflow",
        handler: (args, ctx) => runtime.runCommandEffect(ctx, handleStartWorkflow("plan", args, ctx)),
      })
    }

    if (!existingCommandNames.has("realgoal")) {
      pi.registerCommand("realgoal", {
        description: "Inspect and control Realgoal workflows (/realgoal [status|list|resume|pause|cancel|publish|execute|doctor|...])",
        getArgumentCompletions: (prefix) => {
          const trimmed = prefix.trim().toLowerCase()
          if (trimmed.includes(" ")) return null
          const matches = REALGOAL_SUBCOMMANDS.filter((sub) => sub.startsWith(trimmed))
          return matches.length > 0 ? matches.map((m) => ({ value: m, label: m })) : null
        },
        handler: (args, ctx) => runtime.runCommandEffect(ctx, handleRealgoalAction(args, ctx)),
      })
    }
    commandsRegistered = true
    return runtime.runEventEffect(
      ControllerService.use((c) =>
        c.updateMemory((mem) => ({
          ...mem,
          commandCollisions: collisions,
        })),
      ).pipe(Effect.asVoid),
      undefined,
    )
  })
}
