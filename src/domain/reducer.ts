import { Effect, Match, Option } from "effect"
import type { ResolvedRealgoalConfig } from "./config.ts"
import {
  AuthorizationRequiredError,
  FinishRejectedError,
  InvalidTransitionError,
  QuestionConflictError,
  StaleRevisionError,
  TodoContractError,
  type RealgoalError,
} from "./errors.ts"
import {
  SCHEMA_VERSION,
  emptyConfigOverrides,
  type AcceptanceCriterion,
  type AuthorizationKind,
  type CompletionScope,
  type DecisionRecord,
  type Difficulty,
  type DraftReviewReport,
  type DurableQuestion,
  type EvidenceRecord,
  type ExecutionDriver,
  type ObservedTaskStatus,
  type OwnerToken,
  type PreviewArtifact,
  type PublicationRecord,
  type QuestionAnswer,
  type QuestionOption,
  type RunStatus,
  type TaskBinding,
  type TaskWaitCondition,
  type TodoItem,
  type TodoReviewSummary,
  type TransitionOrigin,
  type UserAuthorization,
  type VerificationDriver,
  type WorkerJobRecord,
  type WorkItemState,
  type WorkflowKind,
  type WorkflowPhase,
} from "./models.ts"
import { computeReviewInputManifestHash, sha256Hex } from "../services/path-safety.ts"

const GOAL_LEGAL_NEXT: Record<string, ReadonlySet<string>> = {
  intake: new Set(["explore", "analyze"]),
  explore: new Set(["analyze", "explore"]),
  analyze: new Set(["process", "explore", "analyze"]),
  process: new Set(["verify", "analyze", "explore", "process"]),
  verify: new Set(["process", "analyze", "explore", "verify"]),
  complete: new Set([]),
}

const PLAN_LEGAL_NEXT: Record<string, ReadonlySet<string>> = {
  intake: new Set(["discovery", "design", "analysis"]),
  discovery: new Set(["discovery", "design", "analysis", "finalization"]),
  design: new Set(["discovery", "design", "analysis", "finalization"]),
  analysis: new Set(["discovery", "design", "analysis", "finalization"]),
  finalization: new Set(["draft_review", "publication_choice", "discovery", "design", "analysis"]),
  draft_review: new Set(["publication_choice", "discovery", "design", "analysis", "draft_review"]),
  publication_choice: new Set(["publication", "discovery", "design", "analysis"]),
  publication: new Set(["execution_choice", "publication_choice", "discovery", "design", "analysis"]),
  execution_choice: new Set(["lookup", "discovery", "design", "analysis"]),
  lookup: new Set(["implement", "verify_goal", "lookup"]),
  implement: new Set(["verify_item", "lookup", "implement"]),
  verify_item: new Set(["lookup", "implement", "verify_goal", "verify_item"]),
  verify_goal: new Set(["lookup", "implement", "verify_goal"]),
  complete: new Set([]),
}

export const PLANNING_ONLY_PHASES: ReadonlySet<WorkflowPhase> = new Set<WorkflowPhase>([
  "intake",
  "discovery",
  "design",
  "analysis",
  "finalization",
  "draft_review",
  "publication_choice",
  "publication",
  "execution_choice",
])

export const isPlanningPhase = (state: WorkItemState): boolean =>
  state.kind === "plan" && PLANNING_ONLY_PHASES.has(state.phase)

export const inferCompletionScope = (objective: string, kind: WorkflowKind): CompletionScope => {
  const lower = objective.toLowerCase()
  const artifactOnly =
    /\b(only\s+(?:a\s+)?(?:spec|specification|plan|design)|spec\s+only|plan\s+only|do\s+not\s+implement|without\s+implementing)\b/.test(
      lower,
    )
  if (artifactOnly) return "artifact"
  return kind === "plan" && /\bwrite\s+(?:a\s+)?specification\b/.test(lower) && !/\bimplement\b/.test(lower)
    ? "artifact"
    : "implementation"
}

export const createInitialWorkItem = (params: {
  readonly id: string
  readonly displayName: string
  readonly safeDirName: string
  readonly workspacePath: string
  readonly sessionId: string
  readonly owner: OwnerToken
  readonly kind: WorkflowKind
  readonly objective: string
  readonly constraints?: ReadonlyArray<string>
  readonly nonGoals?: ReadonlyArray<string>
  readonly acceptanceCriteria?: ReadonlyArray<string>
  readonly completionScope?: CompletionScope
  readonly verificationDriver?: VerificationDriver
  readonly nowIso: string
}): WorkItemState => {
  const criteriaList: ReadonlyArray<AcceptanceCriterion> =
    (params.acceptanceCriteria ?? []).length > 0
      ? (params.acceptanceCriteria ?? []).map((desc, idx) => ({
          id: `C${String(idx + 1).padStart(3, "0")}`,
          description: desc,
          required: true,
          deferredReason: Option.none(),
          waiverAuthorizationId: Option.none(),
          evidenceIds: [],
        }))
      : [
          {
            id: "C001",
            description: `Satisfy objective: ${params.objective}`,
            required: true,
            deferredReason: Option.none(),
            waiverAuthorizationId: Option.none(),
            evidenceIds: [],
          },
        ]

  const initialTodos: ReadonlyArray<TodoItem> =
    params.kind === "goal"
      ? [
          {
            id: "T001",
            title: params.displayName,
            description: params.objective,
            stage: "main",
            order: 1,
            dependencyIds: [],
            goal: params.objective,
            inScope: [params.objective],
            outOfScope: [...(params.nonGoals ?? [])],
            acceptanceCriteria: criteriaList.map((c) => c.id),
            difficulty: "medium",
            difficultyRationale: "Initial implicit TODO for lightweight goal",
            status: "pending",
            attempt: 0,
            implementationNotes: [],
            evidenceIds: [],
            reviewResult: Option.none(),
            associatedTaskIds: [],
            associatedWorkerIds: [],
            skipAuthorizationId: Option.none(),
            history: [
              {
                timestamp: params.nowIso,
                action: "created",
                reason: "Implicit goal TODO created at intake",
                actor: "controller",
              },
            ],
          },
        ]
      : []

  const completionScope = params.completionScope ?? inferCompletionScope(params.objective, params.kind)

  return {
    schemaVersion: SCHEMA_VERSION,
    id: params.id,
    displayName: params.displayName,
    safeDirName: params.safeDirName,
    createdAt: params.nowIso,
    updatedAt: params.nowIso,
    revision: 1,
    workspacePath: params.workspacePath,
    originatingSessionId: params.sessionId,
    owner: Option.some(params.owner),
    kind: params.kind,
    phase: "intake",
    runStatus: "running",
    objective: params.objective,
    nonGoals: [...(params.nonGoals ?? [])],
    constraints: [...(params.constraints ?? [])],
    acceptanceCriteria: criteriaList,
    completionScope,
    todos: initialTodos,
    questions: [],
    decisions: [],
    authorizations: [],
    evidence: [],
    artifactHashes: {},
    finalizedCandidateHash: Option.none(),
    draftGateWaiverId: Option.none(),
    reviews: [],
    publications: [],
    previews: [],
    executionDriver: Option.none(),
    verificationDriver: params.verificationDriver ?? "direct",
    trackedTasks: [],
    activeWaitGroup: Option.none(),
    workers: [],
    consumedEventKeys: [],
    operationIds: [],
    nextAction:
      params.kind === "goal"
        ? "Establish scope/acceptance criteria in intake, then explore or analyze before processing."
        : "Inspect project context and establish goals, constraints, and open questions in discovery.",
    pauseOrBlockReason: Option.none(),
    goalLevelVerifiedRevision: Option.none(),
    retainedResourceIds: [],
    completionSummary: Option.none(),
    archived: false,
    progress: {
      noProgressContinuations: 0,
      repeatedFailureCount: 0,
      lastFailureFingerprint: Option.none(),
      recentFingerprints: [],
      lastMeaningfulProgressAt: params.nowIso,
      lastProgressKind: "created",
      lastContinuationBoundaryKey: Option.none(),
      totalContinuations: 0,
    },
    transitions: [
      {
        fromPhase: "intake",
        toPhase: "intake",
        fromStatus: "running",
        toStatus: "running",
        reason: `Created ${params.kind} work item`,
        revision: 1,
        origin: "user",
        timestamp: params.nowIso,
      },
    ],
    configOverrides: emptyConfigOverrides(),
  }
}

export const checkRevision = (
  state: WorkItemState,
  expectedRevision: number,
  operationId?: string,
): Effect.Effect<{ readonly alreadyApplied: boolean }, StaleRevisionError> => {
  if (operationId !== undefined && state.operationIds.includes(operationId)) {
    return Effect.succeed({ alreadyApplied: true })
  }
  if (state.revision !== expectedRevision) {
    return Effect.fail(
      new StaleRevisionError({
        workItemId: state.id,
        expectedRevision,
        actualRevision: state.revision,
        message: `Stale state revision for ${state.id}: expected ${expectedRevision}, actual ${state.revision}`,
      }),
    )
  }
  return Effect.succeed({ alreadyApplied: false })
}

const bumpRevision = (
  state: WorkItemState,
  nowIso: string,
  operationId?: string,
  qualifyingProgressKind?: string,
): WorkItemState => {
  const nextOpIds =
    operationId !== undefined && !state.operationIds.includes(operationId)
      ? [...state.operationIds.slice(-255), operationId]
      : state.operationIds

  const nextProgress =
    qualifyingProgressKind !== undefined
      ? {
          ...state.progress,
          noProgressContinuations: 0,
          repeatedFailureCount: 0,
          lastFailureFingerprint: Option.none(),
          lastMeaningfulProgressAt: nowIso,
          lastProgressKind: qualifyingProgressKind,
        }
      : state.progress

  return {
    ...state,
    revision: state.revision + 1,
    updatedAt: nowIso,
    operationIds: nextOpIds,
    progress: nextProgress,
  }
}

const appendTransition = (
  state: WorkItemState,
  toPhase: WorkflowPhase,
  toStatus: RunStatus,
  reason: string,
  origin: TransitionOrigin,
  nowIso: string,
): ReadonlyArray<WorkItemState["transitions"][number]> => [
  ...state.transitions.slice(-199),
  {
    fromPhase: state.phase,
    toPhase,
    fromStatus: state.runStatus,
    toStatus,
    reason,
    revision: state.revision + 1,
    origin,
    timestamp: nowIso,
  },
]

