import { spawn } from "node:child_process"
import type {
  AgentToolResult,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent"
import { Cause, Effect, Exit, ManagedRuntime, Option } from "effect"
import { ConfigService } from "../domain/config.ts"
import { toStructuredError, type RealgoalError } from "../domain/errors.ts"
import type { ThinkingLevelValue } from "../domain/models.ts"
import { ControllerService } from "../services/controller-service.ts"
import { DoctorService } from "../services/doctor-service.ts"
import { PersistenceService } from "../services/persistence.ts"
import { PreviewService } from "../services/preview-service.ts"
import { RealtasksAdapter, type ToolInvokeOutcome, type ToolInvoker } from "../services/realtasks-adapter.ts"
import { WorkerService, type ParentModelSnapshot } from "../services/worker-service.ts"
import { applyUiStatusAndWidgets } from "../ui/presentation.ts"

export type RealgoalServices =
  | ControllerService
  | ConfigService
  | PersistenceService
  | RealtasksAdapter
  | PreviewService
  | WorkerService
  | DoctorService

export interface ToolSuccessEnvelope {
  readonly summary: string
  readonly details: Record<string, unknown>
  readonly terminate?: boolean
}

export interface RealgoalRuntime {
  readonly managed: ManagedRuntime.ManagedRuntime<RealgoalServices, never>
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E, RealgoalServices>,
    signal?: AbortSignal,
  ) => Promise<A>
  readonly runToolEffect: (
    ctx: ExtensionToolContext,
    signal: AbortSignal | undefined,
    effect: Effect.Effect<ToolSuccessEnvelope, RealgoalError, RealgoalServices>,
  ) => Promise<AgentToolResult<Record<string, unknown>>>
  readonly runCommandEffect: (
    ctx: ExtensionCommandContext,
    effect: Effect.Effect<Option.Option<string>, RealgoalError, RealgoalServices>,
  ) => Promise<void>
  readonly runEventEffect: <A>(
    effect: Effect.Effect<A, RealgoalError, RealgoalServices>,
    fallback: A,
    signal?: AbortSignal,
  ) => Promise<A>
  readonly refreshUi: (ctx: ExtensionContext) => Promise<void>
  readonly dispose: () => Promise<void>
}

export const formatToolSuccess = (
  envelope: ToolSuccessEnvelope,
): AgentToolResult<Record<string, unknown>> => ({
  content: [{ type: "text", text: envelope.summary }],
  details: { ok: true, ...envelope.details },
  structuredContent: { ok: true, ...(envelope.details as Record<string, never>) },
  ...(envelope.terminate === true ? { terminate: true } : {}),
})

export const formatToolFailure = (
  error: RealgoalError,
): AgentToolResult<Record<string, unknown>> => {
  const structured = toStructuredError(error)
  return {
    content: [
      {
        type: "text",
        text: `[${structured.code}] ${structured.message}`,
      },
    ],
    details: {
      ok: false,
      error: structured,
    },
    structuredContent: {
      ok: false,
      code: structured.code,
      message: structured.message,
      details: structured.details as Record<string, never>,
    },
    isError: true,
  }
}

export const formatToolAborted = (): AgentToolResult<Record<string, unknown>> => ({
  content: [{ type: "text", text: "Operation aborted." }],
  details: { ok: false, aborted: true },
  structuredContent: { ok: false, aborted: true },
  isError: true,
})

