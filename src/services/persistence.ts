import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Context, Effect, Layer, Option, Schedule, Schema, Semaphore } from "effect"
import {
  AuthorizationRequiredError,
  InvalidTransitionError,
  OwnershipConflictError,
  PathSafetyError,
  PersistenceError,
  type RealgoalError,
} from "../domain/errors.ts"
import {
  OwnerTokenJson,
  WorkItemStateJson,
  type DurableQuestion,
  type OwnerToken,
  type PublicationRecord,
  type TodoItem,
  type WorkItemState,
} from "../domain/models.ts"
import { hasValidDraftReviewApproval } from "../domain/reducer.ts"
import { allocateUniqueSafeDirName, resolveWithinRoot, sha256Hex } from "./path-safety.ts"

const windowsAtomicRenameSchedule = Schedule.max([
  Schedule.exponential("25 millis"),
  Schedule.recurs(4),
])

const isTransientRenameError = (err: NodeJS.ErrnoException): boolean =>
  err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES"

export const atomicWriteTextFile = (
  targetPath: string,
  content: string,
): Effect.Effect<void, PersistenceError> => {
  const dir = path.dirname(targetPath)
  const tempPath = path.join(dir, `.${path.basename(targetPath)}.tmp.${crypto.randomUUID()}`)

  return Effect.tryPromise({
    try: () => fs.mkdir(dir, { recursive: true }),
    catch: (err) =>
      new PersistenceError({
        operation: "mkdir",
        path: dir,
        message: `Failed creating directory ${dir}: ${(err as Error).message}`,
        corrupted: false,
      }),
  }).pipe(
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: () => fs.writeFile(tempPath, content, "utf8"),
        catch: (err) =>
          new PersistenceError({
            operation: "writeTemp",
            path: tempPath,
            message: `Failed writing temp file ${tempPath}: ${(err as Error).message}`,
            corrupted: false,
          }),
      }),
    ),
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: () => fs.rename(tempPath, targetPath),
        catch: (err) => err as NodeJS.ErrnoException,
      }).pipe(
        Effect.retry({
          schedule: windowsAtomicRenameSchedule,
          while: isTransientRenameError,
        }),
        Effect.mapError(
          (err) =>
            new PersistenceError({
              operation: "atomicRename",
              path: targetPath,
              message: `Failed atomically replacing ${targetPath}: ${err.message}`,
              corrupted: false,
            }),
        ),
      ),
    ),
    Effect.tapError(() =>
      Effect.tryPromise({
        try: () => fs.unlink(tempPath),
        catch: () => undefined,
      }).pipe(Effect.ignore),
    ),
  )
}

export const renderTodoProjection = (state: WorkItemState): string => {
  const bodyLines =
    state.todos.length === 0
      ? ["_No TODO items recorded yet._"]
      : [...state.todos]
          .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id.localeCompare(b.id)))
          .map((t: TodoItem) => {
            const box = t.status === "done" ? "[x]" : t.status === "skipped" ? "[-]" : "[ ]"
            const deps = t.dependencyIds.length > 0 ? ` (deps: ${t.dependencyIds.join(", ")})` : ""
            const ev = t.evidenceIds.length > 0 ? ` [evidence: ${t.evidenceIds.join(", ")}]` : ""
            return `- ${box} **${t.id}** (${t.status} · ${t.difficulty} · stage:${t.stage})${deps}: ${t.title} — ${t.description}${ev}`
          })

  const body = [
    `# TODO — ${state.displayName}`,
    "",
    `> Managed projection of \`state.json\` (workItemId: \`${state.id}\`, revision: \`${state.revision}\`).`,
    `> Do not edit checkboxes directly to mark completion; use \`realgoal_todo\`.`,
    "",
    ...bodyLines,
    "",
  ].join("\n")

  const bodyHash = sha256Hex(body)
  return `<!-- realgoal-managed-view:todo workItemId=${state.id} revision=${state.revision} sha256=${bodyHash} -->\n${body}`
}