export const computeCurrentManifestHash = (
  state: WorkItemState,
  finalizedHash: string,
): string => {
  const requestHash = sha256Hex(
    JSON.stringify({
      objective: state.objective,
      nonGoals: state.nonGoals,
      constraints: state.constraints,
    }),
  )
  const criteriaHash = sha256Hex(
    JSON.stringify(
      state.acceptanceCriteria.map((c) => ({
        id: c.id,
        description: c.description,
        required: c.required,
        deferredReason: Option.getOrNull(c.deferredReason),
      })),
    ),
  )
  const materialDecisions = state.decisions
    .filter((d) => d.material)
    .map((d) => ({ id: d.id, category: d.category, summary: d.summary }))
  const decisionsHash = sha256Hex(JSON.stringify(materialDecisions))
  return computeReviewInputManifestHash({
    finalizedHash,
    requestHash,
    criteriaHash,
    decisionsHash,
    projectFileHashes: state.artifactHashes,
  })
}

export const hasValidDraftReviewApproval = (state: WorkItemState): boolean =>
  Option.match(state.finalizedCandidateHash, {
    onNone: () => false,
    onSome: (finalizedHash) => {
      const hasWaiver = Option.match(state.draftGateWaiverId, {
        onNone: () => false,
        onSome: (waiverId) =>
          state.authorizations.some((a) => a.id === waiverId && a.kind === "waive_draft_gate"),
      })
      if (hasWaiver) {
        return true
      }
      const expectedManifest = computeCurrentManifestHash(state, finalizedHash)
      const matchingReview = [...state.reviews]
        .reverse()
        .find((r) => r.inputManifestHash === expectedManifest && r.finalizedHash === finalizedHash)
      if (!matchingReview) return false
      const hasUnresolvedBlocking = matchingReview.findings.some((f) => f.severity === "blocking" && !f.resolved)
      return matchingReview.verdict === "pass" && !hasUnresolvedBlocking
    },
  })

export const findAuthorization = (
  state: WorkItemState,
  kind: AuthorizationKind,
  artifactHash?: string,
): Option.Option<UserAuthorization> => {
  const found = [...state.authorizations].reverse().find((a) => {
    if (a.kind !== kind) return false
    if (artifactHash !== undefined && Option.isSome(a.artifactHash)) {
      return a.artifactHash.value === artifactHash
    }
    return true
  })
  return Option.fromUndefinedOr(found)
}

export const recordUserAuthorization = (
  state: WorkItemState,
  auth: UserAuthorization,
  nowIso: string,
): WorkItemState => {
  const bumped = bumpRevision(state, nowIso, undefined, `authorization:${auth.kind}`)
  return {
    ...bumped,
    authorizations: [...state.authorizations, auth],
  }
}

export const advancePhase = (
  state: WorkItemState,
  params: {
    readonly expectedRevision: number
    readonly operationId: string
    readonly targetPhase: WorkflowPhase
    readonly reason: string
    readonly nextAction: string
    readonly origin: TransitionOrigin
    readonly draftGateEnabled: boolean
    readonly nowIso: string
  },
): Effect.Effect<WorkItemState, RealgoalError> =>
  checkRevision(state, params.expectedRevision, params.operationId).pipe(
    Effect.flatMap(({ alreadyApplied }): Effect.Effect<WorkItemState, RealgoalError> => {
      if (alreadyApplied) return Effect.succeed(state)

      if (state.runStatus === "finished" || state.runStatus === "cancelled") {
        return Effect.fail(
          new InvalidTransitionError({
            workItemId: state.id,
            fromPhase: state.phase,
            toPhase: params.targetPhase,
            fromStatus: state.runStatus,
            toStatus: state.runStatus,
            reason: `Cannot advance terminal work item (${state.runStatus})`,
            missingConditions: [`Work item is already ${state.runStatus}`],
          }),
        )
      }

      if (params.targetPhase === "complete") {
        return Effect.fail(
          new InvalidTransitionError({
            workItemId: state.id,
            fromPhase: state.phase,
            toPhase: "complete",
            fromStatus: state.runStatus,
            toStatus: state.runStatus,
            reason: "Cannot advance to 'complete' via advance; call realgoal_finish explicitly.",
            missingConditions: ["Use realgoal_finish to validate and commit goal completion"],
          }),
        )
      }

      const table = state.kind === "goal" ? GOAL_LEGAL_NEXT : PLAN_LEGAL_NEXT
      const allowed = table[state.phase]
      if (!allowed || !allowed.has(params.targetPhase)) {
        return Effect.fail(
          new InvalidTransitionError({
            workItemId: state.id,
            fromPhase: state.phase,
            toPhase: params.targetPhase,
            fromStatus: state.runStatus,
            toStatus: state.runStatus,
            reason: `Illegal phase transition for ${state.kind}: ${state.phase} -> ${params.targetPhase}`,
            missingConditions: [`Allowed next phases from ${state.phase}: ${[...(allowed ?? [])].join(", ") || "none"}`],
          }),
        )
      }

      if (state.kind === "goal" && state.phase === "intake" && params.targetPhase === "analyze") {
        if (params.reason.trim().length < 3) {
          return Effect.fail(
            new InvalidTransitionError({
              workItemId: state.id,
              fromPhase: state.phase,
              toPhase: params.targetPhase,
              fromStatus: state.runStatus,
              toStatus: state.runStatus,
              reason: "Skipping explore requires a brief recorded reason",
              missingConditions: ["Provide reason explaining why exploration is skipped"],
            }),
          )
        }
      }

      if (state.kind === "plan") {
        if (params.targetPhase === "finalization" && Option.isNone(state.finalizedCandidateHash)) {
          return Effect.fail(
            new InvalidTransitionError({
              workItemId: state.id,
              fromPhase: state.phase,
              toPhase: params.targetPhase,
              fromStatus: state.runStatus,
              toStatus: state.runStatus,
              reason: "finalized.md must be registered via finalize before entering finalization/publication",
              missingConditions: ["Register candidate finalized.md via realgoal_control(action: 'finalize')"],
            }),
          )
        }

        if (params.targetPhase === "publication_choice") {
          if (Option.isNone(state.finalizedCandidateHash)) {
            return Effect.fail(
              new InvalidTransitionError({
                workItemId: state.id,
                fromPhase: state.phase,
                toPhase: params.targetPhase,
                fromStatus: state.runStatus,
                toStatus: state.runStatus,
                reason: "Missing finalized.md candidate hash",
                missingConditions: ["Finalize draft first"],
              }),
            )
          }
          if (params.draftGateEnabled && !hasValidDraftReviewApproval(state)) {
            return Effect.fail(
              new InvalidTransitionError({
                workItemId: state.id,
                fromPhase: state.phase,
                toPhase: params.targetPhase,
                fromStatus: state.runStatus,
                toStatus: state.runStatus,
                reason: "Independent draft review gate is enabled and has not passed for the current input manifest",
                missingConditions: [
                  "Obtain a passing draft_review for the current finalized.md and decisions, or record user waiver",
                ],
              }),
            )
          }
        }

        if (params.targetPhase === "publication") {
          const finHash = Option.getOrUndefined(state.finalizedCandidateHash)
          const hasPubAuth =
            Option.isSome(findAuthorization(state, "publish_spec", finHash)) ||
            Option.isSome(findAuthorization(state, "publish_plan", finHash)) ||
            Option.isSome(findAuthorization(state, "publish_both", finHash))
          if (!hasPubAuth) {
            return Effect.fail(
              new AuthorizationRequiredError({
                workItemId: state.id,
                decisionKind: "publication_choice",
                message: "User publication authorization is required before entering publication phase",
              }),
            )
          }
        }

        if (params.targetPhase === "lookup") {
          if (state.phase === "execution_choice") {
            const hasPlanPub = state.publications.some((p) => p.target === "plan" && p.status === "completed")
            const hasDirect = Option.isSome(findAuthorization(state, "execute_direct"))
            const hasSubagent = Option.isSome(findAuthorization(state, "execute_subagent"))
            if (!hasPlanPub || (!hasDirect && !hasSubagent)) {
              return Effect.fail(
                new AuthorizationRequiredError({
                  workItemId: state.id,
                  decisionKind: "execution_choice",
                  message:
                    "Planning cannot silently become implementation: published plan and explicit user execution choice (direct or subagent) are required.",
                }),
              )
            }
          }
        }
      }

      const nextStatus: RunStatus =
        params.targetPhase === "publication_choice" || params.targetPhase === "execution_choice"
          ? "awaiting_user"
          : state.runStatus === "awaiting_user" && params.origin === "user"
            ? "running"
            : state.runStatus

      const transitions = appendTransition(
        state,
        params.targetPhase,
        nextStatus,
        params.reason,
        params.origin,
        params.nowIso,
      )
      const bumped = bumpRevision(state, params.nowIso, params.operationId, `phase:${params.targetPhase}`)
      const selectedDriver: Option.Option<ExecutionDriver> =
        params.targetPhase === "lookup" && Option.isNone(state.executionDriver)
          ? Option.isSome(findAuthorization(state, "execute_subagent"))
            ? Option.some("subagent")
            : Option.some("direct")
          : state.executionDriver

      return Effect.succeed({
        ...bumped,
        phase: params.targetPhase,
        runStatus: nextStatus,
        executionDriver: selectedDriver,
        nextAction: params.nextAction,
        transitions,
      })
    }),
  )

