import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect, Option } from "effect"
import { PathSafetyError, PreviewSecurityError } from "../domain/errors.ts"

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
])

export const sha256Hex = (content: string | Uint8Array): string =>
  crypto.createHash("sha256").update(content).digest("hex")

export const shortHash = (content: string, len = 6): string => sha256Hex(content).slice(0, len)

export const isWindowsReservedStem = (name: string): boolean => {
  const trimmed = name.trim().replace(/[. ]+$/, "")
  const base = (trimmed.split(".")[0] ?? "").toUpperCase()
  return WINDOWS_RESERVED_NAMES.has(base)
}

export const sanitizeTaskStem = (
  displayName: string,
): Effect.Effect<string, PathSafetyError> => {
  const raw = displayName.trim()
  if (raw.length === 0) {
    return Effect.fail(
      new PathSafetyError({
        inputName: displayName,
        reason: "Task name must not be empty",
      }),
    )
  }
  if (raw === "." || raw === ".." || raw.includes("\0")) {
    return Effect.fail(
      new PathSafetyError({
        inputName: displayName,
        reason: "Task name contains forbidden special path segments",
      }),
    )
  }
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    return Effect.fail(
      new PathSafetyError({
        inputName: displayName,
        reason: "Task name must not be an absolute path",
      }),
    )
  }
  if (raw.includes("..") && (raw.includes("/") || raw.includes("\\"))) {
    return Effect.fail(
      new PathSafetyError({
        inputName: displayName,
        reason: "Task name must not contain path traversal sequences",
      }),
    )
  }

  const normalized = raw
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001F\u007F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "")
    .slice(0, 64)
    .replace(/[-. ]+$/g, "")

  if (normalized.length === 0 || normalized === "." || normalized === "..") {
    return Effect.fail(
      new PathSafetyError({
        inputName: displayName,
        reason: "Task name produced an empty safe stem after sanitization",
      }),
    )
  }

  if (isWindowsReservedStem(normalized)) {
    return Effect.succeed(`task-${normalized.toLowerCase()}-${shortHash(raw, 6)}`)
  }

  return Effect.succeed(normalized)
}

export const allocateUniqueSafeDirName = (
  draftsRootDir: string,
  displayName: string,
  workItemId: string,
): Effect.Effect<string, PathSafetyError> =>
  sanitizeTaskStem(displayName).pipe(
    Effect.flatMap((stem) =>
      Effect.tryPromise({
        try: () => fs.readdir(draftsRootDir),
        catch: (err) => err as NodeJS.ErrnoException,
      }).pipe(
        Effect.catchIf(
          (err) => err.code === "ENOENT",
          () => Effect.succeed([] as string[]),
        ),
        Effect.mapError(
          (err) =>
            new PathSafetyError({
              inputName: displayName,
              reason: `Failed listing drafts directory ${draftsRootDir}: ${err.message}`,
            }),
        ),
        Effect.map((existingEntries) => {
          const lowerExisting = new Set(existingEntries.map((e) => e.toLowerCase()))
          if (!lowerExisting.has(stem.toLowerCase())) {
            return stem
          }
          const suffixed = `${stem.slice(0, 55)}-${shortHash(`${workItemId}:${displayName}`, 6)}`
          if (!lowerExisting.has(suffixed.toLowerCase())) {
            return suffixed
          }
          return `${stem.slice(0, 50)}-${crypto.randomBytes(4).toString("hex")}`
        }),
      ),
    ),
  )

const realpathExistingAncestor = (targetPath: string): Effect.Effect<string, PathSafetyError> => {
  const resolved = path.resolve(targetPath)
  const step = (current: string, suffixParts: ReadonlyArray<string>): Effect.Effect<string, PathSafetyError> =>
    Effect.tryPromise({
      try: () => fs.realpath(current),
      catch: (err) => err as NodeJS.ErrnoException,
    }).pipe(
      Effect.map((realBase) =>
        suffixParts.length === 0 ? realBase : path.join(realBase, ...suffixParts),
      ),
      Effect.catchIf(
        (err) => err.code === "ENOENT",
        () => {
          const parent = path.dirname(current)
          if (parent === current) {
            return Effect.fail(
              new PathSafetyError({
                inputName: targetPath,
                reason: `Cannot resolve ancestor realpath for ${targetPath}`,
              }),
            )
          }
          return step(parent, [path.basename(current), ...suffixParts])
        },
      ),
      Effect.mapError((err) =>
        err instanceof PathSafetyError
          ? err
          : new PathSafetyError({
              inputName: targetPath,
              reason: `Failed resolving realpath for ${targetPath}: ${err.message}`,
            }),
      ),
    )

  return step(resolved, [])
}

