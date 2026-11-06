import { Option, Schema } from "effect"

export const SCHEMA_VERSION = 1 as const

export const WorkflowKindSchema = Schema.Literals(["goal", "plan"])
export type WorkflowKind = typeof WorkflowKindSchema.Type

export const RunStatusSchema = Schema.Literals([
  "running",
  "waiting_task",
  "awaiting_user",
  "paused",
  "blocked",
  "finished",
  "cancelled",
])
export type RunStatus = typeof RunStatusSchema.Type

export const GoalPhaseSchema = Schema.Literals([
  "intake",
  "explore",
  "analyze",
  "process",
  "verify",
  "complete",
])
export type GoalPhase = typeof GoalPhaseSchema.Type

export const PlanPhaseSchema = Schema.Literals([
  "intake",
  "discovery",
  "design",
  "analysis",
  "finalization",
  "draft_review",
  "publication_choice",
  "publication",
  "execution_choice",
  "lookup",
  "implement",
  "verify_item",
  "verify_goal",
  "complete",
])
export type PlanPhase = typeof PlanPhaseSchema.Type

export const WorkflowPhaseSchema = Schema.Union([GoalPhaseSchema, PlanPhaseSchema])
export type WorkflowPhase = typeof WorkflowPhaseSchema.Type

export const CompletionScopeSchema = Schema.Literals(["implementation", "artifact"])
export type CompletionScope = typeof CompletionScopeSchema.Type

export const ExecutionDriverSchema = Schema.Literals(["direct", "subagent"])
export type ExecutionDriver = typeof ExecutionDriverSchema.Type

export const VerificationDriverSchema = Schema.Literals(["direct", "subagent"])
export type VerificationDriver = typeof VerificationDriverSchema.Type

export const DifficultySchema = Schema.Literals(["light", "medium", "heavy"])
export type Difficulty = typeof DifficultySchema.Type

export const ThinkingLevelSchema = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
export type ThinkingLevelValue = typeof ThinkingLevelSchema.Type

export const TodoStatusSchema = Schema.Literals([
  "pending",
  "in_progress",
  "verify_pending",
  "done",
  "blocked",
  "skipped",
])
export type TodoStatus = typeof TodoStatusSchema.Type

export const EvidenceMethodSchema = Schema.Literals([
  "executable_test",
  "static_review",
  "manual_inspection",
  "user_confirmation",
  "user_waiver",
])
export type EvidenceMethod = typeof EvidenceMethodSchema.Type

export const EvidenceResultSchema = Schema.Literals(["pass", "fail", "blocked", "not_run", "waived"])
export type EvidenceResult = typeof EvidenceResultSchema.Type

export const ReviewVerdictSchema = Schema.Literals(["pass", "changes_required", "blocked"])
export type ReviewVerdict = typeof ReviewVerdictSchema.Type

export const TransitionOriginSchema = Schema.Literals(["user", "agent_tool", "dependency_event", "recovery"])
export type TransitionOrigin = typeof TransitionOriginSchema.Type

export const AuthorizationKindSchema = Schema.Literals([
  "publish_spec",
  "publish_plan",
  "publish_both",
  "execute_direct",
  "execute_subagent",
  "stop_here",
  "waive_draft_gate",
  "waive_criterion",
  "scope_change",
  "cleanup_tasks",
  "browser_open",
  "resume",
  "transfer_ownership",
  "model_override",
  "spike_approval",
])
export type AuthorizationKind = typeof AuthorizationKindSchema.Type

export const ObservedTaskStatusSchema = Schema.Literals([
  "running",
  "ready",
  "completed",
  "failed",
  "timed_out",
  "stopped",
  "lost",
  "unavailable",
])
export type ObservedTaskStatus = typeof ObservedTaskStatusSchema.Type