export const renderQuestionsProjection = (state: WorkItemState): string => {
  const sections =
    state.questions.length === 0
      ? ["_No durable questions recorded._"]
      : state.questions.map((q: DurableQuestion) => {
          const opts = q.options.map((o) => `  - \`${o.id}\`: **${o.label}** — ${o.description}`)
          const ansLine = Option.match(q.answer, {
            onNone: () => `  - Answer: _pending_`,
            onSome: (ans) =>
              `  - Answer (${ans.source} at ${ans.answeredAt}): options=[${ans.selectedOptionIds.join(", ")}]${
                Option.isSome(ans.customText) ? ` custom="${ans.customText.value}"` : ""
              }${Option.isSome(ans.comments) ? ` comments="${ans.comments.value}"` : ""}`,
          })
          return [
            `## ${q.id} (${q.status}${q.blocking ? ", blocking" : ""}) — ${q.title}`,
            `- Purpose: ${q.purpose}`,
            `- Prompt: ${q.prompt}`,
            ...opts,
            ansLine,
          ].join("\n")
        })

  const body = [
    `# Questions — ${state.displayName}`,
    "",
    `> Managed projection of \`state.json\` (workItemId: \`${state.id}\`, revision: \`${state.revision}\`).`,
    "",
    ...sections,
    "",
  ].join("\n\n")

  const bodyHash = sha256Hex(body)
  return `<!-- realgoal-managed-view:questions workItemId=${state.id} revision=${state.revision} sha256=${bodyHash} -->\n${body}`
}

export const checkProjectionMatches = (rawContent: string): boolean => {
  const newlineIdx = rawContent.indexOf("\n")
  if (newlineIdx < 0) return false
  const header = rawContent.slice(0, newlineIdx)
  const body = rawContent.slice(newlineIdx + 1)
  const m = /sha256=([a-f0-9]{64})/.exec(header)
  if (!m?.[1]) return false
  return sha256Hex(body) === m[1]
}

export const renderRequestMarkdown = (state: WorkItemState): string =>
  [
    `# Request — ${state.displayName}`,
    "",
    `- **Work Item ID:** \`${state.id}\``,
    `- **Workflow Kind:** \`${state.kind}\``,
    `- **Completion Scope:** \`${state.completionScope}\``,
    `- **Created At:** ${state.createdAt}`,
    "",
    `## Objective`,
    state.objective,
    "",
    ...(state.constraints.length > 0
      ? [`## Constraints`, ...state.constraints.map((c) => `- ${c}`), ""]
      : []),
    ...(state.nonGoals.length > 0
      ? [`## Non-goals`, ...state.nonGoals.map((n) => `- ${n}`), ""]
      : []),
    `## Acceptance Criteria`,
    ...state.acceptanceCriteria.map((c) => `- **${c.id}** (${c.required ? "required" : "deferred"}): ${c.description}`),
    "",
  ].join("\n")

export const validateImplementationPlanContent = (
  markdown: string,
): Effect.Effect<void, InvalidTransitionError> => {
  const missing: string[] = []
  const lower = markdown.toLowerCase()
  if (!lower.includes("objective") && !lower.includes("goal")) {
    missing.push("Plan must state the Objective/Goal and constraints")
  }
  if (!lower.includes("stage") && !lower.includes("## ")) {
    missing.push("Plan must have a stage-by-stage structure")
  }
  if (!lower.includes("in scope") && !lower.includes("scope")) {
    missing.push("Plan stages must define in-scope / out-of-scope boundaries")
  }
  if (!lower.includes("pass condition") && !lower.includes("acceptance") && !lower.includes("check")) {
    missing.push("Plan stages must specify verification checks and review pass conditions")
  }
  if (/\btbd\b/i.test(markdown)) {
    missing.push("Blocking requirements in plan must not be hidden under 'TBD'")
  }
  if (missing.length > 0) {
    return Effect.fail(
      new InvalidTransitionError({
        workItemId: "plan-validation",
        fromPhase: "publication_choice",
        toPhase: "publication",
        fromStatus: "running",
        toStatus: "running",
        reason: `Implementation plan failed validation: ${missing.join("; ")}`,
        missingConditions: missing,
      }),
    )
  }
  return Effect.void
}

export interface DraftPaths {
  readonly realgoalRoot: string
  readonly draftsRoot: string
  readonly draftDir: string
  readonly statePath: string
  readonly lockPath: string
  readonly requestPath: string
  readonly todoPath: string
  readonly researchPath: string
  readonly decisionsPath: string
  readonly questionsPath: string
  readonly finalizedPath: string
  readonly historyDir: string
  readonly previewsDir: string
  readonly reviewsDir: string
  readonly workersDir: string
}

