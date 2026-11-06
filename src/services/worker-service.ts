import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import type { ResolvedRealgoalConfig } from "../domain/config.ts"
import {
  AuthorizationRequiredError,
  PersistenceError,
  RealtasksAdapterError,
  WorkerValidationError,
  type RealgoalError,
} from "../domain/errors.ts"
import {
  WorkerRequestJson,
  WorkerResultJson,
  type Difficulty,
  type ModelProfileSpec,
  type ResolvedModelSpec,
  type ThinkingLevelValue,
  type UserAuthorization,
  type WorkerJobRecord,
  type WorkerRequestPayload,
  type WorkerResultPayload,
  type WorkerRole,
  type WorkItemState,
} from "../domain/models.ts"
import { atomicWriteTextFile } from "./persistence.ts"
import { isCandidateInsideRoot, resolveWithinRoot } from "./path-safety.ts"
import { RealtasksBashDetailsSchema, type ToolInvoker } from "./realtasks-adapter.ts"

export interface ParentModelSnapshot {
  readonly provider: string
  readonly modelId: string
  readonly thinkingLevel: ThinkingLevelValue
  readonly availableModels: ReadonlyArray<{
    readonly provider: string
    readonly id: string
    readonly reasoning: boolean
    readonly supportedThinkingLevels?: ReadonlyArray<ThinkingLevelValue>
    readonly hasChildCredentials: boolean
    readonly isEphemeralParentOnly?: boolean
  }>
}

const THINKING_FALLBACK_ORDER: ReadonlyArray<ThinkingLevelValue> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

const clampThinkingForModel = (
  requested: ThinkingLevelValue,
  reasoningSupported: boolean,
  supportedLevels?: ReadonlyArray<ThinkingLevelValue>,
): { readonly effective: ThinkingLevelValue; readonly clamped: boolean } => {
  if (!reasoningSupported) {
    return {
      effective: "off",
      clamped: requested !== "off",
    }
  }
  const allowed =
    supportedLevels && supportedLevels.length > 0
      ? supportedLevels
      : (["off", "minimal", "low", "medium", "high"] as ReadonlyArray<ThinkingLevelValue>)

  if (allowed.includes(requested)) {
    return { effective: requested, clamped: false }
  }
  const reqIdx = THINKING_FALLBACK_ORDER.indexOf(requested)
  for (let i = reqIdx - 1; i >= 0; i--) {
    const candidate = THINKING_FALLBACK_ORDER[i]
    if (candidate && allowed.includes(candidate)) {
      return { effective: candidate, clamped: true }
    }
  }
  const first = allowed[0] ?? "off"
  return { effective: first, clamped: first !== requested }
}

const parseModelPattern = (
  rawModel: string,
  fallbackProvider: string,
): { readonly provider: string; readonly modelId: string } => {
  const slashIdx = rawModel.indexOf("/")
  if (slashIdx > 0) {
    return {
      provider: rawModel.slice(0, slashIdx),
      modelId: rawModel.slice(slashIdx + 1),
    }
  }
  return {
    provider: fallbackProvider,
    modelId: rawModel,
  }
}

export const resolveWorkerModel = (params: {
  readonly difficulty: Difficulty
  readonly config: ResolvedRealgoalConfig
  readonly parent: ParentModelSnapshot
  readonly explicitOverrideAuthorization?: Option.Option<UserAuthorization>
}): Effect.Effect<
  {
    readonly requested: ModelProfileSpec
    readonly resolved: ResolvedModelSpec
    readonly warning: Option.Option<string>
  },
  RealgoalError