export const OwnerTokenSchema = Schema.Struct({
  sessionId: Schema.String,
  runtimeId: Schema.String,
  pid: Schema.Int,
  acquiredAt: Schema.String,
  hostMode: Schema.Literals(["tui", "rpc", "json", "print"]),
  readOnly: Schema.Boolean,
})
export type OwnerToken = typeof OwnerTokenSchema.Type
export const OwnerTokenJson = Schema.fromJsonString(OwnerTokenSchema)

export const AcceptanceCriterionSchema = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  required: Schema.Boolean,
  deferredReason: Schema.OptionFromOptionalKey(Schema.String),
  waiverAuthorizationId: Schema.OptionFromOptionalKey(Schema.String),
  evidenceIds: Schema.Array(Schema.String),
})
export type AcceptanceCriterion = typeof AcceptanceCriterionSchema.Type

export const TodoHistoryEntrySchema = Schema.Struct({
  timestamp: Schema.String,
  action: Schema.String,
  reason: Schema.String,
  actor: Schema.Literals(["user", "agent", "worker", "controller"]),
})
export type TodoHistoryEntry = typeof TodoHistoryEntrySchema.Type

export const TodoReviewSummarySchema = Schema.Struct({
  reviewerActor: Schema.Literals(["direct", "subagent"]),
  verdict: ReviewVerdictSchema,
  summary: Schema.String,
  workerJobId: Schema.OptionFromOptionalKey(Schema.String),
  reviewedHashes: Schema.Record(Schema.String, Schema.String),
  timestamp: Schema.String,
})
export type TodoReviewSummary = typeof TodoReviewSummarySchema.Type

export const TodoItemSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  stage: Schema.String,
  order: Schema.Int,
  dependencyIds: Schema.Array(Schema.String),
  goal: Schema.String,
  inScope: Schema.Array(Schema.String),
  outOfScope: Schema.Array(Schema.String),
  acceptanceCriteria: Schema.Array(Schema.String),
  difficulty: DifficultySchema,
  difficultyRationale: Schema.String,
  status: TodoStatusSchema,
  attempt: Schema.Int,
  implementationNotes: Schema.Array(Schema.String),
  evidenceIds: Schema.Array(Schema.String),
  reviewResult: Schema.OptionFromOptionalKey(TodoReviewSummarySchema),
  associatedTaskIds: Schema.Array(Schema.String),
  associatedWorkerIds: Schema.Array(Schema.String),
  skipAuthorizationId: Schema.OptionFromOptionalKey(Schema.String),
  history: Schema.Array(TodoHistoryEntrySchema),
})
export type TodoItem = typeof TodoItemSchema.Type

export const EvidenceRecordSchema = Schema.Struct({
  id: Schema.String,
  criterionIds: Schema.Array(Schema.String),
  todoIds: Schema.Array(Schema.String),
  method: EvidenceMethodSchema,
  result: EvidenceResultSchema,
  commandOrObservation: Schema.String,
  exitCode: Schema.OptionFromOptionalKey(Schema.Int),
  outputSnippet: Schema.OptionFromOptionalKey(Schema.String),
  timestamp: Schema.String,
  artifactPaths: Schema.Array(Schema.String),
  reviewedHashes: Schema.Record(Schema.String, Schema.String),
  waiverAuthorizationId: Schema.OptionFromOptionalKey(Schema.String),
})
export type EvidenceRecord = typeof EvidenceRecordSchema.Type

export const QuestionOptionSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.String,
  rationale: Schema.OptionFromOptionalKey(Schema.String),
  previewPath: Schema.OptionFromOptionalKey(Schema.String),
})
export type QuestionOption = typeof QuestionOptionSchema.Type

export const QuestionAnswerSchema = Schema.Struct({
  selectedOptionIds: Schema.Array(Schema.String),
  customText: Schema.OptionFromOptionalKey(Schema.String),
  comments: Schema.OptionFromOptionalKey(Schema.String),
  source: Schema.Literals(["browser", "pi_ui", "command", "delegated_to_agent"]),
  answeredAt: Schema.String,
  previewRevision: Schema.OptionFromOptionalKey(Schema.Int),
})
export type QuestionAnswer = typeof QuestionAnswerSchema.Type