export const registerFinalizedCandidate = (
  state: WorkItemState,
  params: {
    readonly expectedRevision: number
    readonly operationId: string
    readonly finalizedHash: string
    readonly draftGateEnabled: boolean
    readonly nowIso: string
  },
): Effect.Effect<WorkItemState, RealgoalError> =>
  checkRevision(state, params.expectedRevision, params.operationId).pipe(
    Effect.flatMap(({ alreadyApplied }) => {
      if (alreadyApplied) return Effect.succeed(state)
      if (state.kind !== "plan") {
        return Effect.fail(
          new InvalidTransitionError({
            workItemId: state.id,
            fromPhase: state.phase,
            toPhase: "finalization",
            fromStatus: state.runStatus,
            toStatus: state.runStatus,
            reason: "finalize is only applicable to /plan workflows",
            missingConditions: ["Workflow kind must be 'plan'"],
          }),
        )
      }
      const pendingBlockingQ = state.questions.filter((q) => q.blocking && q.status === "pending")
      if (pendingBlockingQ.length > 0) {
        return Effect.fail(
          new InvalidTransitionError({
            workItemId: state.id,
            fromPhase: state.phase,
            toPhase: "finalization",
            fromStatus: state.runStatus,
            toStatus: state.runStatus,
            reason: "Cannot finalize while blocking questions remain unanswered",
            missingConditions: pendingBlockingQ.map((q) => `Unresolved blocking question ${q.id}: ${q.title}`),
          }),
        )
      }

      const withHash: WorkItemState = {
        ...state,
        finalizedCandidateHash: Option.some(params.finalizedHash),
        artifactHashes: {
          ...state.artifactHashes,
          "finalized.md": params.finalizedHash,
        },
      }
      const gatePassed = !params.draftGateEnabled || hasValidDraftReviewApproval(withHash)
      const nextPhase: WorkflowPhase = gatePassed ? "publication_choice" : "draft_review"
      const nextStatus: RunStatus = gatePassed ? "awaiting_user" : "running"
      const nextAction = gatePassed
        ? "Await user publication choice (/realgoal publish or menu: spec, plan, both, refine, or stop here)."
        : "Dispatch independent draft_review worker via realgoal_delegate for finalized.md."

      const transitions = appendTransition(
        state,
        nextPhase,
        nextStatus,
        `Registered finalized.md (${params.finalizedHash.slice(0, 12)})`,
        "agent_tool",
        params.nowIso,
      )
      const bumped = bumpRevision(withHash, params.nowIso, params.operationId, "finalized_candidate")
      return Effect.succeed({
        ...bumped,
        phase: nextPhase,
        runStatus: nextStatus,
        nextAction,
        transitions,
      })
    }),
  )

export const recordDraftReviewReport = (
  state: WorkItemState,
  report: DraftReviewReport,
  nowIso: string,
): WorkItemState => {
  const hasBlocking = report.findings.some((f) => f.severity === "blocking" && !f.resolved)
  const passed = report.verdict === "pass" && !hasBlocking
  const nextPhase: WorkflowPhase = passed
    ? "publication_choice"
    : report.verdict === "changes_required"
      ? "design"
      : state.phase
  const nextStatus: RunStatus = passed
    ? "awaiting_user"
    : report.verdict === "blocked"
      ? "blocked"
      : state.runStatus === "paused"
        ? "paused"
        : "running"
  const reason = passed
    ? `Draft review ${report.id} passed`
    : `Draft review ${report.id} returned ${report.verdict}`

  const transitions = appendTransition(state, nextPhase, nextStatus, reason, "dependency_event", nowIso)
  const bumped = bumpRevision(state, nowIso, undefined, passed ? "draft_review_pass" : undefined)

  return {
    ...bumped,
    phase: nextPhase,
    runStatus: nextStatus,
    pauseOrBlockReason:
      report.verdict === "blocked" ? Option.some(`Draft review blocked: ${report.summary}`) : state.pauseOrBlockReason,
    reviews: [...state.reviews, report],
    nextAction: passed
      ? "Draft review passed. Present publication choice to user."
      : "Address blocking review findings in design/finalized.md and re-run review.",
    transitions,
  }
}

export const detectTodoCycle = (todos: ReadonlyArray<TodoItem>): Option.Option<ReadonlyArray<string>> => {
  const byId = new Map(todos.map((t) => [t.id, t]))
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const dfs = (id: string, stack: ReadonlyArray<string>): Option.Option<ReadonlyArray<string>> => {
    if (visiting.has(id)) {
      return Option.some([...stack, id])
    }
    if (visited.has(id)) {
      return Option.none()
    }
    visiting.add(id)
    const item = byId.get(id)
    if (item) {
      for (const depId of item.dependencyIds) {
        const cycle = dfs(depId, [...stack, id])
        if (Option.isSome(cycle)) return cycle
      }
    }
    visiting.delete(id)
    visited.add(id)
    return Option.none()
  }

  for (const t of todos) {
    const cycle = dfs(t.id, [])
    if (Option.isSome(cycle)) return cycle
  }
  return Option.none()
}

export const validateTodoGraph = (
  workItemId: string,
  todos: ReadonlyArray<TodoItem>,
): Effect.Effect<void, TodoContractError> => {
  const knownIds = new Set(todos.map((t) => t.id))
  const missingDeps: string[] = []
  for (const t of todos) {
    for (const dep of t.dependencyIds) {
      if (!knownIds.has(dep)) {
        missingDeps.push(`TODO ${t.id} references unknown dependency ${dep}`)
      }
    }
  }
  if (missingDeps.length > 0) {
    return Effect.fail(
      new TodoContractError({
        workItemId,
        todoId: Option.none(),
        reason: "Unknown TODO dependency IDs",
        missingConditions: missingDeps,
      }),
    )
  }
  return Option.match(detectTodoCycle(todos), {
    onNone: () => Effect.void,
    onSome: (cycle) =>
      Effect.fail(
        new TodoContractError({
          workItemId,
          todoId: Option.fromUndefinedOr(cycle[0]),
          reason: `Cyclic TODO dependency detected: ${cycle.join(" -> ")}`,
          missingConditions: [`Remove dependency cycle: ${cycle.join(" -> ")}`],
        }),
      ),
  })
}

export const areDependenciesSatisfied = (todo: TodoItem, allTodos: ReadonlyArray<TodoItem>): boolean => {
  const byId = new Map(allTodos.map((t) => [t.id, t]))
  return todo.dependencyIds.every((depId) => {
    const dep = byId.get(depId)
    if (!dep) return false
    return dep.status === "done" || (dep.status === "skipped" && Option.isSome(dep.skipAuthorizationId))
  })
}

export const selectNextEligibleTodo = (todos: ReadonlyArray<TodoItem>): Option.Option<TodoItem> => {
  const sorted = [...todos].sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id.localeCompare(b.id)))
  const active = sorted.find((t) => t.status === "in_progress" || t.status === "verify_pending")
  if (active) return Option.some(active)
  const nextPending = sorted.find((t) => t.status === "pending" && areDependenciesSatisfied(t, todos))
  return Option.fromUndefinedOr(nextPending)
}

export const isEvidenceFresh = (
  evidence: EvidenceRecord,
  currentArtifactHashes: Record<string, string>,
): boolean => {
  for (const [fileKey, recordedHash] of Object.entries(evidence.reviewedHashes)) {
    const current = currentArtifactHashes[fileKey]
    if (current !== undefined && current !== recordedHash) {
      return false
    }
  }
  return true
}

export type TodoMutationInput =
  | {
      readonly action: "append"
      readonly items: ReadonlyArray<{
        readonly title: string
        readonly description: string
        readonly stage?: string
        readonly dependencyIds?: ReadonlyArray<string>
        readonly goal?: string
        readonly inScope?: ReadonlyArray<string>
        readonly outOfScope?: ReadonlyArray<string>
        readonly acceptanceCriteria?: ReadonlyArray<string>
        readonly difficulty?: Difficulty
        readonly difficultyRationale?: string
      }>
      readonly reason: string
    }
  | {
      readonly action: "update"
      readonly todoId: string
      readonly title?: string
      readonly description?: string
      readonly stage?: string
      readonly dependencyIds?: ReadonlyArray<string>
      readonly goal?: string
      readonly inScope?: ReadonlyArray<string>
      readonly outOfScope?: ReadonlyArray<string>
      readonly acceptanceCriteria?: ReadonlyArray<string>
      readonly difficulty?: Difficulty
      readonly difficultyRationale?: string
      readonly implementationNote?: string
      readonly reason: string
    }
  | {
      readonly action: "reorder"
      readonly orderedIds: ReadonlyArray<string>
      readonly reason: string
    }
  | {
      readonly action: "split"
      readonly todoId: string
      readonly parts: ReadonlyArray<{
        readonly title: string
        readonly description: string
        readonly difficulty?: Difficulty
      }>
      readonly reason: string
    }
  | {
      readonly action: "start"
      readonly todoId: string
    }
  | {
      readonly action: "submit_for_verification"
      readonly todoId: string
      readonly implementationSummary: string
      readonly actor: "agent" | "worker"
    }
  | {
      readonly action: "record_evidence"
      readonly evidence: EvidenceRecord
    }
  | {
      readonly action: "complete"
      readonly todoId: string
      readonly evidenceIds: ReadonlyArray<string>
      readonly reviewSummary?: TodoReviewSummary
    }
  | {
      readonly action: "block"
      readonly todoId: string
      readonly reason: string
    }
  | {
      readonly action: "reopen"
      readonly todoId: string
      readonly reason: string
    }
  | {
      readonly action: "skip"
      readonly todoId: string
      readonly authorizationId: string
      readonly reason: string
      readonly deferCriterionIds?: ReadonlyArray<string>
    }

const nextTodoId = (existing: ReadonlyArray<TodoItem>, offset = 0): string => {
  const maxNum = existing.reduce((acc, item) => {
    const m = /^T(\d+)$/.exec(item.id)
    const n = m ? Number.parseInt(m[1] ?? "0", 10) : 0
    return Math.max(acc, n)
  }, 0)
  return `T${String(maxNum + 1 + offset).padStart(3, "0")}`
}

