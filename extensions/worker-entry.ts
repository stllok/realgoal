import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Predicate, Schema } from "effect"
import { RoleGuardError } from "../src/domain/errors.ts"
import {
  WorkerRequestJson,
  WorkerResultJson,
  type ReviewFinding,
  type WorkerRequestPayload,
  type WorkerResultPayload,
} from "../src/domain/models.ts"
import { atomicWriteTextFile } from "../src/services/persistence.ts"
import { checkWorkerWriteAllowed } from "../src/services/worker-service.ts"

const PARENT_ONLY_TOOLS = new Set([
  "realgoal_control",
  "realgoal_todo",
  "realgoal_question",
  "realgoal_preview",
  "realgoal_delegate",
  "realgoal_finish",
])

const MUTATING_BUILTIN_TOOLS = new Set(["write", "edit", "bash", "powershell"])

const WorkerResultToolParams = Type.Object({
  status: Type.Union([
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("blocked"),
    Type.Literal("needs_input"),
  ]),
  verdict: Type.Optional(
    Type.Union([Type.Literal("pass"), Type.Literal("changes_required"), Type.Literal("blocked")]),
  ),
  summary: Type.String({ description: "Concise summary of work, review verdict, or blocker" }),
  filesChanged: Type.Optional(Type.Array(Type.String())),
  deviations: Type.Optional(Type.Array(Type.String())),
  findings: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        severity: Type.Union([Type.Literal("blocking"), Type.Literal("important"), Type.Literal("minor")]),
        locationOrRequirement: Type.String(),
        explanation: Type.String(),
        suggestedResolution: Type.String(),
      }),
    ),
  ),
  checksRun: Type.Optional(
    Type.Array(
      Type.Object({
        commandOrCheck: Type.String(),
        passed: Type.Boolean(),
        exitCode: Type.Optional(Type.Number()),
        outputSummary: Type.String(),
      }),
    ),
  ),
  needsInputQuestion: Type.Optional(
    Type.String({ description: "Clarification question to escalate to parent when status='needs_input'" }),
  ),
})

const loadWorkerRequest = (requestFile: string): Effect.Effect<WorkerRequestPayload, RoleGuardError> =>
  Effect.tryPromise({
    try: () => fs.readFile(requestFile, "utf8"),
    catch: (err) =>
      new RoleGuardError({
        role: process.env["REALGOAL_WORKER_ROLE"] ?? "worker",
        attemptedAction: "loadWorkerRequest",
        reason: `Failed reading worker request file ${requestFile}: ${(err as Error).message}`,
      }),
  }).pipe(
    Effect.flatMap((raw) =>
      Schema.decodeUnknownEffect(WorkerRequestJson)(raw).pipe(
        Effect.mapError(
          (err) =>
            new RoleGuardError({
              role: process.env["REALGOAL_WORKER_ROLE"] ?? "worker",
              attemptedAction: "decodeWorkerRequest",
              reason: `Invalid worker request schema: ${err.message}`,
            }),
        ),
      ),
    ),
  )