export const resolveDraftPaths = (
  workspaceCwd: string,
  configDirName: string,
  safeDirName: string,
): DraftPaths => {
  const realgoalRoot = path.resolve(workspaceCwd, configDirName, "realgoal")
  const draftsRoot = path.join(realgoalRoot, "draft")
  const draftDir = path.join(draftsRoot, safeDirName)
  return {
    realgoalRoot,
    draftsRoot,
    draftDir,
    statePath: path.join(draftDir, "state.json"),
    lockPath: path.join(draftDir, "state.lock.json"),
    requestPath: path.join(draftDir, "request.md"),
    todoPath: path.join(draftDir, "todo.md"),
    researchPath: path.join(draftDir, "research.md"),
    decisionsPath: path.join(draftDir, "decisions.md"),
    questionsPath: path.join(draftDir, "questions.md"),
    finalizedPath: path.join(draftDir, "finalized.md"),
    historyDir: path.join(draftDir, "history"),
    previewsDir: path.join(draftDir, "previews"),
    reviewsDir: path.join(draftDir, "reviews"),
    workersDir: path.join(draftDir, "workers"),
  }
}

export interface LoadedWorkItemResult {
  readonly state: WorkItemState
  readonly paths: DraftPaths
  readonly recoveredFromHistory: boolean
  readonly projectionDivergences: ReadonlyArray<string>
  readonly partialPublications: ReadonlyArray<PublicationRecord>
}

const decodeWorkItemJson = (
  raw: string,
  filePath: string,
): Effect.Effect<WorkItemState, PersistenceError> =>
  Schema.decodeUnknownEffect(WorkItemStateJson)(raw).pipe(
    Effect.mapError(
      (err) =>
        new PersistenceError({
          operation: "decodeState",
          path: filePath,
          message: `Invalid or unsupported state schema at ${filePath}: ${err.message}`,
          corrupted: true,
        }),
    ),
  )

const encodeWorkItemJson = (
  state: WorkItemState,
  filePath: string,
): Effect.Effect<string, PersistenceError> =>
  Schema.encodeEffect(WorkItemStateJson)(state).pipe(
    Effect.map((compact) => JSON.stringify(JSON.parse(compact), null, 2) + "\n"),
    Effect.mapError(
      (err) =>
        new PersistenceError({
          operation: "encodeState",
          path: filePath,
          message: `Failed encoding state for ${filePath}: ${err.message}`,
          corrupted: false,
        }),
    ),
  )

const recoverFromHistoryDir = (
  paths: DraftPaths,
): Effect.Effect<WorkItemState, PersistenceError> =>
  Effect.tryPromise({
    try: () => fs.readdir(paths.historyDir),
    catch: (err) =>
      new PersistenceError({
        operation: "readHistory",
        path: paths.historyDir,
        message: `Cannot recover corrupted state; history directory unreadable: ${(err as Error).message}`,
        corrupted: true,
      }),
  }).pipe(
    Effect.flatMap((files) => {
      const revFiles = files
        .map((f) => {
          const m = /^(\d+)\.json$/.exec(f)
          return m ? { file: f, rev: Number.parseInt(m[1] ?? "0", 10) } : undefined
        })
        .filter((x): x is { file: string; rev: number } => x !== undefined)
        .sort((a, b) => b.rev - a.rev)

      const tryNext = (idx: number): Effect.Effect<WorkItemState, PersistenceError> => {
        const entry = revFiles[idx]
        if (!entry) {
          return Effect.fail(
            new PersistenceError({
              operation: "recoverHistory",
              path: paths.statePath,
              message: `State at ${paths.statePath} is corrupted and no valid history snapshot was found`,
              corrupted: true,
            }),
          )
        }
        const histPath = path.join(paths.historyDir, entry.file)
        return Effect.tryPromise({
          try: () => fs.readFile(histPath, "utf8"),
          catch: () => "",
        }).pipe(
          Effect.flatMap((raw) => decodeWorkItemJson(raw, histPath)),
          Effect.catch(() => tryNext(idx + 1)),
        )
      }

      return tryNext(0)
    }),
  )

const checkManagedFileDivergence = (
  filePath: string,
  label: string,
): Effect.Effect<Option.Option<string>, never> =>
  Effect.tryPromise({
    try: () => fs.readFile(filePath, "utf8"),
    catch: () => null,
  }).pipe(
    Effect.map((raw) => {
      if (raw === null) return Option.none()
      return checkProjectionMatches(raw)
        ? Option.none()
        : Option.some(`${label} (${filePath}) was modified outside realgoal_todo/realgoal_question`)
    }),
    Effect.orElseSucceed(() => Option.none()),
  )