export const applyTodoMutation = (
  state: WorkItemState,
  expectedRevision: number,
  operationId: string,
  mutation: TodoMutationInput,
  nowIso: string,
): Effect.Effect<WorkItemState, RealgoalError> =>
  checkRevision(state, expectedRevision, operationId).pipe(
    Effect.flatMap(({ alreadyApplied }) => {
      if (alreadyApplied) return Effect.succeed(state)

      return Match.value(mutation).pipe(
        Match.discriminatorsExhaustive("action")({
          append: (m) => {
            if (m.items.length === 0) {
              return Effect.fail(
                new TodoContractError({
                  workItemId: state.id,
                  todoId: Option.none(),
                  reason: "append requires at least one item",
                  missingConditions: ["Provide non-empty items array"],
                }),
              )
            }
            const baseOrder = state.todos.reduce((acc, t) => Math.max(acc, t.order), 0)
            const created: ReadonlyArray<TodoItem> = m.items.map((raw, idx) => ({
              id: nextTodoId(state.todos, idx),
              title: raw.title,
              description: raw.description,
              stage: raw.stage ?? "main",
              order: baseOrder + idx + 1,
              dependencyIds: [...(raw.dependencyIds ?? [])],
              goal: raw.goal ?? raw.title,
              inScope: [...(raw.inScope ?? [raw.title])],
              outOfScope: [...(raw.outOfScope ?? [])],
              acceptanceCriteria: [...(raw.acceptanceCriteria ?? [])],
              difficulty: raw.difficulty ?? "medium",
              difficultyRationale: raw.difficultyRationale ?? "Standard task scope",
              status: "pending",
              attempt: 0,
              implementationNotes: [],
              evidenceIds: [],
              reviewResult: Option.none(),
              associatedTaskIds: [],
              associatedWorkerIds: [],
              skipAuthorizationId: Option.none(),
              history: [
                {
                  timestamp: nowIso,
                  action: "appended",
                  reason: m.reason,
                  actor: "agent",
                },
              ],
            }))
            const nextTodos = [...state.todos, ...created]
            return validateTodoGraph(state.id, nextTodos).pipe(
              Effect.map(() => {
                const bumped = bumpRevision(state, nowIso, operationId, "todo_append")
                return {
                  ...bumped,
                  todos: nextTodos,
                }
              }),
            )
          },
          update: (m) => {
            const target = state.todos.find((t) => t.id === m.todoId)
            if (!target) {
              return Effect.fail(
                new TodoContractError({
                  workItemId: state.id,
                  todoId: Option.some(m.todoId),
                  reason: `Unknown TODO ${m.todoId}`,
                  missingConditions: [`TODO ${m.todoId} does not exist`],
                }),
              )
            }
            const updated: TodoItem = {
              ...target,
              title: m.title ?? target.title,
              description: m.description ?? target.description,
              stage: m.stage ?? target.stage,
              dependencyIds: m.dependencyIds ? [...m.dependencyIds] : target.dependencyIds,
              goal: m.goal ?? target.goal,
              inScope: m.inScope ? [...m.inScope] : target.inScope,
              outOfScope: m.outOfScope ? [...m.outOfScope] : target.outOfScope,
              acceptanceCriteria: m.acceptanceCriteria ? [...m.acceptanceCriteria] : target.acceptanceCriteria,
              difficulty: m.difficulty ?? target.difficulty,
              difficultyRationale: m.difficultyRationale ?? target.difficultyRationale,
              implementationNotes: m.implementationNote
                ? [...target.implementationNotes, m.implementationNote]
                : target.implementationNotes,
              history: [
                ...target.history,
                { timestamp: nowIso, action: "updated", reason: m.reason, actor: "agent" },
              ],
            }
            const nextTodos = state.todos.map((t) => (t.id === m.todoId ? updated : t))
            return validateTodoGraph(state.id, nextTodos).pipe(
              Effect.map(() => {
                const bumped = bumpRevision(state, nowIso, operationId)
                return { ...bumped, todos: nextTodos }
              }),
            )
          },
          reorder: (m) => {
            const orderMap = new Map(m.orderedIds.map((id, idx) => [id, idx + 1]))
            const nextTodos = state.todos.map((t) => {
              const newOrder = orderMap.get(t.id)
              return newOrder !== undefined
                ? {
                    ...t,
                    order: newOrder,
                    history: [
                      ...t.history,
                      { timestamp: nowIso, action: "reordered", reason: m.reason, actor: "agent" as const },
                    ],
                  }
                : t
            })
            const bumped = bumpRevision(state, nowIso, operationId)
            return Effect.succeed({ ...bumped, todos: nextTodos })
          },
          split: (m) => {
            const target = state.todos.find((t) => t.id === m.todoId)
            if (!target) {
              return Effect.fail(
                new TodoContractError({
                  workItemId: state.id,
                  todoId: Option.some(m.todoId),
                  reason: `Unknown TODO ${m.todoId}`,
                  missingConditions: [`TODO ${m.todoId} does not exist`],
                }),
              )
            }
            if (m.parts.length < 2) {
              return Effect.fail(
                new TodoContractError({
                  workItemId: state.id,
                  todoId: Option.some(m.todoId),
                  reason: "split requires at least 2 parts",
                  missingConditions: ["Provide at least 2 parts to split a TODO"],
                }),
              )
            }
            const children: ReadonlyArray<TodoItem> = m.parts.map((part, idx) => ({
              id: idx === 0 ? target.id : nextTodoId(state.todos, idx - 1),
              title: part.title,
              description: part.description,
              stage: target.stage,
              order: target.order + idx,
              dependencyIds: idx === 0 ? target.dependencyIds : [],
              goal: part.title,
              inScope: target.inScope,
              outOfScope: target.outOfScope,
              acceptanceCriteria: target.acceptanceCriteria,
              difficulty: part.difficulty ?? target.difficulty,
              difficultyRationale: target.difficultyRationale,
              status: "pending",
              attempt: target.attempt,
              implementationNotes: target.implementationNotes,
              evidenceIds: [],
              reviewResult: Option.none(),
              associatedTaskIds: [],
              associatedWorkerIds: [],
              skipAuthorizationId: Option.none(),
              history: [
                ...target.history,
                { timestamp: nowIso, action: "split", reason: m.reason, actor: "agent" },
              ],
            }))
            const nextTodos = state.todos.flatMap((t) => (t.id === m.todoId ? children : [t]))
            return validateTodoGraph(state.id, nextTodos).pipe(
              Effect.map(() => {
                const bumped = bumpRevision(state, nowIso, operationId, "todo_split")
                return { ...bumped, todos: nextTodos }
              }),
            )
          },
          start: (m) => {
            const target = state.todos.find((t) => t.id === m.todoId)
            if (!target) {
              return Effect.fail(
                new TodoContractError({
                  workItemId: state.id,
                  todoId: Option.some(m.todoId),
                  reason: `Unknown TODO ${m.todoId}`,
                  missingConditions: [`TODO ${m.todoId} does not exist`],
                }),
              )
            }
            if (isPlanningPhase(state)) {
              return Effect.fail(
                new TodoContractError({
                  workItemId: state.id,
                  todoId: Option.some(m.todoId),
                  reason: "Cannot start implementation TODO while workflow is still in planning phase",
                  missingConditions: ["Publish plan and obtain user execution authorization first"],
                }),
              )
            }
            const otherActive = state.todos.find(
              (t) => t.id !== m.todoId && t.status === "in_progress",
            )
            if (otherActive) {
              return Effect.fail(
                new TodoContractError({
                  workItemId: state.id,
                  todoId: Option.some(m.todoId),
                  reason: `Only 1 active implementation writer is allowed in v1 (${otherActive.id} is already in_progress)`,
                  missingConditions: [`Finish, verify, or pause ${otherActive.id} before starting ${m.todoId}`],
                }),
              )
            }
            if (!areDependenciesSatisfied(target, state.todos)) {
              return Effect.fail(
                new TodoContractError({
                  workItemId: state.id,
                  todoId: Option.some(m.todoId),
                  reason: `Dependencies for ${m.todoId} are not satisfied`,
                  missingConditions: target.dependencyIds.map((d) => `Dependency ${d} must be done`),
                }),
              )
            }
            const nextTodos = state.todos.map((t) =>
              t.id === m.todoId
                ? {
                    ...t,
                    status: "in_progress" as const,
                    attempt: t.attempt + 1,
                    history: [
                      ...t.history,
                      { timestamp: nowIso, action: "started", reason: `Attempt ${t.attempt + 1}`, actor: "agent" as const },
                    ],
                  }
                : t,
            )
            const bumped = bumpRevision(state, nowIso, operationId, `todo_start:${m.todoId}`)
            return Effect.succeed({ ...bumped, todos: nextTodos })
          },
          submit_for_verification: (m) => {
            const target = state.todos.find((t) => t.id === m.todoId)
            if (!target) {
              return Effect.fail(
                new TodoContractError({
                  workItemId: state.id,
                  todoId: Option.some(m.todoId),
                  reason: `Unknown TODO ${m.todoId}`,
                  missingConditions: [`TODO ${m.todoId} does not exist`],
                }),
              )
            }
            if (target.status !== "in_progress" && target.status !== "pending") {
              return Effect.fail(
                new TodoContractError({
                  workItemId: state.id,
                  todoId: Option.some(m.todoId),
                  reason: `TODO ${m.todoId} must be in_progress before submitting for verification (got ${target.status})`,
                  missingConditions: [`Start TODO ${m.todoId} first`],
                }),
              )
            }
            const nextTodos = state.todos.map((t) =>
              t.id === m.todoId
                ? {
                    ...t,
                    status: "verify_pending" as const,
                    implementationNotes: [...t.implementationNotes, m.implementationSummary],
                    history: [
                      ...t.history,
                      {
                        timestamp: nowIso,
                        action: "submit_for_verification",
                        reason: m.implementationSummary,
                        actor: m.actor,
                      },
                    ],
                  }
                : t,
            )
            const bumped = bumpRevision(state, nowIso, operationId, `todo_verify_pending:${m.todoId}`)
            return Effect.succeed({ ...bumped, todos: nextTodos })
          },
          record_evidence: (m) => {
            if (m.evidence.result === "waived" && Option.isNone(m.evidence.waiverAuthorizationId)) {
              return Effect.fail(
                new AuthorizationRequiredError({
                  workItemId: state.id,
                  decisionKind: "waive_criterion",
                  message: "Waived evidence requires a recorded user authorization ID",
                }),
              )
            }
            const updatedCriteria = state.acceptanceCriteria.map((c) =>
              m.evidence.criterionIds.includes(c.id) && !c.evidenceIds.includes(m.evidence.id)
                ? { ...c, evidenceIds: [...c.evidenceIds, m.evidence.id] }
                : c,
            )
            const updatedTodos = state.todos.map((t) =>
              m.evidence.todoIds.includes(t.id) && !t.evidenceIds.includes(m.evidence.id)
                ? { ...t, evidenceIds: [...t.evidenceIds, m.evidence.id] }
                : t,
            )
            const bumped = bumpRevision(
              state,
              nowIso,
              operationId,
              m.evidence.result === "pass" || m.evidence.result === "waived" ? `evidence:${m.evidence.id}` : undefined,
            )
            return Effect.succeed({
              ...bumped,
              evidence: [...state.evidence, m.evidence],
              acceptanceCriteria: updatedCriteria,
              todos: updatedTodos,
            })
          },
          complete: (m) => {
            const target = state.todos.find((t) => t.id === m.todoId)
            if (!target) {
              return Effect.fail(
                new TodoContractError({
                  workItemId: state.id,
                  todoId: Option.some(m.todoId),
                  reason: `Unknown TODO ${m.todoId}`,
                  missingConditions: [`TODO ${m.todoId} does not exist`],
                }),
              )
            }
            const missing: string[] = []
            if (!areDependenciesSatisfied(target, state.todos)) {
              missing.push(`Dependencies for ${m.todoId} are not completed`)
            }
            if (
              Option.getOrElse(state.executionDriver, () => "direct" as const) === "subagent" &&
              target.status !== "verify_pending" &&
              target.status !== "done"
            ) {
              missing.push(
                `Subagent-implemented TODO ${m.todoId} must pass through verify_pending before completion`,
              )
            }
            const combinedEvIds = [...new Set([...target.evidenceIds, ...m.evidenceIds])]
            const matchingEv = state.evidence.filter((e) => combinedEvIds.includes(e.id))
            if (matchingEv.length === 0) {
              missing.push(`At least one recorded EvidenceRecord is required to complete ${m.todoId}`)
            } else {
              const passingFresh = matchingEv.filter(
                (e) =>
                  (e.result === "pass" || (e.result === "waived" && Option.isSome(e.waiverAuthorizationId))) &&
                  isEvidenceFresh(e, state.artifactHashes),
              )
              if (passingFresh.length === 0) {
                missing.push(
                  `No fresh passing (or user-waived) evidence found for ${m.todoId}; failed, not_run, blocked, or stale evidence cannot complete a TODO`,
                )
              }
              const unresolvedFail = matchingEv.some((e) => e.result === "fail")
              if (unresolvedFail && passingFresh.length === 0) {
                missing.push(`TODO ${m.todoId} has failing check evidence`)
              }
            }

            const effectiveReview = m.reviewSummary ? Option.some(m.reviewSummary) : target.reviewResult
            if (state.verificationDriver === "subagent") {
              const validSubagentReview = Option.match(effectiveReview, {
                onNone: () => false,
                onSome: (rev) => rev.reviewerActor === "subagent" && rev.verdict === "pass",
              })
              if (!validSubagentReview) {
                missing.push(
                  `Verification driver is 'subagent': ${m.todoId} requires a passing fresh subagent verification review`,
                )
              }
            }

            if (missing.length > 0) {
              return Effect.fail(
                new TodoContractError({
                  workItemId: state.id,
                  todoId: Option.some(m.todoId),
                  reason: `Completion contract rejected for ${m.todoId}`,
                  missingConditions: missing,
                }),
              )
            }

            const nextTodos = state.todos.map((t) =>
              t.id === m.todoId
                ? {
                    ...t,
                    status: "done" as const,
                    evidenceIds: combinedEvIds,
                    reviewResult: effectiveReview,
                    history: [
                      ...t.history,
                      {
                        timestamp: nowIso,
                        action: "completed",
                        reason: `Verified with evidence: ${combinedEvIds.join(", ")}`,
                        actor: "controller" as const,
                      },
                    ],
                  }
                : t,
            )
            const bumped = bumpRevision(state, nowIso, operationId, `todo_done:${m.todoId}`)
            return Effect.succeed({ ...bumped, todos: nextTodos })
          },
          block: (m) => {
            const target = state.todos.find((t) => t.id === m.todoId)
            if (!target) {
              return Effect.fail(
                new TodoContractError({
                  workItemId: state.id,
                  todoId: Option.some(m.todoId),
                  reason: `Unknown TODO ${m.todoId}`,
                  missingConditions: [`TODO ${m.todoId} does not exist`],
                }),
              )
            }
            const nextTodos = state.todos.map((t) =>
              t.id === m.todoId
                ? {
                    ...t,
                    status: "blocked" as const,
                    history: [
                      ...t.history,
                      { timestamp: nowIso, action: "blocked", reason: m.reason, actor: "agent" as const },
                    ],
                  }
                : t,
            )
            const bumped = bumpRevision(state, nowIso, operationId)
            return Effect.succeed({ ...bumped, todos: nextTodos })
          },
          reopen: (m) => {
            const target = state.todos.find((t) => t.id === m.todoId)
            if (!target) {
              return Effect.fail(
                new TodoContractError({
                  workItemId: state.id,
                  todoId: Option.some(m.todoId),
                  reason: `Unknown TODO ${m.todoId}`,
                  missingConditions: [`TODO ${m.todoId} does not exist`],
                }),
              )
            }
            const nextTodos = state.todos.map((t) =>
              t.id === m.todoId
                ? {
                    ...t,
                    status: "in_progress" as const,
                    reviewResult: Option.none(),
                    history: [
                      ...t.history,
                      { timestamp: nowIso, action: "reopened", reason: m.reason, actor: "controller" as const },
                    ],
                  }
                : t,
            )
            const bumped = bumpRevision(state, nowIso, operationId, `todo_reopen:${m.todoId}`)
            return Effect.succeed({ ...bumped, todos: nextTodos })
          },
          skip: (m) => {
            const auth = state.authorizations.find(
              (a) => a.id === m.authorizationId && a.kind === "scope_change",
            )
            if (!auth) {
              return Effect.fail(
                new AuthorizationRequiredError({
                  workItemId: state.id,
                  decisionKind: "scope_change",
                  message: `Skipping TODO ${m.todoId} requires a recorded user scope_change authorization`,
                }),
              )
            }
            const target = state.todos.find((t) => t.id === m.todoId)
            if (!target) {
              return Effect.fail(
                new TodoContractError({
                  workItemId: state.id,
                  todoId: Option.some(m.todoId),
                  reason: `Unknown TODO ${m.todoId}`,
                  missingConditions: [`TODO ${m.todoId} does not exist`],
                }),
              )
            }
            const deferIds = new Set(m.deferCriterionIds ?? [])
            const updatedCriteria = state.acceptanceCriteria.map((c) =>
              deferIds.has(c.id)
                ? {
                    ...c,
                    required: false,
                    deferredReason: Option.some(m.reason),
                    waiverAuthorizationId: Option.some(auth.id),
                  }
                : c,
            )
            const nextTodos = state.todos.map((t) =>
              t.id === m.todoId
                ? {
                    ...t,
                    status: "skipped" as const,
                    skipAuthorizationId: Option.some(auth.id),
                    history: [
                      ...t.history,
                      { timestamp: nowIso, action: "skipped", reason: m.reason, actor: "user" as const },
                    ],
                  }
                : t,
            )
            const bumped = bumpRevision(state, nowIso, operationId, `todo_skip:${m.todoId}`)
            return Effect.succeed({
              ...bumped,
              todos: nextTodos,
              acceptanceCriteria: updatedCriteria,
            })
          },
        }),
      )
    }),
  )

