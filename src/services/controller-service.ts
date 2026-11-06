import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Context, Effect, Layer, Option, SynchronizedRef } from "effect"
import {
  ConfigService,
  makeDefaultConfig,
  type EffectiveConfigResult,
} from "../domain/config.ts"
import {
  RoleGuardError,
  WorkItemNotFoundError,
  type RealgoalError,
} from "../domain/errors.ts"
import type {
  CompletionScope,
  DraftReviewReport,
  EvidenceRecord,
  OwnerToken,
  TodoReviewSummary,
  UserAuthorization,
  VerificationDriver,
  WorkerJobRecord,
  WorkItemState,
  WorkflowKind,
} from "../domain/models.ts"
import {
  applyTodoMutation,
  createDurableQuestion,
  createInitialWorkItem,
  pauseWorkItem,
  recordDraftReviewReport,
  recordOperationFailure,
  resolveQuestionCAS,
} from "../domain/reducer.ts"
import { DoctorService } from "./doctor-service.ts"
import { PersistenceService, resolveDraftPaths, type DraftPaths, type LoadedWorkItemResult } from "./persistence.ts"
import { sha256FileOption } from "./path-safety.ts"
import { PreviewService } from "./preview-service.ts"
import { RealtasksAdapter, type ToolInvoker } from "./realtasks-adapter.ts"
import { WorkerService } from "./worker-service.ts"

export interface SessionRuntimeMemory {
  readonly runtimeId: string
  readonly sessionId: string
  readonly workspaceCwd: string
  readonly globalAgentDir: string
  readonly configDirName: string
  readonly hostMode: "tui" | "rpc" | "json" | "print"
  readonly isProjectTrusted: boolean
  readonly readOnlyAttachment: boolean
  readonly activeWorkItemId: Option.Option<string>
  readonly uiPromptWaiting: boolean
  readonly hadQualifyingProgressSinceLastSettle: boolean
  readonly lastProgressRevisionSeenAtSettle: number
  readonly toolsBeforePlanRestriction: Option.Option<ReadonlyArray<string>>
  readonly commandCollisions: ReadonlyArray<string>
  readonly pendingScopeChangeMessage: Option.Option<string>
}

const makeInitialMemory = (configDirName = ".pi"): SessionRuntimeMemory => ({
  runtimeId: crypto.randomUUID(),
  sessionId: "uninitialized",
  workspaceCwd: process.cwd(),
  globalAgentDir: path.join(process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".", configDirName, "agent"),
  configDirName,
  hostMode: "tui",
  isProjectTrusted: false,
  readOnlyAttachment: false,
  activeWorkItemId: Option.none(),
  uiPromptWaiting: false,
  hadQualifyingProgressSinceLastSettle: false,
  lastProgressRevisionSeenAtSettle: 0,
  toolsBeforePlanRestriction: Option.none(),
  commandCollisions: [],
  pendingScopeChangeMessage: Option.none(),
})