export class PersistenceService extends Context.Service<
  PersistenceService,
  {
    readonly allocateDraftStem: (
      workspaceCwd: string,
      configDirName: string,
      displayName: string,
      workItemId: string,
    ) => Effect.Effect<string, PathSafetyError>
    readonly initializeWorkItem: (
      workspaceCwd: string,
      configDirName: string,
      state: WorkItemState,
      owner: OwnerToken,
    ) => Effect.Effect<DraftPaths, RealgoalError>
    readonly saveWorkItem: (
      workspaceCwd: string,
      configDirName: string,
      state: WorkItemState,
      callerOwner: OwnerToken,
    ) => Effect.Effect<DraftPaths, RealgoalError>
    readonly loadWorkItemBySafeDir: (
      workspaceCwd: string,
      configDirName: string,
      safeDirName: string,
    ) => Effect.Effect<LoadedWorkItemResult, RealgoalError>
    readonly loadWorkItemById: (
      workspaceCwd: string,
      configDirName: string,
      workItemId: string,
    ) => Effect.Effect<Option.Option<LoadedWorkItemResult>, RealgoalError>
    readonly listAllWorkItems: (
      workspaceCwd: string,
      configDirName: string,
    ) => Effect.Effect<
      ReadonlyArray<LoadedWorkItemResult | { readonly safeDirName: string; readonly error: PersistenceError }>,
      never
    >
    readonly acquireOrVerifyOwnership: (
      workspaceCwd: string,
      configDirName: string,
      state: WorkItemState,
      callerOwner: OwnerToken,
      forceTransferAuthorized: boolean,
    ) => Effect.Effect<WorkItemState, RealgoalError>
    readonly releaseOwnership: (
      workspaceCwd: string,
      configDirName: string,
      safeDirName: string,
      callerOwner: OwnerToken,
    ) => Effect.Effect<void, never>
    readonly publishMarkdownArtifact: (params: {
      readonly workspaceCwd: string
      readonly configDirName: string
      readonly state: WorkItemState
      readonly callerOwner: OwnerToken
      readonly target: "spec" | "plan"
      readonly destinationDir: string
      readonly customFileName?: string
      readonly content: string
      readonly authorizationId: string
      readonly allowOverwrite: boolean
      readonly draftGateEnabled: boolean
      readonly nowIso: string
    }) => Effect.Effect<{ readonly state: WorkItemState; readonly writtenPath: string }, RealgoalError>
  }