export const createDurableQuestion = (
  state: WorkItemState,
  params: {
    readonly questionId: string
    readonly title: string
    readonly prompt: string
    readonly purpose: string
    readonly blocking: boolean
    readonly allowFreeText: boolean
    readonly multiSelect: boolean
    readonly options: ReadonlyArray<QuestionOption>
    readonly previewId: Option.Option<string>
    readonly nowIso: string
  },
): { readonly state: WorkItemState; readonly question: DurableQuestion } => {
  const question: DurableQuestion = {
    id: params.questionId,
    revision: 1,
    title: params.title,
    prompt: params.prompt,
    purpose: params.purpose,
    blocking: params.blocking,
    allowFreeText: params.allowFreeText,
    multiSelect: params.multiSelect,
    options: params.options,
    previewId: params.previewId,
    status: "pending",
    answer: Option.none(),
    createdAt: params.nowIso,
  }
  const nextStatus: RunStatus =
    params.blocking && state.runStatus !== "paused" && state.runStatus !== "cancelled"
      ? "awaiting_user"
      : state.runStatus
  const transitions =
    nextStatus !== state.runStatus
      ? appendTransition(
          state,
          state.phase,
          nextStatus,
          `Awaiting user answer on ${question.id}: ${question.title}`,
          "agent_tool",
          params.nowIso,
        )
      : state.transitions
  const bumped = bumpRevision(state, params.nowIso)
  return {
    question,
    state: {
      ...bumped,
      runStatus: nextStatus,
      questions: [...state.questions, question],
      nextAction: params.blocking
        ? `Await user answer for ${question.id} (${question.title})`
        : state.nextAction,
      transitions,
    },
  }
}

