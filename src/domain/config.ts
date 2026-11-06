import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import { ConfigurationError } from "./errors.ts"
import {
  ExecutionDriverSchema,
  ModelProfileSpecSchema,
  ThinkingLevelSchema,
  VerificationDriverSchema,
  type ExecutionDriver,
  type ModelProfileSpec,
  type VerificationDriver,
  type WorkItemConfigOverrides,
} from "./models.ts"

export type ConfigSource = "default" | "global" | "project" | "work_item"

const RawTierConfigSchema = Schema.Struct({
  model: Schema.OptionFromOptionalKey(Schema.String),
  thinking: Schema.OptionFromOptionalKey(Schema.Union([Schema.Literal("inherit"), ThinkingLevelSchema])),
})

export const PartialRealgoalConfigSchema = Schema.Struct({
  continuation: Schema.OptionFromOptionalKey(
    Schema.Struct({
      enabled: Schema.OptionFromOptionalKey(Schema.Boolean),
      maxNoProgressContinuations: Schema.OptionFromOptionalKey(Schema.Int),
      maxRepeatedFailureAttempts: Schema.OptionFromOptionalKey(Schema.Int),
      maxTotalTurns: Schema.OptionFromOptionalKey(Schema.NullOr(Schema.Int)),
    }),
  ),
  verification: Schema.OptionFromOptionalKey(
    Schema.Struct({
      draftGate: Schema.OptionFromOptionalKey(
        Schema.Struct({
          enabled: Schema.OptionFromOptionalKey(Schema.Boolean),
        }),
      ),
      executionDriver: Schema.OptionFromOptionalKey(VerificationDriverSchema),
    }),
  ),
  execution: Schema.OptionFromOptionalKey(
    Schema.Struct({
      driver: Schema.OptionFromOptionalKey(Schema.Union([Schema.Literal("ask"), ExecutionDriverSchema])),
      maxConcurrentWriters: Schema.OptionFromOptionalKey(Schema.Int),
    }),
  ),
  models: Schema.OptionFromOptionalKey(
    Schema.Struct({
      light: Schema.OptionFromOptionalKey(RawTierConfigSchema),
      medium: Schema.OptionFromOptionalKey(RawTierConfigSchema),
      heavy: Schema.OptionFromOptionalKey(RawTierConfigSchema),
    }),
  ),
  browser: Schema.OptionFromOptionalKey(
    Schema.Struct({
      enabled: Schema.OptionFromOptionalKey(Schema.Boolean),
      open: Schema.OptionFromOptionalKey(Schema.Literals(["ask", "always", "never"])),
      host: Schema.OptionFromOptionalKey(Schema.String),
      externalAssets: Schema.OptionFromOptionalKey(Schema.Boolean),
    }),
  ),
  recovery: Schema.OptionFromOptionalKey(
    Schema.Struct({
      autoResumeAfterRestart: Schema.OptionFromOptionalKey(Schema.Boolean),
    }),
  ),
  publication: Schema.OptionFromOptionalKey(
    Schema.Struct({
      specDirectory: Schema.OptionFromOptionalKey(Schema.String),
      planDirectory: Schema.OptionFromOptionalKey(Schema.String),
    }),
  ),
  tasks: Schema.OptionFromOptionalKey(
    Schema.Struct({
      keepAlive: Schema.OptionFromOptionalKey(Schema.Boolean),
    }),
  ),
})

export type PartialRealgoalConfig = typeof PartialRealgoalConfigSchema.Type

export interface ResolvedRealgoalConfig {
  readonly continuation: {
    readonly enabled: boolean
    readonly maxNoProgressContinuations: number
    readonly maxRepeatedFailureAttempts: number
    readonly maxTotalTurns: Option.Option<number>
  }
  readonly verification: {
    readonly draftGate: {
      readonly enabled: boolean
    }
    readonly executionDriver: VerificationDriver
  }
  readonly execution: {
    readonly driver: Option.Option<ExecutionDriver>
    readonly maxConcurrentWriters: 1
  }
  readonly models: {
    readonly light: ModelProfileSpec
    readonly medium: ModelProfileSpec
    readonly heavy: ModelProfileSpec
  }
  readonly browser: {
    readonly enabled: boolean
    readonly open: "ask" | "always" | "never"
    readonly host: string
    readonly externalAssets: boolean
  }
  readonly recovery: {
    readonly autoResumeAfterRestart: boolean
  }
  readonly publication: {
    readonly specDirectory: string
    readonly planDirectory: string
  }
  readonly tasks: {
    readonly keepAlive: boolean
  }
}