export default function realgoalWorkerExtension(pi: ExtensionAPI): void {
  const runtime = ManagedRuntime.make(Layer.empty)
  const requestFile = process.env["REALGOAL_WORKER_REQUEST_FILE"] ?? ""
  const resultFile = process.env["REALGOAL_WORKER_RESULT_FILE"] ?? ""

  pi.on("session_shutdown", () => {
    void runtime.dispose()
  })

  pi.on("tool_call", (event, ctx) =>
    runtime
      .runPromiseExit(
        loadWorkerRequest(requestFile).pipe(
          Effect.flatMap((req) => {
            if (PARENT_ONLY_TOOLS.has(event.toolName)) {
              return Effect.succeed({
                block: true,
                reason: `Delegated ${req.role} worker cannot invoke parent controller tool "${event.toolName}" or recursively delegate.`,
              })
            }

            if (req.role !== "implementation" && MUTATING_BUILTIN_TOOLS.has(event.toolName)) {
              return Effect.succeed({
                block: true,
                reason: `Delegated ${req.role} reviewer is read-only and cannot invoke "${event.toolName}".`,
              })
            }

            if (
              req.role === "implementation" &&
              (event.toolName === "write" || event.toolName === "edit")
            ) {
              const rawInput = Predicate.isObject(event.input)
                ? (event.input as Record<string, unknown>)
                : {}
              const candidatePath =
                typeof rawInput["path"] === "string"
                  ? rawInput["path"]
                  : typeof rawInput["file_path"] === "string"
                    ? rawInput["file_path"]
                    : ""
              if (!candidatePath) {
                return Effect.succeed({
                  block: true,
                  reason: `Missing path argument on ${event.toolName}`,
                })
              }
              return checkWorkerWriteAllowed(ctx.cwd, req.allowedWritePaths, candidatePath).pipe(
                Effect.map((allowed) =>
                  allowed
                    ? undefined
                    : {
                        block: true,
                        reason: `Path "${candidatePath}" is outside allowed worker write scope (or targets protected Realgoal draft state).`,
                      },
                ),
              )
            }

            return Effect.succeed(undefined)
          }),
          Effect.catch((err) =>
            Effect.succeed({
              block: true,
              reason: err.reason,
            }),
          ),
        ),
        ctx.signal ? { signal: ctx.signal } : undefined,
      )
      .then((exit) =>
        Exit.isSuccess(exit)
          ? exit.value
          : Cause.hasInterruptsOnly(exit.cause)
            ? undefined
            : Promise.reject(Cause.squash(exit.cause)),
      ),
  )

  pi.registerTool({
    name: "realgoal_worker_result",
    label: "realgoal_worker_result",
    description:
      "Submit the structured final result for this delegated Realgoal worker job and terminate the worker run.",
    parameters: WorkerResultToolParams,
    execute: (_toolCallId, params, signal) =>
      runtime
        .runPromiseExit(
          loadWorkerRequest(requestFile).pipe(
            Effect.flatMap((req) => {
              const findings: ReadonlyArray<ReviewFinding> = (params.findings ?? []).map((f) => ({
                id: f.id,
                severity: f.severity,
                locationOrRequirement: f.locationOrRequirement,
                explanation: f.explanation,
                suggestedResolution: f.suggestedResolution,
                resolved: false,
              }))

              const payload: WorkerResultPayload = {
                schemaVersion: 1,
                jobId: req.jobId,
                workItemId: req.workItemId,
                role: req.role,
                todoId: req.todoId,
                inputArtifactHash: req.inputArtifactHash,
                inputManifestHash: req.inputManifestHash,
                status: params.status,
                verdict: Option.fromUndefinedOr(params.verdict),
                summary: params.summary,
                filesChanged: (params.filesChanged ?? []).map((p) => path.normalize(p)),
                deviations: params.deviations ?? [],
                findings,
                checksRun: (params.checksRun ?? []).map((c) => ({
                  commandOrCheck: c.commandOrCheck,
                  passed: c.passed,
                  exitCode:
                    c.exitCode !== undefined ? Option.some(Math.trunc(c.exitCode)) : Option.none(),
                  outputSummary: c.outputSummary,
                })),
                needsInputQuestion: Option.fromUndefinedOr(params.needsInputQuestion),
                timestamp: new Date().toISOString(),
              }

              return Schema.encodeEffect(WorkerResultJson)(payload).pipe(
                Effect.flatMap((encoded) =>
                  atomicWriteTextFile(resultFile, JSON.stringify(JSON.parse(encoded), null, 2) + "\n"),
                ),
                Effect.map((): AgentToolResult<Record<string, unknown>> => ({
                  content: [{ type: "text" as const, text: `Recorded worker result (${payload.status}).` }],
                  details: { ok: true, jobId: req.jobId, status: payload.status },
                  terminate: true,
                })),
              )
            }),
            Effect.catch((err) =>
              Effect.succeed<AgentToolResult<Record<string, unknown>>>({
                content: [{ type: "text" as const, text: `Failed recording worker result: ${String(err)}` }],
                details: { ok: false, error: String(err) },
                isError: true,
              }),
            ),
          ),
          signal ? { signal } : undefined,
        )
        .then((exit): AgentToolResult<Record<string, unknown>> =>
          Exit.isSuccess(exit)
            ? exit.value
            : Cause.hasInterruptsOnly(exit.cause)
              ? {
                  content: [{ type: "text" as const, text: "Operation aborted." }],
                  details: { ok: false, aborted: true },
                  isError: true,
                }
              : Promise.reject(Cause.squash(exit.cause)) as never,
        ),
  })
}