export const resolveQuestionCAS = (
  state: WorkItemState,
  params: {
    readonly questionId: string
    readonly expectedQuestionRevision: number
    readonly answer: QuestionAnswer
    readonly delegatedChoiceSummary?: string
    readonly nowIso: string
  },
): Effect.Effect<WorkItemState, QuestionConflictError> => {
  if (state.runStatus === "cancelled" || state.runStatus === "finished") {
    return Effect.fail(
      new QuestionConflictError({
        workItemId: state.id,
        questionId: params.questionId,
        status: "paused_or_cancelled",
        message: `Work item ${state.id} is ${state.runStatus}; stale answer rejected.`,
      }),
    )
  }

  if (state.runStatus === "paused" && params.answer.source === "browser") {
    return Effect.fail(
      new QuestionConflictError({
        workItemId: state.id,
        questionId: params.questionId,
        status: "paused_or_cancelled",
        message: `Workflow ${state.id} is manually paused; browser callback cannot revive a paused workflow.`,
      }),
    )
  }

  const target = state.questions.find((q) => q.id === params.questionId)
  if (!target) {
    return Effect.fail(
      new QuestionConflictError({
        workItemId: state.id,
        questionId: params.questionId,
        status: "not_found",
        message: `Question ${params.questionId} does not exist on work item ${state.id}`,
      }),
    )
  }
  if (target.status === "answered") {
    return Effect.fail(
      new QuestionConflictError({
        workItemId: state.id,
        questionId: params.questionId,
        status: "already_answered",
        message: `Question ${params.questionId} was already answered; duplicate submission ignored.`,
      }),
    )
  }
  if (target.status !== "pending" || target.revision !== params.expectedQuestionRevision) {
    return Effect.fail(
      new QuestionConflictError({
        workItemId: state.id,
        questionId: params.questionId,
        status: "stale_revision",
        message: `Question ${params.questionId} revision mismatch (expected ${params.expectedQuestionRevision}, actual ${target.revision}, status ${target.status})`,
      }),
    )
  }

  const knownOptionIds = new Set(target.options.map((o) => o.id))
  const invalidOption = params.answer.selectedOptionIds.find((id) => !knownOptionIds.has(id))
  if (invalidOption !== undefined) {
    return Effect.fail(
      new QuestionConflictError({
        workItemId: state.id,
        questionId: params.questionId,
        status: "invalid_choice",
        message: `Unknown option ID "${invalidOption}" submitted for question ${params.questionId}`,
      }),
    )
  }
  if (
    params.answer.selectedOptionIds.length === 0 &&
    Option.isNone(params.answer.customText) &&
    params.answer.source !== "delegated_to_agent"
  ) {
    return Effect.fail(
      new QuestionConflictError({
        workItemId: state.id,
        questionId: params.questionId,
        status: "invalid_choice",
        message: `Answer for ${params.questionId} must select an option or provide custom text`,
      }),
    )
  }
  if (!target.allowFreeText && Option.isSome(params.answer.customText) && params.answer.selectedOptionIds.length === 0) {
    return Effect.fail(
      new QuestionConflictError({
        workItemId: state.id,
        questionId: params.questionId,
        status: "invalid_choice",
        message: `Question ${params.questionId} does not allow free-text-only answers`,
      }),
    )
  }

  const updatedQuestions = state.questions.map((q) =>
    q.id === params.questionId
      ? {
          ...q,
          revision: q.revision + 1,
          status: "answered" as const,
          answer: Option.some(params.answer),
        }
      : q,
  )

  const summaryParts = [
    ...params.answer.selectedOptionIds.map(
      (id) => target.options.find((o) => o.id === id)?.label ?? id,
    ),
    ...(Option.isSome(params.answer.customText) ? [params.answer.customText.value] : []),
  ]
  const decisionRecord: DecisionRecord = {
    id: `D${String(state.decisions.length + 1).padStart(3, "0")}`,
    category:
      params.answer.source === "delegated_to_agent" ? "delegated_decision" : "user_decision",
    summary:
      params.delegatedChoiceSummary ??
      `${target.title}: ${summaryParts.join(", ") || "delegated to agent"}`,
    rationale: Option.getOrElse(params.answer.comments, () => `Resolved question ${target.id}`),
    rejectedAlternatives: target.options
      .filter((o) => !params.answer.selectedOptionIds.includes(o.id))
      .map((o) => o.label),
    sourceReferences: [`question:${target.id}`],
    questionId: Option.some(target.id),
    material: target.blocking,
    timestamp: params.nowIso,
  }

  const stillPendingBlocking = updatedQuestions.some((q) => q.blocking && q.status === "pending")
  const nextStatus: RunStatus =
    state.runStatus === "awaiting_user" && !stillPendingBlocking ? "running" : state.runStatus
  const transitions =
    nextStatus !== state.runStatus
      ? appendTransition(
          state,
          state.phase,
          nextStatus,
          `Question ${target.id} answered via ${params.answer.source}`,
          "user",
          params.nowIso,
        )
      : state.transitions

  const bumped = bumpRevision(state, params.nowIso, undefined, `question_answered:${target.id}`)
  return Effect.succeed({
    ...bumped,
    runStatus: nextStatus,
    questions: updatedQuestions,
    decisions: [...state.decisions, decisionRecord],
    nextAction:
      nextStatus === "running"
        ? `Incorporate answer to ${target.id} and continue ${state.phase}.`
        : state.nextAction,
    transitions,
  })
}

export const registerPreviewArtifact = (
  state: WorkItemState,
  preview: PreviewArtifact,
  nowIso: string,
): WorkItemState => {
  const existingIdx = state.previews.findIndex((p) => p.id === preview.id)
  const nextPreviews =
    existingIdx >= 0
      ? state.previews.map((p, i) => (i === existingIdx ? preview : p))
      : [...state.previews, preview]
  const bumped = bumpRevision(state, nowIso, undefined, `preview:${preview.id}`)
  return {
    ...bumped,
    previews: nextPreviews,
  }
}

export const bindTasksAndMaybeWait = (
  state: WorkItemState,
  params: {
    readonly bindings: ReadonlyArray<TaskBinding>
    readonly mode: "all" | "any"
    readonly enterWait: boolean
    readonly resumePhase: WorkflowPhase
    readonly nowIso: string
  },
): WorkItemState => {
  const bindingMap = new Map(state.trackedTasks.map((b) => [b.taskId, b]))
  for (const b of params.bindings) {
    bindingMap.set(b.taskId, b)
  }
  const mergedBindings = [...bindingMap.values()]

  const isSatisfied = (b: TaskBinding): boolean => {
    if (b.waitCondition.kind === "ready") {
      return b.lastStatus === "ready"
    }
    return b.lastStatus === "completed"
  }

  const isTerminalFailure = (b: TaskBinding): boolean =>
    b.lastStatus === "failed" ||
    b.lastStatus === "timed_out" ||
    b.lastStatus === "stopped" ||
    b.lastStatus === "lost" ||
    (b.waitCondition.kind === "ready" && b.lastStatus === "completed")

  const targetBindings = params.bindings
  const earlyFailure =
    params.mode === "all" && targetBindings.some((b) => b.requireSuccess && isTerminalFailure(b))
  const allDone =
    params.mode === "all"
      ? targetBindings.every((b) => isSatisfied(b) || (!b.requireSuccess && isTerminalFailure(b)))
      : targetBindings.some((b) => isSatisfied(b))
  const allFailedInAny =
    params.mode === "any" && targetBindings.every((b) => isTerminalFailure(b))

  const shouldStayRunning = !params.enterWait || earlyFailure || allDone || allFailedInAny

  const nextStatus: RunStatus =
    state.runStatus === "paused" || state.runStatus === "cancelled"
      ? state.runStatus
      : shouldStayRunning
        ? "running"
        : "waiting_task"

  const nextPhase = shouldStayRunning && (allDone || earlyFailure || allFailedInAny) ? params.resumePhase : state.phase
  const waitGroup =
    nextStatus === "waiting_task"
      ? Option.some({
          mode: params.mode,
          taskIds: targetBindings.map((b) => b.taskId),
          enteredAt: params.nowIso,
          resumePhase: params.resumePhase,
        })
      : Option.none()

  const transitions =
    nextStatus !== state.runStatus || nextPhase !== state.phase
      ? appendTransition(
          state,
          nextPhase,
          nextStatus,
          nextStatus === "waiting_task"
            ? `Waiting (${params.mode}) on realtasks: ${targetBindings.map((b) => b.taskId).join(", ")}`
            : `Reconciled realtasks bindings immediately (${earlyFailure || allFailedInAny ? "failed" : "satisfied"})`,
          "agent_tool",
          params.nowIso,
        )
      : state.transitions

  const bumped = bumpRevision(state, params.nowIso)
  return {
    ...bumped,
    phase: nextPhase,
    runStatus: nextStatus,
    trackedTasks: mergedBindings,
    activeWaitGroup: waitGroup,
    nextAction:
      nextStatus === "waiting_task"
        ? `Waiting for ${targetBindings.map((b) => b.taskId).join(", ")} -> resume ${params.resumePhase}`
        : earlyFailure || allFailedInAny
          ? `Handle task failure for ${targetBindings.filter(isTerminalFailure).map((b) => b.taskId).join(", ")}`
          : state.nextAction,
    transitions,
  }
}