export const DurableQuestionSchema = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  title: Schema.String,
  prompt: Schema.String,
  purpose: Schema.String,
  blocking: Schema.Boolean,
  allowFreeText: Schema.Boolean,
  multiSelect: Schema.Boolean,
  options: Schema.Array(QuestionOptionSchema),
  previewId: Schema.OptionFromOptionalKey(Schema.String),
  status: Schema.Literals(["pending", "answered", "cancelled"]),
  answer: Schema.OptionFromOptionalKey(QuestionAnswerSchema),
  createdAt: Schema.String,
})
export type DurableQuestion = typeof DurableQuestionSchema.Type

export const DecisionRecordSchema = Schema.Struct({
  id: Schema.String,
  category: Schema.Literals(["observed_fact", "user_decision", "design_proposal", "delegated_decision", "unverified_assumption"]),
  summary: Schema.String,
  rationale: Schema.String,
  rejectedAlternatives: Schema.Array(Schema.String),
  sourceReferences: Schema.Array(Schema.String),
  questionId: Schema.OptionFromOptionalKey(Schema.String),
  material: Schema.Boolean,
  timestamp: Schema.String,
})
export type DecisionRecord = typeof DecisionRecordSchema.Type

export const UserAuthorizationSchema = Schema.Struct({
  id: Schema.String,
  kind: AuthorizationKindSchema,
  summary: Schema.String,
  targetRevision: Schema.OptionFromOptionalKey(Schema.Int),
  artifactHash: Schema.OptionFromOptionalKey(Schema.String),
  taskIds: Schema.Array(Schema.String),
  criterionIds: Schema.Array(Schema.String),
  modelOverride: Schema.OptionFromOptionalKey(
    Schema.Struct({
      provider: Schema.OptionFromOptionalKey(Schema.String),
      model: Schema.String,
      thinking: Schema.OptionFromOptionalKey(ThinkingLevelSchema),
    }),
  ),
  actor: Schema.Literals(["user", "delegated_by_user"]),
  timestamp: Schema.String,
})
export type UserAuthorization = typeof UserAuthorizationSchema.Type

export const TaskWaitConditionSchema = Schema.Struct({
  kind: Schema.Literals(["terminal", "ready", "monitor_event"]),
  eventPattern: Schema.OptionFromOptionalKey(Schema.String),
})
export type TaskWaitCondition = typeof TaskWaitConditionSchema.Type

export const TaskBindingSchema = Schema.Struct({
  taskId: Schema.String,
  sessionId: Schema.String,
  originatingToolCallId: Schema.OptionFromOptionalKey(Schema.String),
  workerId: Schema.OptionFromOptionalKey(Schema.String),
  workItemId: Schema.String,
  todoId: Schema.OptionFromOptionalKey(Schema.String),
  purpose: Schema.String,
  ownership: Schema.Literals(["owned", "attached"]),
  waitCondition: TaskWaitConditionSchema,
  resumePhase: WorkflowPhaseSchema,
  requireSuccess: Schema.Boolean,
  lastStatus: ObservedTaskStatusSchema,
  lastExitCode: Schema.OptionFromOptionalKey(Schema.Int),
  lastObservedAt: Schema.String,
  observationSource: Schema.String,
  notifyPolicy: Schema.Literals(["wake", "passive", "silent", "unknown"]),
  autoWakeAvailable: Schema.Boolean,
  retainedResource: Schema.Boolean,
  readinessTimedOut: Schema.Boolean,
})
export type TaskBinding = typeof TaskBindingSchema.Type