export const makeToolInvoker = (ctx: ExtensionToolContext): ToolInvoker =>
  (name: string, args: Record<string, unknown>, signal?: AbortSignal): Effect.Effect<ToolInvokeOutcome, never> =>
    Effect.tryPromise({
      try: () => ctx.executeTool(name, args, signal ? { signal } : undefined),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(
      Effect.map((outcome): ToolInvokeOutcome => {
        const rawContent = outcome.result?.content
        const textParts = Array.isArray(rawContent)
          ? rawContent
              .filter(
                (b: unknown): b is { type: "text"; text: string } =>
                  typeof b === "object" &&
                  b !== null &&
                  (b as Record<string, unknown>)["type"] === "text" &&
                  typeof (b as Record<string, unknown>)["text"] === "string",
              )
              .map((b) => b.text)
          : []
        return {
          contentText: textParts.join("\n"),
          details: outcome.result?.details,
          isError: Boolean(outcome.isError || outcome.result?.isError),
        }
      }),
      Effect.catch((errMsg) =>
        Effect.succeed<ToolInvokeOutcome>({
          contentText: errMsg,
          details: undefined,
          isError: true,
        }),
      ),
    )

const VALID_THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

const normalizeThinkingLevel = (raw: string | undefined): ThinkingLevelValue =>
  raw !== undefined && VALID_THINKING_LEVELS.has(raw) ? (raw as ThinkingLevelValue) : "medium"

export const extractParentModelSnapshot = (
  ctx: ExtensionContext,
  fallbackThinking?: string,
): ParentModelSnapshot => {
  const currentModel = ctx.model
  const provider = typeof currentModel?.provider === "string" ? currentModel.provider : "anthropic"
  const modelId = typeof currentModel?.id === "string" ? currentModel.id : "claude-sonnet-4-5"
  const thinkingLevel = normalizeThinkingLevel(ctx.thinkingLevel ?? fallbackThinking)

  const registry = ctx.modelRegistry as
    | {
        getAll?: () => ReadonlyArray<{
          provider: string
          id: string
          reasoning?: boolean
        }>
        hasConfiguredAuth?: (m: unknown) => boolean
        getRegisteredProviderIds?: () => ReadonlyArray<string>
      }
    | undefined

  const ephemeralProviders = new Set<string>(
    typeof registry?.getRegisteredProviderIds === "function" ? registry.getRegisteredProviderIds() : [],
  )

  const rawAll = typeof registry?.getAll === "function" ? registry.getAll() : []
  const mappedModels = rawAll.map((m) => ({
    provider: m.provider,
    id: m.id,
    reasoning: Boolean(m.reasoning),
    hasChildCredentials:
      typeof registry?.hasConfiguredAuth === "function" ? Boolean(registry.hasConfiguredAuth(m)) : true,
    isEphemeralParentOnly: ephemeralProviders.has(m.provider),
  }))

  const hasParentInList = mappedModels.some((m) => m.provider === provider && m.id === modelId)
  const availableModels = hasParentInList
    ? mappedModels
    : [
        {
          provider,
          id: modelId,
          reasoning: Boolean(currentModel?.reasoning ?? true),
          hasChildCredentials:
            currentModel && typeof registry?.hasConfiguredAuth === "function"
              ? Boolean(registry.hasConfiguredAuth(currentModel))
              : true,
          isEphemeralParentOnly: ephemeralProviders.has(provider),
        },
        ...mappedModels,
      ]

  return {
    provider,
    modelId,
    thinkingLevel,
    availableModels,
  }
}

export const openUrlInSystemBrowser = (
  url: string,
  customLauncher?: (targetUrl: string) => Promise<boolean>,
): Effect.Effect<boolean, never> => {
  if (customLauncher) {
    return Effect.tryPromise({
      try: () => customLauncher(url),
      catch: () => false,
    }).pipe(Effect.orElseSucceed(() => false))
  }

  return Effect.sync(() => {
    try {
      if (process.platform === "win32") {
        const child = spawn("cmd.exe", ["/c", "start", "", url], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        })
        child.unref()
        return true
      }
      const cmd = process.platform === "darwin" ? "open" : "xdg-open"
      const child = spawn(cmd, [url], {
        detached: true,
        stdio: "ignore",
      })
      child.unref()
      return true
    } catch {
      return false
    }
  })
}

export const makeRealgoalRuntime = (): RealgoalRuntime => {
  const managed = ManagedRuntime.make(ControllerService.layer)

  const runPromise = <A, E>(
    effect: Effect.Effect<A, E, RealgoalServices>,
    signal?: AbortSignal,
  ): Promise<A> => (signal ? managed.runPromise(effect, { signal }) : managed.runPromise(effect))

  const refreshUiEffect = (ctx: ExtensionContext): Effect.Effect<void, never, RealgoalServices> =>
    ControllerService.use((controller) =>
      Effect.all({
        mem: controller.getMemory(),
        activeOpt: controller.getActiveWorkItem().pipe(Effect.orElseSucceed(() => Option.none())),
      }).pipe(
        Effect.tap(({ mem, activeOpt }) =>
          Effect.sync(() => {
            applyUiStatusAndWidgets(
              ctx,
              Option.map(activeOpt, (loaded) => loaded.state),
              mem.uiPromptWaiting,
            )
          }),
        ),
        Effect.asVoid,
      ),
    )

  const runExit = <A, E>(
    effect: Effect.Effect<A, E, RealgoalServices>,
    signal?: AbortSignal,
  ): Promise<Exit.Exit<A, E>> =>
    signal ? managed.runPromiseExit(effect, { signal }) : managed.runPromiseExit(effect)

  const resolveInterruptibleExit = <A>(exit: Exit.Exit<A, never>, onInterrupt: () => A): Promise<A> =>
    Exit.isSuccess(exit)
      ? Promise.resolve(exit.value)
      : Cause.hasInterruptsOnly(exit.cause)
        ? Promise.resolve(onInterrupt())
        : Promise.reject(Cause.squash(exit.cause))

  const refreshUi = (ctx: ExtensionContext): Promise<void> =>
    runExit(refreshUiEffect(ctx)).then((exit) => resolveInterruptibleExit(exit, () => undefined))

  const runToolEffect = (
    ctx: ExtensionToolContext,
    signal: AbortSignal | undefined,
    effect: Effect.Effect<ToolSuccessEnvelope, RealgoalError, RealgoalServices>,
  ): Promise<AgentToolResult<Record<string, unknown>>> =>
    runExit(
      effect.pipe(
        Effect.tap(() => refreshUiEffect(ctx)),
        Effect.match({
          onFailure: (err) => formatToolFailure(err),
          onSuccess: (env) => formatToolSuccess(env),
        }),
      ),
      signal,
    ).then((exit) => resolveInterruptibleExit(exit, () => formatToolAborted()))

  const runCommandEffect = (
    ctx: ExtensionCommandContext,
    effect: Effect.Effect<Option.Option<string>, RealgoalError, RealgoalServices>,
  ): Promise<void> =>
    runExit(
      effect.pipe(
        Effect.tap(() => refreshUiEffect(ctx)),
        Effect.matchEffect({
          onFailure: (err) =>
            Effect.sync(() => {
              const structured = toStructuredError(err)
              if (ctx.hasUI) {
                ctx.ui.notify(`[${structured.code}] ${structured.message}`, "error")
              }
            }),
          onSuccess: (msgOpt) =>
            Effect.sync(() => {
              if (ctx.hasUI && Option.isSome(msgOpt)) {
                ctx.ui.notify(msgOpt.value, "info")
              }
            }),
        }),
      ),
      ctx.signal && !ctx.signal.aborted ? ctx.signal : undefined,
    ).then((exit) => resolveInterruptibleExit(exit, () => undefined))

  const runEventEffect = <A>(
    effect: Effect.Effect<A, RealgoalError, RealgoalServices>,
    fallback: A,
    signal?: AbortSignal,
  ): Promise<A> =>
    runExit(
      effect.pipe(Effect.orElseSucceed(() => fallback)),
      signal,
    ).then((exit) => resolveInterruptibleExit(exit, () => fallback))
  return {
    managed,
    runPromise,
    runToolEffect,
    runCommandEffect,
    runEventEffect,
    refreshUi,
    dispose: () => managed.dispose(),
  }
}