export class ControllerService extends Context.Service<
  ControllerService,
  {
    readonly getMemory: () => Effect.Effect<SessionRuntimeMemory, never>
    readonly updateMemory: (
      fn: (cur: SessionRuntimeMemory) => SessionRuntimeMemory,
    ) => Effect.Effect<SessionRuntimeMemory, never>
    readonly makeOwnerToken: (mem: SessionRuntimeMemory) => OwnerToken
    readonly assertNotChildWorker: (actionName: string) => Effect.Effect<void, RoleGuardError>
    readonly getEffectiveConfig: (
      stateOpt?: Option.Option<WorkItemState>,
    ) => Effect.Effect<EffectiveConfigResult, RealgoalError>
    readonly getActiveWorkItem: () => Effect.Effect<Option.Option<LoadedWorkItemResult>, RealgoalError>
    readonly requireWorkItem: (
      workItemIdOpt?: Option.Option<string>,
    ) => Effect.Effect<LoadedWorkItemResult, RealgoalError>
    readonly startNewWorkItem: (params: {
      readonly kind: WorkflowKind
      readonly displayName: string
      readonly objective: string
      readonly constraints?: ReadonlyArray<string>
      readonly nonGoals?: ReadonlyArray<string>
      readonly acceptanceCriteria?: ReadonlyArray<string>
      readonly completionScope?: CompletionScope
      readonly verificationDriver?: VerificationDriver
      readonly nowIso: string
    }) => Effect.Effect<{ readonly state: WorkItemState; readonly paths: DraftPaths }, RealgoalError>
    readonly saveUpdatedState: (
      prevState: WorkItemState,
      nextState: WorkItemState,
    ) => Effect.Effect<DraftPaths, RealgoalError>
    readonly createUserAuthorization: (params: {
      readonly state: WorkItemState
      readonly kind: UserAuthorization["kind"]
      readonly summary: string
      readonly artifactHash?: Option.Option<string>
      readonly taskIds?: ReadonlyArray<string>
      readonly criterionIds?: ReadonlyArray<string>
      readonly modelOverride?: UserAuthorization["modelOverride"]
      readonly actor?: "user" | "delegated_by_user"
      readonly nowIso: string
    }) => Effect.Effect<{ readonly state: WorkItemState; readonly auth: UserAuthorization }, RealgoalError>
    readonly reconcileFinishedWorkerJobs: (params: {
      readonly state: WorkItemState
      readonly nowIso: string
    }) => Effect.Effect<WorkItemState, RealgoalError>
    readonly refreshTrackedFileHashes: (
      state: WorkItemState,
      filePaths: ReadonlyArray<string>,
    ) => Effect.Effect<WorkItemState, never>
    readonly copyWorkItemForFork: (params: {
      readonly sourceState: WorkItemState
      readonly newDisplayName: string
      readonly nowIso: string
    }) => Effect.Effect<{ readonly state: WorkItemState; readonly paths: DraftPaths }, RealgoalError>
  }