export const WaitGroupSchema = Schema.Struct({
  mode: Schema.Literals(["all", "any"]),
  taskIds: Schema.Array(Schema.String),
  enteredAt: Schema.String,
  resumePhase: WorkflowPhaseSchema,
})
export type WaitGroup = typeof WaitGroupSchema.Type

export const PreviewArtifactSchema = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  title: Schema.String,
  questionId: Schema.OptionFromOptionalKey(Schema.String),
  rootRelativeDir: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      description: Schema.String,
      rationale: Schema.String,
      relativeHtmlOrSvgPath: Schema.String,
      sha256: Schema.String,
    }),
  ),
  iconSetLicenseNote: Schema.OptionFromOptionalKey(Schema.String),
  createdAt: Schema.String,
})
export type PreviewArtifact = typeof PreviewArtifactSchema.Type

export const ReviewFindingSchema = Schema.Struct({
  id: Schema.String,
  severity: Schema.Literals(["blocking", "important", "minor"]),
  locationOrRequirement: Schema.String,
  explanation: Schema.String,
  suggestedResolution: Schema.String,
  resolved: Schema.Boolean,
})
export type ReviewFinding = typeof ReviewFindingSchema.Type

export const DraftReviewReportSchema = Schema.Struct({
  id: Schema.String,
  verdict: ReviewVerdictSchema,
  inputManifestHash: Schema.String,
  finalizedHash: Schema.String,
  requestHash: Schema.String,
  decisionsHash: Schema.String,
  criteriaHash: Schema.String,
  projectFileHashes: Schema.Record(Schema.String, Schema.String),
  findings: Schema.Array(ReviewFindingSchema),
  workerJobId: Schema.OptionFromOptionalKey(Schema.String),
  summary: Schema.String,
  timestamp: Schema.String,
})
export type DraftReviewReport = typeof DraftReviewReportSchema.Type

export const PublicationRecordSchema = Schema.Struct({
  id: Schema.String,
  target: Schema.Literals(["spec", "plan"]),
  destinationPath: Schema.String,
  sourceFinalizedHash: Schema.String,
  sourceRevision: Schema.Int,
  publishedHash: Schema.OptionFromOptionalKey(Schema.String),
  status: Schema.Literals(["pending", "completed"]),
  authorizationId: Schema.String,
  timestamp: Schema.String,
})
export type PublicationRecord = typeof PublicationRecordSchema.Type

export const ModelProfileSpecSchema = Schema.Struct({
  model: Schema.String,
  thinking: Schema.Union([Schema.Literal("inherit"), ThinkingLevelSchema]),
})
export type ModelProfileSpec = typeof ModelProfileSpecSchema.Type

export const ResolvedModelSpecSchema = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  requestedThinking: ThinkingLevelSchema,
  effectiveThinking: ThinkingLevelSchema,
  thinkingClamped: Schema.Boolean,
  resolutionSource: Schema.Literals(["job_override", "tier_profile", "parent_inherit"]),
})
export type ResolvedModelSpec = typeof ResolvedModelSpecSchema.Type

export const WorkerRoleSchema = Schema.Literals(["implementation", "verification", "draft_review"])
export type WorkerRole = typeof WorkerRoleSchema.Type