export const isSubPath = (rootReal: string, candidateReal: string): boolean => {
  const normRoot = process.platform === "win32" ? rootReal.toLowerCase() : rootReal
  const normCandidate = process.platform === "win32" ? candidateReal.toLowerCase() : candidateReal
  const rel = path.relative(normRoot, normCandidate)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export const resolveWithinRoot = (
  rootDir: string,
  relativeOrCandidatePath: string,
): Effect.Effect<string, PathSafetyError> => {
  if (relativeOrCandidatePath.includes("\0")) {
    return Effect.fail(
      new PathSafetyError({
        inputName: relativeOrCandidatePath,
        reason: "Path contains null byte",
      }),
    )
  }
  if (
    path.isAbsolute(relativeOrCandidatePath) ||
    /^[a-zA-Z]:[\\/]/.test(relativeOrCandidatePath) ||
    relativeOrCandidatePath.startsWith("\\\\")
  ) {
    return Effect.fail(
      new PathSafetyError({
        inputName: relativeOrCandidatePath,
        reason: `Absolute path is not allowed inside confined root: ${relativeOrCandidatePath}`,
      }),
    )
  }

  const joined = path.resolve(rootDir, relativeOrCandidatePath)
  return Effect.all({
    rootReal: realpathExistingAncestor(rootDir),
    targetReal: realpathExistingAncestor(joined),
  }).pipe(
    Effect.flatMap(({ rootReal, targetReal }) =>
      isSubPath(rootReal, targetReal)
        ? Effect.succeed(targetReal)
        : Effect.fail(
            new PathSafetyError({
              inputName: relativeOrCandidatePath,
              reason: `Path escapes confined root (${rootDir}): ${relativeOrCandidatePath}`,
            }),
          ),
    ),
  )
}

export const isCandidateInsideRoot = (
  workspaceCwd: string,
  allowedRootPath: string,
  candidateInputPath: string,
): Effect.Effect<boolean, never> => {
  const resolvedCandidate = path.resolve(workspaceCwd, candidateInputPath)
  return Effect.all({
    rootReal: realpathExistingAncestor(allowedRootPath),
    targetReal: realpathExistingAncestor(resolvedCandidate),
  }).pipe(
    Effect.map(({ rootReal, targetReal }) => isSubPath(rootReal, targetReal)),
    Effect.orElseSucceed(() => false),
  )
}

export const sha256FileOption = (filePath: string): Effect.Effect<Option.Option<string>, never> =>
  Effect.tryPromise({
    try: () => fs.readFile(filePath),
    catch: () => undefined,
  }).pipe(
    Effect.map((buf) => Option.some(sha256Hex(buf))),
    Effect.orElseSucceed(() => Option.none()),
  )

export const computeReviewInputManifestHash = (params: {
  readonly finalizedHash: string
  readonly requestHash: string
  readonly criteriaHash: string
  readonly decisionsHash: string
  readonly projectFileHashes?: Record<string, string>
}): string => {
  const sortedFiles = Object.entries(params.projectFileHashes ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join("|")
  return sha256Hex(
    [
      `finalized:${params.finalizedHash}`,
      `request:${params.requestHash}`,
      `criteria:${params.criteriaHash}`,
      `decisions:${params.decisionsHash}`,
      `files:${sortedFiles}`,
    ].join("\n"),
  )
}

export const sanitizeSvgContent = (
  rawSvg: string,
  allowExternalAssets = false,
): Effect.Effect<string, PreviewSecurityError> => {
  if (!rawSvg.includes("<svg")) {
    return Effect.fail(
      new PreviewSecurityError({
        reason: "Invalid SVG content: missing <svg> root element",
        path: Option.none(),
      }),
    )
  }

  const withoutScripts = rawSvg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<script[^>]*\/?>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/<foreignObject[^>]*\/?>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(?:xlink:href|href)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, "")
    .replace(/(?:xlink:href|href)\s*=\s*(?:"\s*data:text\/html[^"]*"|'\s*data:text\/html[^']*')/gi, "")

  const sanitized = allowExternalAssets
    ? withoutScripts
    : withoutScripts.replace(
        /(?:xlink:href|href|src)\s*=\s*(?:"\s*https?:\/\/[^"]*"|'\s*https?:\/\/[^']*')/gi,
        "",
      )

  return Effect.succeed(sanitized)
}
