import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { Deferred, Effect, Option } from "effect"
import {
  AuthorizationRequiredError,
  InvalidTransitionError,
  PersistenceError,
  QuestionConflictError,
  type RealgoalError,
} from "../domain/errors.ts"
import type {
  CompletionScope,
  DecisionRecord,
  Difficulty,
  EvidenceRecord,
  QuestionAnswer,
  TaskWaitCondition,
  TodoReviewSummary,
  WorkerRole,
  WorkItemState,
  WorkflowPhase,
} from "../domain/models.ts"
import {
  advancePhase,
  applyTodoMutation,
  bindTasksAndMaybeWait,
  blockWorkItem,
  checkRevision,
  computeCurrentManifestHash,
  createDurableQuestion,
  findAuthorization,
  finishWorkItem,
  pauseWorkItem,
  registerFinalizedCandidate,
  registerPreviewArtifact,
  resolveQuestionCAS,
  selectNextEligibleTodo,
  type TodoMutationInput,
} from "../domain/reducer.ts"
import {
  extractParentModelSnapshot,
  makeToolInvoker,
  openUrlInSystemBrowser,
  type RealgoalRuntime,
  type RealgoalServices,
  type ToolSuccessEnvelope,
} from "../bridge/pi-wrapper.ts"
import { ControllerService } from "../services/controller-service.ts"
import { atomicWriteTextFile, PersistenceService } from "../services/persistence.ts"
import { sha256Hex } from "../services/path-safety.ts"
import { PreviewService } from "../services/preview-service.ts"
import { RealtasksAdapter } from "../services/realtasks-adapter.ts"
import { WorkerService } from "../services/worker-service.ts"
import { formatDetailedStatusReport } from "../ui/presentation.ts"

export interface RegisterToolsOptions {
  readonly customBrowserLauncher?: (url: string) => Promise<boolean>
  readonly piExecutable?: string
}

const persistBrowserOpenPreference = (
  globalAgentDir: string,
  preference: "always" | "never",
): Effect.Effect<void, never> => {
  const globalCfgPath = path.join(globalAgentDir, "realgoal.json")
  return Effect.tryPromise({
    try: async () => {
      let existing: Record<string, unknown> = {}
      try {
        const raw = await fs.readFile(globalCfgPath, "utf8")
        const parsed = JSON.parse(raw) as unknown
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>
        }
      } catch {
        existing = {}
      }
      const prevBrowser =
        typeof existing["browser"] === "object" && existing["browser"] !== null
          ? (existing["browser"] as Record<string, unknown>)
          : {}
      const updated = {
        ...existing,
        browser: {
          ...prevBrowser,
          open: preference,
        },
      }
      await fs.mkdir(path.dirname(globalCfgPath), { recursive: true })
      await fs.writeFile(globalCfgPath, JSON.stringify(updated, null, 2) + "\n", "utf8")
    },
    catch: () => undefined,
  }).pipe(Effect.ignore)
}

const buildPreviewBindingEffect = (
  workItemId: string,
  safeDirName: string,
  draftPreviewsRoot: string,
  externalAssetsAllowed: boolean,
): Effect.Effect<
  Parameters<PreviewService["Service"]["ensureServerAndCreateLaunchUrl"]>[0]["binding"],
  never,
  RealgoalServices
> =>
  Effect.Do.pipe(
    Effect.bind("controller", () => ControllerService.useSync((s) => s)),
    Effect.bind("previewSvc", () => PreviewService.useSync((s) => s)),
    Effect.map(({ controller, previewSvc }) => ({
      workItemId,
      safeDirName,
      draftPrevewsRoot: draftPreviewsRoot,
      externalAssetsAllowed,
      getStateSnapshot: () =>
        controller
          .requireWorkItem(Option.some(workItemId))
          .pipe(
            Effect.map((loaded) => Option.some(loaded.state)),
            Effect.orElseSucceed(() => Option.none()),
          ),
      onBrowserSubmit: (submitParams) =>
        controller.requireWorkItem(Option.some(submitParams.workItemId)).pipe(
          Effect.flatMap((loaded) =>
            resolveQuestionCAS(loaded.state, {
              questionId: submitParams.questionId,
              expectedQuestionRevision: submitParams.expectedQuestionRevision,
              answer: submitParams.answer,
              nowIso: new Date().toISOString(),
            }).pipe(
              Effect.flatMap((nextState) =>
                controller
                  .saveUpdatedState(loaded.state, nextState)
                  .pipe(Effect.as(nextState)),
              ),
            ),
          ),
        ),
    })),
  )

