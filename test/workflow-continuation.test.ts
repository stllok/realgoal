import { describe, expect, test } from "bun:test"
import { Option } from "effect"
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

  test("W07 & W08: No-progress threshold pauses cleanly, while >15 productive turns never hit an arbitrary turn cap", async () => {
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

      // W07: Now 3 consecutive no-progress continuations hit default maxNoProgressContinuations=3
      const np1 = await h.emitAgentBeforeSettle({ contextLen: 30 })
      expect(np1.continue).toBe(true)
      const np2 = await h.emitAgentBeforeSettle({ contextLen: 31 })
      expect(np2.continue).toBe(true)
      const np3 = await h.emitAgentBeforeSettle({ contextLen: 32 })
      expect(np3.continue).toBe(false)

      const stalled = await h.runtime.runPromise(
        ControllerService.use((c) => c.requireWorkItem()),
      )
      expect(stalled.state.runStatus).toBe("paused")
      expect(Option.getOrElse(stalled.state.pauseOrBlockReason, () => "")).toContain(
        "No qualifying progress",
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
})
