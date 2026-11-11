import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { ControllerService } from "../index.ts"
import { createPiTestHarness } from "./helpers/pi-harness.ts"

describe("§18.1 Workflow and continuation (W01–W10)", () => {
  test("W01 & W02: /goal continues once per settle boundary without completing on '[DONE]' prose", async () => {
    const h = await createPiTestHarness()
    try {
      await h.invokeCommand("goal", "Fix flaky cache invalidation")
      expect(h.sentUserMessages.length).toBe(1)

      // W02: Assistant writes "[DONE] finished!" prose without calling realgoal_finish
      await h.emitMessageEnd({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "[DONE] All finished!" }],
      })

      const activeAfterProse = await h.runtime.runPromise(
        ControllerService.use((c) => c.requireWorkItem()),
      )
      expect(activeAfterProse.state.runStatus).toBe("running")
      expect(activeAfterProse.state.phase).toBe("intake")

      // W01: First settle requests one continuation
      const settle1 = await h.emitAgentBeforeSettle({ contextLen: 2 })
      expect(settle1.continue).toBe(true)
      expect(
        settle1.entries?.some(
          (e) => e.type === "custom_message" && e.customType === "realgoal-continuation",
        ),
      ).toBe(true)

      // Duplicate call at same boundary key (same revision + contextLen) does not emit duplicate prompt
      const dupSettle = await h.emitAgentBeforeSettle({ contextLen: 2 })
      expect(dupSettle.continue).toBe(false)
    } finally {
      await h.cleanup()
    }
  })

  test("W03 & W04: realgoal_finish rejects missing evidence/TODOs with exact conditions, and valid finish is idempotent", async () => {
    const h = await createPiTestHarness()
    try {
      await h.invokeCommand("goal", "Implement health endpoint")

      // W03: Attempt finish while T001 is pending and C001 has no passing evidence
      const rejected = await h.invokeTool("realgoal_finish", {
        summary: "Premature finish",
        recordGoalLevelVerification: false,
      })
      expect(rejected.isError).toBe(true)
      const errDetails = (rejected.details as any).error
      expect(errDetails.code).toBe("FinishRejectedError")
      expect(errDetails.details.missingConditions.length).toBeGreaterThanOrEqual(3)

      // Complete T001 properly with fresh passing evidence
      await h.invokeTool("realgoal_todo", { action: "start", todoId: "T001" })
      const evRes = await h.invokeTool("realgoal_todo", {
        action: "record_evidence",
        todoId: "T001",
        evidence: {
          id: "EV001",
          criterionIds: ["C001"],
          todoIds: ["T001"],
          method: "executable_test",
          result: "pass",
          commandOrObservation: "bun test health.test.ts -> 1 pass",
          exitCode: 0,
        },
      })
      expect(evRes.isError).toBeUndefined()

      const doneRes = await h.invokeTool("realgoal_todo", {
        action: "complete",
        todoId: "T001",
        evidenceIds: ["EV001"],
      })
      expect(doneRes.isError).toBeUndefined()

      // W04: Call valid realgoal_finish twice (same operationId / terminal revision)
      const fin1 = await h.invokeTool("realgoal_finish", {
        summary: "Implemented and verified health endpoint",
        operationId: "op_fin_1",
        evidenceIds: ["EV001"],
        recordGoalLevelVerification: true,
      })
      expect(fin1.isError).toBeUndefined()
      expect(fin1.terminate).toBe(true)
      const revAfterFirst = (fin1.details as any).revision

      const fin2 = await h.invokeTool("realgoal_finish", {
        summary: "Implemented and verified health endpoint",
        operationId: "op_fin_1",
        evidenceIds: ["EV001"],
        recordGoalLevelVerification: true,
      })
      expect(fin2.isError).toBeUndefined()
      expect((fin2.details as any).revision).toBe(revAfterFirst)

      // Settle after finished does not continue
      const settleAfterFinish = await h.emitAgentBeforeSettle({ contextLen: 10 })
      expect(settleAfterFinish.continue).toBe(false)
    } finally {
      await h.cleanup()
    }
  })

  test("W05 & W06: Escape abort persists paused state; provider error blocks cleanly without infinite loop", async () => {
    const h = await createPiTestHarness()
    try {
      await h.invokeCommand("goal", "Migrate schema")

      // W05: Escape abort at settle boundary
      const abortSettle = await h.emitAgentBeforeSettle({ outcome: "aborted", contextLen: 3 })
      expect(abortSettle.continue).toBe(false)
      await h.emitAgentSettled(true)

      const pausedLoaded = await h.runtime.runPromise(
        ControllerService.use((c) => c.requireWorkItem()),
      )
      expect(pausedLoaded.state.runStatus).toBe("paused")

      // Resume then hit W06 provider error
      await h.invokeCommand("realgoal", "resume")
      await h.emitMessageEnd({
        role: "assistant",
        stopReason: "error",
        errorMessage: "401 Unauthorized API key",
      })

      const blockedLoaded = await h.runtime.runPromise(
        ControllerService.use((c) => c.requireWorkItem()),
      )
      expect(blockedLoaded.state.runStatus).toBe("blocked")
      expect(Option.getOrElse(blockedLoaded.state.pauseOrBlockReason, () => "")).toContain("401")

      const settleAfterError = await h.emitAgentBeforeSettle({ outcome: "error", contextLen: 5 })
      expect(settleAfterError.continue).toBe(false)
    } finally {
      await h.cleanup()
    }
  })

  test("W07 & W08: Only pauses on agent mark pause (with reason), user interrupt, or crash in process/implement; tool_error and no-progress do not pause", async () => {
    const h = await createPiTestHarness()
    try {
      await h.invokeCommand("goal", "Multi-step refactor")

      // W08: 12 consecutive productive turns (each records a checkpoint before settling)
      for (let i = 1; i <= 12; i++) {
        const cp = await h.invokeTool("realgoal_control", {
          action: "checkpoint",
          researchNotes: `Productive finding #${i}`,
          nextAction: `Step ${i + 1}`,
        })
        expect(cp.isError).toBeUndefined()
        const s = await h.emitAgentBeforeSettle({ contextLen: 10 + i })
        expect(s.continue).toBe(true)
      }

      // W07: Repeated tool_error and consecutive no-progress continuations do NOT pause
      for (let i = 1; i <= 5; i++) {
        const errTool = await h.invokeTool("task_output", { id: "t_missing" })
        expect(errTool.isError).toBe(true)
      }
      const np1 = await h.emitAgentBeforeSettle({ contextLen: 30 })
      expect(np1.continue).toBe(true)
      const np2 = await h.emitAgentBeforeSettle({ contextLen: 31 })
      expect(np2.continue).toBe(true)
      const np3 = await h.emitAgentBeforeSettle({ contextLen: 32 })
      expect(np3.continue).toBe(true)

      const stillRunning = await h.runtime.runPromise(
        ControllerService.use((c) => c.requireWorkItem()),
      )
      expect(stillRunning.state.runStatus).toBe("running")

      // Crash recovery in non-process phase ('intake') does NOT pause
      await h.emitSessionStart("startup")
      const afterIntakeCrash = await h.runtime.runPromise(
        ControllerService.use((c) => c.requireWorkItem()),
      )
      expect(afterIntakeCrash.state.runStatus).toBe("running")

      // Advance to process -> crash recovery in 'process' phase DOES pause
      await h.invokeTool("realgoal_control", { action: "advance", targetPhase: "explore" })
      await h.invokeTool("realgoal_control", { action: "advance", targetPhase: "analyze" })
      await h.invokeTool("realgoal_control", { action: "advance", targetPhase: "process" })
      await h.emitSessionStart("startup")
      const afterProcessCrash = await h.runtime.runPromise(
        ControllerService.use((c) => c.requireWorkItem()),
      )
      expect(afterProcessCrash.state.runStatus).toBe("paused")

      // Resume, then test agent pause requires a non-empty reason
      await h.invokeCommand("realgoal", "resume")
      const badPause = await h.invokeTool("realgoal_control", { action: "pause" })
      expect(badPause.isError).toBe(true)

      const goodPause = await h.invokeTool("realgoal_control", {
        action: "pause",
        reason: "Waiting for external schema migration window",
      })
      expect(goodPause.isError).toBeUndefined()
      const agentPaused = await h.runtime.runPromise(
        ControllerService.use((c) => c.requireWorkItem()),
      )
      expect(agentPaused.state.runStatus).toBe("paused")
      expect(Option.getOrElse(agentPaused.state.pauseOrBlockReason, () => "")).toBe(
        "Waiting for external schema migration window",
      )
    } finally {
      await h.cleanup()
    }
  })

  test("W09 & W10: Preserves upstream extension boundary entries and flags mid-run user scope interjections", async () => {
    const h = await createPiTestHarness()
    try {
      await h.invokeCommand("goal", "Build CSV exporter")

      // W09: Another extension already proposed a custom entry and continue:true
      const otherEntry = {
        type: "custom_message" as const,
        customType: "other-ext-notice",
        content: "Upstream notice",
        display: true,
      }
      const composed = await h.emitAgentBeforeSettle({
        entries: [otherEntry],
        continue: true,
        contextLen: 4,
      })
      expect(composed.continue).toBe(true)
      expect(
        composed.entries?.some(
          (e) => e.type === "custom_message" && e.customType === "other-ext-notice",
        ),
      ).toBe(true)
      expect(
        composed.entries?.some(
          (e) => e.type === "custom_message" && e.customType === "realgoal-continuation",
        ),
      ).toBe(true)

      // W10: User sends mid-run scope change message
      await h.emitInput("Actually also support Parquet output and drop TSV", "interactive")
      const injected = await h.emitBeforeAgentStart("Actually also support Parquet output and drop TSV")
      expect(injected?.message?.content).toContain("USER INTERJECTION DETECTED")
      expect(injected?.message?.content).toContain("Parquet")
    } finally {
      await h.cleanup()
    }
  })

  test("UI status omits current TODO title and /goal todo widget shows stage progression", async () => {
    const h = await createPiTestHarness()
    try {
      await h.invokeCommand("goal", "Tighten compact footer status and show stages")

      expect(h.ui.statuses.get("realgoal")).toBe("Goal · intake")
      expect(h.ui.widgets.get("realgoal-todos")).toEqual([
        "▶ Intake",
        "○ Explore",
        "○ Analyze",
        "○ Process",
        "○ Verify",
      ])

      // Skip explore directly to analyze
      await h.invokeTool("realgoal_control", {
        action: "advance",
        targetPhase: "analyze",
        reason: "Scope is localized to presentation.ts",
        nextAction: "Proceed to process",
      })
      expect(h.ui.statuses.get("realgoal")).toBe("Goal · analyze")
      expect(h.ui.widgets.get("realgoal-todos")).toEqual([
        "✓ Intake",
        "− Explore (skipped)",
        "▶ Analyze",
        "○ Process",
        "○ Verify",
      ])

      // Revisit explore, then advance through analyze -> process -> verify
      await h.invokeTool("realgoal_control", {
        action: "advance",
        targetPhase: "explore",
        reason: "Check callers",
        nextAction: "Analyze callers",
      })
      await h.invokeTool("realgoal_control", {
        action: "advance",
        targetPhase: "analyze",
        reason: "Callers checked",
        nextAction: "Implement",
      })
      await h.invokeTool("realgoal_control", {
        action: "advance",
        targetPhase: "process",
        reason: "Ready to edit",
        nextAction: "Verify",
      })
      expect(h.ui.statuses.get("realgoal")).toBe("Goal · process")
      expect(h.ui.widgets.get("realgoal-todos")).toEqual([
        "✓ Intake",
        "✓ Explore",
        "✓ Analyze",
        "▶ Process",
        "○ Verify",
      ])

      // Appending a second explicit TODO switches widget to explicit TODO list and shows count without current TODO title
      await h.invokeTool("realgoal_todo", {
        action: "append",
        items: [{ title: "Add regression test", description: "Cover UI status and widget" }],
      })
      expect(h.ui.statuses.get("realgoal")).toBe("Goal · process · 0/2 done")
      expect(h.ui.statuses.get("realgoal")).not.toContain("T001")
      expect(h.ui.widgets.get("realgoal-todos")).toEqual([
        "○ T001 Tighten compact footer status and show stages",
        "○ T002 Add regression test",
      ])
    } finally {
      await h.cleanup()
    }
  })

  test("Gracefully handles pre-aborted and mid-flight AbortSignal without throwing 'All fibers interrupted without error'", async () => {
    const h = await createPiTestHarness()
    try {
      await h.invokeCommand("goal", "Verify abort interruption handling")
      const aborted = AbortSignal.abort()

      // Pre-aborted ctx.signal across before_agent_start, tool execution, message_end, settle, and slash commands
      const beforeStart = await h.emitBeforeAgentStart("continue", aborted)
      expect(beforeStart).toBeUndefined()

      const abortedTool = await h.invokeTool(
        "realgoal_control",
        { action: "status" },
        { signal: aborted },
      )
      expect(abortedTool.isError).toBe(true)
      expect(abortedTool.details).toEqual({ ok: false, aborted: true })
      expect((abortedTool.content[0] as { text: string }).text).toBe("Operation aborted.")

      // Exact reproduction of ExtensionRunner.emitMessageEnd during streamAssistantResponse abort
      await h.emitMessageEnd(
        {
          role: "assistant",
          stopReason: "aborted",
          content: [],
        },
        aborted,
      )

      const settleRes = await h.emitAgentBeforeSettle({
        outcome: "aborted",
        contextLen: 4,
        signal: aborted,
      })
      expect(settleRes.continue).toBe(false)

      await h.emitAgentSettled(true, aborted)
      const pausedAfterAbort = await h.runtime.runPromise(
        ControllerService.use((c) => c.requireWorkItem()),
      )
      expect(pausedAfterAbort.state.runStatus).toBe("paused")

      // Slash command invoked while previous run's signal is still aborted executes cleanly
      const sentBefore = h.sentMessages.length
      await h.invokeCommand("realgoal", "status", aborted)
      expect(h.sentMessages.length).toBeGreaterThan(sentBefore)

      // Mid-flight fiber interruptions on runEventEffect, runToolEffect, and runCommandEffect resolve gracefully
      const eventCtrl = new AbortController()
      setTimeout(() => eventCtrl.abort(), 10)
      const eventVal = await h.runtime.runEventEffect(
        Effect.sleep("5 seconds").pipe(Effect.as("done")),
        "fallback",
        eventCtrl.signal,
      )
      expect(eventVal).toBe("fallback")

      const cmdCtrl = new AbortController()
      setTimeout(() => cmdCtrl.abort(), 10)
      await h.runtime.runCommandEffect(
        {
          hasUI: false,
          signal: cmdCtrl.signal,
          ui: { setStatus() {}, setWidget() {}, notify() {} },
        } as any,
        Effect.sleep("5 seconds").pipe(Effect.as(Option.some("done"))),
      )

      const toolCtrl = new AbortController()
      setTimeout(() => toolCtrl.abort(), 10)
      const midFlightTool = await h.runtime.runToolEffect(
        {
          hasUI: false,
          ui: { setStatus() {}, setWidget() {}, notify() {} },
        } as any,
        toolCtrl.signal,
        Effect.sleep("5 seconds").pipe(Effect.as({ summary: "done", details: {} })),
      )
      expect(midFlightTool.isError).toBe(true)
      expect(midFlightTool.details).toEqual({ ok: false, aborted: true })

      // Non-interrupt defects still reject rather than being swallowed
      await expect(
        h.runtime.runEventEffect(Effect.die(new Error("unexpected-defect")), "fallback"),
      ).rejects.toThrow("unexpected-defect")
    } finally {
      await h.cleanup()
    }
  })
})
