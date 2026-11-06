import { Match, Option, Schema } from "effect"

export class StaleRevisionError extends Schema.TaggedError<StaleRevisionError>()("StaleRevisionError", {
  workItemId: Schema.String,
  expectedRevision: Schema.Int,
  actualRevision: Schema.Int,
  message: Schema.String,
}) {}

export class OwnershipConflictError extends Schema.TaggedError<OwnershipConflictError>()("OwnershipConflictError", {
  workItemId: Schema.String,
  ownerSessionId: Schema.String,
  ownerRuntimeId: Schema.String,
  attemptingSessionId: Schema.String,
  attemptingRuntimeId: Schema.String,
  reason: Schema.String,
}) {}

export class InvalidTransitionError extends Schema.TaggedError<InvalidTransitionError>()("InvalidTransitionError", {
  workItemId: Schema.String,
  fromPhase: Schema.String,
  toPhase: Schema.String,
  fromStatus: Schema.String,
  toStatus: Schema.String,
  reason: Schema.String,
  missingConditions: Schema.Array(Schema.String),
}) {}

export class AuthorizationRequiredError extends Schema.TaggedError<AuthorizationRequiredError>()(
  "AuthorizationRequiredError",
  {
    workItemId: Schema.String,
    decisionKind: Schema.String,
    message: Schema.String,
  },
) {}

export class FinishRejectedError extends Schema.TaggedError<FinishRejectedError>()("FinishRejectedError", {
  workItemId: Schema.String,
  missingConditions: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

export class TodoContractError extends Schema.TaggedError<TodoContractError>()("TodoContractError", {
  workItemId: Schema.String,
  todoId: Schema.OptionFromOptionalKey(Schema.String),
  reason: Schema.String,
  missingConditions: Schema.Array(Schema.String),
}) {}

export class QuestionConflictError extends Schema.TaggedError<QuestionConflictError>()("QuestionConflictError", {
  workItemId: Schema.String,
  questionId: Schema.String,
  status: Schema.Literals(["already_answered", "stale_revision", "paused_or_cancelled", "not_found", "invalid_choice"]),
  message: Schema.String,
}) {}

export class PreviewSecurityError extends Schema.TaggedError<PreviewSecurityError>()("PreviewSecurityError", {
  reason: Schema.String,
  path: Schema.OptionFromOptionalKey(Schema.String),
}) {}

export class PathSafetyError extends Schema.TaggedError<PathSafetyError>()("PathSafetyError", {
  inputName: Schema.String,
  reason: Schema.String,
}) {}

export class PersistenceError extends Schema.TaggedError<PersistenceError>()("PersistenceError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
  corrupted: Schema.Boolean,
}) {}

export class RealtasksAdapterError extends Schema.TaggedError<RealtasksAdapterError>()("RealtasksAdapterError", {
  taskId: Schema.OptionFromOptionalKey(Schema.String),
  reason: Schema.String,
  unavailableFromSession: Schema.Boolean,
}) {}

export class WorkerValidationError extends Schema.TaggedError<WorkerValidationError>()("WorkerValidationError", {
  jobId: Schema.String,
  status: Schema.Literals(["failed", "blocked", "needs_input"]),
  reason: Schema.String,
}) {}

export class RoleGuardError extends Schema.TaggedError<RoleGuardError>()("RoleGuardError", {
  role: Schema.String,
  attemptedAction: Schema.String,
  reason: Schema.String,
}) {}

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()("ConfigurationError", {
  source: Schema.String,
  message: Schema.String,
}) {}

export class WorkItemNotFoundError extends Schema.TaggedError<WorkItemNotFoundError>()("WorkItemNotFoundError", {
  workItemId: Schema.String,
  message: Schema.String,
}) {}

export type RealgoalError =
  | StaleRevisionError
  | OwnershipConflictError
  | InvalidTransitionError
  | AuthorizationRequiredError
  | FinishRejectedError
  | TodoContractError
  | QuestionConflictError
  | PreviewSecurityError
  | PathSafetyError
  | PersistenceError
  | RealtasksAdapterError
  | WorkerValidationError
  | RoleGuardError
  | ConfigurationError
  | WorkItemNotFoundError

export interface StructuredErrorPayload {
  readonly code: RealgoalError["_tag"]
  readonly message: string
  readonly details: Record<string, unknown>
}

export const toStructuredError = (error: RealgoalError): StructuredErrorPayload =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      StaleRevisionError: (e) => ({
        code: e._tag,
        message: e.message,
        details: {
          workItemId: e.workItemId,
          expectedRevision: e.expectedRevision,
          actualRevision: e.actualRevision,
        },
      }),
      OwnershipConflictError: (e) => ({
        code: e._tag,
        message: e.reason,
        details: {
          workItemId: e.workItemId,
          ownerSessionId: e.ownerSessionId,
          ownerRuntimeId: e.ownerRuntimeId,
          attemptingSessionId: e.attemptingSessionId,
          attemptingRuntimeId: e.attemptingRuntimeId,
        },
      }),
      InvalidTransitionError: (e) => ({
        code: e._tag,
        message: e.reason,
        details: {
          workItemId: e.workItemId,
          fromPhase: e.fromPhase,
          toPhase: e.toPhase,
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          missingConditions: e.missingConditions,
        },
      }),
      AuthorizationRequiredError: (e) => ({
        code: e._tag,
        message: e.message,
        details: {
          workItemId: e.workItemId,
          decisionKind: e.decisionKind,
        },
      }),
      FinishRejectedError: (e) => ({
        code: e._tag,
        message: e.message,
        details: {
          workItemId: e.workItemId,
          missingConditions: e.missingConditions,
        },
      }),
      TodoContractError: (e) => ({
        code: e._tag,
        message: e.reason,
        details: {
          workItemId: e.workItemId,
          todoId: Option.getOrUndefined(e.todoId),
          missingConditions: e.missingConditions,
        },
      }),
      QuestionConflictError: (e) => ({
        code: e._tag,
        message: e.message,
        details: {
          workItemId: e.workItemId,
          questionId: e.questionId,
          status: e.status,
        },
      }),
      PreviewSecurityError: (e) => ({
        code: e._tag,
        message: e.reason,
        details: {
          path: Option.getOrUndefined(e.path),
        },
      }),
      PathSafetyError: (e) => ({
        code: e._tag,
        message: e.reason,
        details: {
          inputName: e.inputName,
        },
      }),
      PersistenceError: (e) => ({
        code: e._tag,
        message: e.message,
        details: {
          operation: e.operation,
          path: e.path,
          corrupted: e.corrupted,
        },
      }),
      RealtasksAdapterError: (e) => ({
        code: e._tag,
        message: e.reason,
        details: {
          taskId: Option.getOrUndefined(e.taskId),
          unavailableFromSession: e.unavailableFromSession,
        },
      }),
      WorkerValidationError: (e) => ({
        code: e._tag,
        message: e.reason,
        details: {
          jobId: e.jobId,
          status: e.status,
        },
      }),
      RoleGuardError: (e) => ({
        code: e._tag,
        message: e.reason,
        details: {
          role: e.role,
          attemptedAction: e.attemptedAction,
        },
      }),
      ConfigurationError: (e) => ({
        code: e._tag,
        message: e.message,
        details: {
          source: e.source,
        },
      }),
      WorkItemNotFoundError: (e) => ({
        code: e._tag,
        message: e.message,
        details: {
          workItemId: e.workItemId,
        },
      }),
    }),
  )
