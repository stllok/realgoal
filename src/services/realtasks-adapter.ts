import { Context, Effect, Layer, Option, Predicate, Ref, Schema } from "effect"
import { AuthorizationRequiredError, RealtasksAdapterError, type RealgoalError } from "../domain/errors.ts"
import {
  ObservedTaskStatusSchema,
  type ObservedTaskStatus,
  type TaskBinding,
  type TaskWaitCondition,
  type WorkItemState,
  type WorkflowPhase,
} from "../domain/models.ts"
import { bindTasksAndMaybeWait, reconcileObservedTask } from "../domain/reducer.ts"

export const RealtasksBashDetailsSchema = Schema.Struct({
  taskId: Schema.OptionFromOptionalNullOr(Schema.String),
  status: Schema.OptionFromOptionalNullOr(Schema.String),
  requested: Schema.OptionFromOptionalNullOr(Schema.String),
  executed: Schema.OptionFromOptionalNullOr(Schema.String),
})

export const RealtasksReadDetailsSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  status: Schema.Literals(["running", "completed", "failed", "timed_out", "stopped", "lost"]),
  exitCode: Schema.OptionFromOptionalNullOr(Schema.Number),
  cursor: Schema.Number,
})

export const RealtasksNoticeItemSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["terminal", "signal", "event"]),
  summary: Schema.OptionFromOptionalNullOr(Schema.String),
  level: Schema.OptionFromOptionalNullOr(Schema.Literals(["info", "warning", "error"])),
  label: Schema.OptionFromOptionalNullOr(Schema.String),
  detail: Schema.OptionFromOptionalNullOr(Schema.String),
})

export const RealtasksNotificationDetailsSchema = Schema.Struct({
  items: Schema.Array(RealtasksNoticeItemSchema),
})

export const RealtasksLifecycleEntrySchema = Schema.Struct({
  event: Schema.Literals(["started", "ended", "readopted"]),
  id: Schema.OptionFromOptionalNullOr(Schema.String),
  status: Schema.OptionFromOptionalNullOr(Schema.String),
  running: Schema.OptionFromOptionalNullOr(Schema.Array(Schema.String)),
  finished: Schema.OptionFromOptionalNullOr(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        status: Schema.String,
      }),
    ),
  ),
})

export interface ToolInvokeOutcome {
  readonly contentText: string
  readonly details: unknown
  readonly isError: boolean
}