export const WorkerJobRecordSchema = Schema.Struct({
  jobId: Schema.String,
  role: WorkerRoleSchema,
  workItemId: Schema.String,
  todoId: Schema.OptionFromOptionalKey(Schema.String),
  purpose: Schema.String,
  scope: Schema.String,
  inputArtifactHash: Schema.OptionFromOptionalKey(Schema.String),
  inputManifestHash: Schema.OptionFromOptionalKey(Schema.String),
  difficulty: DifficultySchema,
  requestedModel: ModelProfileSpecSchema,
  resolvedModel: ResolvedModelSpecSchema,
  allowedTools: Schema.Array(Schema.String),
  allowedWritePaths: Schema.Array(Schema.String),
  taskId: Schema.OptionFromOptionalKey(Schema.String),
  status: Schema.Literals(["dispatched", "running", "completed", "failed", "blocked", "needs_input"]),
  requestPath: Schema.String,
  resultPath: Schema.String,
  transcriptPath: Schema.String,
  summary: Schema.OptionFromOptionalKey(Schema.String),
  needsInputQuestion: Schema.OptionFromOptionalKey(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type WorkerJobRecord = typeof WorkerJobRecordSchema.Type

export const WorkerRequestPayloadSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  jobId: Schema.String,
  workItemId: Schema.String,
  workItemRevision: Schema.Int,
  role: WorkerRoleSchema,
  todoId: Schema.OptionFromOptionalKey(Schema.String),
  objective: Schema.String,
  purpose: Schema.String,
  scope: Schema.String,
  nonGoals: Schema.Array(Schema.String),
  acceptanceCriteria: Schema.Array(Schema.String),
  verificationCommands: Schema.Array(Schema.String),
  relevantDecisions: Schema.Array(Schema.String),
  inputArtifactHash: Schema.OptionFromOptionalKey(Schema.String),
  inputManifestHash: Schema.OptionFromOptionalKey(Schema.String),
  allowedTools: Schema.Array(Schema.String),
  allowedWritePaths: Schema.Array(Schema.String),
  contextFiles: Schema.Array(Schema.String),
})
export type WorkerRequestPayload = typeof WorkerRequestPayloadSchema.Type
export const WorkerRequestJson = Schema.fromJsonString(WorkerRequestPayloadSchema)

export const WorkerResultPayloadSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  jobId: Schema.String,
  workItemId: Schema.String,
  role: WorkerRoleSchema,
  todoId: Schema.OptionFromOptionalKey(Schema.String),
  inputArtifactHash: Schema.OptionFromOptionalKey(Schema.String),
  inputManifestHash: Schema.OptionFromOptionalKey(Schema.String),
  status: Schema.Literals(["completed", "failed", "blocked", "needs_input"]),
  verdict: Schema.OptionFromOptionalKey(ReviewVerdictSchema),
  summary: Schema.String,
  filesChanged: Schema.Array(Schema.String),
  deviations: Schema.Array(Schema.String),
  findings: Schema.Array(ReviewFindingSchema),
  checksRun: Schema.Array(
    Schema.Struct({
      commandOrCheck: Schema.String,
      passed: Schema.Boolean,
      exitCode: Schema.OptionFromOptionalKey(Schema.Int),
      outputSummary: Schema.String,
    }),
  ),
  needsInputQuestion: Schema.OptionFromOptionalKey(Schema.String),
  timestamp: Schema.String,
})
export type WorkerResultPayload = typeof WorkerResultPayloadSchema.Type
export const WorkerResultJson = Schema.fromJsonString(WorkerResultPayloadSchema)

export const ProgressStateSchema = Schema.Struct({
  noProgressContinuations: Schema.Int,
  repeatedFailureCount: Schema.Int,
  lastFailureFingerprint: Schema.OptionFromOptionalKey(Schema.String),
  recentFingerprints: Schema.Array(Schema.String),
  lastMeaningfulProgressAt: Schema.String,
  lastProgressKind: Schema.String,
  lastContinuationBoundaryKey: Schema.OptionFromOptionalKey(Schema.String),
  totalContinuations: Schema.Int,
})
export type ProgressState = typeof ProgressStateSchema.Type

export const TransitionRecordSchema = Schema.Struct({
  fromPhase: WorkflowPhaseSchema,
  toPhase: WorkflowPhaseSchema,
  fromStatus: RunStatusSchema,
  toStatus: RunStatusSchema,
  reason: Schema.String,
  revision: Schema.Int,
  origin: TransitionOriginSchema,
  timestamp: Schema.String,
})
export type TransitionRecord = typeof TransitionRecordSchema.Type

