import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, test } from "bun:test"
import { ControllerService, DoctorService, posixShellQuote } from "../index.ts"
import { createPiTestHarness } from "./helpers/pi-harness.ts"

const realRealtasksEntry = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "git",
  "github.com",
  "st0nie",
  "realtasks",
  "index.ts",
)

const describeIfInstalled = fs.existsSync(realRealtasksEntry) ? describe : describe.skip

describeIfInstalled("§18 Real Windows E2E with installed st0nie/realtasks", () => {
  test("E2E-01: /realgoal doctor, POSIX shell quoting on Windows Bash, durable wait -> real <task-notification> wake -> finish", async () => {
    const h = await createPiTestHarness({
      useRealRealtasks: true,
      mode: "print",
      hasUI: false,
    })
    try {
      // 1. Verify /realgoal doctor against live Realtasks tools + Windows Bash + Pi CLI
      await h.invokeCommand("realgoal", "doctor")
      const doctorMsg = h.sentMessages.find((m) => String(m.content).includes("Realgoal Doctor"))
      expect(doctorMsg).toBeDefined()
      expect(String(doctorMsg?.content)).toContain("Realgoal Doctor (HEALTHY)")
      expect(String(doctorMsg?.content)).toContain("[OK] Realtasks capability tools")

      // 2. Start a /goal and launch a real Windows Bash background task with tricky POSIX quoting
      await h.invokeCommand("goal", "Verify Windows realtasks background execution end-to-end")
      await h.emitAgentStart()

      const trickyPayload = "it's quoted & spaced $HOME `literal`!"
      const quotedCmd = `printf '%s\\n' ${posixShellQuote(trickyPayload)} && sleep 0.6 && echo E2E_DONE_OK`

      const bgRes = await h.invokeTool("bash", {
        command: quotedCmd,
        description: "e2e windows bash quoted job",
        run_in_background: true,
        notify: "wake",
        rtk: "off",
      })
      expect(bgRes.isError).toBeFalsy()
      const realTaskId = (bgRes.details as { taskId?: string } | undefined)?.taskId
      expect(typeof realTaskId).toBe("string")

      // 3. Enter durable wait; RealtasksAdapter inspects with peek: true without consuming wake latch
      const waitRes = await h.invokeTool("realgoal_control", {
        action: "wait",
        waitRequests: [{ taskId: realTaskId!, purpose: "Windows quoted bash job" }],
      })
      expect(waitRes.isError).toBeUndefined()
      expect(waitRes.terminate).toBe(true)
      expect((waitRes.details as { runStatus: string }).runStatus).toBe("waiting_task")

      // 4. Settle in print mode: realtasks waits for the background wake task, emits <task-notification>,
      //    and realgoal reconciles waiting_task -> running with continue: true!
      const settleRes = await h.emitAgentBeforeSettle({ contextLen: 4 })
      expect(settleRes.continue).toBe(true)

      const rtNotice = settleRes.entries?.find(
        (e) => e.type === "custom_message" && e.customType === "task-notification",
      )
      expect(rtNotice).toBeDefined()
      expect(String((rtNotice as { content?: unknown }).content)).toContain("E2E_DONE_OK")
      expect(String((rtNotice as { content?: unknown }).content)).toContain(trickyPayload)

      const wokeItem = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))
      expect(wokeItem.state.runStatus).toBe("running")
      expect(wokeItem.state.trackedTasks[0]?.lastStatus).toBe("completed")

      // 5. Inspect full output via peek: true and finish the /goal cleanly
      const peekOut = await h.invokeTool("task_output", {
        id: realTaskId!,
        from: "start",
        peek: true,
      })
      const peekText = peekOut.content.map((p) => (p.type === "text" ? p.text : "")).join("")
      expect(peekText).toContain(trickyPayload)
      expect(peekText).toContain("E2E_DONE_OK")

      await h.invokeTool("realgoal_todo", { action: "start", todoId: "T001" })
      const evRes = await h.invokeTool("realgoal_todo", {
        action: "record_evidence",
        todoId: "T001",
        evidence: {
          id: "EV_E2E_1",
          criterionIds: ["C001"],
          todoIds: ["T001"],
          method: "executable_test",
          result: "pass",
          commandOrObservation: `Real task ${realTaskId} exited 0 with exact quoted payload`,
          exitCode: 0,
        },
      })
      expect(evRes.isError).toBeUndefined()
      const doneRes = await h.invokeTool("realgoal_todo", {
        action: "complete",
        todoId: "T001",
        evidenceIds: ["EV_E2E_1"],
      })
      expect(doneRes.isError).toBeUndefined()

      const fin = await h.invokeTool("realgoal_finish", {
        summary: "Verified Windows E2E realtasks wake & quoting",
        evidenceIds: ["EV_E2E_1"],
        recordGoalLevelVerification: true,
      })
      expect(fin.isError).toBeUndefined()
      expect((fin.details as { runStatus: string }).runStatus).toBe("finished")

      await h.emitAgentEnd()
    } finally {
      await h.cleanup()
    }
  }, 20_000)

  test("E2E-02: Real keep_alive re-adoption across separate Pi instances and authorized /realgoal stop --stop-tasks process termination", async () => {
    const h1 = await createPiTestHarness({
      useRealRealtasks: true,
      mode: "print",
      hasUI: false,
      sessionId: "sess-e2e-keepalive",
      keepTempDirOnCleanup: true,
    })
    let liveTaskId = ""
    const sharedTempDir = h1.tempDir

    try {
      await h1.invokeCommand("goal", "Manage long-lived keep_alive process on Windows")
      await h1.emitAgentStart()

      const bgRes = await h1.invokeTool("bash", {
        command: "echo KEEP_ALIVE_STARTED && sleep 30",
        description: "long lived windows sleep",
        run_in_background: true,
        keep_alive: true,
        notify: "wake",
        rtk: "off",
      })
      expect(bgRes.isError).toBeFalsy()
      liveTaskId = (bgRes.details as { taskId: string }).taskId
      expect(typeof liveTaskId).toBe("string")

      await h1.invokeTool("realgoal_control", {
        action: "wait",
        waitRequests: [{ taskId: liveTaskId, purpose: "Long-lived keep_alive daemon" }],
      })
    } finally {
      // Tear down first extension instance (detaches realtasks while keeping keep_alive child alive)
      await h1.cleanup()
    }

    // Boot a brand-new extension instance on the same workspace + sessionId
    const h2 = await createPiTestHarness({
      useRealRealtasks: true,
      mode: "print",
      hasUI: false,
      existingTempDir: sharedTempDir,
      sessionId: "sess-e2e-keepalive",
    })
    try {
      // Real realtasks re-adopted the running OS process across instances!
      const peekAfterReattach = await h2.invokeTool("task_output", {
        id: liveTaskId,
        from: "start",
        peek: true,
      })
      expect(peekAfterReattach.isError).toBeFalsy()
      expect((peekAfterReattach.details as { status: string }).status).toBe("running")

      // Resume work item in instance 2, then cancel with user cleanup confirmation & execute authorized cleanup
      await h2.invokeCommand("realgoal", "resume")
      h2.hasUI = true
      h2.ui.confirmQueue.push(true)
      await h2.invokeCommand("realgoal", "cancel")

      const afterCancel = await h2.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))
      expect(afterCancel.state.runStatus).toBe("cancelled")
      const cleanupAuth = afterCancel.state.authorizations.find((a) => a.kind === "cleanup_tasks")
      expect(cleanupAuth).toBeDefined()

      const cleanupRes = await h2.invokeTool("realgoal_control", {
        action: "cleanup",
        authorizationId: cleanupAuth!.id,
        cleanupTaskIds: [liveTaskId],
      })
      expect(cleanupRes.isError).toBeUndefined()

      const peekAfterStop = await h2.invokeTool("task_output", {
        id: liveTaskId,
        peek: true,
      })
      expect((peekAfterStop.details as { status: string }).status).toBe("stopped")

      // Also verify DoctorService directly returns healthy status when realtasks is loaded
      const report = await h2.runtime.runPromise(
        DoctorService.use((doc) =>
          doc.runDiagnostics({
            workspaceCwd: h2.tempDir,
            configDirName: ".pi",
            registeredToolNames: h2.activeTools,
            bashSupportsBackground: true,
            commandCollisions: [],
            previewHost: "127.0.0.1",
          }),
        ),
      )
      expect(report.overallStatus).toBe("healthy")
    } finally {
      await h2.cleanup()
    }
  }, 20_000)
})