export const reconcileObservedTask = (
  state: WorkItemState,
  params: {
    readonly taskId: string
    readonly status: ObservedTaskStatus
    readonly exitCode: Option.Option<number>
    readonly source: string
    readonly eventKey?: string
    readonly readinessTimedOut?: boolean
    readonly nowIso: string
  },
): { readonly state: WorkItemState; readonly matched: boolean; readonly wokeFromWait: boolean } => {
  if (params.eventKey !== undefined && state.consumedEventKeys.includes(params.eventKey)) {
    return { state, matched: false, wokeFromWait: false }
  }
  const existing = state.trackedTasks.find((t) => t.taskId === params.taskId)
  if (!existing) {
    return { state, matched: false, wokeFromWait: false }
  }

  const updatedBinding: TaskBinding = {
    ...existing,
    lastStatus: params.status,
    lastExitCode: Option.isSome(params.exitCode) ? params.exitCode : existing.lastExitCode,
    lastObservedAt: params.nowIso,
    observationSource: params.source,
    readinessTimedOut: params.readinessTimedOut ?? existing.readinessTimedOut,
  }
  const updatedTasks = state.trackedTasks.map((t) => (t.taskId === params.taskId ? updatedBinding : t))
  const consumed =
    params.eventKey !== undefined
      ? [...state.consumedEventKeys.slice(-511), params.eventKey]
      : state.consumedEventKeys

  if (
    state.runStatus === "paused" ||
    state.runStatus === "cancelled" ||
    state.runStatus === "awaiting_user" ||
    state.runStatus === "finished"
  ) {
    const bumped = bumpRevision(state, params.nowIso)
    return {
      matched: true,
      wokeFromWait: false,
      state: {
        ...bumped,
        trackedTasks: updatedTasks,
        consumedEventKeys: consumed,
      },
    }
  }

  return Option.match(state.activeWaitGroup, {
    onNone: () => {
      const bumped = bumpRevision(state, params.nowIso)
      return {
        matched: true,
        wokeFromWait: false,
        state: {
          ...bumped,
          trackedTasks: updatedTasks,
          consumedEventKeys: consumed,
        },
      }
    },
    onSome: (wg) => {
      if (!wg.taskIds.includes(params.taskId)) {
        const bumped = bumpRevision(state, params.nowIso)
        return {
          matched: true,
          wokeFromWait: false,
          state: {
            ...bumped,
            trackedTasks: updatedTasks,
            consumedEventKeys: consumed,
          },
        }
      }

      const groupBindings = wg.taskIds
        .map((id) => updatedTasks.find((t) => t.taskId === id))
        .filter((b): b is TaskBinding => b !== undefined)

      const isSatisfied = (b: TaskBinding): boolean =>
        b.waitCondition.kind === "ready"
          ? b.lastStatus === "ready"
          : b.waitCondition.kind === "monitor_event"
            ? b.lastStatus === "ready" || b.lastStatus === "completed"
            : b.lastStatus === "completed"

      const isFailed = (b: TaskBinding): boolean =>
        b.lastStatus === "failed" ||
        b.lastStatus === "timed_out" ||
        b.lastStatus === "stopped" ||
        b.lastStatus === "lost" ||
        (b.waitCondition.kind === "ready" && b.lastStatus === "completed")

      const unblockedBySuccess =
        wg.mode === "all"
          ? groupBindings.every((b) => isSatisfied(b) || (!b.requireSuccess && isFailed(b)))
          : groupBindings.some((b) => isSatisfied(b))

      const unblockedByFailure =
        (wg.mode === "all" && groupBindings.some((b) => b.requireSuccess && isFailed(b))) ||
        (wg.mode === "any" && groupBindings.every((b) => isFailed(b)))

      const unavailableBlock = groupBindings.some((b) => b.lastStatus === "unavailable")

      if (!unblockedBySuccess && !unblockedByFailure && !unavailableBlock) {
        const bumped = bumpRevision(state, params.nowIso)
        return {
          matched: true,
          wokeFromWait: false,
          state: {
            ...bumped,
            trackedTasks: updatedTasks,
            consumedEventKeys: consumed,
          },
        }
      }

      const nextStatus: RunStatus = unavailableBlock ? "blocked" : "running"
      const nextPhase: WorkflowPhase = unavailableBlock ? state.phase : wg.resumePhase
      const reason = unavailableBlock
        ? `Task ${params.taskId} is unavailable from this session; manual reconciliation required`
        : unblockedByFailure
          ? `Wait unblocked due to task failure (${params.taskId}: ${params.status}); entering recovery in ${nextPhase}`
          : `Wait satisfied (${params.taskId}: ${params.status}); resuming ${nextPhase}`

      const transitions = appendTransition(state, nextPhase, nextStatus, reason, "dependency_event", params.nowIso)
      const bumped = bumpRevision(
        state,
        params.nowIso,
        undefined,
        unblockedBySuccess ? `task_satisfied:${params.taskId}` : undefined,
      )
      return {
        matched: true,
        wokeFromWait: nextStatus === "running",
        state: {
          ...bumped,
          phase: nextPhase,
          runStatus: nextStatus,
          trackedTasks: updatedTasks,
          activeWaitGroup: Option.none(),
          consumedEventKeys: consumed,
          pauseOrBlockReason: unavailableBlock ? Option.some(reason) : state.pauseOrBlockReason,
          nextAction: unavailableBlock
            ? reason
            : unblockedByFailure
              ? `Inspect failed task ${params.taskId} (${params.status}) and recover or block.`
              : `Reconcile completed dependency ${params.taskId} and proceed with ${nextPhase}.`,
          transitions,
        },
      }
    },
  })
}

export const pauseWorkItem = (
  state: WorkItemState,
  reason: string,
  origin: TransitionOrigin,
  nowIso: string,
): WorkItemState => {
  if (state.runStatus === "finished" || state.runStatus === "cancelled") {
    return state
  }
  const transitions = appendTransition(state, state.phase, "paused", reason, origin, nowIso)
  const bumped = bumpRevision(state, nowIso)
  return {
    ...bumped,
    runStatus: "paused",
    pauseOrBlockReason: Option.some(reason),
    transitions,
  }
}

export const blockWorkItem = (
  state: WorkItemState,
  reason: string,
  origin: TransitionOrigin,
  nowIso: string,
): WorkItemState => {
  if (state.runStatus === "finished" || state.runStatus === "cancelled") {
    return state
  }
  const transitions = appendTransition(state, state.phase, "blocked", reason, origin, nowIso)
  const bumped = bumpRevision(state, nowIso)
  return {
    ...bumped,
    runStatus: "blocked",
    pauseOrBlockReason: Option.some(reason),
    transitions,
  }
}

export const cancelWorkItem = (
  state: WorkItemState,
  reason: string,
  nowIso: string,
): WorkItemState => {
  if (state.runStatus === "cancelled") return state
  const cancelledQuestions = state.questions.map((q) =>
    q.status === "pending" ? { ...q, status: "cancelled" as const, revision: q.revision + 1 } : q,
  )
  const transitions = appendTransition(state, state.phase, "cancelled", reason, "user", nowIso)
  const bumped = bumpRevision(state, nowIso)
  return {
    ...bumped,
    runStatus: "cancelled",
    questions: cancelledQuestions,
    activeWaitGroup: Option.none(),
    pauseOrBlockReason: Option.some(reason),
    nextAction: "Cancelled by user; artifacts retained.",
    transitions,
  }
}

export const resumeWorkItem = (
  state: WorkItemState,
  authorization: UserAuthorization,
  guidance: Option.Option<string>,
  nowIso: string,
): Effect.Effect<WorkItemState, InvalidTransitionError> => {
  if (state.runStatus === "cancelled" || state.runStatus === "finished") {
    return Effect.fail(
      new InvalidTransitionError({
        workItemId: state.id,
        fromPhase: state.phase,
        toPhase: state.phase,
        fromStatus: state.runStatus,
        toStatus: "running",
        reason: `Cannot resume terminal work item (${state.runStatus})`,
        missingConditions: [`Work item is ${state.runStatus}`],
      }),
    )
  }
  const pendingBlocking = state.questions.some((q) => q.blocking && q.status === "pending")
  const hasRunningWait = Option.isSome(state.activeWaitGroup)
  const nextStatus: RunStatus = pendingBlocking
    ? "awaiting_user"
    : hasRunningWait
      ? "waiting_task"
      : "running"

  const transitions = appendTransition(
    state,
    state.phase,
    nextStatus,
    Option.match(guidance, {
      onNone: () => "Resumed by user",
      onSome: (g) => `Resumed by user with guidance: ${g}`,
    }),
    "user",
    nowIso,
  )
  const bumped = bumpRevision(state, nowIso, undefined, "user_resume")
  return Effect.succeed({
    ...bumped,
    runStatus: nextStatus,
    pauseOrBlockReason: Option.none(),
    authorizations: [...state.authorizations, authorization],
    nextAction: Option.getOrElse(guidance, () => state.nextAction),
    progress: {
      ...bumped.progress,
      noProgressContinuations: 0,
      repeatedFailureCount: 0,
      lastFailureFingerprint: Option.none(),
    },
    transitions,
  })
}

export const recordOperationFailure = (
  state: WorkItemState,
  fingerprint: string,
  errorSummary: string,
  config: ResolvedRealgoalConfig,
  nowIso: string,
): WorkItemState => {
  if (state.runStatus === "waiting_task" || state.runStatus === "awaiting_user") {
    return state
  }
  const sameAsLast =
    Option.isSome(state.progress.lastFailureFingerprint) &&
    state.progress.lastFailureFingerprint.value === fingerprint
  const nextCount = sameAsLast ? state.progress.repeatedFailureCount + 1 : 1
  const threshold = config.continuation.maxRepeatedFailureAttempts

  const updatedProgress = {
    ...state.progress,
    repeatedFailureCount: nextCount,
    lastFailureFingerprint: Option.some(fingerprint),
    recentFingerprints: [...state.progress.recentFingerprints.slice(-15), fingerprint],
  }

  if (nextCount >= threshold && state.runStatus === "running") {
    const reason = `Repeated failure ${nextCount}/${threshold} (${fingerprint}): ${errorSummary}`
    const transitions = appendTransition(state, state.phase, "paused", reason, "recovery", nowIso)
    const bumped = bumpRevision(state, nowIso)
    return {
      ...bumped,
      runStatus: "paused",
      pauseOrBlockReason: Option.some(reason),
      progress: updatedProgress,
      nextAction: `Paused after repeated failure (${nextCount}/${threshold}). Provide guidance, change approach, /realgoal resume, or /realgoal cancel.`,
      transitions,
    }
  }

  return {
    ...state,
    updatedAt: nowIso,
    progress: updatedProgress,
  }
}

export interface SettleDecisionResult {
  readonly nextState: WorkItemState
  readonly shouldContinue: boolean
  readonly reminderMessage: Option.Option<string>
}

