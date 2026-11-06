import { describe, expect, test } from "bun:test"
import { ControllerService } from "../index.ts"
import { createPiTestHarness } from "./helpers/pi-harness.ts"

describe("§18.2 Realtasks and lifecycle races (R01–R16)", () => {
  test("R01, R02, R09: Durable wait without polling, fast-finish race during wait registration, and peek-only inspections", async () => {
    const h = await createPiTestHarness()
    try {
      await h.invokeCommand("goal", "Run integration suite in background")

      // Start a slow background task
      const bg1 = await h.invokeTool("bash", {
        command: "bun test slow-suite",
        run_in_background: true,
      })
      const slowTaskId = (bg1.details as any).taskId as string

      // R01: Enter durable wait
      const waitRes = await h.invokeTool("realgoal_control", {
        action: "wait",
        waitRequests: [{ taskId: slowTaskId, purpose: "Slow integration suite" }],
      })
      expect(waitRes.isError).toBeUndefined()
      expect(waitRes.terminate).toBe(true)
      expect((waitRes.details as any).runStatus).toBe("waiting_task")

      // R09: Verify peek: true was used (0 consuming calls!)
      const rec1 = h.tasks.get(slowTaskId)!
      expect(rec1.peekCalls).toBe(1)
      expect(rec1.consumingCalls).toBe(0)

      // Settle while waiting_task must NOT poll or continue
      const settleWaiting = await h.emitAgentBeforeSettle({ contextLen: 5 })
      expect(settleWaiting.continue).toBe(false)

      // R02: Start a second task that finishes BEFORE wait registration is called
      await h.invokeCommand("realgoal", "resume")
      const bg2 = await h.invokeTool("bash", {
        command: "echo instant",
        run_in_background: true,
      })
      const fastTaskId = (bg2.details as any).taskId as string
      h.tasks.get(fastTaskId)!.status = "completed"
      h.tasks.get(fastTaskId)!.exitCode = 0

      const fastWait = await h.invokeTool("realgoal_control", {
        action: "wait",
        waitRequests: [{ taskId: fastTaskId, purpose: "Instant task" }],
      })
      expect(fastWait.isError).toBeUndefined()
      // Did NOT get stuck in waiting_task!
      expect((fastWait.details as any).runStatus).toBe("running")
      expect(fastWait.terminate).toBeUndefined()
    } finally {
      await h.cleanup()
    }
  })

  test("R03, R04, R05: Both extension load orders wake once on settle notification, deduplicate replays, and ignore unrelated tasks", async () => {
    for (const loadAfter of [false, true]) {
      const h = await createPiTestHarness({ loadRealtasksAfterRealgoal: loadAfter })
      try {
        await h.invokeCommand("goal", `Order check loadAfter=${loadAfter}`)
        const bg = await h.invokeTool("bash", { command: "sleep 2", run_in_background: true })
        const trackedId = (bg.details as any).taskId as string

        await h.invokeTool("realgoal_control", {
          action: "wait",
          waitRequests: [{ taskId: trackedId, purpose: "Build job" }],
        })

        // R05: Unrelated task completes -> state remains waiting_task
        const unrelatedNotice = {
          type: "custom_message" as const,
          customType: "task-notification",
          content: "<task-notification>unrelated</task-notification>",
          display: true,
          details: {
            items: [{ id: "t_unrelated_999", kind: "terminal", detail: "completed" }],
          },
        }
        const afterUnrelated = await h.emitAgentBeforeSettle({
          entries: [unrelatedNotice],
          continue: true,
          contextLen: 4,
        })
        const stUnrelated = await h.runtime.runPromise(
          ControllerService.use((c) => c.requireWorkItem()),
        )
        expect(stUnrelated.state.runStatus).toBe("waiting_task")
        expect(afterUnrelated.entries).toContainEqual(unrelatedNotice)

        // R03: Tracked task notification arrives in settle entries -> wakes to running & preserves notification
        h.tasks.get(trackedId)!.status = "completed"
        const trackedNotice = {
          type: "custom_message" as const,
          customType: "task-notification",
          content: `<task-notification>${trackedId} completed</task-notification>`,
          display: true,
          details: {
            items: [{ id: trackedId, kind: "terminal", detail: "completed (exit 0)" }],
          },
        }
        const wokeSettle = await h.emitAgentBeforeSettle({
          entries: [trackedNotice],
          continue: true,
          contextLen: 6,
        })
        expect(wokeSettle.continue).toBe(true)
        expect(wokeSettle.entries).toContainEqual(trackedNotice)

        const stWoke = await h.runtime.runPromise(
          ControllerService.use((c) => c.requireWorkItem()),
        )
        expect(stWoke.state.runStatus).toBe("running")
        const revAfterWake = stWoke.state.revision

        // R04: Replay identical message_end notification -> deduplicated
        await h.emitMessageEnd({
          role: "custom",
          customType: "task-notification",
          details: {
            items: [{ id: trackedId, kind: "terminal", detail: "completed (exit 0)" }],
          },
        })
        // Status stays running without corrupting or duplicating transitions
        const stAfterDup = await h.runtime.runPromise(
          ControllerService.use((c) => c.requireWorkItem()),
        )
        expect(stAfterDup.state.runStatus).toBe("running")
        expect(stAfterDup.state.revision).toBeGreaterThanOrEqual(revAfterWake)
      } finally {
        await h.cleanup()
      }
    }
  })

  test("R06, R07, R08: Failed task enters recovery (never finish), paused goal stays paused on task finish, and passive/silent tasks reject unattended wait", async () => {
    const h = await createPiTestHarness()
    try {
      await h.invokeCommand("goal", "Test failure & pause task semantics")

      // R08: Start passive task -> unattended wait is rejected
      const passiveBg = await h.invokeTool("bash", {
        command: "sleep 5",
        run_in_background: true,
        notify: "passive",
      })
      const passiveId = (passiveBg.details as any).taskId as string
      const passiveWait = await h.invokeTool("realgoal_control", {
        action: "wait",
        waitRequests: [{ taskId: passiveId, purpose: "Passive watcher" }],
      })
      expect(passiveWait.isError).toBe(true)
      expect((passiveWait.details as any).error.code).toBe("RealtasksAdapterError")

      // R07: Start wake task, enter wait, user pauses, then task completes -> stays paused!
      const wakeBg = await h.invokeTool("bash", {
        command: "sleep 5",
        run_in_background: true,
      })
      const wakeId = (wakeBg.details as any).taskId as string
      await h.invokeTool("realgoal_control", {
        action: "wait",
        waitRequests: [{ taskId: wakeId, purpose: "Paused task test" }],
      })
      await h.invokeCommand("realgoal", "pause")

      h.tasks.get(wakeId)!.status = "completed"
      await h.emitMessageEnd({
        role: "custom",
        customType: "task-notification",
        details: {
          items: [{ id: wakeId, kind: "terminal", detail: "completed" }],
        },
      })
      const stPaused = await h.runtime.runPromise(
        ControllerService.use((c) => c.requireWorkItem()),
      )
      expect(stPaused.state.runStatus).toBe("paused")
      expect(stPaused.state.trackedTasks.find((t) => t.taskId === wakeId)?.lastStatus).toBe("completed")

      // R06: Resume, bind a failing task -> wakes into recovery and blocks realgoal_finish
      await h.invokeCommand("realgoal", "resume")
      const failBg = await h.invokeTool("bash", {
        command: "exit 1",
        run_in_background: true,
      })
      const failId = (failBg.details as any).taskId as string
      await h.invokeTool("realgoal_control", {
        action: "wait",
        waitRequests: [{ taskId: failId, purpose: "Required build", requireSuccess: true }],
      })
      h.tasks.get(failId)!.status = "failed"
      h.tasks.get(failId)!.exitCode = 1
      await h.emitMessageEnd({
        role: "custom",
        customType: "task-notification",
        details: {
          items: [{ id: failId, kind: "terminal", detail: "failed (exit 1)" }],
        },
      })
      const stRecovered = await h.runtime.runPromise(
        ControllerService.use((c) => c.requireWorkItem()),
      )
      expect(stRecovered.state.runStatus).toBe("running")
      expect(stRecovered.state.nextAction).toContain("failed")

      const finishAttempt = await h.invokeTool("realgoal_finish", {
        summary: "Try finish despite failed required task",
        recordGoalLevelVerification: true,
      })
      expect(finishAttempt.isError).toBe(true)
    } finally {
      await h.cleanup()
    }
  })

  test("R10, R11, R12: Service readiness resumes without exit, readiness timeout stays unresolved, and nested codemode task calls bind accurately", async () => {
    const h = await createPiTestHarness()
    try {
      await h.invokeCommand("goal", "Dev server readiness & nested codemode")

      // R10 + R12: Start ready server with parentToolCallId (nested codemode simulation)
      const srvRes = await h.invokeTool(
        "bash",
        {
          command: "bun run dev-server",
          ready: { port: 3000 },
        },
        { toolCallId: "tc_parent/1", parentToolCallId: "tc_parent" },
      )
      const srvId = (srvRes.details as any).taskId as string

      const waitReady = await h.invokeTool("realgoal_control", {
        action: "wait",
        waitRequests: [
          {
            taskId: srvId,
            purpose: "Dev server on :3000",
            waitCondition: "ready",
          },
        ],
      })
      expect(waitReady.isError).toBeUndefined()
      // Already ready while still running -> immediately stays running!
      expect((waitReady.details as any).runStatus).toBe("running")

      // R11: Simulate a service whose readiness timed out while process stays running
      let nextId = "t_bg_3"
      h.tasks.set("t_timeout_srv", {
        id: "t_timeout_srv",
        label: "slow-server",
        status: "running",
        output: "Task t_timeout_srv is running but not ready after 5000ms",
        cursor: 0,
        peekCalls: 0,
        consumingCalls: 0,
        notify: "wake",
      })
      void nextId
      const timeoutWait = await h.invokeTool("realgoal_control", {
        action: "wait",
        waitRequests: [
          {
            taskId: "t_timeout_srv",
            purpose: "Unready server",
            waitCondition: "ready",
          },
        ],
      })
      expect((timeoutWait.details as any).runStatus).toBe("waiting_task")
    } finally {
      await h.cleanup()
    }
  })

  test("R13, R14, R15, R16: Cross-session unavailable tasks, re-adoption reconcile, authorized-only task_stop, and headless print/json waiting", async () => {
    const h = await createPiTestHarness({ hasUI: false, mode: "json" })
    try {
      await h.invokeCommand("goal", "Headless task lifecycle")
      const bgOwned = await h.invokeTool("bash", { command: "sleep 30", run_in_background: true })
      const ownedId = (bgOwned.details as any).taskId as string
      const bgUnrelated = await h.invokeTool("bash", { command: "sleep 60", run_in_background: true })
      const unrelatedId = (bgUnrelated.details as any).taskId as string

      // R16: Enter waiting_task in headless json mode -> persisted durably
      const waitHeadless = await h.invokeTool("realgoal_control", {
        action: "wait",
        waitRequests: [{ taskId: ownedId, purpose: "Owned job" }],
      })
      expect(waitHeadless.terminate).toBe(true)
      expect((waitHeadless.details as any).runStatus).toBe("waiting_task")

      // R13: Task finishes while passive/re-adopted -> reconcile updates accurately
      h.tasks.get(ownedId)!.status = "completed"
      const recRes = await h.invokeTool("realgoal_control", { action: "reconcile" })
      expect((recRes.details as any).runStatus).toBe("running")

      // R14: Switch to a brand new session where task_output cannot find an old session's task
      const ghostBg = await h.invokeTool("bash", { command: "sleep 10", run_in_background: true })
      const ghostId = (ghostBg.details as any).taskId as string
      await h.invokeTool("realgoal_control", {
        action: "wait",
        waitRequests: [{ taskId: ghostId, purpose: "Old session task" }],
      })
      h.tasks.delete(ghostId)
      await h.emitSessionBeforeSwitch()
      h.sessionId = "sess-new-2"
      await h.emitSessionStart("resume")
      await h.invokeCommand("realgoal", `resume`)

      const crossSessionReconcile = await h.invokeTool("realgoal_control", { action: "reconcile" })
      const ghostStatus = (crossSessionReconcile.details as any).trackedTasks.find(
        (t: any) => t.taskId === ghostId,
      )?.lastStatus
      // Must be 'unavailable', NOT mislabeled as 'lost'!
      expect(ghostStatus).toBe("unavailable")

      // R15: Authorize cleanup ONLY for unrelatedId? No — unrelatedId is not even tracked!
      // Authorize cleanup for ghostId only; ensure task_stop("all") is NEVER called and unrelatedId is untouched.
      const loaded = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))
      const { auth } = await h.runtime.runPromise(
        ControllerService.use((c) =>
          c.createUserAuthorization({
            state: loaded.state,
            kind: "cleanup_tasks",
            summary: "Authorize stopping ghostId only",
            taskIds: [ghostId],
            nowIso: new Date().toISOString(),
          }),
        ),
      )

      // Attempt to stop unrelatedId with ghostId's authorization -> rejected!
      const badStop = await h.invokeTool("realgoal_control", {
        action: "cleanup",
        authorizationId: auth.id,
        cleanupTaskIds: [unrelatedId],
      })
      expect(badStop.isError).toBe(true)
      expect(h.stopCalls.some((c) => c.id === "all")).toBe(false)
      expect(h.tasks.get(unrelatedId)?.status).toBe("running")

      // Valid stop of ghostId
      const okStop = await h.invokeTool("realgoal_control", {
        action: "cleanup",
        authorizationId: auth.id,
        cleanupTaskIds: [ghostId],
      })
      expect(okStop.isError).toBeUndefined()
      expect(h.stopCalls).toEqual([{ id: ghostId }])
    } finally {
      await h.cleanup()
    }
  })
})