> => {
  const tierProfile = params.config.models[params.difficulty]
  const overrideOpt = Option.flatMap(
    params.explicitOverrideAuthorization ?? Option.none(),
    (auth) => (auth.kind === "model_override" ? auth.modelOverride : Option.none()),
  )

  const resolutionSource: ResolvedModelSpec["resolutionSource"] = Option.isSome(overrideOpt)
    ? "job_override"
    : tierProfile.model !== "inherit" || tierProfile.thinking !== "inherit"
      ? "tier_profile"
      : "parent_inherit"

  const requestedModelStr = Option.match(overrideOpt, {
    onNone: () => tierProfile.model,
    onSome: (ov) =>
      Option.match(ov.provider, {
        onNone: () => ov.model,
        onSome: (p) => `${p}/${ov.model}`,
      }),
  })

  const requestedThinkingUnion: ModelProfileSpec["thinking"] = Option.match(overrideOpt, {
    onNone: () => tierProfile.thinking,
    onSome: (ov) => Option.getOrElse(ov.thinking, () => tierProfile.thinking),
  })

  const targetModelPair =
    requestedModelStr === "inherit"
      ? { provider: params.parent.provider, modelId: params.parent.modelId }
      : parseModelPattern(requestedModelStr, params.parent.provider)

  const requestedThinking: ThinkingLevelValue =
    requestedThinkingUnion === "inherit" ? params.parent.thinkingLevel : requestedThinkingUnion

  if (params.parent.availableModels.length > 0) {
    const matched = params.parent.availableModels.find(
      (m) =>
        (m.provider === targetModelPair.provider && m.id === targetModelPair.modelId) ||
        m.id === targetModelPair.modelId,
    )
    if (!matched) {
      return Effect.fail(
        new WorkerValidationError({
          jobId: "dispatch",
          status: "blocked",
          reason: `Resolved worker model "${targetModelPair.provider}/${targetModelPair.modelId}" is unavailable in child registry. Configure a supported model or credentials rather than swapping silently.`,
        }),
      )
    }
    if (matched.isEphemeralParentOnly) {
      return Effect.fail(
        new WorkerValidationError({
          jobId: "dispatch",
          status: "blocked",
          reason: `Model "${matched.provider}/${matched.id}" comes from an in-process parent-only custom provider and cannot be spawned in an isolated child Pi process without an approved adapter.`,
        }),
      )
    }
    if (!matched.hasChildCredentials) {
      return Effect.fail(
        new WorkerValidationError({
          jobId: "dispatch",
          status: "blocked",
          reason: `Missing child authentication/credentials for provider "${matched.provider}" (model "${matched.id}"). Authenticate in Pi before dispatching subagents.`,
        }),
      )
    }

    const clampedResult = clampThinkingForModel(
      requestedThinking,
      matched.reasoning,
      matched.supportedThinkingLevels,
    )
    const warning = clampedResult.clamped
      ? Option.some(
          `Model ${matched.provider}/${matched.id} does not support thinking="${requestedThinking}"; clamped to "${clampedResult.effective}".`,
        )
      : Option.none()

    return Effect.succeed({
      requested: {
        model: requestedModelStr,
        thinking: requestedThinkingUnion,
      },
      resolved: {
        provider: matched.provider,
        modelId: matched.id,
        requestedThinking,
        effectiveThinking: clampedResult.effective,
        thinkingClamped: clampedResult.clamped,
        resolutionSource,
      },
      warning,
    })
  }

  return Effect.succeed({
    requested: {
      model: requestedModelStr,
      thinking: requestedThinkingUnion,
    },
    resolved: {
      provider: targetModelPair.provider,
      modelId: targetModelPair.modelId,
      requestedThinking,
      effectiveThinking: requestedThinking,
      thinkingClamped: false,
      resolutionSource,
    },
    warning: Option.none(),
  })
}