export interface EffectiveConfigResult {
  readonly config: ResolvedRealgoalConfig
  readonly sources: Record<string, ConfigSource>
  readonly warnings: ReadonlyArray<string>
}

export const DEFAULT_MODEL_PROFILE: ModelProfileSpec = {
  model: "inherit",
  thinking: "inherit",
}

export const makeDefaultConfig = (configDirName = ".pi"): ResolvedRealgoalConfig => ({
  continuation: {
    enabled: true,
    maxNoProgressContinuations: 3,
    maxRepeatedFailureAttempts: 3,
    maxTotalTurns: Option.none(),
  },
  verification: {
    draftGate: {
      enabled: false,
    },
    executionDriver: "direct",
  },
  execution: {
    driver: Option.none(),
    maxConcurrentWriters: 1,
  },
  models: {
    light: DEFAULT_MODEL_PROFILE,
    medium: DEFAULT_MODEL_PROFILE,
    heavy: DEFAULT_MODEL_PROFILE,
  },
  browser: {
    enabled: true,
    open: "ask",
    host: "127.0.0.1",
    externalAssets: false,
  },
  recovery: {
    autoResumeAfterRestart: false,
  },
  publication: {
    specDirectory: "./doc",
    planDirectory: `./${configDirName}/realgoal/plan`,
  },
  tasks: {
    keepAlive: false,
  },
})

const FORBIDDEN_SECRET_KEY_PATTERN = /(api[_-]?key|secret|password|bearer|access[_-]?token|private[_-]?key)/i

const scanForForbiddenSecretKeys = (value: unknown, pathPrefix = ""): ReadonlyArray<string> => {
  if (!Predicate.isObject(value) || Array.isArray(value)) {
    return []
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const current = pathPrefix ? `${pathPrefix}.${key}` : key
    const hit = FORBIDDEN_SECRET_KEY_PATTERN.test(key) ? [current] : []
    return [...hit, ...scanForForbiddenSecretKeys(child, current)]
  })
}

const isLoopbackHost = (host: string): boolean =>
  host === "127.0.0.1" || host === "localhost" || host === "::1"