>()("realgoal/services/PersistenceService") {
  static readonly layer = Layer.effect(
    PersistenceService,
    Effect.sync(() => {
      const semaphores = new Map<string, Semaphore.Semaphore>()

      const getSemaphore = (key: string): Semaphore.Semaphore => {
        const existing = semaphores.get(key)
        if (existing) return existing
        const created = Semaphore.makeUnsafe(1)
        semaphores.set(key, created)
        return created
      }

      const withItemLock = <A, E>(
        workItemKey: string,
        eff: Effect.Effect<A, E>,
      ): Effect.Effect<A, E> => getSemaphore(workItemKey).withPermits(1)(eff)

      const readLockTokenOption = (lockPath: string): Effect.Effect<Option.Option<OwnerToken>, never> =>
        Effect.tryPromise({
          try: () => fs.readFile(lockPath, "utf8"),
          catch: () => null,
        }).pipe(
          Effect.flatMap((raw) =>
            raw === null
              ? Effect.succeed(Option.none())
              : Schema.decodeUnknownEffect(OwnerTokenJson)(raw).pipe(
                  Effect.map(Option.some),
                  Effect.orElseSucceed(() => Option.none()),
                ),
          ),
          Effect.orElseSucceed(() => Option.none()),
        )

      const writeLockToken = (lockPath: string, owner: OwnerToken): Effect.Effect<void, PersistenceError> =>
        Schema.encodeEffect(OwnerTokenJson)(owner).pipe(
          Effect.mapError(
            (err) =>
              new PersistenceError({
                operation: "encodeLock",
                path: lockPath,
                message: err.message,
                corrupted: false,
              }),
          ),
          Effect.flatMap((json) => atomicWriteTextFile(lockPath, json + "\n")),
        )

      const writeSnapshotAndProjections = (
        paths: DraftPaths,
        state: WorkItemState,
      ): Effect.Effect<void, PersistenceError> =>
        encodeWorkItemJson(state, paths.statePath).pipe(
          Effect.flatMap((jsonText) =>
            atomicWriteTextFile(path.join(paths.historyDir, `${state.revision}.json`), jsonText).pipe(
              Effect.flatMap(() => atomicWriteTextFile(paths.statePath, jsonText)),
            ),
          ),
          Effect.flatMap(() => {
            const writeTodo =
              state.todos.length > 0 || state.kind === "plan"
                ? atomicWriteTextFile(paths.todoPath, renderTodoProjection(state))
                : Effect.void
            const writeQuestions =
              state.questions.length > 0
                ? atomicWriteTextFile(paths.questionsPath, renderQuestionsProjection(state))
                : Effect.void
            return Effect.all([writeTodo, writeQuestions], { discard: true })
          }),
        )

      const verifyOwnerCanMutate = (
        paths: DraftPaths,
        state: WorkItemState,
        callerOwner: OwnerToken,
      ): Effect.Effect<void, OwnershipConflictError> => {
        if (callerOwner.readOnly) {
          return Effect.fail(
            new OwnershipConflictError({
              workItemId: state.id,
              ownerSessionId: Option.match(state.owner, { onNone: () => "none", onSome: (o) => o.sessionId }),
              ownerRuntimeId: Option.match(state.owner, { onNone: () => "none", onSome: (o) => o.runtimeId }),
              attemptingSessionId: callerOwner.sessionId,
              attemptingRuntimeId: callerOwner.runtimeId,
              reason: "Read-only session attachment cannot mutate work item; transfer ownership or create a copy.",
            }),
          )
        }
        return readLockTokenOption(paths.lockPath).pipe(
          Effect.flatMap((diskLockOpt) => {
            const effectiveOwner = Option.orElse(diskLockOpt, () => state.owner)
            return Option.match(effectiveOwner, {
              onNone: () => Effect.void,
              onSome: (locked) => {
                if (
                  locked.sessionId === callerOwner.sessionId &&
                  locked.runtimeId === callerOwner.runtimeId
                ) {
                  return Effect.void
                }
                return Effect.fail(
                  new OwnershipConflictError({
                    workItemId: state.id,
                    ownerSessionId: locked.sessionId,
                    ownerRuntimeId: locked.runtimeId,
                    attemptingSessionId: callerOwner.sessionId,
                    attemptingRuntimeId: callerOwner.runtimeId,
                    reason: `Work item ${state.id} is owned by session ${locked.sessionId} (runtime ${locked.runtimeId}). Acquire/transfer ownership explicitly before mutating.`,
                  }),
                )
              },
            })
          }),
        )
      }

      const loadBySafeDirInternal = (
        workspaceCwd: string,
        configDirName: string,
        safeDirName: string,
      ): Effect.Effect<LoadedWorkItemResult, RealgoalError> => {
        const draftsRoot = path.resolve(workspaceCwd, configDirName, "realgoal", "draft")
        return resolveWithinRoot(draftsRoot, safeDirName).pipe(
          Effect.flatMap(() => {
            const paths = resolveDraftPaths(workspaceCwd, configDirName, safeDirName)
            return Effect.tryPromise({
              try: () => fs.readFile(paths.statePath, "utf8"),
              catch: (err) => err as NodeJS.ErrnoException,
            }).pipe(
              Effect.flatMap((raw) =>
                decodeWorkItemJson(raw, paths.statePath).pipe(
                  Effect.map((state) => ({ state, recoveredFromHistory: false })),
                ),
              ),
              Effect.catch((err) => {
                const isNotFound =
                  !(err instanceof PersistenceError) && (err as NodeJS.ErrnoException).code === "ENOENT"
                const isCorrupted = err instanceof PersistenceError && err.corrupted
                if (isNotFound || isCorrupted) {
                  return recoverFromHistoryDir(paths).pipe(
                    Effect.tap((recovered) =>
                      encodeWorkItemJson(recovered, paths.statePath).pipe(
                        Effect.flatMap((json) => atomicWriteTextFile(paths.statePath, json)),
                        Effect.ignore,
                      ),
                    ),
                    Effect.map((state) => ({ state, recoveredFromHistory: true })),
                  )
                }
                return Effect.fail(
                  err instanceof PersistenceError
                    ? err
                    : new PersistenceError({
                        operation: "readState",
                        path: paths.statePath,
                        message: `Failed reading ${paths.statePath}: ${(err as Error).message}`,
                        corrupted: false,
                      }),
                )
              }),
              Effect.flatMap(({ state, recoveredFromHistory }) =>
                Effect.all({
                  todoDiv: checkManagedFileDivergence(paths.todoPath, "todo.md"),
                  qDiv: checkManagedFileDivergence(paths.questionsPath, "questions.md"),
                }).pipe(
                  Effect.map(({ todoDiv, qDiv }) => {
                    const divergences = [todoDiv, qDiv]
                      .filter(Option.isSome)
                      .map((o) => o.value)
                    const partialPubs = state.publications.filter((p) => p.status === "pending")
                    return {
                      state,
                      paths,
                      recoveredFromHistory,
                      projectionDivergences: divergences,
                      partialPublications: partialPubs,
                    }
                  }),
                ),
              ),
            )
          }),
        )
      }

      return PersistenceService.of({
        allocateDraftStem: (workspaceCwd, configDirName, displayName, workItemId) => {
          const draftsRoot = path.resolve(workspaceCwd, configDirName, "realgoal", "draft")
          return allocateUniqueSafeDirName(draftsRoot, displayName, workItemId)
        },

        initializeWorkItem: (workspaceCwd, configDirName, state, owner) =>
          withItemLock(state.id, Effect.Do.pipe(
            Effect.let("paths", () => resolveDraftPaths(workspaceCwd, configDirName, state.safeDirName)),
            Effect.tap(({ paths }) =>
              Effect.tryPromise({
                try: () => fs.mkdir(paths.historyDir, { recursive: true }),
                catch: (err) =>
                  new PersistenceError({
                    operation: "mkdirDraft",
                    path: paths.draftDir,
                    message: `Failed creating draft directory ${paths.draftDir}: ${(err as Error).message}`,
                    corrupted: false,
                  }),
              }),
            ),
            Effect.tap(({ paths }) => writeLockToken(paths.lockPath, owner)),
            Effect.tap(({ paths }) => atomicWriteTextFile(paths.requestPath, renderRequestMarkdown(state))),
            Effect.tap(({ paths }) => writeSnapshotAndProjections(paths, state)),
            Effect.map(({ paths }) => paths),
          )),

        saveWorkItem: (workspaceCwd, configDirName, state, callerOwner) =>
          withItemLock(state.id, Effect.Do.pipe(
            Effect.let("paths", () => resolveDraftPaths(workspaceCwd, configDirName, state.safeDirName)),
            Effect.tap(({ paths }) => verifyOwnerCanMutate(paths, state, callerOwner)),
            Effect.tap(({ paths }) => writeLockToken(paths.lockPath, callerOwner)),
            Effect.tap(({ paths }) => writeSnapshotAndProjections(paths, state)),
            Effect.map(({ paths }) => paths),
          )),

        loadWorkItemBySafeDir: loadBySafeDirInternal,

        listAllWorkItems: (workspaceCwd, configDirName) => {
          const draftsRoot = path.resolve(workspaceCwd, configDirName, "realgoal", "draft")
          return Effect.tryPromise({
            try: () => fs.readdir(draftsRoot, { withFileTypes: true }),
            catch: () => [],
          }).pipe(
            Effect.orElseSucceed(() => []),
            Effect.flatMap((entries) => {
              const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
              return Effect.forEach(dirs, (dirName) =>
                loadBySafeDirInternal(workspaceCwd, configDirName, dirName).pipe(
                  Effect.catch((err) =>
                    Effect.succeed({
                      safeDirName: dirName,
                      error:
                        err instanceof PersistenceError
                          ? err
                          : new PersistenceError({
                              operation: "loadItem",
                              path: dirName,
                              message: String(err),
                              corrupted: true,
                            }),
                    }),
                  ),
                ),
              )
            }),
          )
        },

        loadWorkItemById: (workspaceCwd, configDirName, workItemId) => {
          const draftsRoot = path.resolve(workspaceCwd, configDirName, "realgoal", "draft")
          return Effect.tryPromise({
            try: () => fs.readdir(draftsRoot, { withFileTypes: true }),
            catch: () => [],
          }).pipe(
            Effect.orElseSucceed(() => []),
            Effect.flatMap((entries) => {
              const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
              const step = (idx: number): Effect.Effect<Option.Option<LoadedWorkItemResult>, RealgoalError> => {
                const d = dirs[idx]
                if (!d) return Effect.succeed(Option.none())
                return loadBySafeDirInternal(workspaceCwd, configDirName, d).pipe(
                  Effect.flatMap((loaded) =>
                    loaded.state.id === workItemId || loaded.state.safeDirName === workItemId
                      ? Effect.succeed(Option.some(loaded))
                      : step(idx + 1),
                  ),
                  Effect.catch(() => step(idx + 1)),
                )
              }
              return step(0)
            }),
          )
        },

        acquireOrVerifyOwnership: (
          workspaceCwd,
          configDirName,
          state,
          callerOwner,
          forceTransferAuthorized,
        ) =>
          withItemLock(state.id, Effect.Do.pipe(
            Effect.let("paths", () => resolveDraftPaths(workspaceCwd, configDirName, state.safeDirName)),
            Effect.bind("diskLock", ({ paths }) => readLockTokenOption(paths.lockPath)),
            Effect.flatMap(({ paths, diskLock }): Effect.Effect<WorkItemState, RealgoalError> => {
              if (callerOwner.readOnly) {
                return Effect.succeed(state)
              }
              const current = diskLock
              const sameSessionReload = Option.match(current, {
                onNone: () => true,
                onSome: (locked) =>
                  locked.sessionId === callerOwner.sessionId &&
                  (locked.runtimeId === callerOwner.runtimeId || locked.pid === callerOwner.pid),
              })

              if (!sameSessionReload && !forceTransferAuthorized) {
                const locked = Option.getOrThrow(current)
                return Effect.fail(
                  new OwnershipConflictError({
                    workItemId: state.id,
                    ownerSessionId: locked.sessionId,
                    ownerRuntimeId: locked.runtimeId,
                    attemptingSessionId: callerOwner.sessionId,
                    attemptingRuntimeId: callerOwner.runtimeId,
                    reason: `Work item "${state.displayName}" (${state.id}) is locked by session ${locked.sessionId}. Confirm explicit ownership transfer to resume here.`,
                  }),
                )
              }

              const updated: WorkItemState = {
                ...state,
                owner: Option.some(callerOwner),
              }
              return writeLockToken(paths.lockPath, callerOwner).pipe(
                Effect.flatMap(() => writeSnapshotAndProjections(paths, updated)),
                Effect.as(updated),
              )
            }),
          )),

        releaseOwnership: (workspaceCwd, configDirName, safeDirName, callerOwner) => {
          const paths = resolveDraftPaths(workspaceCwd, configDirName, safeDirName)
          return readLockTokenOption(paths.lockPath).pipe(
            Effect.flatMap((lockOpt) =>
              Option.match(lockOpt, {
                onNone: () => Effect.void,
                onSome: (locked) =>
                  locked.sessionId === callerOwner.sessionId &&
                  locked.runtimeId === callerOwner.runtimeId
                    ? Effect.tryPromise({
                        try: () => fs.unlink(paths.lockPath),
                        catch: () => undefined,
                      }).pipe(Effect.ignore)
                    : Effect.void,
              }),
            ),
          )
        },

        publishMarkdownArtifact: (params) =>
          withItemLock(params.state.id, Effect.Do.pipe(
            Effect.let("paths", () =>
              resolveDraftPaths(params.workspaceCwd, params.configDirName, params.state.safeDirName),
            ),
            Effect.tap(({ paths }) => verifyOwnerCanMutate(paths, params.state, params.callerOwner)),
            Effect.bind("finHash", () =>
              Option.match(params.state.finalizedCandidateHash, {
                onNone: () =>
                  Effect.fail(
                    new InvalidTransitionError({
                      workItemId: params.state.id,
                      fromPhase: params.state.phase,
                      toPhase: "publication",
                      fromStatus: params.state.runStatus,
                      toStatus: params.state.runStatus,
                      reason: "Cannot publish without a registered finalized.md candidate",
                      missingConditions: ["Register finalized.md via realgoal_control(action: 'finalize')"],
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
            Effect.tap(({ paths, finHash }) =>
              Effect.tryPromise({
                try: () => fs.readFile(paths.finalizedPath, "utf8"),
                catch: (err) =>
                  new PersistenceError({
                    operation: "readFinalized",
                    path: paths.finalizedPath,
                    message: `Missing finalized.md at ${paths.finalizedPath}: ${(err as Error).message}`,
                    corrupted: false,
                  }),
              }).pipe(
                Effect.flatMap((diskFinalized) =>
                  sha256Hex(diskFinalized) === finHash
                    ? Effect.void
                    : Effect.fail(
                        new InvalidTransitionError({
                          workItemId: params.state.id,
                          fromPhase: params.state.phase,
                          toPhase: "publication",
                          fromStatus: params.state.runStatus,
                          toStatus: params.state.runStatus,
                          reason: "finalized.md changed on disk after approval/finalization; re-finalize and re-validate gate",
                          missingConditions: ["Re-run finalize on the modified finalized.md"],
                        }),
                      ),
                ),
              ),
            ),
            Effect.tap((): Effect.Effect<void, RealgoalError> => {
              if (params.draftGateEnabled && !hasValidDraftReviewApproval(params.state)) {
                return Effect.fail(
                  new InvalidTransitionError({
                    workItemId: params.state.id,
                    fromPhase: params.state.phase,
                    toPhase: "publication",
                    fromStatus: params.state.runStatus,
                    toStatus: params.state.runStatus,
                    reason: "Draft review gate approval is missing or invalidated by changed inputs",
                    missingConditions: ["Pass draft_review for current manifest or obtain user waiver"],
                  }),
                )
              }
              const expectedAuthKinds =
                params.target === "spec"
                  ? new Set(["publish_spec", "publish_both"])
                  : new Set(["publish_plan", "publish_both"])
              const auth = params.state.authorizations.find(
                (a) => a.id === params.authorizationId && expectedAuthKinds.has(a.kind),
              )
              if (!auth) {
                return Effect.fail(
                  new AuthorizationRequiredError({
                    workItemId: params.state.id,
                    decisionKind: params.target === "spec" ? "publish_spec" : "publish_plan",
                    message: `Valid user publication authorization is required before publishing ${params.target}`,
                  }),
                )
              }
              return params.target === "plan" ? validateImplementationPlanContent(params.content) : Effect.void
            }),
            Effect.bind("targetFilePath", () => {
              const resolvedDestRoot = path.resolve(params.workspaceCwd, params.destinationDir)
              const fileName = `${params.customFileName ?? params.state.safeDirName}.md`
              return resolveWithinRoot(resolvedDestRoot, fileName)
            }),
            Effect.tap(({ targetFilePath }) =>
              Effect.tryPromise({
                try: () => fs.readFile(targetFilePath, "utf8"),
                catch: () => null,
              }).pipe(
                Effect.orElseSucceed(() => null),
                Effect.flatMap((existing): Effect.Effect<void, RealgoalError> => {
                  if (existing === null || params.allowOverwrite) return Effect.void
                  const belongsToSameWorkItem = existing.includes(`realgoal-source-work-item: ${params.state.id}`)
                  if (belongsToSameWorkItem) return Effect.void
                  return Effect.fail(
                    new InvalidTransitionError({
                      workItemId: params.state.id,
                      fromPhase: params.state.phase,
                      toPhase: "publication",
                      fromStatus: params.state.runStatus,
                      toStatus: params.state.runStatus,
                      reason: `Refusing to silently overwrite existing unrelated file at ${targetFilePath}`,
                      missingConditions: ["Confirm overwrite explicitly or choose a different file name"],
                    }),
                  )
                }),
              ),
            ),
            Effect.flatMap(({ paths, finHash, targetFilePath }) => {
              const pubId = `PUB${String(params.state.publications.length + 1).padStart(3, "0")}`
              const header = [
                `<!-- realgoal-source-work-item: ${params.state.id} -->`,
                `<!-- realgoal-source-finalized-sha256: ${finHash} -->`,
                `<!-- realgoal-source-revision: ${params.state.revision} -->`,
                "",
              ].join("\n")
              const fullDocument = header + params.content.trimEnd() + "\n"
              const pubHash = sha256Hex(fullDocument)

              const pendingRecord: PublicationRecord = {
                id: pubId,
                target: params.target,
                destinationPath: targetFilePath,
                sourceFinalizedHash: finHash,
                sourceRevision: params.state.revision,
                publishedHash: Option.none(),
                status: "pending",
                authorizationId: params.authorizationId,
                timestamp: params.nowIso,
              }

              const stateWithPending: WorkItemState = {
                ...params.state,
                revision: params.state.revision + 1,
                updatedAt: params.nowIso,
                publications: [...params.state.publications, pendingRecord],
              }

              const completedRecord: PublicationRecord = {
                ...pendingRecord,
                publishedHash: Option.some(pubHash),
                status: "completed",
              }

              const nextPhase =
                params.target === "plan" ? ("execution_choice" as const) : params.state.phase
              const nextStatus =
                params.target === "plan" ? ("awaiting_user" as const) : params.state.runStatus

              const stateCompleted: WorkItemState = {
                ...stateWithPending,
                revision: stateWithPending.revision + 1,
                phase: nextPhase,
                runStatus: nextStatus,
                publications: stateWithPending.publications.map((p) =>
                  p.id === pubId ? completedRecord : p,
                ),
                artifactHashes: {
                  ...stateWithPending.artifactHashes,
                  [targetFilePath]: pubHash,
                },
                nextAction:
                  params.target === "plan"
                    ? "Await user execution choice: Direct-driven, Subagent-driven, or Stop here."
                    : stateWithPending.nextAction,
              }

              return writeSnapshotAndProjections(paths, stateWithPending).pipe(
                Effect.flatMap(() => atomicWriteTextFile(targetFilePath, fullDocument)),
                Effect.flatMap(() => writeSnapshotAndProjections(paths, stateCompleted)),
                Effect.as({ state: stateCompleted, writtenPath: targetFilePath }),
              )
            }),
          )),
      })
    }),
  )
}