export const posixShellQuote = (arg: string): string => {
  if (arg.length === 0) return "''"
  const normalized = process.platform === "win32" ? arg.replace(/\\/g, "/") : arg
  return `'${normalized.replace(/'/g, `'\\''`)}'`
}

export const splitStrictJsonlLines = (rawBufferText: string): ReadonlyArray<string> => {
  const lines = rawBufferText.split("\n")
  return lines
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.trim().length > 0)
}

export const validateWorkerTranscriptAndResult = (params: {
  readonly job: WorkerJobRecord
  readonly rawTranscript: string
  readonly rawResultJsonOption: Option.Option<string>
}): Effect.Effect<WorkerResultPayload, WorkerValidationError> => {
  const lines = splitStrictJsonlLines(params.rawTranscript)
  if (lines.length === 0) {
    return Effect.fail(
      new WorkerValidationError({
        jobId: params.job.jobId,
        status: "failed",
        reason: `Worker ${params.job.jobId} produced an empty JSONL transcript (missing session/settlement events)`,
      }),
    )
  }

  const parsedEvents: Record<string, unknown>[] = []
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ""
    try {
      const parsed = JSON.parse(rawLine) as unknown
      if (!Predicate.isObject(parsed)) {
        return Effect.fail(
          new WorkerValidationError({
            jobId: params.job.jobId,
            status: "failed",
            reason: `Non-object JSONL record at line ${i + 1} in worker ${params.job.jobId}`,
          }),
        )
      }
      parsedEvents.push(parsed as Record<string, unknown>)
    } catch {
      return Effect.fail(
        new WorkerValidationError({
          jobId: params.job.jobId,
          status: "failed",
          reason: `Truncated or malformed JSONL record at line ${i + 1} in worker ${params.job.jobId}`,
        }),
      )
    }
  }

  const hasSessionHeader = parsedEvents[0]?.["type"] === "session"
  if (!hasSessionHeader) {
    return Effect.fail(
      new WorkerValidationError({
        jobId: params.job.jobId,
        status: "failed",
        reason: `Worker ${params.job.jobId} transcript is missing initial {"type":"session"} header`,
      }),
    )
  }

  const settledEvents = parsedEvents.filter((e) => e["type"] === "agent_settled")
  const lastSettled = settledEvents[settledEvents.length - 1]
  if (!lastSettled) {
    return Effect.fail(
      new WorkerValidationError({
        jobId: params.job.jobId,
        status: "failed",
        reason: `Worker ${params.job.jobId} exited without emitting agent_settled`,
      }),
    )
  }
  if (lastSettled["aborted"] === true) {
    return Effect.fail(
      new WorkerValidationError({
        jobId: params.job.jobId,
        status: "failed",
        reason: `Worker ${params.job.jobId} run aborted (agent_settled.aborted === true)`,
      }),
    )
  }

  const assistantEnds = parsedEvents.filter((e) => {
    if (e["type"] !== "message_end") return false
    const msg = e["message"]
    return Predicate.isObject(msg) && msg["role"] === "assistant"
  })
  const finalAssistantMsg =
    assistantEnds.length > 0
      ? (assistantEnds[assistantEnds.length - 1]?.["message"] as Record<string, unknown>)
      : undefined

  if (!finalAssistantMsg) {
    return Effect.fail(
      new WorkerValidationError({
        jobId: params.job.jobId,
        status: "failed",
        reason: `Worker ${params.job.jobId} emitted no final assistant message`,
      }),
    )
  }

  const stopReason = finalAssistantMsg["stopReason"]
  if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") {
    const errMsg =
      typeof finalAssistantMsg["errorMessage"] === "string"
        ? `: ${finalAssistantMsg["errorMessage"]}`
        : ""
    return Effect.fail(
      new WorkerValidationError({
        jobId: params.job.jobId,
        status: "failed",
        reason: `Worker ${params.job.jobId} final assistant stopReason="${String(stopReason)}"${errMsg} (process exit 0 is not sufficient)`,
      }),
    )
  }

  return Option.match(params.rawResultJsonOption, {
    onNone: () =>
      Effect.fail(
        new WorkerValidationError({
          jobId: params.job.jobId,
          status: "failed",
          reason: `Worker ${params.job.jobId} finished without calling realgoal_worker_result to write result.json`,
        }),
      ),
    onSome: (rawJson) =>
      Schema.decodeUnknownEffect(WorkerResultJson)(rawJson).pipe(
        Effect.mapError(
          (err) =>
            new WorkerValidationError({
              jobId: params.job.jobId,
              status: "failed",
              reason: `Worker ${params.job.jobId} result.json failed schema validation: ${err.message}`,
            }),
        ),
        Effect.flatMap((decoded): Effect.Effect<WorkerResultPayload, WorkerValidationError> => {
          if (decoded.workItemId !== params.job.workItemId || decoded.jobId !== params.job.jobId) {
            return Effect.fail(
              new WorkerValidationError({
                jobId: params.job.jobId,
                status: "failed",
                reason: `Worker result workItemId/jobId mismatch (expected ${params.job.workItemId}/${params.job.jobId}, got ${decoded.workItemId}/${decoded.jobId})`,
              }),
            )
          }
          if (decoded.role !== params.job.role) {
            return Effect.fail(
              new WorkerValidationError({
                jobId: params.job.jobId,
                status: "failed",
                reason: `Worker result role mismatch (expected ${params.job.role}, got ${decoded.role})`,
              }),
            )
          }
          if (
            Option.isSome(params.job.inputArtifactHash) &&
            (!Option.isSome(decoded.inputArtifactHash) ||
              decoded.inputArtifactHash.value !== params.job.inputArtifactHash.value)
          ) {
            return Effect.fail(
              new WorkerValidationError({
                jobId: params.job.jobId,
                status: "failed",
                reason: `Worker result inputArtifactHash mismatch (stale or forged revision)`,
              }),
            )
          }
          if (
            Option.isSome(params.job.inputManifestHash) &&
            (!Option.isSome(decoded.inputManifestHash) ||
              decoded.inputManifestHash.value !== params.job.inputManifestHash.value)
          ) {
            return Effect.fail(
              new WorkerValidationError({
                jobId: params.job.jobId,
                status: "failed",
                reason: `Worker result inputManifestHash mismatch`,
              }),
            )
          }
          if (decoded.status === "failed" || decoded.status === "blocked") {
            return Effect.fail(
              new WorkerValidationError({
                jobId: params.job.jobId,
                status: decoded.status,
                reason: `Worker reported ${decoded.status}: ${decoded.summary}`,
              }),
            )
          }
          return Effect.succeed(decoded)
        }),
      ),
  })
}

const renderWorkerPromptMarkdown = (req: WorkerRequestPayload): string => {
  const roleHeading =
    req.role === "draft_review"
      ? "Independent Draft Gap Reviewer"
      : req.role === "verification"
        ? "Independent Verification Reviewer"
        : "Scoped Implementation Worker"

  return [
    `# Realgoal Delegated Job — ${roleHeading}`,
    "",
    `- **Job ID:** \`${req.jobId}\``,
    `- **Work Item ID:** \`${req.workItemId}\` (rev \`${req.workItemRevision}\`)`,
    `- **Role:** \`${req.role}\``,
    ...(Option.isSome(req.todoId) ? [`- **Target TODO:** \`${req.todoId.value}\``] : []),
    ...(Option.isSome(req.inputArtifactHash)
      ? [`- **Input Artifact Hash:** \`${req.inputArtifactHash.value}\``]
      : []),
    ...(Option.isSome(req.inputManifestHash)
      ? [`- **Input Manifest Hash:** \`${req.inputManifestHash.value}\``]
      : []),
    "",
    `## Objective`,
    req.objective,
    "",
    `## Job Purpose & Scope`,
    `${req.purpose}`,
    "",
    `${req.scope}`,
    "",
    ...(req.nonGoals.length > 0 ? [`## Non-Goals`, ...req.nonGoals.map((n) => `- ${n}`), ""] : []),
    ...(req.relevantDecisions.length > 0
      ? [`## Relevant Material Decisions`, ...req.relevantDecisions.map((d) => `- ${d}`), ""]
      : []),
    ...(req.contextFiles.length > 0
      ? [`## Relevant Files to Inspect`, ...req.contextFiles.map((f) => `- \`${f}\``), ""]
      : []),
    `## Acceptance Criteria`,
    ...req.acceptanceCriteria.map((c) => `- ${c}`),
    "",
    ...(req.verificationCommands.length > 0
      ? [`## Verification Checks`, ...req.verificationCommands.map((v) => `- \`${v}\``), ""]
      : []),
    `## Mandatory Result Contract`,
    `1. Stay strictly within your assigned role (\`${req.role}\`) and allowed scope.`,
    `2. Do NOT attempt to mark the parent goal complete or mutate \`.pi/realgoal/draft/.../state.json\`.`,
    `3. If a blocking question prevents execution, call \`realgoal_worker_result\` with \`status: "needs_input"\` and \`needsInputQuestion\`.`,
    `4. When finished, you MUST call \`realgoal_worker_result\` with your structured report.`,
    "",
  ].join("\n")
}