export type ToolInvoker = (
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Effect.Effect<ToolInvokeOutcome, never>

export interface ObservedRuntimeTaskMeta {
  readonly taskId: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly parentToolCallId: Option.Option<string>
  readonly notifyPolicy: "wake" | "passive" | "silent" | "unknown"
  readonly readinessState: "none" | "ready" | "timed_out" | "exited_before_ready"
  readonly lastStatus: ObservedTaskStatus
  readonly observedAt: string
}

export interface PeekedTaskOutcome {
  readonly taskId: string
  readonly status: ObservedTaskStatus
  readonly exitCode: Option.Option<number>
  readonly readinessTimedOut: boolean
  readonly outputPreview: string
}

const mapRawStatus = (raw: string): Option.Option<ObservedTaskStatus> =>
  Schema.decodeUnknownOption(ObservedTaskStatusSchema)(raw)

const classifyBashReadiness = (
  contentText: string,
  isError: boolean,
  hadReadyArg: boolean,
): "none" | "ready" | "timed_out" | "exited_before_ready" => {
  if (!hadReadyArg) return "none"
  if (isError || contentText.includes("exited before it was ready")) return "exited_before_ready"
  if (contentText.includes("is running but not ready after")) return "timed_out"
  if (contentText.includes("is ready (")) return "ready"
  return "none"
}

export interface ExtractedRealtasksHint {
  readonly taskId: string
  readonly kind: "terminal" | "signal" | "event"
  readonly inferredStatus: Option.Option<ObservedTaskStatus>
  readonly eventKey: string
}

export const extractHintsFromCustomMessage = (
  customType: string,
  details: unknown,
  boundaryOrdinal = 0,
): ReadonlyArray<ExtractedRealtasksHint> => {
  if (customType !== "task-notification" && customType !== "task-event") {
    return []
  }
  const decoded = Schema.decodeUnknownOption(RealtasksNotificationDetailsSchema)(details)
  return Option.match(decoded, {
    onNone: () => [],
    onSome: (d) =>
      d.items.map((item, idx) => {
        const detailText = Option.getOrElse(item.detail, () => Option.getOrElse(item.summary, () => ""))
        const statusOpt: Option.Option<ObservedTaskStatus> =
          item.kind === "event"
            ? Option.some("ready")
            : item.kind === "signal" && detailText.includes("ready")
              ? Option.some("ready")
              : detailText.startsWith("completed") || detailText.includes(" completed")
                ? Option.some("completed")
                : detailText.startsWith("failed") || detailText.includes(" failed")
                  ? Option.some("failed")
                  : detailText.startsWith("timed_out") || detailText.includes(" timed_out")
                    ? Option.some("timed_out")
                    : detailText.startsWith("stopped") || detailText.includes(" stopped")
                      ? Option.some("stopped")
                      : detailText.startsWith("lost") || detailText.includes(" lost")
                        ? Option.some("lost")
                        : Option.none()

        const keyDetail = Option.getOrElse(item.detail, () => item.kind)
        return {
          taskId: item.id,
          kind: item.kind,
          inferredStatus: statusOpt,
          eventKey: `${customType}:${item.id}:${item.kind}:${keyDetail}:${boundaryOrdinal}:${idx}`,
        }
      }),
  })
}

export class RealtasksAdapter extends Context.Service<
  RealtasksAdapter,
  {
    readonly recordToolExecutionStart: (params: {
      readonly toolCallId: string
      readonly toolName: string
      readonly args: unknown
      readonly parentToolCallId?: string
    }) => Effect.Effect<void, never>
    readonly recordToolExecutionEnd: (params: {
      readonly sessionId: string
      readonly toolCallId: string
      readonly toolName: string
      readonly result: unknown
      readonly isError: boolean
      readonly parentToolCallId?: string
      readonly nowIso: string
    }) => Effect.Effect<Option.Option<ObservedRuntimeTaskMeta>, never>
    readonly getObservedTaskMeta: (taskId: string) => Effect.Effect<Option.Option<ObservedRuntimeTaskMeta>, never>
    readonly peekTaskOnce: (params: {
      readonly invoker: ToolInvoker
      readonly taskId: string
      readonly currentSessionId: string
      readonly originatingSessionId: string
      readonly signal?: AbortSignal
    }) => Effect.Effect<PeekedTaskOutcome, RealtasksAdapterError>
    readonly reconcileAndEnterWait: (params: {
      readonly invoker: ToolInvoker
      readonly state: WorkItemState
      readonly currentSessionId: string
      readonly requests: ReadonlyArray<{
        readonly taskId: string
        readonly todoId: Option.Option<string>
        readonly purpose: string
        readonly ownership: "owned" | "attached"
        readonly waitCondition: TaskWaitCondition
        readonly requireSuccess: boolean
        readonly notifyPolicy?: "wake" | "passive" | "silent"
      }>
      readonly mode: "all" | "any"
      readonly resumePhase: WorkflowPhase
      readonly nowIso: string
      readonly signal?: AbortSignal
    }) => Effect.Effect<WorkItemState, RealgoalError>
    readonly reconcileTrackedTasksOnce: (params: {
      readonly invoker: ToolInvoker
      readonly state: WorkItemState
      readonly currentSessionId: string
      readonly onlyTaskIds?: ReadonlyArray<string>
      readonly nowIso: string
      readonly signal?: AbortSignal
    }) => Effect.Effect<WorkItemState, RealgoalError>
    readonly applyNotificationHints: (params: {
      readonly state: WorkItemState
      readonly hints: ReadonlyArray<ExtractedRealtasksHint>
      readonly nowIso: string
    }) => Effect.Effect<{ readonly state: WorkItemState; readonly anyWoke: boolean }, never>
    readonly stopAuthorizedTasks: (params: {
      readonly invoker: ToolInvoker
      readonly state: WorkItemState
      readonly taskIds: ReadonlyArray<string>
      readonly authorizationId: string
      readonly signal?: AbortSignal
    }) => Effect.Effect<ReadonlyArray<{ readonly taskId: string; readonly stopped: boolean; readonly output: string }>, RealgoalError>
  }
>()("realgoal/services/RealtasksAdapter") {
  static readonly layer = Layer.effect(
    RealtasksAdapter,
    Effect.all({
      pendingCallsRef: Ref.make(
        new Map<
          string,
          {
            readonly toolName: string
            readonly notifyPolicy: "wake" | "passive" | "silent" | "unknown"
            readonly hadReady: boolean
            readonly parentToolCallId: Option.Option<string>
          }
        >(),
      ),
      observedTasksRef: Ref.make(new Map<string, ObservedRuntimeTaskMeta>()),
    }).pipe(
      Effect.map(({ pendingCallsRef, observedTasksRef }) => {
        const peekTaskOnceImpl = (params: {
          readonly invoker: ToolInvoker
          readonly taskId: string
          readonly currentSessionId: string
          readonly originatingSessionId: string
          readonly signal?: AbortSignal
        }): Effect.Effect<PeekedTaskOutcome, RealtasksAdapterError> => {
          if (params.taskId.trim() === "" || params.taskId === "all") {
            return Effect.fail(
              new RealtasksAdapterError({
                taskId: Option.some(params.taskId),
                reason: "Task ID must be an exact non-empty realtasks identifier, never 'all'",
                unavailableFromSession: false,
              }),
            )
          }

          return Effect.all({
            res: params.invoker(
              "task_output",
              { id: params.taskId, peek: true, tail_lines: 40 },
              params.signal,
            ),
            metaOpt: Ref.get(observedTasksRef).pipe(Effect.map((m) => Option.fromUndefinedOr(m.get(params.taskId)))),
          }).pipe(
            Effect.flatMap(({ res, metaOpt }): Effect.Effect<PeekedTaskOutcome, RealtasksAdapterError> => {
              if (res.isError) {
                const lower = res.contentText.toLowerCase()
                const unknownTask =
                  lower.includes("unknown task") ||
                  lower.includes("no task matching") ||
                  lower.includes("not found")
                if (unknownTask && params.originatingSessionId !== params.currentSessionId) {
                  return Effect.succeed({
                    taskId: params.taskId,
                    status: "unavailable",
                    exitCode: Option.none(),
                    readinessTimedOut: false,
                    outputPreview: res.contentText,
                  })
                }
                return Effect.fail(
                  new RealtasksAdapterError({
                    taskId: Option.some(params.taskId),
                    reason: `task_output peek failed for ${params.taskId}: ${res.contentText}`,
                    unavailableFromSession: false,
                  }),
                )
              }

              const decodedOpt = Schema.decodeUnknownOption(RealtasksReadDetailsSchema)(res.details)
              return Option.match(decodedOpt, {
                onNone: () =>
                  Effect.fail(
                    new RealtasksAdapterError({
                      taskId: Option.some(params.taskId),
                      reason: `Incompatible realtasks task_output details shape for ${params.taskId}`,
                      unavailableFromSession: false,
                    }),
                  ),
                onSome: (details) => {
                  const readinessState = Option.match(metaOpt, {
                    onNone: () => "none" as const,
                    onSome: (m) => m.readinessState,
                  })
                  const effectiveStatus: ObservedTaskStatus =
                    details.status === "running" && readinessState === "ready"
                      ? "ready"
                      : details.status

                  return Effect.succeed({
                    taskId: details.id,
                    status: effectiveStatus,
                    exitCode: Option.map(details.exitCode, (n) => Math.trunc(n)),
                    readinessTimedOut: readinessState === "timed_out",
                    outputPreview: res.contentText,
                  })
                },
              })
            }),
          )
        }

        return RealtasksAdapter.of({
          recordToolExecutionStart: (params) => {
            const argsObj = Predicate.isObject(params.args) ? (params.args as Record<string, unknown>) : {}
            const rawNotify = argsObj["notify"]
            const notifyPolicy: "wake" | "passive" | "silent" | "unknown" =
              rawNotify === "wake" || rawNotify === "passive" || rawNotify === "silent"
                ? rawNotify
                : params.toolName === "bash" || params.toolName === "monitor"
                  ? "wake"
                  : "unknown"
            const hadReady = argsObj["ready"] !== undefined
            return Ref.update(pendingCallsRef, (map) => {
              const next = new Map(map)
              next.set(params.toolCallId, {
                toolName: params.toolName,
                notifyPolicy,
                hadReady,
                parentToolCallId: Option.fromUndefinedOr(params.parentToolCallId),
              })
              return next
            })
          },

          recordToolExecutionEnd: (params) =>
            Ref.modify(pendingCallsRef, (map) => {
              const entry = map.get(params.toolCallId)
              const next = new Map(map)
              next.delete(params.toolCallId)
              return [Option.fromUndefinedOr(entry), next] as const
            }).pipe(
              Effect.flatMap((callMetaOpt) => {
                const resObj = Predicate.isObject(params.result)
                  ? (params.result as Record<string, unknown>)
                  : {}
                const rawDetails = resObj["details"]
                const contentArr = Array.isArray(resObj["content"]) ? resObj["content"] : []
                const contentText = contentArr
                  .map((c) => (Predicate.isObject(c) && typeof c["text"] === "string" ? c["text"] : ""))
                  .join("\n")

                if (params.toolName === "bash" || params.toolName === "monitor") {
                  const bashDetailsOpt = Schema.decodeUnknownOption(RealtasksBashDetailsSchema)(rawDetails)
                  const taskIdOpt = Option.flatMap(bashDetailsOpt, (d) => d.taskId)
                  return Option.match(taskIdOpt, {
                    onNone: () => Effect.succeed(Option.none<ObservedRuntimeTaskMeta>()),
                    onSome: (taskId) => {
                      const hadReady = Option.match(callMetaOpt, { onNone: () => false, onSome: (m) => m.hadReady })
                      const readinessState = classifyBashReadiness(contentText, params.isError, hadReady)
                      const rawStatusStr = Option.getOrElse(
                        Option.flatMap(bashDetailsOpt, (d) => d.status),
                        () => (params.isError ? "failed" : "completed"),
                      )
                      const mappedStatus: ObservedTaskStatus =
                        readinessState === "ready"
                          ? "ready"
                          : Option.getOrElse(mapRawStatus(rawStatusStr), () => "running")

                      const meta: ObservedRuntimeTaskMeta = {
                        taskId,
                        sessionId: params.sessionId,
                        toolCallId: params.toolCallId,
                        parentToolCallId: Option.orElse(
                          Option.fromUndefinedOr(params.parentToolCallId),
                          () => Option.flatMap(callMetaOpt, (m) => m.parentToolCallId),
                        ),
                        notifyPolicy: Option.match(callMetaOpt, {
                          onNone: () => "wake",
                          onSome: (m) => m.notifyPolicy,
                        }),
                        readinessState,
                        lastStatus: mappedStatus,
                        observedAt: params.nowIso,
                      }
                      return Ref.update(observedTasksRef, (m) => {
                        const next = new Map(m)
                        next.set(taskId, meta)
                        return next
                      }).pipe(Effect.as(Option.some(meta)))
                    },
                  })
                }

                if (params.toolName === "task_output") {
                  const readOpt = Schema.decodeUnknownOption(RealtasksReadDetailsSchema)(rawDetails)
                  return Option.match(readOpt, {
                    onNone: () => Effect.succeed(Option.none<ObservedRuntimeTaskMeta>()),
                    onSome: (d) =>
                      Ref.modify(observedTasksRef, (m) => {
                        const prev = m.get(d.id)
                        const meta: ObservedRuntimeTaskMeta = {
                          taskId: d.id,
                          sessionId: prev?.sessionId ?? params.sessionId,
                          toolCallId: prev?.toolCallId ?? params.toolCallId,
                          parentToolCallId: Option.fromUndefinedOr(params.parentToolCallId),
                          notifyPolicy: prev?.notifyPolicy ?? "unknown",
                          readinessState: prev?.readinessState ?? "none",
                          lastStatus:
                            d.status === "running" && prev?.readinessState === "ready"
                              ? "ready"
                              : d.status,
                          observedAt: params.nowIso,
                        }
                        const next = new Map(m)
                        next.set(d.id, meta)
                        return [Option.some(meta), next] as const
                      }),
                  })
                }

                return Effect.succeed(Option.none())
              }),
            ),

          getObservedTaskMeta: (taskId) =>
            Ref.get(observedTasksRef).pipe(Effect.map((m) => Option.fromUndefinedOr(m.get(taskId)))),

          peekTaskOnce: peekTaskOnceImpl,

          reconcileAndEnterWait: (params) =>
            Ref.get(observedTasksRef).pipe(
              Effect.flatMap((observedMap): Effect.Effect<WorkItemState, RealgoalError> => {
                for (const req of params.requests) {
                  const meta = observedMap.get(req.taskId)
                  const effectivePolicy = req.notifyPolicy ?? meta?.notifyPolicy ?? "unknown"
                  if (effectivePolicy === "passive" || effectivePolicy === "silent") {
                    return Effect.fail(
                      new RealtasksAdapterError({
                        taskId: Option.some(req.taskId),
                        reason: `Task ${req.taskId} has notify="${effectivePolicy}", which will NOT automatically wake the agent. Do not enter an unattended wait; use manual /realgoal resume or an explicit intentional task_wait.`,
                        unavailableFromSession: false,
                      }),
                    )
                  }
                }

                return Effect.forEach(params.requests, (req) => {
                  const existing = params.state.trackedTasks.find((t) => t.taskId === req.taskId)
                  const meta = observedMap.get(req.taskId)
                  const origSession = existing?.sessionId ?? meta?.sessionId ?? params.currentSessionId

                  return peekTaskOnceImpl({
                    invoker: params.invoker,
                    taskId: req.taskId,
                    currentSessionId: params.currentSessionId,
                    originatingSessionId: origSession,
                    signal: params.signal,
                  }).pipe(
                    Effect.map((peeked): TaskBinding => {
                      const policy = req.notifyPolicy ?? meta?.notifyPolicy ?? existing?.notifyPolicy ?? "wake"
                      const statusForBinding: ObservedTaskStatus =
                        req.waitCondition.kind === "ready" && peeked.readinessTimedOut
                          ? "running"
                          : peeked.status

                      return {
                        taskId: peeked.taskId,
                        sessionId: origSession,
                        originatingToolCallId: meta
                          ? Option.some(meta.toolCallId)
                          : existing?.originatingToolCallId ?? Option.none(),
                        workerId: existing?.workerId ?? Option.none(),
                        workItemId: params.state.id,
                        todoId: req.todoId,
                        purpose: req.purpose,
                        ownership: req.ownership,
                        waitCondition: req.waitCondition,
                        resumePhase: params.resumePhase,
                        requireSuccess: req.requireSuccess,
                        lastStatus: statusForBinding,
                        lastExitCode: peeked.exitCode,
                        lastObservedAt: params.nowIso,
                        observationSource: "task_output:peek",
                        notifyPolicy: policy,
                        autoWakeAvailable: policy === "wake",
                        retainedResource: existing?.retainedResource ?? false,
                        readinessTimedOut: peeked.readinessTimedOut,
                      }
                    }),
                  )
                }).pipe(
                  Effect.map((bindings) =>
                    bindTasksAndMaybeWait(params.state, {
                      bindings,
                      mode: params.mode,
                      enterWait: true,
                      resumePhase: params.resumePhase,
                      nowIso: params.nowIso,
                    }),
                  ),
                )
              }),
            ),

          reconcileTrackedTasksOnce: (params) => {
            const filterSet = params.onlyTaskIds ? new Set(params.onlyTaskIds) : undefined
            const targets = params.state.trackedTasks.filter((t) =>
              filterSet ? filterSet.has(t.taskId) : t.lastStatus === "running" || t.lastStatus === "ready",
            )
            return Effect.reduce(targets, () => params.state, (accState, binding) =>
              peekTaskOnceImpl({
                invoker: params.invoker,
                taskId: binding.taskId,
                currentSessionId: params.currentSessionId,
                originatingSessionId: binding.sessionId,
                signal: params.signal,
              }).pipe(
                Effect.map((peeked) => {
                  const rec = reconcileObservedTask(accState, {
                    taskId: peeked.taskId,
                    status: peeked.status,
                    exitCode: peeked.exitCode,
                    source: "reconcile:peek",
                    readinessTimedOut: peeked.readinessTimedOut,
                    nowIso: params.nowIso,
                  })
                  return rec.state
                }),
              ),
            )
          },

          applyNotificationHints: (params) =>
            Effect.sync(() => {
              let current = params.state
              let anyWoke = false
              for (const hint of params.hints) {
                if (Option.isNone(hint.inferredStatus)) continue
                const outcome = reconcileObservedTask(current, {
                  taskId: hint.taskId,
                  status: hint.inferredStatus.value,
                  exitCode: Option.none(),
                  source: "notification_hint",
                  eventKey: hint.eventKey,
                  nowIso: params.nowIso,
                })
                current = outcome.state
                if (outcome.wokeFromWait) {
                  anyWoke = true
                }
              }
              return { state: current, anyWoke }
            }),

          stopAuthorizedTasks: (params) => {
            if (params.taskIds.some((id) => id === "all" || id.trim() === "")) {
              return Effect.fail(
                new RealtasksAdapterError({
                  taskId: Option.some("all"),
                  reason: "Generic task_stop('all') is forbidden; specify exact authorized tracked task IDs.",
                  unavailableFromSession: false,
                }),
              )
            }
            const auth = params.state.authorizations.find(
              (a) => a.id === params.authorizationId && a.kind === "cleanup_tasks",
            )
            if (!auth) {
              return Effect.fail(
                new AuthorizationRequiredError({
                  workItemId: params.state.id,
                  decisionKind: "cleanup_tasks",
                  message: "Stopping tasks requires an explicit user cleanup_tasks authorization",
                }),
              )
            }
            const trackedSet = new Set(params.state.trackedTasks.map((t) => t.taskId))
            const authorizedSet = new Set(auth.taskIds)
            const unauthorized = params.taskIds.filter(
              (id) => !trackedSet.has(id) || !authorizedSet.has(id),
            )
            if (unauthorized.length > 0) {
              return Effect.fail(
                new AuthorizationRequiredError({
                  workItemId: params.state.id,
                  decisionKind: "cleanup_tasks",
                  message: `Task IDs are not both tracked on this work item and user-authorized for cleanup: ${unauthorized.join(", ")}`,
                }),
              )
            }

            return Effect.forEach(params.taskIds, (taskId) =>
              params.invoker("task_stop", { id: taskId }, params.signal).pipe(
                Effect.map((res) => ({
                  taskId,
                  stopped: !res.isError,
                  output: res.contentText,
                })),
              ),
            )
          },
        })
      }),
    ),
  )
}
