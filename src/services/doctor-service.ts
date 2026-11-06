import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as http from "node:http"
import * as path from "node:path"
import { Context, Effect, Layer } from "effect"

export interface DiagnosticCheckItem {
  readonly id: string
  readonly label: string
  readonly status: "ok" | "warning" | "error"
  readonly detail: string
}

export interface DoctorReport {
  readonly overallStatus: "healthy" | "degraded" | "blocked"
  readonly checks: ReadonlyArray<DiagnosticCheckItem>
}

const REQUIRED_REALTASKS_TOOLS = ["bash", "task_output", "task_wait", "task_stop", "task_list", "monitor"]

const probeWritableDir = (dirPath: string, label: string): Effect.Effect<DiagnosticCheckItem, never> => {
  const probeFile = path.join(dirPath, `.realgoal-doctor-probe-${process.pid}`)
  return Effect.tryPromise({
    try: async () => {
      await fs.mkdir(dirPath, { recursive: true })
      await fs.writeFile(probeFile, "ok", "utf8")
      await fs.unlink(probeFile)
    },
    catch: (err) => (err as Error).message,
  }).pipe(
    Effect.map(
      (): DiagnosticCheckItem => ({
        id: `writable:${label}`,
        label: `Writable ${label}`,
        status: "ok",
        detail: dirPath,
      }),
    ),
    Effect.catch((msg) =>
      Effect.succeed<DiagnosticCheckItem>({
        id: `writable:${label}`,
        label: `Writable ${label}`,
        status: "error",
        detail: `Cannot write to ${dirPath}: ${msg}`,
      }),
    ),
  )
}

const probeLoopbackHttp = (host: string): Effect.Effect<DiagnosticCheckItem, never> =>
  Effect.callback<DiagnosticCheckItem>((resume) => {
    const srv = http.createServer()
    srv.once("error", (err) => {
      resume(
        Effect.succeed({
          id: "preview_loopback",
          label: "Loopback preview HTTP server",
          status: "warning",
          detail: `Loopback bind failed on ${host} (${err.message}); Pi terminal UI fallback will be used.`,
        }),
      )
    })
    srv.listen(0, host, () => {
      const addr = srv.address()
      const portInfo = addr && typeof addr !== "string" ? `${host}:${addr.port}` : host
      srv.close(() => {
        resume(
          Effect.succeed({
            id: "preview_loopback",
            label: "Loopback preview HTTP server",
            status: "ok",
            detail: `Verified ephemeral bind on ${portInfo}`,
          }),
        )
      })
    })
  })

const probeExecutableVersion = (
  exe: string,
  args: ReadonlyArray<string>,
): Effect.Effect<{ readonly ok: boolean; readonly output: string }, never> =>
  Effect.callback<{ readonly ok: boolean; readonly output: string }>((resume) => {
    execFile(exe, [...args], { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resume(Effect.succeed({ ok: false, output: stderr?.trim() || err.message }))
        return
      }
      resume(Effect.succeed({ ok: true, output: (stdout || stderr).trim() }))
    })
  })

const checkWindowsBashTransport = (): Effect.Effect<DiagnosticCheckItem, never> => {
  if (process.platform !== "win32") {
    return Effect.succeed({
      id: "bash_transport",
      label: "POSIX shell transport",
      status: "ok",
      detail: `Platform ${process.platform}`,
    })
  }
  return probeExecutableVersion("where.exe", ["bash"]).pipe(
    Effect.map((res): DiagnosticCheckItem => {
      if (!res.ok) {
        return {
          id: "bash_transport",
          label: "Windows Bash transport",
          status: "error",
          detail: `No bash found in PATH (${res.output}). Install Git Bash / MSYS2 / Cygwin for realtasks.`,
        }
      }
      const lines = res.output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      const first = (lines[0] ?? "").toLowerCase()
      const onlyWsl =
        lines.length > 0 &&
        lines.every((l) => l.toLowerCase().includes("system32\\bash.exe") || l.toLowerCase().includes("windowsapps\\bash.exe"))
      if (onlyWsl) {
        return {
          id: "bash_transport",
          label: "Windows Bash transport",
          status: "error",
          detail: `Found only WSL Bash launcher (${lines[0]}), which realtasks rejects. Install Git Bash / MSYS2 / Cygwin.`,
        }
      }
      if (first.includes("system32\\bash.exe")) {
        return {
          id: "bash_transport",
          label: "Windows Bash transport",
          status: "warning",
          detail: `WSL bash precedes Git Bash in PATH (${lines.join("; ")}). Ensure Pi/realtasks resolves Git Bash.`,
        }
      }
      return {
        id: "bash_transport",
        label: "Windows Bash transport",
        status: "ok",
        detail: `Resolved ${lines[0]}`,
      }
    }),
  )
}