export const defaultAllowedToolsForRole = (role: WorkerRole): ReadonlyArray<string> => {
  switch (role) {
    case "draft_review":
      return ["read", "grep", "find", "ls", "realgoal_worker_result"]
    case "verification":
      return ["read", "grep", "find", "ls", "realgoal_worker_result"]
    case "implementation":
      return ["read", "edit", "write", "bash", "grep", "find", "ls", "realgoal_worker_result"]
  }
}

export const buildSafeWorkerCommand = (params: {
  readonly piExecutable: string
  readonly workerExtensionPath: string
  readonly resolvedModel: ResolvedModelSpec
  readonly allowedTools: ReadonlyArray<string>
  readonly requestPath: string
  readonly resultPath: string
  readonly promptPath: string
  readonly transcriptPath: string
  readonly stderrPath: string
  readonly role: WorkerRole
}): string => {
  const toolList = [...new Set([...params.allowedTools, "realgoal_worker_result"])].join(",")
  const envPrefix = [
    `REALGOAL_WORKER_ROLE=${posixShellQuote(params.role)}`,
    `REALGOAL_WORKER_REQUEST_FILE=${posixShellQuote(params.requestPath)}`,
    `REALGOAL_WORKER_RESULT_FILE=${posixShellQuote(params.resultPath)}`,
  ].join(" ")

  const cliArgs = [
    posixShellQuote(params.piExecutable),
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "-e",
    posixShellQuote(params.workerExtensionPath),
    "--provider",
    posixShellQuote(params.resolvedModel.provider),
    "--model",
    posixShellQuote(params.resolvedModel.modelId),
    "--thinking",
    posixShellQuote(params.resolvedModel.effectiveThinking),
    "--tools",
    posixShellQuote(toolList),
    "--exclude-tools",
    posixShellQuote("mcp__*"),
    posixShellQuote(`@${params.promptPath}`),
  ].join(" ")

  return `${envPrefix} ${cliArgs} > ${posixShellQuote(params.transcriptPath)} 2> ${posixShellQuote(params.stderrPath)}`
}