export const decideBeforeSettle = (
  state: WorkItemState,
  params: {
    readonly currentSessionId: string
    readonly currentRuntimeId: string
    readonly outcome: "completed" | "aborted" | "error"
    readonly errorMessage?: string
    readonly boundaryKey: string
    readonly config: ResolvedRealgoalConfig
    readonly hadQualifyingProgressSinceLastContinuation: boolean
    readonly nowIso: string
  },
): SettleDecisionResult => {
  const isOwner = Option.match(state.owner, {
    onNone: () => false,
    onSome: (o) =>
      !o.readOnly &&
      o.sessionId === params.currentSessionId &&
      o.runtimeId === params.currentRuntimeId,
  })
  if (!isOwner) {
    return { nextState: state, shouldContinue: false, reminderMessage: Option.none() }
  }

  if (params.outcome === "aborted") {
    const paused = pauseWorkItem(state, "Interrupted by user abort (Escape)", "user", params.nowIso)
    return { nextState: paused, shouldContinue: false, reminderMessage: Option.none() }
  }

  if (params.outcome === "error") {
    const blocked = blockWorkItem(
      state,
      `Agent run ended with provider/runtime error: ${params.errorMessage ?? "unknown error"}`,
      "recovery",
      params.nowIso,
    )
    return { nextState: blocked, shouldContinue: false, reminderMessage: Option.none() }
  }

  if (state.runStatus !== "running" || !params.config.continuation.enabled) {
    return { nextState: state, shouldContinue: false, reminderMessage: Option.none() }
  }

  if (
    Option.isSome(state.progress.lastContinuationBoundaryKey) &&
    state.progress.lastContinuationBoundaryKey.value === params.boundaryKey
  ) {
    return { nextState: state, shouldContinue: false, reminderMessage: Option.none() }
  }

  if (Option.isSome(params.config.continuation.maxTotalTurns)) {
    const cap = params.config.continuation.maxTotalTurns.value
    if (state.progress.totalContinuations >= cap) {
      const paused = pauseWorkItem(
        state,
        `Configured continuation.maxTotalTurns (${cap}) reached`,
        "recovery",
        params.nowIso,
      )
      return { nextState: paused, shouldContinue: false, reminderMessage: Option.none() }
    }
  }

  const nextNoProgress = params.hadQualifyingProgressSinceLastContinuation
    ? 0
    : state.progress.noProgressContinuations + 1

  if (nextNoProgress >= params.config.continuation.maxNoProgressContinuations) {
    const reason = `No qualifying progress for ${nextNoProgress}/${params.config.continuation.maxNoProgressContinuations} continuations in phase '${state.phase}'`
    const transitions = appendTransition(state, state.phase, "paused", reason, "recovery", params.nowIso)
    const bumped = bumpRevision(state, params.nowIso)
    return {
      shouldContinue: false,
      reminderMessage: Option.none(),
      nextState: {
        ...bumped,
        runStatus: "paused",
        pauseOrBlockReason: Option.some(reason),
        nextAction: `${reason}. Offer guidance, change approach, /realgoal resume, or /realgoal cancel.`,
        progress: {
          ...bumped.progress,
          noProgressContinuations: nextNoProgress,
        },
        transitions,
      },
    }
  }

  const nextTodoOpt = selectNextEligibleTodo(state.todos)
  const doneCount = state.todos.filter((t) => t.status === "done").length
  const unresolvedCriteria = state.acceptanceCriteria.filter((c) => {
    if (!c.required) return false
    const evs = state.evidence.filter((e) => c.evidenceIds.includes(e.id))
    return !evs.some(
      (e) =>
        (e.result === "pass" || (e.result === "waived" && Option.isSome(e.waiverAuthorizationId))) &&
        isEvidenceFresh(e, state.artifactHashes),
    )
  })

  const todoLine = Option.match(nextTodoOpt, {
    onNone: () => `TODOs: ${doneCount}/${state.todos.length} done`,
    onSome: (t) => `Next TODO: ${t.id} [${t.status}] — ${t.title} (${doneCount}/${state.todos.length} done)`,
  })

  const criteriaLine =
    unresolvedCriteria.length > 0
      ? `Unresolved criteria: ${unresolvedCriteria.map((c) => c.id).join(", ")}`
      : "All acceptance criteria have recorded evidence; verify goal-level checks and call realgoal_finish if eligible."

  const reminder = [
    `[Realgoal Continuation · ${state.kind.toUpperCase()} "${state.displayName}" · rev ${state.revision + 1}]`,
    `Phase: ${state.phase} | Next action: ${state.nextAction}`,
    todoLine,
    criteriaLine,
    `Note: Prose alone never finishes a workflow. Advance TODOs/phases with realgoal_* tools, enter realtasks waits when blocked on background jobs, or call realgoal_finish when all contracts pass.`,
  ].join("\n")

  const bumped = bumpRevision(state, params.nowIso)
  return {
    shouldContinue: true,
    reminderMessage: Option.some(reminder),
    nextState: {
      ...bumped,
      progress: {
        ...bumped.progress,
        noProgressContinuations: nextNoProgress,
        lastContinuationBoundaryKey: Option.some(params.boundaryKey),
        totalContinuations: bumped.progress.totalContinuations + 1,
      },
    },
  }
}

export const finishWorkItem = (
  state: WorkItemState,
  params: {
    readonly expectedRevision: number
    readonly operationId: string
    readonly callerIsChildWorker: boolean
    readonly completionScope: CompletionScope
    readonly summary: string
    readonly evidenceIds: ReadonlyArray<string>
    readonly retainedResourceIds: ReadonlyArray<string>
    readonly recordGoalLevelVerification: boolean
    readonly draftGateEnabled: boolean
    readonly nowIso: string
  },
): Effect.Effect<WorkItemState, RealgoalError> => {
  if (params.callerIsChildWorker) {
    return Effect.fail(
      new FinishRejectedError({
        workItemId: state.id,
        missingConditions: ["Child worker/reviewer cannot mark the parent workflow complete"],
        message: "Rejected realgoal_finish: caller is a delegated worker, not the owning parent workflow.",
      }),
    )
  }

  if (state.runStatus === "finished" && state.operationIds.includes(params.operationId)) {
    return Effect.succeed(state)
  }
  if (state.runStatus === "finished" && state.revision === params.expectedRevision) {
    return Effect.succeed(state)
  }

  return checkRevision(state, params.expectedRevision, params.operationId).pipe(
    Effect.flatMap(({ alreadyApplied }) => {
      if (alreadyApplied) return Effect.succeed(state)

      const missing: string[] = []

      if (state.runStatus === "cancelled") {
        missing.push("Work item was cancelled")
      }

      if (params.completionScope !== state.completionScope) {
        if (params.completionScope === "implementation" && state.completionScope === "artifact") {
          missing.push("Work item completionScope is 'artifact', not 'implementation'")
        } else if (params.completionScope === "artifact" && state.completionScope === "implementation") {
          missing.push(
            "Cannot claim goal finish via 'artifact' scope when the requested deliverable is 'implementation' (use 'stop here' to park a plan handoff instead)",
          )
        }
      }

      if (params.summary.trim().length === 0) {
        missing.push("Non-empty completion summary is required")
      }

      const unfinishedTodos = state.todos.filter((t) => {
        if (t.status === "done") return false
        if (t.status === "skipped" && Option.isSome(t.skipAuthorizationId)) return false
        return true
      })
      if (params.completionScope === "implementation" && unfinishedTodos.length > 0) {
        missing.push(
          `Required TODOs are not done: ${unfinishedTodos.map((t) => `${t.id} (${t.status})`).join(", ")}`,
        )
      }

      if (params.completionScope === "artifact") {
        const completedPubs = state.publications.filter((p) => p.status === "completed")
        if (completedPubs.length === 0) {
          missing.push("Artifact completion requires at least one completed publication record")
        }
      }

      for (const crit of state.acceptanceCriteria) {
        if (!crit.required) {
          if (Option.isNone(crit.waiverAuthorizationId)) {
            missing.push(`Deferred criterion ${crit.id} lacks a user scope/waiver authorization`)
          }
          continue
        }
        const relevantEv = state.evidence.filter(
          (e) => crit.evidenceIds.includes(e.id) || params.evidenceIds.includes(e.id),
        )
        const hasValidPassOrWaiver = relevantEv.some(
          (e) =>
            (e.result === "pass" || (e.result === "waived" && Option.isSome(e.waiverAuthorizationId))) &&
            isEvidenceFresh(e, state.artifactHashes),
        )
        if (!hasValidPassOrWaiver) {
          missing.push(`Acceptance criterion ${crit.id} ("${crit.description}") lacks current passing evidence or user waiver`)
        }
        const hasUnresolvedFailure =
          relevantEv.length > 0 &&
          relevantEv[relevantEv.length - 1]?.result === "fail"
        if (hasUnresolvedFailure) {
          missing.push(`Acceptance criterion ${crit.id} has an unresolved failing verification check`)
        }
      }

      const blockingQuestions = state.questions.filter((q) => q.blocking && q.status === "pending")
      if (blockingQuestions.length > 0) {
        missing.push(
          `Unresolved blocking questions: ${blockingQuestions.map((q) => q.id).join(", ")}`,
        )
      }

      if (state.kind === "plan" && params.draftGateEnabled && !hasValidDraftReviewApproval(state)) {
        missing.push("Required independent draft review gate has not passed for the current revision")
      }

      const activeWorkers = state.workers.filter(
        (w) => w.status === "dispatched" || w.status === "running",
      )
      if (activeWorkers.length > 0) {
        missing.push(`Active delegated workers remain: ${activeWorkers.map((w) => w.jobId).join(", ")}`)
      }

      const retainedSet = new Set(params.retainedResourceIds)
      const unresolvedTasks = state.trackedTasks.filter((t) => {
        if (retainedSet.has(t.taskId) && t.retainedResource) return false
        if (t.lastStatus === "running" || t.lastStatus === "unavailable") return true
        if (t.readinessTimedOut && !retainedSet.has(t.taskId)) return true
        if (
          t.requireSuccess &&
          (t.lastStatus === "failed" ||
            t.lastStatus === "timed_out" ||
            t.lastStatus === "stopped" ||
            t.lastStatus === "lost")
        ) {
          return true
        }
        return false
      })
      if (unresolvedTasks.length > 0) {
        missing.push(
          `Unresolved or failed required background tasks: ${unresolvedTasks.map((t) => `${t.taskId} (${t.lastStatus})`).join(", ")}`,
        )
      }

      const hasGoalVerification =
        params.completionScope === "artifact" ||
        params.recordGoalLevelVerification ||
        Option.isSome(state.goalLevelVerifiedRevision)
      if (!hasGoalVerification) {
        missing.push("Final goal-level verification has not been recorded for implementation work")
      }

      if (missing.length > 0) {
        return Effect.fail(
          new FinishRejectedError({
            workItemId: state.id,
            missingConditions: missing,
            message: `realgoal_finish rejected (${missing.length} missing condition${missing.length === 1 ? "" : "s"}): ${missing.join("; ")}`,
          }),
        )
      }

      const transitions = appendTransition(
        state,
        "complete",
        "finished",
        `Completed (${params.completionScope}): ${params.summary}`,
        "agent_tool",
        params.nowIso,
      )
      const bumped = bumpRevision(state, params.nowIso, params.operationId, "finished")
      return Effect.succeed({
        ...bumped,
        phase: "complete",
        runStatus: "finished",
        activeWaitGroup: Option.none(),
        pauseOrBlockReason: Option.none(),
        goalLevelVerifiedRevision: params.recordGoalLevelVerification
          ? Option.some(bumped.revision)
          : state.goalLevelVerifiedRevision,
        retainedResourceIds: [...params.retainedResourceIds],
        completionSummary: Option.some(params.summary),
        nextAction: "Completed.",
        transitions,
      })
    }),
  )
}

export type { TaskWaitCondition, WorkerJobRecord, PublicationRecord }