>()("realgoal/services/ControllerService") {
  static readonly layerNoDeps = Layer.effect(
    ControllerService,
    Effect.Do.pipe(
      Effect.bind("configSvc", () => ConfigService.useSync((s) => s)),
      Effect.bind("persistence", () => PersistenceService.useSync((s) => s)),
      Effect.bind("workerSvc", () => WorkerService.useSync((s) => s)),
      Effect.bind("memRef", () => SynchronizedRef.make(makeInitialMemory())),
      Effect.map(({ configSvc, persistence, workerSvc, memRef }) => {
        const makeOwner = (mem: SessionRuntimeMemory): OwnerToken => ({
          sessionId: mem.sessionId,
          runtimeId: mem.runtimeId,
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          hostMode: mem.hostMode,
          readOnly: mem.readOnlyAttachment,
        })

        const assertNotChildWorker = (actionName: string): Effect.Effect<void, RoleGuardError> => {
          const workerRole = process.env["REALGOAL_WORKER_ROLE"]
          if (workerRole && workerRole.trim().length > 0) {
            return Effect.fail(
              new RoleGuardError({
                role: workerRole,
                attemptedAction: actionName,
                reason: `Delegated child worker (${workerRole}) is forbidden from executing parent controller action '${actionName}'.`,
              }),
            )
          }
          return Effect.void
        }

        const getEffectiveConfigImpl = (
          stateOpt: Option.Option<WorkItemState> = Option.none(),
        ): Effect.Effect<EffectiveConfigResult, RealgoalError> =>
          SynchronizedRef.get(memRef).pipe(
            Effect.flatMap((mem) =>
              configSvc.loadEffective({
                globalAgentDir: mem.globalAgentDir,
                workspaceCwd: mem.workspaceCwd,
                isProjectTrusted: mem.isProjectTrusted,
                configDirName: mem.configDirName,
                overrides: Option.map(stateOpt, (s) => s.configOverrides),
              }),
            ),
          )

        const saveUpdatedImpl = (
          prevState: WorkItemState,
          nextState: WorkItemState,
        ): Effect.Effect<DraftPaths, RealgoalError> =>
          SynchronizedRef.get(memRef).pipe(
            Effect.flatMap((mem) =>
              persistence.saveWorkItem(mem.workspaceCwd, mem.configDirName, nextState, makeOwner(mem)).pipe(
                Effect.tap(() => {
                  const progressed =
                    nextState.progress.lastMeaningfulProgressAt !==
                      prevState.progress.lastMeaningfulProgressAt ||
                    nextState.todos.filter((t) => t.status === "done").length >
                      prevState.todos.filter((t) => t.status === "done").length
                  return progressed
                    ? SynchronizedRef.update(memRef, (cur) => ({
                        ...cur,
                        hadQualifyingProgressSinceLastSettle: true,
                      }))
                    : Effect.void
                }),
              ),
            ),
          )

        const getActiveImpl = (): Effect.Effect<Option.Option<LoadedWorkItemResult>, RealgoalError> =>
          SynchronizedRef.get(memRef).pipe(
            Effect.flatMap((mem) =>
              Option.match(mem.activeWorkItemId, {
                onNone: () => Effect.succeed(Option.none()),
                onSome: (id) => persistence.loadWorkItemById(mem.workspaceCwd, mem.configDirName, id),
              }),
            ),
          )

        const requireWorkItemImpl = (
          workItemIdOpt: Option.Option<string> = Option.none(),
        ): Effect.Effect<LoadedWorkItemResult, RealgoalError> =>
          SynchronizedRef.get(memRef).pipe(
            Effect.flatMap((mem) => {
              const targetIdOpt = Option.orElse(workItemIdOpt, () => mem.activeWorkItemId)
              return Option.match(targetIdOpt, {
                onNone: () =>
                  Effect.fail(
                    new WorkItemNotFoundError({
                      workItemId: "active",
                      message: "No active Realgoal work item. Start one with /goal or /plan, or /realgoal resume.",
                    }),
                  ),
                onSome: (id) =>
                  persistence.loadWorkItemById(mem.workspaceCwd, mem.configDirName, id).pipe(
                    Effect.flatMap((foundOpt) =>
                      Option.match(foundOpt, {
                        onNone: () =>
                          Effect.fail(
                            new WorkItemNotFoundError({
                              workItemId: id,
                              message: `Work item '${id}' was not found in ${mem.configDirName}/realgoal/draft/.`,
                            }),
                          ),
                        onSome: Effect.succeed,
                      }),
                    ),
                  ),
              })
            }),
          )

        return ControllerService.of({
          getMemory: () => SynchronizedRef.get(memRef),
          updateMemory: (fn) => SynchronizedRef.updateAndGet(memRef, fn),
          makeOwnerToken: makeOwner,
          assertNotChildWorker,
          getEffectiveConfig: getEffectiveConfigImpl,
          getActiveWorkItem: getActiveImpl,
          requireWorkItem: requireWorkItemImpl,

          startNewWorkItem: (params) =>
            assertNotChildWorker("startNewWorkItem").pipe(
              Effect.flatMap(() => SynchronizedRef.get(memRef)),
              Effect.flatMap((mem) =>
                Effect.Do.pipe(
                  Effect.let("workItemId", () => `rg_${crypto.randomBytes(6).toString("hex")}`),
                  Effect.bind("safeDirName", ({ workItemId }) =>
                    persistence.allocateDraftStem(
                      mem.workspaceCwd,
                      mem.configDirName,
                      params.displayName,
                      workItemId,
                    ),
                  ),
                  Effect.bind("cfg", () =>
                    configSvc
                      .loadEffective({
                        globalAgentDir: mem.globalAgentDir,
                        workspaceCwd: mem.workspaceCwd,
                        isProjectTrusted: mem.isProjectTrusted,
                        configDirName: mem.configDirName,
                      })
                      .pipe(
                        Effect.orElseSucceed(() => ({
                          config: makeDefaultConfig(mem.configDirName),
                          sources: {},
                          warnings: [],
                        })),
                      ),
                  ),
                  Effect.flatMap(({ workItemId, safeDirName, cfg }) => {
                    const owner = makeOwner({ ...mem, readOnlyAttachment: false })
                    const state = createInitialWorkItem({
                      id: workItemId,
                      displayName: params.displayName,
                      safeDirName,
                      workspacePath: mem.workspaceCwd,
                      sessionId: mem.sessionId,
                      owner,
                      kind: params.kind,
                      objective: params.objective,
                      constraints: params.constraints,
                      nonGoals: params.nonGoals,
                      acceptanceCriteria: params.acceptanceCriteria,
                      completionScope: params.completionScope,
                      verificationDriver:
                        params.verificationDriver ?? cfg.config.verification.executionDriver,
                      nowIso: params.nowIso,
                    })
                    return persistence
                      .initializeWorkItem(mem.workspaceCwd, mem.configDirName, state, owner)
                      .pipe(
                        Effect.tap(() =>
                          SynchronizedRef.update(memRef, (cur) => ({
                            ...cur,
                            readOnlyAttachment: false,
                            activeWorkItemId: Option.some(state.id),
                            hadQualifyingProgressSinceLastSettle: true,
                            pendingScopeChangeMessage: Option.none(),
                          })),
                        ),
                        Effect.map((paths) => ({ state, paths })),
                      )
                  }),
                ),
              ),
            ),

          saveUpdatedState: saveUpdatedImpl,

          createUserAuthorization: (params) => {
            const auth: UserAuthorization = {
              id: `AUTH_${crypto.randomBytes(5).toString("hex")}`,
              kind: params.kind,
              summary: params.summary,
              targetRevision: Option.some(params.state.revision),
              artifactHash: params.artifactHash ?? Option.none(),
              taskIds: [...(params.taskIds ?? [])],
              criterionIds: [...(params.criterionIds ?? [])],
              modelOverride: params.modelOverride ?? Option.none(),
              actor: params.actor ?? "user",
              timestamp: params.nowIso,
            }
            const nextState: WorkItemState = {
              ...params.state,
              revision: params.state.revision + 1,
              updatedAt: params.nowIso,
              authorizations: [...params.state.authorizations, auth],
            }
            return saveUpdatedImpl(params.state, nextState).pipe(
              Effect.as({ state: nextState, auth }),
            )
          },

          reconcileFinishedWorkerJobs: (params) =>
            Effect.Do.pipe(
              Effect.bind("effCfg", () => getEffectiveConfigImpl(Option.some(params.state))),
              Effect.bind("nextState", ({ effCfg }) => {
                const candidateJobs = params.state.workers.filter((w) => {
                  if (w.status !== "running" && w.status !== "dispatched") return false
                  return Option.match(w.taskId, {
                    onNone: () => false,
                    onSome: (tid) => {
                      const binding = params.state.trackedTasks.find((t) => t.taskId === tid)
                      return (
                        binding !== undefined &&
                        binding.lastStatus !== "running" &&
                        binding.lastStatus !== "ready" &&
                        binding.lastStatus !== "unavailable"
                      )
                    },
                  })
                })

                return Effect.reduce(candidateJobs, () => params.state, (accState, job) => {
                  const binding = Option.flatMap(job.taskId, (tid) =>
                    Option.fromUndefinedOr(accState.trackedTasks.find((t) => t.taskId === tid)),
                  )
                  const taskFailed = Option.match(binding, {
                    onNone: () => true,
                    onSome: (b) => b.lastStatus !== "completed",
                  })

                  return workerSvc.collectAndValidateWorker(job).pipe(
                    Effect.flatMap((validated): Effect.Effect<WorkItemState, RealgoalError> => {
                      if (taskFailed) {
                        const failedJob: WorkerJobRecord = {
                          ...job,
                          status: "failed",
                          summary: Option.some(
                            `Outer realtasks task did not complete cleanly (${Option.match(binding, {
                              onNone: () => "unknown",
                              onSome: (b) => b.lastStatus,
                            })})`,
                          ),
                          updatedAt: params.nowIso,
                        }
                        const withWorker = {
                          ...accState,
                          workers: accState.workers.map((w) => (w.jobId === job.jobId ? failedJob : w)),
                        }
                        return Effect.succeed(
                          recordOperationFailure(
                            withWorker,
                            `worker_fail:${job.role}:${Option.getOrElse(job.todoId, () => "none")}`,
                            `Worker ${job.jobId} outer task failed`,
                            effCfg.config,
                            params.nowIso,
                          ),
                        )
                      }

                      if (validated.status === "needs_input") {
                        const qText = Option.getOrElse(
                          validated.needsInputQuestion,
                          () => validated.summary,
                        )
                        const qId = `Q${String(accState.questions.length + 1).padStart(3, "0")}`
                        const updatedWorker: WorkerJobRecord = {
                          ...job,
                          status: "needs_input",
                          summary: Option.some(validated.summary),
                          needsInputQuestion: Option.some(qText),
                          updatedAt: params.nowIso,
                        }
                        const withQ = createDurableQuestion(
                          {
                            ...accState,
                            workers: accState.workers.map((w) =>
                              w.jobId === job.jobId ? updatedWorker : w,
                            ),
                          },
                          {
                            questionId: qId,
                            title: `Clarification needed for ${job.jobId}`,
                            prompt: qText,
                            purpose: `Escalated from ${job.role} worker ${job.jobId}`,
                            blocking: true,
                            allowFreeText: true,
                            multiSelect: false,
                            options: [],
                            previewId: Option.none(),
                            nowIso: params.nowIso,
                          },
                        )
                        return Effect.succeed(withQ.state)
                      }

                      const completedJob: WorkerJobRecord = {
                        ...job,
                        status: "completed",
                        summary: Option.some(validated.summary),
                        updatedAt: params.nowIso,
                      }
                      const baseUpdated: WorkItemState = {
                        ...accState,
                        workers: accState.workers.map((w) =>
                          w.jobId === job.jobId ? completedJob : w,
                        ),
                      }

                      if (job.role === "draft_review") {
                        const verdict = Option.getOrElse(validated.verdict, () => "changes_required" as const)
                        const finHash = Option.getOrElse(
                          job.inputArtifactHash,
                          () => Option.getOrElse(baseUpdated.finalizedCandidateHash, () => "unknown"),
                        )
                        const manifestHash = Option.getOrElse(job.inputManifestHash, () => "unknown")
                        const report: DraftReviewReport = {
                          id: `REV_${job.jobId}`,
                          verdict,
                          inputManifestHash: manifestHash,
                          finalizedHash: finHash,
                          requestHash: "bound",
                          decisionsHash: "bound",
                          criteriaHash: "bound",
                          projectFileHashes: baseUpdated.artifactHashes,
                          findings: validated.findings,
                          workerJobId: Option.some(job.jobId),
                          summary: validated.summary,
                          timestamp: params.nowIso,
                        }
                        return SynchronizedRef.get(memRef).pipe(
                          Effect.tap((mem) => {
                            const draftPaths = resolveDraftPaths(
                              mem.workspaceCwd,
                              mem.configDirName,
                              baseUpdated.safeDirName,
                            )
                            const revJsonPath = path.join(draftPaths.reviewsDir, `${report.id}.json`)
                            const revMdPath = path.join(draftPaths.reviewsDir, `${report.id}.md`)
                            const mdText = [
                              `# Draft Review Report — ${report.id}`,
                              `- **Verdict:** \`${report.verdict}\``,
                              `- **Input Manifest Hash:** \`${report.inputManifestHash}\``,
                              `- **Summary:** ${report.summary}`,
                              "",
                              ...report.findings.map(
                                (f) =>
                                  `- **[${f.severity.toUpperCase()}] ${f.id}** (${f.locationOrRequirement}): ${f.explanation} → _${f.suggestedResolution}_`,
                              ),
                              "",
                            ].join("\n")
                            return Effect.tryPromise({
                              try: async () => {
                                await fs.mkdir(draftPaths.reviewsDir, { recursive: true })
                                await fs.writeFile(revJsonPath, JSON.stringify(report, null, 2) + "\n", "utf8")
                                await fs.writeFile(revMdPath, mdText, "utf8")
                              },
                              catch: () => undefined,
                            }).pipe(Effect.ignore)
                          }),
                          Effect.map(() => recordDraftReviewReport(baseUpdated, report, params.nowIso)),
                        )
                      }

                      if (job.role === "implementation" && Option.isSome(job.todoId)) {
                        const todoId = job.todoId.value
                        return applyTodoMutation(
                          baseUpdated,
                          baseUpdated.revision,
                          `worker_submit_${job.jobId}`,
                          {
                            action: "submit_for_verification",
                            todoId,
                            implementationSummary: `[Worker ${job.jobId}] ${validated.summary}`,
                            actor: "worker",
                          },
                          params.nowIso,
                        )
                      }

                      if (job.role === "verification" && Option.isSome(job.todoId)) {
                        const todoId = job.todoId.value
                        const verdict = Option.getOrElse(validated.verdict, () => "changes_required" as const)
                        const evId = `EV_${job.jobId}`
                        const evRecord: EvidenceRecord = {
                          id: evId,
                          criterionIds: baseUpdated.acceptanceCriteria.map((c) => c.id),
                          todoIds: [todoId],
                          method: validated.checksRun.length > 0 ? "executable_test" : "static_review",
                          result: verdict === "pass" ? "pass" : verdict === "blocked" ? "blocked" : "fail",
                          commandOrObservation: `Subagent verification (${job.jobId}): ${validated.summary}`,
                          exitCode: Option.none(),
                          outputSnippet: Option.some(validated.summary),
                          timestamp: params.nowIso,
                          artifactPaths: [job.resultPath],
                          reviewedHashes: baseUpdated.artifactHashes,
                          waiverAuthorizationId: Option.none(),
                        }
                        const reviewSummary: TodoReviewSummary = {
                          reviewerActor: "subagent",
                          verdict,
                          summary: validated.summary,
                          workerJobId: Option.some(job.jobId),
                          reviewedHashes: baseUpdated.artifactHashes,
                          timestamp: params.nowIso,
                        }
                        return applyTodoMutation(
                          baseUpdated,
                          baseUpdated.revision,
                          `worker_ev_${job.jobId}`,
                          { action: "record_evidence", evidence: evRecord },
                          params.nowIso,
                        ).pipe(
                          Effect.flatMap((afterEv) => {
                            if (verdict !== "pass") {
                              return applyTodoMutation(
                                afterEv,
                                afterEv.revision,
                                `worker_reopen_${job.jobId}`,
                                {
                                  action: "reopen",
                                  todoId,
                                  reason: `Subagent verification returned ${verdict}: ${validated.summary}`,
                                },
                                params.nowIso,
                              )
                            }
                            const nextTodos = afterEv.todos.map((t) =>
                              t.id === todoId ? { ...t, reviewResult: Option.some(reviewSummary) } : t,
                            )
                            return Effect.succeed({ ...afterEv, todos: nextTodos })
                          }),
                        )
                      }

                      return Effect.succeed(baseUpdated)
                    }),
                    Effect.catchTag("WorkerValidationError", (valErr) => {
                      const failedJob: WorkerJobRecord = {
                        ...job,
                        status: valErr.status === "blocked" ? "blocked" : "failed",
                        summary: Option.some(valErr.reason),
                        updatedAt: params.nowIso,
                      }
                      const withFailedWorker: WorkItemState = {
                        ...accState,
                        workers: accState.workers.map((w) => (w.jobId === job.jobId ? failedJob : w)),
                      }
                      const afterFailure = recordOperationFailure(
                        withFailedWorker,
                        `worker_validation:${job.role}:${Option.getOrElse(job.todoId, () => "none")}`,
                        valErr.reason,
                        effCfg.config,
                        params.nowIso,
                      )
                      return Effect.succeed(
                        valErr.status === "blocked"
                          ? pauseWorkItem(afterFailure, valErr.reason, "recovery", params.nowIso)
                          : afterFailure,
                      )
                    }),
                  )
                })
              }),
              Effect.map(({ nextState }) => nextState),
            ),

          refreshTrackedFileHashes: (state, filePaths) =>
            SynchronizedRef.get(memRef).pipe(
              Effect.flatMap((mem) =>
                Effect.forEach(filePaths, (relOrAbs) => {
                  const full = path.resolve(mem.workspaceCwd, relOrAbs)
                  return sha256FileOption(full).pipe(
                    Effect.map((hashOpt) => ({ key: full, hashOpt })),
                  )
                }).pipe(
                  Effect.map((entries) => {
                    const updatedHashes: Record<string, string> = { ...state.artifactHashes }
                    for (const e of entries) {
                      if (Option.isSome(e.hashOpt)) {
                        updatedHashes[e.key] = e.hashOpt.value
                      }
                    }
                    return {
                      ...state,
                      artifactHashes: updatedHashes,
                    }
                  }),
                ),
              ),
            ),

          copyWorkItemForFork: (params) =>
            SynchronizedRef.get(memRef).pipe(
              Effect.flatMap((mem) => {
                const newId = `rg_${crypto.randomBytes(6).toString("hex")}`
                return persistence
                  .allocateDraftStem(mem.workspaceCwd, mem.configDirName, params.newDisplayName, newId)
                  .pipe(
                    Effect.flatMap((safeDirName) => {
                      const owner = makeOwner({ ...mem, readOnlyAttachment: false })
                      const copiedState: WorkItemState = {
                        ...params.sourceState,
                        id: newId,
                        displayName: params.newDisplayName,
                        safeDirName,
                        createdAt: params.nowIso,
                        updatedAt: params.nowIso,
                        revision: 1,
                        originatingSessionId: mem.sessionId,
                        owner: Option.some(owner),
                        runStatus: "paused",
                        trackedTasks: [],
                        activeWaitGroup: Option.none(),
                        workers: [],
                        reviews: [],
                        publications: [],
                        operationIds: [],
                        consumedEventKeys: [],
                        pauseOrBlockReason: Option.some("Copied from forked work item; review and /realgoal resume."),
                      }
                      return persistence
                        .initializeWorkItem(mem.workspaceCwd, mem.configDirName, copiedState, owner)
                        .pipe(
                          Effect.tap(() =>
                            SynchronizedRef.update(memRef, (cur) => ({
                              ...cur,
                              readOnlyAttachment: false,
                              activeWorkItemId: Option.some(newId),
                            })),
                          ),
                          Effect.map((paths) => ({ state: copiedState, paths })),
                        )
                    }),
                  )
              }),
            ),
        })
      }),
    ),
  )

  static readonly layer = ControllerService.layerNoDeps.pipe(
    Layer.provideMerge(ConfigService.layer),
    Layer.provideMerge(PersistenceService.layer),
    Layer.provideMerge(RealtasksAdapter.layer),
    Layer.provideMerge(PreviewService.layer),
    Layer.provideMerge(WorkerService.layer),
    Layer.provideMerge(DoctorService.layer),
  )
}

export { resolveQuestionCAS }