export const registerRealgoalTools = (
  pi: ExtensionAPI,
  runtime: RealgoalRuntime,
  opts: RegisterToolsOptions = {},
): void => {
  // ---------------------------------------------------------------------------
  // 1. realgoal_control
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "realgoal_control",
    label: "Realgoal Control",
    description:
      "Inspect or mutate the active Realgoal work item: status, checkpoint, advance phase, wait on realtasks, reconcile background tasks/workers, block, pause, finalize candidate spec/plan, publish user-authorized artifacts, or cleanup authorized tasks.",
    promptSnippet:
      "Inspect or advance active Realgoal (/goal or /plan) phase, checkpoint findings, wait on tasks, or finalize finalized.md",
    promptGuidelines: [
      "Only call realgoal_* tools when [Realgoal Active Work Item] is present in context; follow its Legal Next Phases and Phase Contract.",
      "Never read Realgoal extension source files to learn workflow rules — read the realgoal skill only when unsure about previews, delegation, or rejected transitions.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("checkpoint"),
        Type.Literal("advance"),
        Type.Literal("wait"),
        Type.Literal("reconcile"),
        Type.Literal("block"),
        Type.Literal("pause"),
        Type.Literal("finalize"),
        Type.Literal("publish"),
        Type.Literal("cleanup"),
      ]),
      workItemId: Type.Optional(Type.String()),
      expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      operationId: Type.Optional(Type.String()),
      targetPhase: Type.Optional(
        Type.Union(
          [
            Type.Literal("explore"),
            Type.Literal("analyze"),
            Type.Literal("process"),
            Type.Literal("verify"),
            Type.Literal("discovery"),
            Type.Literal("design"),
            Type.Literal("analysis"),
            Type.Literal("finalization"),
            Type.Literal("draft_review"),
            Type.Literal("publication_choice"),
            Type.Literal("publication"),
            Type.Literal("execution_choice"),
            Type.Literal("lookup"),
            Type.Literal("implement"),
            Type.Literal("verify_item"),
            Type.Literal("verify_goal"),
          ],
          {
            description:
              "Target phase for action='advance' (check Legal Next Phases in active context; /goal: explore|analyze|process|verify; /plan: discovery|design|analysis|finalization|draft_review|publication_choice|publication|execution_choice|lookup|implement|verify_item|verify_goal)",
          },
        ),
      ),
      reason: Type.Optional(Type.String()),
      nextAction: Type.Optional(Type.String()),
      researchNotes: Type.Optional(Type.String()),
      decisions: Type.Optional(
        Type.Array(
          Type.Object({
            category: Type.Optional(
              Type.Union([
                Type.Literal("observed_fact"),
                Type.Literal("user_decision"),
                Type.Literal("design_proposal"),
                Type.Literal("delegated_decision"),
                Type.Literal("unverified_assumption"),
              ]),
            ),
            summary: Type.String(),
            rationale: Type.String(),
            rejectedAlternatives: Type.Optional(Type.Array(Type.String())),
            sourceReferences: Type.Optional(Type.Array(Type.String())),
            material: Type.Optional(Type.Boolean()),
          }),
        ),
      ),
      trackedFiles: Type.Optional(Type.Array(Type.String())),
      waitMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("any")])),
      waitRequests: Type.Optional(
        Type.Array(
          Type.Object({
            taskId: Type.String(),
            todoId: Type.Optional(Type.String()),
            purpose: Type.String(),
            ownership: Type.Optional(Type.Union([Type.Literal("owned"), Type.Literal("attached")])),
            waitCondition: Type.Optional(
              Type.Union([
                Type.Literal("terminal"),
                Type.Literal("ready"),
                Type.Literal("monitor_event"),
              ]),
            ),
            requireSuccess: Type.Optional(Type.Boolean()),
          }),
        ),
      ),
      publishTarget: Type.Optional(Type.Union([Type.Literal("spec"), Type.Literal("plan")])),
      customFileName: Type.Optional(Type.String()),
      allowOverwrite: Type.Optional(Type.Boolean()),
      authorizationId: Type.Optional(Type.String()),
      cleanupTaskIds: Type.Optional(Type.Array(Type.String())),
    }),
    execute: (toolCallId, params, signal, _onUpdate, ctx) => {
      const nowIso = new Date().toISOString()
      const opId = params.operationId ?? `op_ctrl_${toolCallId}`
      const workItemIdOpt = Option.fromUndefinedOr(params.workItemId)

      return runtime.runToolEffect(
        ctx,
        signal,
        Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("persistence", () => PersistenceService.useSync((s) => s)),
          Effect.bind("realtasks", () => RealtasksAdapter.useSync((s) => s)),
          Effect.tap(({ controller }) => controller.assertNotChildWorker(`realgoal_control:${params.action}`)),
          Effect.bind("loaded", ({ controller }) => controller.requireWorkItem(workItemIdOpt)),
          Effect.bind("mem", ({ controller }) => controller.getMemory()),
          Effect.bind("effCfg", ({ controller, loaded }) =>
            controller.getEffectiveConfig(Option.some(loaded.state)),
          ),
          Effect.flatMap(({ controller, persistence, realtasks, loaded, mem, effCfg }): Effect.Effect<
            ToolSuccessEnvelope,
            RealgoalError,
            RealgoalServices
          > => {
            const state = loaded.state

            switch (params.action) {
              case "status": {
                const report = formatDetailedStatusReport(state, loaded.paths.draftDir)
                return Effect.succeed({
                  summary: report,
                  details: {
                    workItemId: state.id,
                    revision: state.revision,
                    kind: state.kind,
                    phase: state.phase,
                    runStatus: state.runStatus,
                    draftDir: loaded.paths.draftDir,
                    todosDone: state.todos.filter((t) => t.status === "done").length,
                    todosTotal: state.todos.length,
                  },
                })
              }

              case "checkpoint": {
                const expectedRev = params.expectedRevision ?? state.revision
                return checkRevision(state, expectedRev, opId).pipe(
                  Effect.flatMap(({ alreadyApplied }): Effect.Effect<ToolSuccessEnvelope, RealgoalError> => {
                    if (alreadyApplied) {
                      return Effect.succeed({
                        summary: `Checkpoint ${opId} already applied at revision ${state.revision}.`,
                        details: { workItemId: state.id, revision: state.revision, idempotent: true },
                      })
                    }

                    const newDecisions: ReadonlyArray<DecisionRecord> = (params.decisions ?? []).map(
                      (d, idx) => ({
                        id: `D${String(state.decisions.length + idx + 1).padStart(3, "0")}`,
                        category: d.category ?? "design_proposal",
                        summary: d.summary,
                        rationale: d.rationale,
                        rejectedAlternatives: d.rejectedAlternatives ?? [],
                        sourceReferences: d.sourceReferences ?? [],
                        questionId: Option.none(),
                        material: d.material ?? true,
                        timestamp: nowIso,
                      }),
                    )

                    const appendResearchEff =
                      params.researchNotes && params.researchNotes.trim().length > 0
                        ? Effect.tryPromise({
                            try: () => fs.readFile(loaded.paths.researchPath, "utf8").catch(() => ""),
                            catch: () => "",
                          }).pipe(
                            Effect.orElseSucceed(() => ""),
                            Effect.flatMap((prev) =>
                              atomicWriteTextFile(
                                loaded.paths.researchPath,
                                `${prev.trimEnd()}\n\n### Checkpoint (${nowIso})\n${params.researchNotes}\n`,
                              ),
                            ),
                          )
                        : Effect.void

                    const appendDecisionsEff =
                      newDecisions.length > 0
                        ? Effect.tryPromise({
                            try: () => fs.readFile(loaded.paths.decisionsPath, "utf8").catch(() => ""),
                            catch: () => "",
                          }).pipe(
                            Effect.orElseSucceed(() => ""),
                            Effect.flatMap((prev) => {
                              const lines = newDecisions.map(
                                (d) =>
                                  `### ${d.id} [${d.category}] — ${d.summary}\n- Rationale: ${d.rationale}\n- Timestamp: ${d.timestamp}\n`,
                              )
                              return atomicWriteTextFile(
                                loaded.paths.decisionsPath,
                                `${prev.trimEnd()}\n\n${lines.join("\n")}`,
                              )
                            }),
                          )
                        : Effect.void

                    return appendResearchEff.pipe(
                      Effect.flatMap(() => appendDecisionsEff),
                      Effect.flatMap(() =>
                        controller.refreshTrackedFileHashes(state, params.trackedFiles ?? []),
                      ),
                      Effect.flatMap((hashedState) => {
                        const updated: WorkItemState = {
                          ...hashedState,
                          revision: hashedState.revision + 1,
                          updatedAt: nowIso,
                          operationIds: [...hashedState.operationIds.slice(-255), opId],
                          decisions: [...hashedState.decisions, ...newDecisions],
                          nextAction: params.nextAction ?? hashedState.nextAction,
                          progress: {
                            ...hashedState.progress,
                            noProgressContinuations: 0,
                            repeatedFailureCount: 0,
                            lastFailureFingerprint: Option.none(),
                            lastMeaningfulProgressAt: nowIso,
                            lastProgressKind: "checkpoint",
                          },
                        }
                        return controller.saveUpdatedState(state, updated).pipe(
                          Effect.map(() => ({
                            summary: `Recorded checkpoint at revision ${updated.revision}.`,
                            details: {
                              workItemId: updated.id,
                              revision: updated.revision,
                              decisionsRecorded: newDecisions.length,
                            },
                          })),
                        )
                      }),
                    )
                  }),
                )
              }

              case "advance": {
                const expectedRev = params.expectedRevision ?? state.revision
                const targetPhase = (params.targetPhase ?? state.phase) as WorkflowPhase
                return advancePhase(state, {
                  expectedRevision: expectedRev,
                  operationId: opId,
                  targetPhase,
                  reason: params.reason ?? `Advance phase ${state.phase} -> ${targetPhase}`,
                  nextAction: params.nextAction ?? `Proceed with ${targetPhase}`,
                  origin: "agent_tool",
                  draftGateEnabled: effCfg.config.verification.draftGate.enabled,
                  nowIso,
                }).pipe(
                  Effect.flatMap((nextState) =>
                    controller.saveUpdatedState(state, nextState).pipe(
                      Effect.map(() => ({
                        summary: `Advanced ${state.id} to phase '${nextState.phase}' (status: ${nextState.runStatus}, rev: ${nextState.revision}).`,
                        details: {
                          workItemId: nextState.id,
                          revision: nextState.revision,
                          phase: nextState.phase,
                          runStatus: nextState.runStatus,
                        },
                      })),
                    ),
                  ),
                )
              }

              case "wait": {
                const expectedRev = params.expectedRevision ?? state.revision
                return checkRevision(state, expectedRev, opId).pipe(
                  Effect.flatMap(({ alreadyApplied }): Effect.Effect<ToolSuccessEnvelope, RealgoalError> => {
                    if (alreadyApplied) {
                      return Effect.succeed({
                        summary: `Wait ${opId} already recorded at revision ${state.revision}.`,
                        details: {
                          workItemId: state.id,
                          revision: state.revision,
                          runStatus: state.runStatus,
                        },
                        terminate: state.runStatus === "waiting_task",
                      })
                    }
                    const requests = (params.waitRequests ?? []).map((r) => {
                      const cond: TaskWaitCondition =
                        r.waitCondition === "ready"
                          ? { kind: "ready", eventPattern: Option.none() }
                          : r.waitCondition === "monitor_event"
                            ? { kind: "monitor_event", eventPattern: Option.none() }
                            : { kind: "terminal", eventPattern: Option.none() }
                      return {
                        taskId: r.taskId,
                        todoId: Option.fromUndefinedOr(r.todoId),
                        purpose: r.purpose,
                        ownership: r.ownership ?? ("owned" as const),
                        waitCondition: cond,
                        requireSuccess: r.requireSuccess ?? true,
                      }
                    })
                    if (requests.length === 0) {
                      return Effect.fail(
                        new InvalidTransitionError({
                          workItemId: state.id,
                          fromPhase: state.phase,
                          toPhase: state.phase,
                          fromStatus: state.runStatus,
                          toStatus: "waiting_task",
                          reason: "waitRequests must contain at least one background task ID",
                          missingConditions: ["Provide waitRequests with valid realtasks taskId(s)"],
                        }),
                      )
                    }
                    return realtasks
                      .reconcileAndEnterWait({
                        invoker: makeToolInvoker(ctx),
                        state,
                        currentSessionId: mem.sessionId,
                        requests,
                        mode: params.waitMode ?? "all",
                        resumePhase: (params.targetPhase as WorkflowPhase | undefined) ?? state.phase,
                        nowIso,
                        signal,
                      })
                      .pipe(
                        Effect.flatMap((nextState) =>
                          controller.saveUpdatedState(state, nextState).pipe(
                            Effect.map(() => ({
                              summary:
                                nextState.runStatus === "waiting_task"
                                  ? `Entered waiting_task (${params.waitMode ?? "all"}) for [${requests.map((r) => r.taskId).join(", ")}]. Turn will settle cleanly until realtasks delivers completion.`
                                  : `Inspected [${requests.map((r) => r.taskId).join(", ")}] via peek; wait already satisfied or failed immediately (runStatus=${nextState.runStatus}).`,
                              details: {
                                workItemId: nextState.id,
                                revision: nextState.revision,
                                runStatus: nextState.runStatus,
                                trackedTasks: nextState.trackedTasks.map((t) => ({
                                  taskId: t.taskId,
                                  status: t.lastStatus,
                                })),
                              },
                              terminate: nextState.runStatus === "waiting_task",
                            })),
                          ),
                        ),
                      )
                  }),
                )
              }

              case "reconcile": {
                return realtasks
                  .reconcileTrackedTasksOnce({
                    invoker: makeToolInvoker(ctx),
                    state,
                    currentSessionId: mem.sessionId,
                    nowIso,
                    signal,
                  })
                  .pipe(
                    Effect.flatMap((afterTasks) =>
                      controller.reconcileFinishedWorkerJobs({
                        state: afterTasks,
                        nowIso,
                      }),
                    ),
                    Effect.flatMap((afterWorkers) =>
                      controller.saveUpdatedState(state, afterWorkers).pipe(
                        Effect.map(() => ({
                          summary: `Reconciled ${afterWorkers.trackedTasks.length} tracked task(s) and ${afterWorkers.workers.length} worker(s). Phase=${afterWorkers.phase}, status=${afterWorkers.runStatus}, rev=${afterWorkers.revision}.`,
                          details: {
                            workItemId: afterWorkers.id,
                            revision: afterWorkers.revision,
                            phase: afterWorkers.phase,
                            runStatus: afterWorkers.runStatus,
                            trackedTasks: afterWorkers.trackedTasks.map((t) => ({
                              taskId: t.taskId,
                              lastStatus: t.lastStatus,
                            })),
                            workers: afterWorkers.workers.map((w) => ({
                              jobId: w.jobId,
                              role: w.role,
                              status: w.status,
                              summary: Option.getOrUndefined(w.summary),
                            })),
                          },
                        })),
                      ),
                    ),
                  )
              }

              case "block": {
                const reason = params.reason ?? "Blocked by agent tool"
                const nextState = blockWorkItem(state, reason, "agent_tool", nowIso)
                return controller.saveUpdatedState(state, nextState).pipe(
                  Effect.map(() => ({
                    summary: `Marked ${state.id} as blocked: ${reason}`,
                    details: {
                      workItemId: nextState.id,
                      revision: nextState.revision,
                      runStatus: nextState.runStatus,
                    },
                    terminate: true,
                  })),
                )
              }

              case "pause": {
                const reason = params.reason ?? "Paused by agent tool"
                const nextState = pauseWorkItem(state, reason, "agent_tool", nowIso)
                return controller.saveUpdatedState(state, nextState).pipe(
                  Effect.map(() => ({
                    summary: `Paused ${state.id}: ${reason}`,
                    details: {
                      workItemId: nextState.id,
                      revision: nextState.revision,
                      runStatus: nextState.runStatus,
                    },
                    terminate: true,
                  })),
                )
              }

              case "finalize": {
                const expectedRev = params.expectedRevision ?? state.revision
                const finalizedPath = path.join(loaded.paths.draftDir, "finalized.md")
                return Effect.tryPromise({
                  try: () => fs.readFile(finalizedPath, "utf8"),
                  catch: (err) =>
                    new PersistenceError({
                      operation: "readFinalized",
                      path: finalizedPath,
                      message: `Cannot finalize: ${finalizedPath} could not be read (${(err as Error).message}). Write finalized.md in the draft folder first.`,
                      corrupted: false,
                    }),
                }).pipe(
                  Effect.flatMap((content): Effect.Effect<ToolSuccessEnvelope, RealgoalError> => {
                    if (content.trim().length === 0) {
                      return Effect.fail(
                        new InvalidTransitionError({
                          workItemId: state.id,
                          fromPhase: state.phase,
                          toPhase: "finalization",
                          fromStatus: state.runStatus,
                          toStatus: state.runStatus,
                          reason: "finalized.md is empty",
                          missingConditions: ["Write complete candidate specification/plan to finalized.md"],
                        }),
                      )
                    }
                    const finHash = sha256Hex(content)
                    return controller.refreshTrackedFileHashes(state, [finalizedPath]).pipe(
                      Effect.flatMap((withHashes) =>
                        registerFinalizedCandidate(withHashes, {
                          expectedRevision: expectedRev,
                          operationId: opId,
                          finalizedHash: finHash,
                          draftGateEnabled: effCfg.config.verification.draftGate.enabled,
                          nowIso,
                        }),
                      ),
                      Effect.flatMap((nextState) =>
                        controller.saveUpdatedState(state, nextState).pipe(
                          Effect.map(() => ({
                            summary: `Finalized candidate registered (sha256=${finHash.slice(0, 12)}…). Next phase: ${nextState.phase}, status: ${nextState.runStatus}, rev: ${nextState.revision}.`,
                            details: {
                              workItemId: nextState.id,
                              revision: nextState.revision,
                              phase: nextState.phase,
                              runStatus: nextState.runStatus,
                              finalizedHash: finHash,
                              manifestHash: computeCurrentManifestHash(nextState, finHash),
                            },
                            terminate: nextState.runStatus === "awaiting_user",
                          })),
                        ),
                      ),
                    )
                  }),
                )
              }

              case "publish": {
                const target = params.publishTarget
                if (!target) {
                  return Effect.fail(
                    new InvalidTransitionError({
                      workItemId: state.id,
                      fromPhase: state.phase,
                      toPhase: "publication",
                      fromStatus: state.runStatus,
                      toStatus: state.runStatus,
                      reason: "publishTarget ('spec' | 'plan') is required",
                      missingConditions: ["Specify publishTarget: 'spec' or 'plan'"],
                    }),
                  )
                }
                const matchingAuthOpt = params.authorizationId
                  ? Option.fromUndefinedOr(
                      state.authorizations.find((a) => a.id === params.authorizationId),
                    )
                  : Option.orElse(
                      findAuthorization(state, target === "spec" ? "publish_spec" : "publish_plan"),
                      () => findAuthorization(state, "publish_both"),
                    )

                return Option.match(matchingAuthOpt, {
                  onNone: (): Effect.Effect<ToolSuccessEnvelope, RealgoalError> =>
                    Effect.fail(
                      new AuthorizationRequiredError({
                        workItemId: state.id,
                        decisionKind: target === "spec" ? "publish_spec" : "publish_plan",
                        message: `Publishing ${target} requires explicit user authorization via /realgoal publish.`,
                      }),
                    ),
                  onSome: (auth): Effect.Effect<ToolSuccessEnvelope, RealgoalError> => {
                    const finalizedPath = path.join(loaded.paths.draftDir, "finalized.md")
                    const destDir =
                      target === "spec"
                        ? effCfg.config.publication.specDirectory
                        : effCfg.config.publication.planDirectory
                    return Effect.tryPromise({
                      try: () => fs.readFile(finalizedPath, "utf8"),
                      catch: (err) =>
                        new PersistenceError({
                          operation: "readFinalizedForPublish",
                          path: finalizedPath,
                          message: `Failed reading ${finalizedPath}: ${(err as Error).message}`,
                          corrupted: false,
                        }),
                    }).pipe(
                      Effect.flatMap((markdown) =>
                        persistence.publishMarkdownArtifact({
                          workspaceCwd: mem.workspaceCwd,
                          configDirName: mem.configDirName,
                          state,
                          callerOwner: controller.makeOwnerToken(mem),
                          target,
                          destinationDir: destDir,
                          customFileName: params.customFileName,
                          content: markdown,
                          authorizationId: auth.id,
                          allowOverwrite: Boolean(params.allowOverwrite),
                          draftGateEnabled: effCfg.config.verification.draftGate.enabled,
                          nowIso,
                        }),
                      ),
                      Effect.map(({ state: nextState, writtenPath }) => ({
                        summary: `Published ${target} artifact to ${writtenPath} (rev ${nextState.revision}).`,
                        details: {
                          workItemId: nextState.id,
                          revision: nextState.revision,
                          target,
                          destinationPath: writtenPath,
                        },
                      })),
                    )
                  },
                })
              }

              case "cleanup": {
                const taskIds = params.cleanupTaskIds ?? []
                const authId = params.authorizationId
                if (!authId) {
                  return Effect.fail(
                    new AuthorizationRequiredError({
                      workItemId: state.id,
                      decisionKind: "cleanup_tasks",
                      message: "Stopping tracked background tasks requires a recorded cleanup_tasks user authorizationId.",
                    }),
                  )
                }
                return realtasks
                  .stopAuthorizedTasks({
                    invoker: makeToolInvoker(ctx),
                    state,
                    taskIds,
                    authorizationId: authId,
                    signal,
                  })
                  .pipe(
                    Effect.flatMap((outcomes) => {
                      const stoppedIds = new Set(outcomes.filter((o) => o.stopped).map((o) => o.taskId))
                      const updatedTasks = state.trackedTasks.map((t) =>
                        stoppedIds.has(t.taskId)
                          ? { ...t, lastStatus: "stopped" as const, lastObservedAt: nowIso }
                          : t,
                      )
                      const nextState: WorkItemState = {
                        ...state,
                        revision: state.revision + 1,
                        updatedAt: nowIso,
                        trackedTasks: updatedTasks,
                      }
                      return controller.saveUpdatedState(state, nextState).pipe(
                        Effect.map(() => ({
                          summary: `Stopped ${stoppedIds.size}/${outcomes.length} user-authorized tracked task(s).`,
                          details: {
                            workItemId: nextState.id,
                            revision: nextState.revision,
                            outcomes,
                          },
                        })),
                      )
                    }),
                  )
              }
            }
          }),
        ),
      )
    },
  })

  // ---------------------------------------------------------------------------
  // 2. realgoal_todo
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "realgoal_todo",
    label: "Realgoal TODO",
    description:
      "Inspect and mutate durable Realgoal TODO items: list, append, update, reorder, split, start, submit_for_verification, record_evidence, complete, block, reopen, or skip.",
    promptSnippet:
      "Manage Realgoal TODOs (start -> submit_for_verification -> record_evidence -> complete)",
    executionMode: "sequential",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("append"),
        Type.Literal("update"),
        Type.Literal("reorder"),
        Type.Literal("split"),
        Type.Literal("start"),
        Type.Literal("submit_for_verification"),
        Type.Literal("record_evidence"),
        Type.Literal("complete"),
        Type.Literal("block"),
        Type.Literal("reopen"),
        Type.Literal("skip"),
      ]),
      workItemId: Type.Optional(Type.String()),
      expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      operationId: Type.Optional(Type.String()),
      todoId: Type.Optional(
        Type.String({ description: "TODO ID such as 'T001' (/goal starts with implicit T001)" }),
      ),
      items: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String(),
            description: Type.String(),
            stage: Type.Optional(Type.String()),
            dependencyIds: Type.Optional(Type.Array(Type.String())),
            goal: Type.Optional(Type.String()),
            inScope: Type.Optional(Type.Array(Type.String())),
            outOfScope: Type.Optional(Type.Array(Type.String())),
            acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
            difficulty: Type.Optional(
              Type.Union([Type.Literal("light"), Type.Literal("medium"), Type.Literal("heavy")]),
            ),
            difficultyRationale: Type.Optional(Type.String()),
          }),
        ),
      ),
      orderedIds: Type.Optional(Type.Array(Type.String())),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      difficulty: Type.Optional(
        Type.Union([Type.Literal("light"), Type.Literal("medium"), Type.Literal("heavy")]),
      ),
      difficultyRationale: Type.Optional(Type.String()),
      dependencyIds: Type.Optional(Type.Array(Type.String())),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
      implementationSummary: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
      authorizationId: Type.Optional(Type.String()),
      deferCriterionIds: Type.Optional(Type.Array(Type.String())),
      evidence: Type.Optional(
        Type.Object({
          id: Type.Optional(Type.String()),
          criterionIds: Type.Array(Type.String(), {
            description: "Acceptance criterion IDs verified, e.g. ['C001']",
          }),
          todoIds: Type.Optional(Type.Array(Type.String())),
          method: Type.Union([
            Type.Literal("executable_test"),
            Type.Literal("static_review"),
            Type.Literal("manual_inspection"),
            Type.Literal("user_confirmation"),
            Type.Literal("user_waiver"),
          ]),
          result: Type.Union([
            Type.Literal("pass"),
            Type.Literal("fail"),
            Type.Literal("not_run"),
            Type.Literal("blocked"),
            Type.Literal("waived"),
          ]),
          commandOrObservation: Type.String(),
          exitCode: Type.Optional(Type.Number()),
          outputSnippet: Type.Optional(Type.String()),
          artifactPaths: Type.Optional(Type.Array(Type.String())),
          waiverAuthorizationId: Type.Optional(Type.String()),
        }),
      ),
      evidenceIds: Type.Optional(Type.Array(Type.String())),
      reviewSummary: Type.Optional(
        Type.Object({
          reviewerActor: Type.Union([Type.Literal("direct"), Type.Literal("subagent")]),
          verdict: Type.Union([
            Type.Literal("pass"),
            Type.Literal("changes_required"),
            Type.Literal("blocked"),
          ]),
          summary: Type.String(),
          workerJobId: Type.Optional(Type.String()),
        }),
      ),
    }),
    execute: (toolCallId, params, signal, _onUpdate, ctx) => {
      const nowIso = new Date().toISOString()
      const opId = params.operationId ?? `op_todo_${toolCallId}`
      const workItemIdOpt = Option.fromUndefinedOr(params.workItemId)

      return runtime.runToolEffect(
        ctx,
        signal,
        Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.tap(({ controller }) => controller.assertNotChildWorker(`realgoal_todo:${params.action}`)),
          Effect.bind("loaded", ({ controller }) => controller.requireWorkItem(workItemIdOpt)),
          Effect.flatMap(({ controller, loaded }): Effect.Effect<ToolSuccessEnvelope, RealgoalError> => {
            const state = loaded.state

            if (params.action === "list") {
              const nextOpt = selectNextEligibleTodo(state.todos)
              const lines = state.todos.map(
                (t) => `${t.id} [${t.status}] (${t.difficulty}, deps:[${t.dependencyIds.join(",")}]) — ${t.title}`,
              )
              return Effect.succeed({
                summary:
                  lines.length > 0
                    ? `TODOs (rev ${state.revision}):\n${lines.join("\n")}`
                    : `No TODOs recorded yet (rev ${state.revision}).`,
                details: {
                  workItemId: state.id,
                  revision: state.revision,
                  todos: state.todos.map((t) => ({
                    id: t.id,
                    title: t.title,
                    status: t.status,
                    difficulty: t.difficulty,
                    dependencyIds: t.dependencyIds,
                  })),
                  nextEligibleTodoId: Option.map(nextOpt, (t) => t.id).pipe(Option.getOrUndefined),
                },
              })
            }

            const expectedRev = params.expectedRevision ?? state.revision
            const artifactFiles = params.evidence?.artifactPaths ?? []

            return controller.refreshTrackedFileHashes(state, artifactFiles).pipe(
              Effect.flatMap((stateWithHashes): Effect.Effect<WorkItemState, RealgoalError> => {
                const mutReason = params.reason ?? `realgoal_todo:${params.action}`
                const buildMutation = (): TodoMutationInput => {
                  switch (params.action) {
                    case "append":
                      return { action: "append", items: params.items ?? [], reason: mutReason }
                    case "update":
                      return {
                        action: "update",
                        todoId: params.todoId ?? "",
                        title: params.title,
                        description: params.description,
                        difficulty: params.difficulty,
                        difficultyRationale: params.difficultyRationale,
                        dependencyIds: params.dependencyIds,
                        acceptanceCriteria: params.acceptanceCriteria,
                        reason: mutReason,
                      }
                    case "reorder":
                      return { action: "reorder", orderedIds: params.orderedIds ?? [], reason: mutReason }
                    case "split":
                      return {
                        action: "split",
                        todoId: params.todoId ?? "",
                        parts: (params.items ?? []).map((i) => ({
                          title: i.title,
                          description: i.description,
                          difficulty: i.difficulty,
                        })),
                        reason: mutReason,
                      }
                    case "start":
                      return { action: "start", todoId: params.todoId ?? "" }
                    case "submit_for_verification":
                      return {
                        action: "submit_for_verification",
                        todoId: params.todoId ?? "",
                        implementationSummary: params.implementationSummary ?? "Submitted for verification",
                        actor: "agent",
                      }
                    case "record_evidence": {
                      const evIn = params.evidence
                      const evId =
                        evIn?.id ?? `EV${String(stateWithHashes.evidence.length + 1).padStart(3, "0")}`
                      const evRecord: EvidenceRecord = {
                        id: evId,
                        criterionIds: evIn?.criterionIds ?? [],
                        todoIds: evIn?.todoIds ?? (params.todoId ? [params.todoId] : []),
                        method: evIn?.method ?? "executable_test",
                        result: evIn?.result ?? "not_run",
                        commandOrObservation: evIn?.commandOrObservation ?? "",
                        exitCode: Option.fromUndefinedOr(evIn?.exitCode),
                        outputSnippet: Option.fromUndefinedOr(evIn?.outputSnippet),
                        timestamp: nowIso,
                        artifactPaths: evIn?.artifactPaths ?? [],
                        reviewedHashes: stateWithHashes.artifactHashes,
                        waiverAuthorizationId: Option.fromUndefinedOr(evIn?.waiverAuthorizationId),
                      }
                      return { action: "record_evidence", evidence: evRecord }
                    }
                    case "complete": {
                      const revSummary: TodoReviewSummary | undefined = params.reviewSummary
                        ? {
                            reviewerActor: params.reviewSummary.reviewerActor,
                            verdict: params.reviewSummary.verdict,
                            summary: params.reviewSummary.summary,
                            workerJobId: Option.fromUndefinedOr(params.reviewSummary.workerJobId),
                            reviewedHashes: stateWithHashes.artifactHashes,
                            timestamp: nowIso,
                          }
                        : undefined
                      return {
                        action: "complete",
                        todoId: params.todoId ?? "",
                        evidenceIds: params.evidenceIds ?? [],
                        reviewSummary: revSummary,
                      }
                    }
                    case "block":
                      return {
                        action: "block",
                        todoId: params.todoId ?? "",
                        reason: params.reason ?? "Blocked",
                      }
                    case "reopen":
                      return {
                        action: "reopen",
                        todoId: params.todoId ?? "",
                        reason: params.reason ?? "Reopened for rework",
                      }
                    case "skip":
                    default:
                      return {
                        action: "skip",
                        todoId: params.todoId ?? "",
                        reason: params.reason ?? "Skipped per user authorization",
                        authorizationId: params.authorizationId ?? "",
                        deferCriterionIds: params.deferCriterionIds,
                      }
                  }
                }

                return applyTodoMutation(stateWithHashes, expectedRev, opId, buildMutation(), nowIso)
              }),
              Effect.flatMap((nextState) =>
                controller.saveUpdatedState(state, nextState).pipe(
                  Effect.map(() => {
                    const done = nextState.todos.filter((t) => t.status === "done").length
                    const nextTodo = selectNextEligibleTodo(nextState.todos)
                    return {
                      summary: `Applied realgoal_todo(${params.action}) -> rev ${nextState.revision} (${done}/${nextState.todos.length} done).`,
                      details: {
                        workItemId: nextState.id,
                        revision: nextState.revision,
                        todosDone: done,
                        todosTotal: nextState.todos.length,
                        nextEligibleTodoId: Option.map(nextTodo, (t) => t.id).pipe(Option.getOrUndefined),
                      },
                    }
                  }),
                ),
              ),
            )
          }),
        ),
      )
    },
  })

  // ---------------------------------------------------------------------------
  // 3. realgoal_preview
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "realgoal_preview",
    label: "Realgoal Preview",
    description:
      "Validate and register static HTML/SVG visual mockup options inside <draft>/previews/<previewId>/ for local loopback browser comparison.",
    promptSnippet:
      "Register static .html/.svg mockup options under <draft>/previews/<previewId>/ before realgoal_question",
    executionMode: "sequential",
    parameters: Type.Object({
      previewId: Type.String(),
      title: Type.String(),
      questionId: Type.Optional(Type.String()),
      workItemId: Type.Optional(Type.String()),
      iconSetLicenseNote: Type.Optional(Type.String()),
      options: Type.Array(
        Type.Object({
          id: Type.String(),
          title: Type.String(),
          description: Type.String(),
          rationale: Type.String(),
          relativePath: Type.String({
            description:
              "Static .html or .svg path relative to <draft>/previews/<previewId>/ (no <script> or inline on*= handlers)",
          }),
        }),
        { minItems: 1 },
      ),
    }),
    execute: (_toolCallId, params, signal, _onUpdate, ctx) => {
      const nowIso = new Date().toISOString()
      return runtime.runToolEffect(
        ctx,
        signal,
        Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("previewSvc", () => PreviewService.useSync((s) => s)),
          Effect.tap(({ controller }) => controller.assertNotChildWorker("realgoal_preview")),
          Effect.bind("loaded", ({ controller }) =>
            controller.requireWorkItem(Option.fromUndefinedOr(params.workItemId)),
          ),
          Effect.bind("effCfg", ({ controller, loaded }) =>
            controller.getEffectiveConfig(Option.some(loaded.state)),
          ),
          Effect.bind("artifact", ({ previewSvc, loaded, effCfg }) => {
            const existing = loaded.state.previews.find((p) => p.id === params.previewId)
            const nextRev = existing ? existing.revision + 1 : 1
            return previewSvc.validateAndRegisterPreview({
              draftDir: loaded.paths.draftDir,
              previewId: params.previewId,
              revision: nextRev,
              title: params.title,
              questionId: Option.fromUndefinedOr(params.questionId),
              options: params.options,
              externalAssetsAllowed: effCfg.config.browser.externalAssets,
              iconSetLicenseNote: Option.fromUndefinedOr(params.iconSetLicenseNote),
              nowIso,
            })
          }),
          Effect.flatMap(({ controller, loaded, artifact }) => {
            const nextState = registerPreviewArtifact(loaded.state, artifact, nowIso)
            return controller.saveUpdatedState(loaded.state, nextState).pipe(
              Effect.map(() => ({
                summary: `Validated and registered preview '${artifact.id}' (rev ${artifact.revision}, ${artifact.options.length} option(s)).`,
                details: {
                  workItemId: nextState.id,
                  revision: nextState.revision,
                  previewId: artifact.id,
                  previewRevision: artifact.revision,
                  optionIds: artifact.options.map((o) => o.id),
                },
              })),
            )
          }),
        ),
      )
    },
  })

  // ---------------------------------------------------------------------------
  // 4. realgoal_question
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "realgoal_question",
    label: "Realgoal Question",
    description:
      "Create and present a durable clarification or design question with browser preview + Pi UI fallback and CAS resolution.",
    promptSnippet:
      "Ask a durable clarification/design question during /plan or /goal (optionally linked to realgoal_preview)",
    executionMode: "sequential",
    parameters: Type.Object({
      title: Type.String(),
      prompt: Type.String(),
      purpose: Type.String(),
      blocking: Type.Optional(Type.Boolean()),
      allowFreeText: Type.Optional(Type.Boolean()),
      multiSelect: Type.Optional(Type.Boolean()),
      allowDelegateToAgent: Type.Optional(Type.Boolean()),
      previewId: Type.Optional(
        Type.String({ description: "Optional previewId already registered via realgoal_preview" }),
      ),
      workItemId: Type.Optional(Type.String()),
          options: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String(),
            label: Type.String(),
            description: Type.String(),
            rationale: Type.Optional(Type.String()),
            previewPath: Type.Optional(Type.String()),
            recommended: Type.Optional(Type.Boolean()),
          }),
        ),
      ),
    }),
    execute: (_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) => {
      const nowIso = new Date().toISOString()
      return runtime.runToolEffect(
        ctx,
        signal,
        Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("previewSvc", () => PreviewService.useSync((s) => s)),
          Effect.tap(({ controller }) => controller.assertNotChildWorker("realgoal_question")),
          Effect.bind("loaded", ({ controller }) =>
            controller.requireWorkItem(Option.fromUndefinedOr(params.workItemId)),
          ),
          Effect.bind("mem", ({ controller }) => controller.getMemory()),
          Effect.bind("effCfg", ({ controller, loaded }) =>
            controller.getEffectiveConfig(Option.some(loaded.state)),
          ),
          Effect.bind("created", ({ controller, loaded }) => {
            const qId = `Q${String(loaded.state.questions.length + 1).padStart(3, "0")}`
            const mappedOptions = (params.options ?? []).map((o) => ({
              id: o.id,
              label: o.recommended ? `${o.label} (Recommended)` : o.label,
              description: o.description,
              rationale: Option.fromUndefinedOr(o.rationale),
              previewPath: Option.fromUndefinedOr(o.previewPath),
            }))
            const { state: withQ, question } = createDurableQuestion(loaded.state, {
              questionId: qId,
              title: params.title,
              prompt: params.prompt,
              purpose: params.purpose,
              blocking: params.blocking ?? true,
              allowFreeText: params.allowFreeText ?? true,
              multiSelect: params.multiSelect ?? false,
              options: mappedOptions,
              previewId: Option.fromUndefinedOr(params.previewId),
              nowIso,
            })
            return controller.saveUpdatedState(loaded.state, withQ).pipe(
              Effect.as({ state: withQ, question }),
            )
          }),
          Effect.bind("browserLaunch", ({ previewSvc, loaded, mem, effCfg, created }) => {
            const wantBrowser =
              effCfg.config.browser.enabled &&
              (Option.isSome(created.question.previewId) || effCfg.config.browser.open === "always")
            if (!wantBrowser) {
              return Effect.succeed({
                launchUrlOpt: Option.none<string>(),
                openedBrowser: false,
              })
            }

            return buildPreviewBindingEffect(
              created.state.id,
              created.state.safeDirName,
              loaded.paths.previewsDir,
              effCfg.config.browser.externalAssets,
            ).pipe(
              Effect.flatMap((binding) =>
                previewSvc
                  .ensureServerAndCreateLaunchUrl({
                    host: effCfg.config.browser.host,
                    binding,
                    questionId: created.question.id,
                  })
                  .pipe(
                    Effect.flatMap(({ launchUrl }) => {
                      const openPolicy = effCfg.config.browser.open
                      if (openPolicy === "never" || !ctx.hasUI) {
                        return Effect.succeed({
                          launchUrlOpt: Option.some(launchUrl),
                          openedBrowser: false,
                        })
                      }
                      if (openPolicy === "always") {
                        return openUrlInSystemBrowser(launchUrl, opts.customBrowserLauncher).pipe(
                          Effect.map((opened) => ({
                            launchUrlOpt: Option.some(launchUrl),
                            openedBrowser: opened,
                          })),
                        )
                      }
                      return Effect.tryPromise({
                        try: () =>
                          ctx.ui.select(
                            `Open visual preview for "${created.question.title}" in browser?`,
                            [
                              "Open in browser now",
                              "Always open in browser (save preference)",
                              "Answer in terminal this time",
                              "Never open browser automatically (save preference)",
                            ],
                            signal ? { signal } : undefined,
                          ),
                        catch: () => undefined,
                      }).pipe(
                        Effect.orElseSucceed(() => undefined),
                        Effect.flatMap((choice) => {
                          if (choice === "Always open in browser (save preference)") {
                            return persistBrowserOpenPreference(mem.globalAgentDir, "always").pipe(
                              Effect.flatMap(() =>
                                openUrlInSystemBrowser(launchUrl, opts.customBrowserLauncher),
                              ),
                              Effect.map((opened) => ({
                                launchUrlOpt: Option.some(launchUrl),
                                openedBrowser: opened,
                              })),
                            )
                          }
                          if (choice === "Never open browser automatically (save preference)") {
                            return persistBrowserOpenPreference(mem.globalAgentDir, "never").pipe(
                              Effect.as({
                                launchUrlOpt: Option.some(launchUrl),
                                openedBrowser: false,
                              }),
                            )
                          }
                          if (choice === "Open in browser now") {
                            return openUrlInSystemBrowser(launchUrl, opts.customBrowserLauncher).pipe(
                              Effect.map((opened) => ({
                                launchUrlOpt: Option.some(launchUrl),
                                openedBrowser: opened,
                              })),
                            )
                          }
                          return Effect.succeed({
                            launchUrlOpt: Option.some(launchUrl),
                            openedBrowser: false,
                          })
                        }),
                      )
                    }),
                    Effect.catchTag("PreviewSecurityError", () =>
                      Effect.succeed({
                        launchUrlOpt: Option.none<string>(),
                        openedBrowser: false,
                      }),
                    ),
                  ),
              ),
            )
          }),
          Effect.flatMap(({ controller, previewSvc, created, browserLaunch }): Effect.Effect<
            ToolSuccessEnvelope,
            RealgoalError,
            RealgoalServices
          > => {
            const q = created.question

            if (!ctx.hasUI) {
              return Effect.succeed({
                summary: `Question ${q.id} ("${q.title}") recorded durably in awaiting_user state.${
                  Option.isSome(browserLaunch.launchUrlOpt)
                    ? ` Preview URL: ${browserLaunch.launchUrlOpt.value}`
                    : ""
                } Answer with /realgoal answer ${q.id} <choice>.`,
                details: {
                  workItemId: created.state.id,
                  revision: created.state.revision,
                  questionId: q.id,
                  status: "awaiting_user",
                  launchUrl: Option.getOrUndefined(browserLaunch.launchUrlOpt),
                },
                terminate: q.blocking,
              })
            }

            const uiAbort = new AbortController()
            if (signal) {
              signal.addEventListener("abort", () => uiAbort.abort(), { once: true })
            }

            const terminalPromptEffect: Effect.Effect<Option.Option<QuestionAnswer>, never> = Effect.tryPromise({
              try: async (): Promise<Option.Option<QuestionAnswer>> => {
                const optionRows = q.options.map((o) => `${o.id}: ${o.label} — ${o.description}`)
                const linkedPreviewRev = Option.flatMap(q.previewId, (pid) =>
                  Option.map(
                    Option.fromUndefinedOr(created.state.previews.find((p) => p.id === pid)),
                    (p) => p.revision,
                  ),
                )
                const CUSTOM_LABEL = "Type custom response…"
                const DELEGATE_LABEL = "Let agent choose best option (record rationale)"
                const DEFER_LABEL = "Leave question pending (answer later)"

                if (optionRows.length > 0) {
                  const fullChoices = [
                    ...optionRows,
                    ...(q.allowFreeText ? [CUSTOM_LABEL] : []),
                    ...(params.allowDelegateToAgent !== false ? [DELEGATE_LABEL] : []),
                    DEFER_LABEL,
                  ]
                  const picked = await ctx.ui.select(
                    `${q.id} · ${q.title}: ${q.prompt}`,
                    fullChoices,
                    { signal: uiAbort.signal },
                  )
                  if (picked === undefined || picked === DEFER_LABEL) {
                    return Option.none()
                  }
                  if (picked === DELEGATE_LABEL) {
                    return Option.some<QuestionAnswer>({
                      selectedOptionIds: q.options[0] ? [q.options[0].id] : [],
                      customText: Option.none(),
                      comments: Option.some("User explicitly delegated selection to the agent"),
                      source: "delegated_to_agent",
                      answeredAt: new Date().toISOString(),
                      previewRevision: linkedPreviewRev,
                    })
                  }
                  if (picked === CUSTOM_LABEL) {
                    const typed = await ctx.ui.input(`${q.id} · Custom answer`, q.prompt, {
                      signal: uiAbort.signal,
                    })
                    if (!typed || typed.trim().length === 0) return Option.none()
                    return Option.some<QuestionAnswer>({
                      selectedOptionIds: [],
                      customText: Option.some(typed.trim()),
                      comments: Option.none(),
                      source: "pi_ui",
                      answeredAt: new Date().toISOString(),
                      previewRevision: linkedPreviewRev,
                    })
                  }
                  const matchedIdx = optionRows.indexOf(picked)
                  const matchedOpt = matchedIdx >= 0 ? q.options[matchedIdx] : undefined
                  if (!matchedOpt) return Option.none()
                  return Option.some<QuestionAnswer>({
                    selectedOptionIds: [matchedOpt.id],
                    customText: Option.none(),
                    comments: Option.none(),
                    source: "pi_ui",
                    answeredAt: new Date().toISOString(),
                    previewRevision: linkedPreviewRev,
                  })
                }

                const typed = await ctx.ui.input(`${q.id} · ${q.title}`, q.prompt, {
                  signal: uiAbort.signal,
                })
                if (!typed || typed.trim().length === 0) return Option.none()
                return Option.some<QuestionAnswer>({
                  selectedOptionIds: [],
                  customText: Option.some(typed.trim()),
                  comments: Option.none(),
                  source: "pi_ui",
                  answeredAt: new Date().toISOString(),
                  previewRevision: linkedPreviewRev,
                })
              },
              catch: () => Option.none<QuestionAnswer>(),
            }).pipe(Effect.orElseSucceed(() => Option.none<QuestionAnswer>()))

            const collectAnswerEff: Effect.Effect<
              { readonly via: "browser" | "terminal" | "pending"; readonly answerOpt: Option.Option<QuestionAnswer> },
              never,
              RealgoalServices
            > = Option.isSome(browserLaunch.launchUrlOpt)
              ? previewSvc.registerQuestionWaiter(created.state.id, q.id).pipe(
                  Effect.flatMap((waiter) => {
                    const browserRaceArm = Deferred.await(waiter).pipe(
                      Effect.tap(() => Effect.sync(() => uiAbort.abort())),
                      Effect.map((ans) => ({
                        via: "browser" as const,
                        answerOpt: Option.some(ans),
                      })),
                      Effect.catch(() =>
                        Effect.succeed({
                          via: "pending" as const,
                          answerOpt: Option.none<QuestionAnswer>(),
                        }),
                      ),
                    )
                    const terminalRaceArm = terminalPromptEffect.pipe(
                      Effect.map((ansOpt) => ({
                        via: Option.isSome(ansOpt) ? ("terminal" as const) : ("pending" as const),
                        answerOpt: ansOpt,
                      })),
                    )
                    return Effect.raceFirst(browserRaceArm, terminalRaceArm)
                  }),
                  Effect.ensuring(previewSvc.clearQuestionWaiter(created.state.id, q.id)),
                )
              : terminalPromptEffect.pipe(
                  Effect.map((ansOpt) => ({
                    via: Option.isSome(ansOpt) ? ("terminal" as const) : ("pending" as const),
                    answerOpt: ansOpt,
                  })),
                )

            return collectAnswerEff.pipe(
              Effect.flatMap(({ via, answerOpt }): Effect.Effect<ToolSuccessEnvelope, RealgoalError> => {
                if (via === "browser" && Option.isSome(answerOpt)) {
                  return controller.requireWorkItem(Option.some(created.state.id)).pipe(
                    Effect.map((reloaded) => ({
                      summary: `Question ${q.id} answered via browser preview.`,
                      details: {
                        workItemId: reloaded.state.id,
                        revision: reloaded.state.revision,
                        questionId: q.id,
                        status: "answered",
                        answer: {
                          selectedOptionIds: answerOpt.value.selectedOptionIds,
                          customText: Option.getOrUndefined(answerOpt.value.customText),
                          comments: Option.getOrUndefined(answerOpt.value.comments),
                          source: answerOpt.value.source,
                        },
                      },
                    })),
                  )
                }

                return Option.match(answerOpt, {
                  onNone: () =>
                    Effect.succeed({
                      summary: `Question ${q.id} remains pending (status: ${created.state.runStatus}).${
                        Option.isSome(browserLaunch.launchUrlOpt)
                          ? ` Preview URL: ${browserLaunch.launchUrlOpt.value}`
                          : ""
                      }`,
                      details: {
                        workItemId: created.state.id,
                        revision: created.state.revision,
                        questionId: q.id,
                        status: "pending",
                        launchUrl: Option.getOrUndefined(browserLaunch.launchUrlOpt),
                      },
                      terminate: q.blocking,
                    }),
                  onSome: (terminalAns) =>
                    controller.requireWorkItem(Option.some(created.state.id)).pipe(
                      Effect.flatMap((freshLoaded) =>
                        resolveQuestionCAS(freshLoaded.state, {
                          questionId: q.id,
                          expectedQuestionRevision: q.revision,
                          answer: terminalAns,
                          nowIso: new Date().toISOString(),
                        }).pipe(
                          Effect.flatMap((resolvedState) =>
                            controller
                              .saveUpdatedState(freshLoaded.state, resolvedState)
                              .pipe(Effect.as(resolvedState)),
                          ),
                          Effect.catchTag("QuestionConflictError", (conflict: QuestionConflictError) =>
                            conflict.status === "already_answered"
                              ? controller
                                  .requireWorkItem(Option.some(created.state.id))
                                  .pipe(Effect.map((r) => r.state))
                              : Effect.fail(conflict),
                          ),
                          Effect.map((finalState) => {
                            const finalQ = finalState.questions.find((item) => item.id === q.id)
                            const effectiveAns = Option.getOrElse(
                              Option.flatMap(Option.fromUndefinedOr(finalQ), (fq) => fq.answer),
                              () => terminalAns,
                            )
                            return {
                              summary: `Question ${q.id} resolved (${effectiveAns.source}).`,
                              details: {
                                workItemId: finalState.id,
                                revision: finalState.revision,
                                questionId: q.id,
                                status: "answered",
                                answer: {
                                  selectedOptionIds: effectiveAns.selectedOptionIds,
                                  customText: Option.getOrUndefined(effectiveAns.customText),
                                  comments: Option.getOrUndefined(effectiveAns.comments),
                                  source: effectiveAns.source,
                                },
                              },
                            }
                          }),
                        ),
                      ),
                    ),
                })
              }),
            )
          }),
        ),
      )
    },
  })

  // ---------------------------------------------------------------------------
  // 5. realgoal_delegate
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "realgoal_delegate",
    label: "Realgoal Delegate",
    description:
      "Dispatch an isolated Pi child worker (implementation, verification, or draft_review) via realtasks with tiered model/thinking resolution and strict JSONL/result.json validation.",
    promptSnippet:
      "Dispatch an isolated child Pi worker (implementation, verification, or draft_review)",
    executionMode: "sequential",
    parameters: Type.Object({
      role: Type.Union([
        Type.Literal("implementation"),
        Type.Literal("verification"),
        Type.Literal("draft_review"),
      ]),
      purpose: Type.String(),
      scope: Type.String(),
      todoId: Type.Optional(Type.String()),
      difficulty: Type.Optional(
        Type.Union([Type.Literal("light"), Type.Literal("medium"), Type.Literal("heavy")]),
      ),
      allowedTools: Type.Optional(Type.Array(Type.String())),
      allowedWritePaths: Type.Optional(Type.Array(Type.String())),
      contextFiles: Type.Optional(Type.Array(Type.String())),
      verificationCommands: Type.Optional(Type.Array(Type.String())),
      modelOverrideAuthId: Type.Optional(Type.String()),
      enterWait: Type.Optional(
        Type.Boolean({ description: "Set true to suspend workflow until the worker finishes" }),
      ),
      workItemId: Type.Optional(Type.String()),
    }),
    execute: (_toolCallId, params, signal, _onUpdate, ctx) => {
      const nowIso = new Date().toISOString()
      const role = params.role as WorkerRole

      return runtime.runToolEffect(
        ctx,
        signal,
        Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("workerSvc", () => WorkerService.useSync((s) => s)),
          Effect.tap(({ controller }) => controller.assertNotChildWorker(`realgoal_delegate:${role}`)),
          Effect.bind("loaded", ({ controller }) =>
            controller.requireWorkItem(Option.fromUndefinedOr(params.workItemId)),
          ),
          Effect.bind("mem", ({ controller }) => controller.getMemory()),
          Effect.bind("effCfg", ({ controller, loaded }) =>
            controller.getEffectiveConfig(Option.some(loaded.state)),
          ),
          Effect.flatMap(({ controller, workerSvc, loaded, mem, effCfg }) => {
            const state = loaded.state
            const todoOpt = Option.fromUndefinedOr(
              params.todoId ? state.todos.find((t) => t.id === params.todoId) : undefined,
            )
            const difficulty: Difficulty =
              params.difficulty ??
              Option.match(todoOpt, {
                onNone: () => "medium" as const,
                onSome: (t) => t.difficulty,
              })
            const jobId = `W${String(state.workers.length + 1).padStart(3, "0")}_${crypto.randomBytes(3).toString("hex")}`
            const parentModel = extractParentModelSnapshot(ctx, pi.getThinkingLevel())

            const inputHashOpt =
              role === "draft_review" ? state.finalizedCandidateHash : Option.none<string>()
            const manifestHashOpt =
              role === "draft_review"
                ? Option.map(state.finalizedCandidateHash, (fh) => computeCurrentManifestHash(state, fh))
                : Option.none<string>()

            return workerSvc
              .dispatchWorker({
                invoker: makeToolInvoker(ctx),
                workspaceCwd: mem.workspaceCwd,
                draftDir: loaded.paths.draftDir,
                state,
                config: effCfg.config,
                parentModel,
                jobId,
                role,
                todoId: Option.fromUndefinedOr(params.todoId),
                purpose: params.purpose,
                scope: params.scope,
                difficulty,
                inputArtifactHash: inputHashOpt,
                inputManifestHash: manifestHashOpt,
                allowedTools: params.allowedTools,
                allowedWritePaths: params.allowedWritePaths,
                contextFiles: params.contextFiles ?? [],
                verificationCommands: params.verificationCommands ?? [],
                modelOverrideAuthId: Option.fromUndefinedOr(params.modelOverrideAuthId),
                piExecutable: opts.piExecutable,
                nowIso,
                signal,
              })
              .pipe(
                Effect.flatMap(({ job, taskId, modelWarning }) => {
                  const updatedTodos = state.todos.map((t) =>
                    params.todoId && t.id === params.todoId
                      ? {
                          ...t,
                          status: role === "implementation" ? ("in_progress" as const) : t.status,
                          associatedWorkerIds: [...t.associatedWorkerIds, job.jobId],
                          associatedTaskIds: [...t.associatedTaskIds, taskId],
                        }
                      : t,
                  )
                  const stateWithWorker: WorkItemState = {
                    ...state,
                    todos: updatedTodos,
                    workers: [...state.workers, job],
                  }
                  const shouldWait = params.enterWait !== false
                  const nextState = bindTasksAndMaybeWait(stateWithWorker, {
                    bindings: [
                      {
                        taskId,
                        sessionId: mem.sessionId,
                        originatingToolCallId: Option.none(),
                        workerId: Option.some(job.jobId),
                        workItemId: state.id,
                        todoId: Option.fromUndefinedOr(params.todoId),
                        purpose: `Worker ${job.jobId} (${role}): ${params.purpose}`,
                        ownership: "owned",
                        notifyPolicy: "wake",
                        waitCondition: { kind: "terminal", eventPattern: Option.none() },
                        requireSuccess: true,
                        retainedResource: false,
                        resumePhase: state.phase,
                        autoWakeAvailable: true,
                        lastStatus: "running",
                        lastExitCode: Option.none(),
                        lastObservedAt: nowIso,
                        observationSource: "worker_dispatch",
                        readinessTimedOut: false,
                      },
                    ],
                    mode: "all",
                    enterWait: shouldWait,
                    resumePhase: state.phase,
                    nowIso,
                  })

                  return controller.saveUpdatedState(state, nextState).pipe(
                    Effect.map(() => {
                      const warnSuffix = Option.match(modelWarning, {
                        onNone: () => "",
                        onSome: (w) => ` Note: ${w}`,
                      })
                      return {
                        summary: `Dispatched ${role} worker ${job.jobId} on realtasks task '${taskId}' (${job.resolvedModel.provider}/${job.resolvedModel.modelId}, thinking=${job.resolvedModel.effectiveThinking}).${warnSuffix}`,
                        details: {
                          workItemId: nextState.id,
                          revision: nextState.revision,
                          jobId: job.jobId,
                          taskId,
                          role,
                          resolvedModel: job.resolvedModel,
                          modelWarning: Option.getOrUndefined(modelWarning),
                          runStatus: nextState.runStatus,
                        },
                        terminate: nextState.runStatus === "waiting_task",
                      }
                    }),
                  )
                }),
              )
          }),
        ),
      )
    },
  })

  // ---------------------------------------------------------------------------
  // 6. realgoal_finish
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "realgoal_finish",
    label: "Realgoal Finish",
    description:
      "Atomically verify and finish the active Realgoal work item. Rejects unless all required TODOs, fresh evidence, acceptance criteria, draft review gates, and background tasks are satisfied.",
    promptSnippet:
      "Atomically verify and finish the active Realgoal workflow once TODOs and evidence pass",
    executionMode: "sequential",
    parameters: Type.Object({
      summary: Type.String(),
      completionScope: Type.Optional(
        Type.Union([Type.Literal("implementation"), Type.Literal("artifact")]),
      ),
      expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      operationId: Type.Optional(Type.String()),
      evidenceIds: Type.Optional(Type.Array(Type.String())),
      retainedResourceIds: Type.Optional(Type.Array(Type.String())),
      recordGoalLevelVerification: Type.Optional(
        Type.Boolean({
          description: "Required true for implementation scope once final goal-level verification passes",
        }),
      ),
      workItemId: Type.Optional(Type.String()),
    }),
    execute: (toolCallId, params, signal, _onUpdate, ctx) => {
      const nowIso = new Date().toISOString()
      const opId = params.operationId ?? `op_finish_${toolCallId}`
      const callerIsWorker = Boolean(
        process.env["REALGOAL_WORKER_ROLE"] && process.env["REALGOAL_WORKER_ROLE"]!.trim().length > 0,
      )

      return runtime.runToolEffect(
        ctx,
        signal,
        Effect.Do.pipe(
          Effect.bind("controller", () => ControllerService.useSync((s) => s)),
          Effect.bind("loaded", ({ controller }) =>
            controller.requireWorkItem(Option.fromUndefinedOr(params.workItemId)),
          ),
          Effect.bind("effCfg", ({ controller, loaded }) =>
            controller.getEffectiveConfig(Option.some(loaded.state)),
          ),
          Effect.bind("refreshedState", ({ controller, loaded }) =>
            controller.refreshTrackedFileHashes(loaded.state, Object.keys(loaded.state.artifactHashes)),
          ),
          Effect.flatMap(({ controller, loaded, effCfg, refreshedState }) => {
            const expectedRev = params.expectedRevision ?? refreshedState.revision
            const scope: CompletionScope =
              params.completionScope ?? refreshedState.completionScope

            return finishWorkItem(refreshedState, {
              expectedRevision: expectedRev,
              operationId: opId,
              callerIsChildWorker: callerIsWorker,
              completionScope: scope,
              summary: params.summary,
              evidenceIds: params.evidenceIds ?? [],
              retainedResourceIds: params.retainedResourceIds ?? [],
              recordGoalLevelVerification: params.recordGoalLevelVerification ?? false,
              draftGateEnabled: effCfg.config.verification.draftGate.enabled,
              nowIso,
            }).pipe(
              Effect.flatMap((finishedState) =>
                controller.saveUpdatedState(loaded.state, finishedState).pipe(
                  Effect.map(() => ({
                    summary: `Finished ${finishedState.kind} "${finishedState.displayName}" (${scope}) at revision ${finishedState.revision}: ${params.summary}`,
                    details: {
                      workItemId: finishedState.id,
                      revision: finishedState.revision,
                      phase: finishedState.phase,
                      runStatus: finishedState.runStatus,
                      completionScope: scope,
                    },
                    terminate: true,
                  })),
                ),
              ),
            )
          }),
        ),
      )
    },
  })
}