export class WorkerService extends Context.Service<
  WorkerService,
  {
    readonly dispatchWorker: (params: {
      readonly invoker: ToolInvoker
      readonly workspaceCwd: string
      readonly draftDir: string
      readonly state: WorkItemState
      readonly config: ResolvedRealgoalConfig
      readonly parentModel: ParentModelSnapshot
      readonly jobId: string
      readonly role: WorkerRole
      readonly todoId: Option.Option<string>
      readonly purpose: string
      readonly scope: string
      readonly difficulty: Difficulty
      readonly inputArtifactHash: Option.Option<string>
      readonly inputManifestHash: Option.Option<string>
      readonly allowedTools?: ReadonlyArray<string>
      readonly allowedWritePaths?: ReadonlyArray<string>
      readonly contextFiles: ReadonlyArray<string>
      readonly verificationCommands: ReadonlyArray<string>
      readonly modelOverrideAuthId?: Option.Option<string>
      readonly piExecutable?: string
      readonly nowIso: string
      readonly signal?: AbortSignal
    }) => Effect.Effect<
      {
        readonly job: WorkerJobRecord
        readonly taskId: string
        readonly modelWarning: Option.Option<string>
      },
      RealgoalError
    >
    readonly collectAndValidateWorker: (job: WorkerJobRecord) => Effect.Effect<WorkerResultPayload, RealgoalError>
  }