const decodeConfigLayer = (
  rawJson: string,
  sourceLabel: string,
): Effect.Effect<PartialRealgoalConfig, ConfigurationError> =>
  Effect.try({
    try: () => JSON.parse(rawJson) as unknown,
    catch: (cause) =>
      new ConfigurationError({
        source: sourceLabel,
        message: `Invalid JSON in ${sourceLabel}: ${String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((parsed) => {
      const secretKeys = scanForForbiddenSecretKeys(parsed)
      if (secretKeys.length > 0) {
        return Effect.fail(
          new ConfigurationError({
            source: sourceLabel,
            message: `Credentials/API keys are forbidden in Realgoal configuration (${secretKeys.join(", ")})`,
          }),
        )
      }
      return Schema.decodeUnknownEffect(PartialRealgoalConfigSchema)(parsed).pipe(
        Effect.mapError(
          (err) =>
            new ConfigurationError({
              source: sourceLabel,
              message: `Schema validation failed in ${sourceLabel}: ${err.message}`,
            }),
        ),
      )
    }),
    Effect.flatMap((decoded) => {
      const maxWritersOpt = Option.flatMap(decoded.execution, (e) => e.maxConcurrentWriters)
      if (Option.isSome(maxWritersOpt) && maxWritersOpt.value !== 1) {
        return Effect.fail(
          new ConfigurationError({
            source: sourceLabel,
            message: `execution.maxConcurrentWriters must be 1 in v1 (got ${maxWritersOpt.value})`,
          }),
        )
      }
      const hostOpt = Option.flatMap(decoded.browser, (b) => b.host)
      if (Option.isSome(hostOpt) && !isLoopbackHost(hostOpt.value)) {
        return Effect.fail(
          new ConfigurationError({
            source: sourceLabel,
            message: `browser.host must be loopback only (127.0.0.1, localhost, or ::1); got "${hostOpt.value}"`,
          }),
        )
      }
      const noProgOpt = Option.flatMap(decoded.continuation, (c) => c.maxNoProgressContinuations)
      if (Option.isSome(noProgOpt) && noProgOpt.value < 1) {
        return Effect.fail(
          new ConfigurationError({
            source: sourceLabel,
            message: `continuation.maxNoProgressContinuations must be >= 1`,
          }),
        )
      }
      const failOpt = Option.flatMap(decoded.continuation, (c) => c.maxRepeatedFailureAttempts)
      if (Option.isSome(failOpt) && failOpt.value < 1) {
        return Effect.fail(
          new ConfigurationError({
            source: sourceLabel,
            message: `continuation.maxRepeatedFailureAttempts must be >= 1`,
          }),
        )
      }
      return Effect.succeed(decoded)
    }),
  )

const readOptionalFile = (filePath: string): Effect.Effect<Option.Option<string>, ConfigurationError> =>
  Effect.tryPromise({
    try: () => fs.readFile(filePath, "utf8"),
    catch: (err) => err as NodeJS.ErrnoException,
  }).pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      (err) => err.code === "ENOENT",
      () => Effect.succeed(Option.none()),
    ),
    Effect.mapError(
      (err) =>
        new ConfigurationError({
          source: filePath,
          message: `Failed reading config file ${filePath}: ${err.message}`,
        }),
    ),
  )

const mergePartialInto = (
  base: ResolvedRealgoalConfig,
  sources: Record<string, ConfigSource>,
  partial: PartialRealgoalConfig,
  source: ConfigSource,
): { readonly config: ResolvedRealgoalConfig; readonly sources: Record<string, ConfigSource> } => {
  const nextSources: Record<string, ConfigSource> = { ...sources }

  const pick = <A>(opt: Option.Option<A>, fallback: A, key: string): A =>
    Option.match(opt, {
      onNone: () => fallback,
      onSome: (val) => {
        nextSources[key] = source
        return val
      },
    })

  const cont = partial.continuation
  const ver = partial.verification
  const exec = partial.execution
  const models = partial.models
  const browser = partial.browser
  const rec = partial.recovery
  const pub = partial.publication
  const tasks = partial.tasks

  const maxTotalTurns = Option.match(Option.flatMap(cont, (c) => c.maxTotalTurns), {
    onNone: () => base.continuation.maxTotalTurns,
    onSome: (val) => {
      nextSources["continuation.maxTotalTurns"] = source
      return val === null ? Option.none() : Option.some(val)
    },
  })

  const execDriver = Option.match(Option.flatMap(exec, (e) => e.driver), {
    onNone: () => base.execution.driver,
    onSome: (val) => {
      nextSources["execution.driver"] = source
      return val === "ask" ? Option.none() : Option.some(val)
    },
  })

  const mergeTier = (
    tierName: "light" | "medium" | "heavy",
    tierOpt: Option.Option<typeof RawTierConfigSchema.Type>,
    current: ModelProfileSpec,
  ): ModelProfileSpec => ({
    model: pick(Option.flatMap(tierOpt, (t) => t.model), current.model, `models.${tierName}.model`),
    thinking: pick(Option.flatMap(tierOpt, (t) => t.thinking), current.thinking, `models.${tierName}.thinking`),
  })

  return {
    sources: nextSources,
    config: {
      continuation: {
        enabled: pick(Option.flatMap(cont, (c) => c.enabled), base.continuation.enabled, "continuation.enabled"),
        maxNoProgressContinuations: pick(
          Option.flatMap(cont, (c) => c.maxNoProgressContinuations),
          base.continuation.maxNoProgressContinuations,
          "continuation.maxNoProgressContinuations",
        ),
        maxRepeatedFailureAttempts: pick(
          Option.flatMap(cont, (c) => c.maxRepeatedFailureAttempts),
          base.continuation.maxRepeatedFailureAttempts,
          "continuation.maxRepeatedFailureAttempts",
        ),
        maxTotalTurns,
      },
      verification: {
        draftGate: {
          enabled: pick(
            Option.flatMap(ver, (v) => Option.flatMap(v.draftGate, (d) => d.enabled)),
            base.verification.draftGate.enabled,
            "verification.draftGate.enabled",
          ),
        },
        executionDriver: pick(
          Option.flatMap(ver, (v) => v.executionDriver),
          base.verification.executionDriver,
          "verification.executionDriver",
        ),
      },
      execution: {
        driver: execDriver,
        maxConcurrentWriters: 1,
      },
      models: {
        light: mergeTier("light", Option.flatMap(models, (m) => m.light), base.models.light),
        medium: mergeTier("medium", Option.flatMap(models, (m) => m.medium), base.models.medium),
        heavy: mergeTier("heavy", Option.flatMap(models, (m) => m.heavy), base.models.heavy),
      },
      browser: {
        enabled: pick(Option.flatMap(browser, (b) => b.enabled), base.browser.enabled, "browser.enabled"),
        open: pick(Option.flatMap(browser, (b) => b.open), base.browser.open, "browser.open"),
        host: pick(Option.flatMap(browser, (b) => b.host), base.browser.host, "browser.host"),
        externalAssets: pick(
          Option.flatMap(browser, (b) => b.externalAssets),
          base.browser.externalAssets,
          "browser.externalAssets",
        ),
      },
      recovery: {
        autoResumeAfterRestart: pick(
          Option.flatMap(rec, (r) => r.autoResumeAfterRestart),
          base.recovery.autoResumeAfterRestart,
          "recovery.autoResumeAfterRestart",
        ),
      },
      publication: {
        specDirectory: pick(
          Option.flatMap(pub, (p) => p.specDirectory),
          base.publication.specDirectory,
          "publication.specDirectory",
        ),
        planDirectory: pick(
          Option.flatMap(pub, (p) => p.planDirectory),
          base.publication.planDirectory,
          "publication.planDirectory",
        ),
      },
      tasks: {
        keepAlive: pick(Option.flatMap(tasks, (t) => t.keepAlive), base.tasks.keepAlive, "tasks.keepAlive"),
      },
    },
  }
}

export const applyWorkItemOverrides = (
  effective: EffectiveConfigResult,
  overrides: WorkItemConfigOverrides,
): EffectiveConfigResult => {
  const nextSources: Record<string, ConfigSource> = { ...effective.sources }
  const base = effective.config

  const pick = <A>(opt: Option.Option<A>, fallback: A, key: string): A =>
    Option.match(opt, {
      onNone: () => fallback,
      onSome: (v) => {
        nextSources[key] = "work_item"
        return v
      },
    })

  const maxTotalTurns = Option.match(overrides.maxTotalTurns, {
    onNone: () => base.continuation.maxTotalTurns,
    onSome: (v) => {
      nextSources["continuation.maxTotalTurns"] = "work_item"
      return v === null ? Option.none() : Option.some(v)
    },
  })

  const execDriver = Option.match(overrides.executionDriver, {
    onNone: () => base.execution.driver,
    onSome: (v) => {
      nextSources["execution.driver"] = "work_item"
      return Option.some(v)
    },
  })

  const browserOpen = Option.match(overrides.browserOpenAuthorized, {
    onNone: () => base.browser.open,
    onSome: (v) => {
      nextSources["browser.open"] = "work_item"
      return v ? "always" : "never"
    },
  })

  return {
    warnings: effective.warnings,
    sources: nextSources,
    config: {
      ...base,
      continuation: {
        ...base.continuation,
        maxNoProgressContinuations: pick(
          overrides.maxNoProgressContinuations,
          base.continuation.maxNoProgressContinuations,
          "continuation.maxNoProgressContinuations",
        ),
        maxRepeatedFailureAttempts: pick(
          overrides.maxRepeatedFailureAttempts,
          base.continuation.maxRepeatedFailureAttempts,
          "continuation.maxRepeatedFailureAttempts",
        ),
        maxTotalTurns,
      },
      verification: {
        draftGate: {
          enabled: pick(
            overrides.draftGateEnabled,
            base.verification.draftGate.enabled,
            "verification.draftGate.enabled",
          ),
        },
        executionDriver: pick(
          overrides.verificationDriver,
          base.verification.executionDriver,
          "verification.executionDriver",
        ),
      },
      execution: {
        ...base.execution,
        driver: execDriver,
      },
      browser: {
        ...base.browser,
        enabled: pick(overrides.browserEnabled, base.browser.enabled, "browser.enabled"),
        open: browserOpen,
      },
    },
  }
}

const defaultSourcesMap = (): Record<string, ConfigSource> => ({
  "continuation.enabled": "default",
  "continuation.maxNoProgressContinuations": "default",
  "continuation.maxRepeatedFailureAttempts": "default",
  "continuation.maxTotalTurns": "default",
  "verification.draftGate.enabled": "default",
  "verification.executionDriver": "default",
  "execution.driver": "default",
  "execution.maxConcurrentWriters": "default",
  "models.light.model": "default",
  "models.light.thinking": "default",
  "models.medium.model": "default",
  "models.medium.thinking": "default",
  "models.heavy.model": "default",
  "models.heavy.thinking": "default",
  "browser.enabled": "default",
  "browser.open": "default",
  "browser.host": "default",
  "browser.externalAssets": "default",
  "recovery.autoResumeAfterRestart": "default",
  "publication.specDirectory": "default",
  "publication.planDirectory": "default",
  "tasks.keepAlive": "default",
})

export interface ConfigLoadOptions {
  readonly globalAgentDir: string
  readonly workspaceCwd: string
  readonly isProjectTrusted: boolean
  readonly configDirName?: string
  readonly overrides?: Option.Option<WorkItemConfigOverrides>
}

export class ConfigService extends Context.Service<
  ConfigService,
  {
    readonly loadEffective: (opts: ConfigLoadOptions) => Effect.Effect<EffectiveConfigResult, ConfigurationError>
    readonly decodeAndValidateLayer: (
      rawJson: string,
      sourceLabel: string,
    ) => Effect.Effect<PartialRealgoalConfig, ConfigurationError>
  }
>()("realgoal/domain/ConfigService") {
  static readonly layer = Layer.succeed(
    ConfigService,
    ConfigService.of({
      decodeAndValidateLayer: decodeConfigLayer,
      loadEffective: (opts) => {
        const configDirName = opts.configDirName ?? ".pi"
        const globalPath = path.join(opts.globalAgentDir, "realgoal.json")
        const projectPath = path.join(opts.workspaceCwd, configDirName, "realgoal", "config.json")

        return Effect.Do.pipe(
          Effect.bind("globalRaw", () => readOptionalFile(globalPath)),
          Effect.bind("globalDecoded", ({ globalRaw }) =>
            Option.match(globalRaw, {
              onNone: () => Effect.succeed(Option.none<PartialRealgoalConfig>()),
              onSome: (json) => decodeConfigLayer(json, globalPath).pipe(Effect.map(Option.some)),
            }),
          ),
          Effect.bind("projectCheck", () =>
            opts.isProjectTrusted
              ? readOptionalFile(projectPath).pipe(
                  Effect.flatMap((rawOpt) =>
                    Option.match(rawOpt, {
                      onNone: () =>
                        Effect.succeed({
                          decoded: Option.none<PartialRealgoalConfig>(),
                          warnings: [] as ReadonlyArray<string>,
                        }),
                      onSome: (json) =>
                        decodeConfigLayer(json, projectPath).pipe(
                          Effect.map((d) => ({
                            decoded: Option.some(d),
                            warnings: [] as ReadonlyArray<string>,
                          })),
                        ),
                    }),
                  ),
                )
              : readOptionalFile(projectPath).pipe(
                  Effect.map((rawOpt) => ({
                    decoded: Option.none<PartialRealgoalConfig>(),
                    warnings: Option.isSome(rawOpt)
                      ? [`Ignored untrusted project config at ${projectPath} (project is not trusted)`]
                      : ([] as ReadonlyArray<string>),
                  })),
                ),
          ),
          Effect.map(({ globalDecoded, projectCheck }) => {
            const initial = {
              config: makeDefaultConfig(configDirName),
              sources: defaultSourcesMap(),
            }
            const afterGlobal = Option.match(globalDecoded, {
              onNone: () => initial,
              onSome: (g) => mergePartialInto(initial.config, initial.sources, g, "global"),
            })
            const afterProject = Option.match(projectCheck.decoded, {
              onNone: () => afterGlobal,
              onSome: (p) => mergePartialInto(afterGlobal.config, afterGlobal.sources, p, "project"),
            })
            const baseResult: EffectiveConfigResult = {
              config: afterProject.config,
              sources: afterProject.sources,
              warnings: projectCheck.warnings,
            }
            return Option.match(opts.overrides ?? Option.none(), {
              onNone: () => baseResult,
              onSome: (ov) => applyWorkItemOverrides(baseResult, ov),
            })
          }),
        )
      },
    }),
  )
}

export { ModelProfileSpecSchema }