export class DoctorService extends Context.Service<
  DoctorService,
  {
    readonly runDiagnostics: (params: {
      readonly workspaceCwd: string
      readonly configDirName: string
      readonly registeredToolNames: ReadonlyArray<string>
      readonly bashSupportsBackground: boolean
      readonly commandCollisions: ReadonlyArray<string>
      readonly previewHost: string
      readonly piExecutable?: string
    }) => Effect.Effect<DoctorReport, never>
  }
>()("realgoal/services/DoctorService") {
  static readonly layer = Layer.succeed(
    DoctorService,
    DoctorService.of({
      runDiagnostics: (params) => {
        const toolSet = new Set(params.registeredToolNames)
        const missingRealtasks = REQUIRED_REALTASKS_TOOLS.filter((t) => !toolSet.has(t))

        const realtasksCheck: DiagnosticCheckItem =
          missingRealtasks.length > 0
            ? {
                id: "realtasks_tools",
                label: "Realtasks capability tools",
                status: "error",
                detail: `Missing required realtasks tools: ${missingRealtasks.join(", ")}. Install/enable st0nie/realtasks.`,
              }
            : !params.bashSupportsBackground
              ? {
                  id: "realtasks_tools",
                  label: "Realtasks capability tools",
                  status: "error",
                  detail: `Tool 'bash' does not expose run_in_background/ready parameters; realtasks bash override is not active.`,
                }
              : {
                  id: "realtasks_tools",
                  label: "Realtasks capability tools",
                  status: "ok",
                  detail: `All required tools present (${REQUIRED_REALTASKS_TOOLS.join(", ")})`,
                }

        const collisionCheck: DiagnosticCheckItem =
          params.commandCollisions.length > 0
            ? {
                id: "command_collisions",
                label: "Slash command collisions",
                status: "warning",
                detail: `Detected pre-existing command(s): ${params.commandCollisions.join(", ")}. Use /realgoal <action> if needed.`,
              }
            : {
                id: "command_collisions",
                label: "Slash command collisions",
                status: "ok",
                detail: "/goal, /plan, and /realgoal registered cleanly",
              }

        const realgoalDir = path.resolve(params.workspaceCwd, params.configDirName, "realgoal")
        const docDir = path.resolve(params.workspaceCwd, "doc")

        return Effect.all({
          writeRealgoal: probeWritableDir(realgoalDir, `${params.configDirName}/realgoal`),
          writeDoc: probeWritableDir(docDir, "doc"),
          bashTransport: checkWindowsBashTransport(),
          piCli: probeExecutableVersion(params.piExecutable ?? "pi", ["--version"]).pipe(
            Effect.map(
              (res): DiagnosticCheckItem =>
                res.ok
                  ? {
                      id: "worker_pi_cli",
                      label: "Delegated worker Pi CLI",
                      status: "ok",
                      detail: `pi --version: ${res.output}`,
                    }
                  : {
                      id: "worker_pi_cli",
                      label: "Delegated worker Pi CLI",
                      status: "warning",
                      detail: `'pi --version' failed (${res.output}); subagent execution will block until 'pi' is in PATH.`,
                    },
            ),
          ),
          loopback: probeLoopbackHttp(params.previewHost),
        }).pipe(
          Effect.map(({ writeRealgoal, writeDoc, bashTransport, piCli, loopback }) => {
            const checks: ReadonlyArray<DiagnosticCheckItem> = [
              realtasksCheck,
              collisionCheck,
              writeRealgoal,
              writeDoc,
              bashTransport,
              piCli,
              loopback,
            ]
            const hasError = checks.some((c) => c.status === "error")
            const hasWarning = checks.some((c) => c.status === "warning")
            return {
              overallStatus: hasError ? "blocked" : hasWarning ? "degraded" : "healthy",
              checks,
            } satisfies DoctorReport
          }),
        )
      },
    }),
  )
}