export const WorkItemConfigOverridesSchema = Schema.Struct({
  maxNoProgressContinuations: Schema.OptionFromOptionalKey(Schema.Int),
  maxRepeatedFailureAttempts: Schema.OptionFromOptionalKey(Schema.Int),
  maxTotalTurns: Schema.OptionFromOptionalKey(Schema.NullOr(Schema.Int)),
  draftGateEnabled: Schema.OptionFromOptionalKey(Schema.Boolean),
  executionDriver: Schema.OptionFromOptionalKey(ExecutionDriverSchema),
  verificationDriver: Schema.OptionFromOptionalKey(VerificationDriverSchema),
  browserEnabled: Schema.OptionFromOptionalKey(Schema.Boolean),
  browserOpenAuthorized: Schema.OptionFromOptionalKey(Schema.Boolean),
})
export type WorkItemConfigOverrides = typeof WorkItemConfigOverridesSchema.Type

export const WorkItemStateSchema = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  id: Schema.String,
  displayName: Schema.String,
  safeDirName: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  revision: Schema.Int,
  workspacePath: Schema.String,
  originatingSessionId: Schema.String,
  owner: Schema.OptionFromOptionalKey(OwnerTokenSchema),
  kind: WorkflowKindSchema,
  phase: WorkflowPhaseSchema,
  runStatus: RunStatusSchema,
  objective: Schema.String,
  nonGoals: Schema.Array(Schema.String),
  constraints: Schema.Array(Schema.String),
  acceptanceCriteria: Schema.Array(AcceptanceCriterionSchema),
  completionScope: CompletionScopeSchema,
  todos: Schema.Array(TodoItemSchema),
  questions: Schema.Array(DurableQuestionSchema),
  decisions: Schema.Array(DecisionRecordSchema),
  authorizations: Schema.Array(UserAuthorizationSchema),
  evidence: Schema.Array(EvidenceRecordSchema),
  artifactHashes: Schema.Record(Schema.String, Schema.String),
  finalizedCandidateHash: Schema.OptionFromOptionalKey(Schema.String),
  draftGateWaiverId: Schema.OptionFromOptionalKey(Schema.String),
  reviews: Schema.Array(DraftReviewReportSchema),
  publications: Schema.Array(PublicationRecordSchema),
  previews: Schema.Array(PreviewArtifactSchema),
  executionDriver: Schema.OptionFromOptionalKey(ExecutionDriverSchema),
  verificationDriver: VerificationDriverSchema,
  trackedTasks: Schema.Array(TaskBindingSchema),
  activeWaitGroup: Schema.OptionFromOptionalKey(WaitGroupSchema),
  workers: Schema.Array(WorkerJobRecordSchema),
  consumedEventKeys: Schema.Array(Schema.String),
  operationIds: Schema.Array(Schema.String),
  nextAction: Schema.String,
  pauseOrBlockReason: Schema.OptionFromOptionalKey(Schema.String),
  goalLevelVerifiedRevision: Schema.OptionFromOptionalKey(Schema.Int),
  retainedResourceIds: Schema.Array(Schema.String),
  completionSummary: Schema.OptionFromOptionalKey(Schema.String),
  archived: Schema.Boolean,
  progress: ProgressStateSchema,
  transitions: Schema.Array(TransitionRecordSchema),
  configOverrides: WorkItemConfigOverridesSchema,
})
export type WorkItemState = typeof WorkItemStateSchema.Type
export const WorkItemStateJson = Schema.fromJsonString(WorkItemStateSchema)

export const emptyConfigOverrides = (): WorkItemConfigOverrides => ({
  maxNoProgressContinuations: Option.none(),
  maxRepeatedFailureAttempts: Option.none(),
  maxTotalTurns: Option.none(),
  draftGateEnabled: Option.none(),
  executionDriver: Option.none(),
  verificationDriver: Option.none(),
  browserEnabled: Option.none(),
  browserOpenAuthorized: Option.none(),
})