>()("realgoal/services/WorkerService") {
  static readonly layer = Layer.succeed(
    WorkerService,
    WorkerService.of({
      dispatchWorker: (params) =>
        Effect.Do.pipe(
          Effect.tap((): Effect.Effect<void, RealgoalError> => {
            if (params.role === "implementation") {
              const activeWriter = params.state.workers.find(
                (w) =>
                  w.role === "implementation" &&
                  (w.status === "dispatched" || w.status === "running"),
              )
              if (activeWriter) {
                return Effect.fail(
                  new WorkerValidationError({
                    jobId: params.jobId,
                    status: "blocked",
                    reason: `maxConcurrentWriters is 1; implementation worker ${activeWriter.jobId} is already active`,
                  }),
                )
              }
            }
            return Effect.void
          }),
          Effect.bind("overrideAuthOpt", (): Effect.Effect<Option.Option<UserAuthorization>, RealgoalError> =>
            Option.match(params.modelOverrideAuthId ?? Option.none(), {
              onNone: () => Effect.succeed(Option.none()),
              onSome: (authId) => {
                const found = params.state.authorizations.find(
                  (a) => a.id === authId && a.kind === "model_override",
                )
                return found
                  ? Effect.succeed(Option.some(found))
                  : Effect.fail(
                      new AuthorizationRequiredError({
                        workItemId: params.state.id,
                        decisionKind: "model_override",
                        message: `Model override requires recorded user authorization (unknown auth ${authId})`,
                      }),
                    )
              },
            }),
          ),
          Effect.bind("modelRes", ({ overrideAuthOpt }) =>
            resolveWorkerModel({
              difficulty: params.difficulty,
              config: params.config,
              parent: params.parentModel,
              explicitOverrideAuthorization: overrideAuthOpt,
            }),
          ),
          Effect.bind("workersRoot", () => resolveWithinRoot(params.draftDir, "workers")),
          Effect.bind("jobDir", ({ workersRoot }) => resolveWithinRoot(workersRoot, params.jobId)),
          Effect.flatMap(({ modelRes, jobDir }) => {
            const requestPath = path.join(jobDir, "request.json")
            const resultPath = path.join(jobDir, "result.json")
            const promptPath = path.join(jobDir, "prompt.md")
            const transcriptPath = path.join(jobDir, "transcript.jsonl")
            const stderrPath = path.join(jobDir, "stderr.log")

            const roleTools = params.allowedTools
              ? params.role === "draft_review"
                ? params.allowedTools.filter((t) => t !== "bash" && t !== "write" && t !== "edit")
                : params.allowedTools
              : defaultAllowedToolsForRole(params.role)

            const writeScope =
              params.role === "implementation"
                ? params.allowedWritePaths && params.allowedWritePaths.length > 0
                  ? [...params.allowedWritePaths]
                  : [params.workspaceCwd]
                : []

            const reqPayload: WorkerRequestPayload = {
              schemaVersion: 1,
              jobId: params.jobId,
              workItemId: params.state.id,
              workItemRevision: params.state.revision,
              role: params.role,
              todoId: params.todoId,
              objective: params.state.objective,
              purpose: params.purpose,
              scope: params.scope,
              nonGoals: params.state.nonGoals,
              acceptanceCriteria: params.state.acceptanceCriteria
                .filter((c) => c.required)
                .map((c) => `${c.id}: ${c.description}`),
              verificationCommands: [...params.verificationCommands],
              relevantDecisions: params.state.decisions.map((d) => `${d.id} [${d.category}]: ${d.summary}`),
              inputArtifactHash: params.inputArtifactHash,
              inputManifestHash: params.inputManifestHash,
              allowedTools: [...roleTools],
              allowedWritePaths: writeScope,
              contextFiles: [...params.contextFiles],
            }

            const thisFileDir = path.dirname(fileURLToPath(import.meta.url))
            const workerExtensionPath = path.resolve(thisFileDir, "..", "..", "extensions", "worker-entry.ts")

            const command = buildSafeWorkerCommand({
              piExecutable: params.piExecutable ?? "pi",
              workerExtensionPath,
              resolvedModel: modelRes.resolved,
              allowedTools: roleTools,
              requestPath,
              resultPath,
              promptPath,
              transcriptPath,
              stderrPath,
              role: params.role,
            })

            return Schema.encodeEffect(WorkerRequestJson)(reqPayload).pipe(
              Effect.mapError(
                (err) =>
                  new PersistenceError({
                    operation: "encodeWorkerRequest",
                    path: requestPath,
                    message: err.message,
                    corrupted: false,
                  }),
              ),
              Effect.flatMap((reqJson) =>
                atomicWriteTextFile(requestPath, JSON.stringify(JSON.parse(reqJson), null, 2) + "\n"),
              ),
              Effect.flatMap(() => atomicWriteTextFile(promptPath, renderWorkerPromptMarkdown(reqPayload))),
              Effect.flatMap(() =>
                params.invoker(
                  "bash",
                  {
                    command,
                    description: `realgoal ${params.role} worker ${params.jobId}`,
                    run_in_background: true,
                    notify: "wake",
                    keep_alive: params.config.tasks.keepAlive,
                    rtk: "off",
                  },
                  params.signal,
                ),
              ),
              Effect.flatMap((launchRes): Effect.Effect<{
                readonly job: WorkerJobRecord
                readonly taskId: string
                readonly modelWarning: Option.Option<string>
              }, RealgoalError> => {
                if (launchRes.isError) {
                  return Effect.fail(
                    new RealtasksAdapterError({
                      taskId: Option.none(),
                      reason: `Failed launching worker ${params.jobId} via realtasks bash: ${launchRes.contentText}`,
                      unavailableFromSession: false,
                    }),
                  )
                }
                const bashDetailsOpt = Schema.decodeUnknownOption(RealtasksBashDetailsSchema)(launchRes.details)
                const taskIdOpt = Option.flatMap(bashDetailsOpt, (d) => d.taskId)
                return Option.match(taskIdOpt, {
                  onNone: () =>
                    Effect.fail(
                      new RealtasksAdapterError({
                        taskId: Option.none(),
                        reason: `Realtasks bash launch did not return details.taskId for worker ${params.jobId}`,
                        unavailableFromSession: false,
                      }),
                    ),
                  onSome: (taskId) => {
                    const jobRecord: WorkerJobRecord = {
                      jobId: params.jobId,
                      role: params.role,
                      workItemId: params.state.id,
                      todoId: params.todoId,
                      purpose: params.purpose,
                      scope: params.scope,
                      inputArtifactHash: params.inputArtifactHash,
                      inputManifestHash: params.inputManifestHash,
                      difficulty: params.difficulty,
                      requestedModel: modelRes.requested,
                      resolvedModel: modelRes.resolved,
                      allowedTools: [...roleTools],
                      allowedWritePaths: writeScope,
                      taskId: Option.some(taskId),
                      status: "running",
                      requestPath,
                      resultPath,
                      transcriptPath,
                      summary: Option.none(),
                      needsInputQuestion: Option.none(),
                      createdAt: params.nowIso,
                      updatedAt: params.nowIso,
                    }
                    return Effect.succeed({
                      job: jobRecord,
                      taskId,
                      modelWarning: modelRes.warning,
                    })
                  },
                })
              }),
            )
          }),
        ),

      collectAndValidateWorker: (job) =>
        Effect.all({
          rawTranscript: Effect.tryPromise({
            try: () => fs.readFile(job.transcriptPath, "utf8"),
            catch: (err) =>
              new WorkerValidationError({
                jobId: job.jobId,
                status: "failed",
                reason: `Missing or unreadable worker transcript at ${job.transcriptPath}: ${(err as Error).message}`,
              }),
          }),
          rawResultOpt: Effect.tryPromise({
            try: () => fs.readFile(job.resultPath, "utf8"),
            catch: () => null,
          }).pipe(
            Effect.orElseSucceed(() => null),
            Effect.map((v) => (v === null ? Option.none<string>() : Option.some(v))),
          ),
        }).pipe(
          Effect.flatMap(({ rawTranscript, rawResultOpt }) =>
            validateWorkerTranscriptAndResult({
              job,
              rawTranscript,
              rawResultJsonOption: rawResultOpt,
            }),
          ),
        ),
    }),
  )
}

export const checkWorkerWriteAllowed = (
  workspaceCwd: string,
  allowedWritePaths: ReadonlyArray<string>,
  candidatePath: string,
): Effect.Effect<boolean, never> => {
  const normalizedCandidate = path.resolve(workspaceCwd, candidatePath)
  if (normalizedCandidate.replace(/\\/g, "/").includes("/realgoal/draft/")) {
    return Effect.succeed(false)
  }
  return Effect.forEach(allowedWritePaths, (allowedRoot) =>
    isCandidateInsideRoot(workspaceCwd, path.resolve(workspaceCwd, allowedRoot), candidatePath),
  ).pipe(Effect.map((flags) => flags.some(Boolean)))
}
