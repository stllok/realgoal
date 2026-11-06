import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import {
  allocateUniqueSafeDirName,
  buildSafeWorkerCommand,
  checkWorkerWriteAllowed,
  ConfigService,
  ControllerService,
  makeDefaultConfig,
  PersistenceService,
  posixShellQuote,
  resolveWithinRoot,
  resolveWorkerModel,
  sanitizeTaskStem,
  validateWorkerTranscriptAndResult,
  type OwnerToken,
  type WorkerJobRecord,
} from "../index.ts"
import { createPiTestHarness } from "./helpers/pi-harness.ts"

describe("§18.4 Workers, state, and platforms (D01–D12)", () => {
  test("D01: All 4 execution × verification driver combinations enforce identical TODO & evidence contracts", async () => {
    const combos: Array<{ exec: "direct" | "subagent"; verify: "direct" | "subagent" }> = [
      { exec: "direct", verify: "direct" },
      { exec: "direct", verify: "subagent" },
      { exec: "subagent", verify: "direct" },
      { exec: "subagent", verify: "subagent" },
    ]

    for (const combo of combos) {
      const h = await createPiTestHarness()
      try {
        await h.invokeCommand("plan", `Combo ${combo.exec}-${combo.verify}`)
        const loaded = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))

        const planDoc = [
          "# Plan",
          "## Goal & Scope\nTest drivers.",
          "## Stage 1\nImplement T001.",
          "## Acceptance & Verification\nPass tests.",
        ].join("\n\n")
        await h.invokeTool("realgoal_control", { action: "advance", targetPhase: "discovery" })
        await h.invokeTool("realgoal_control", { action: "advance", targetPhase: "finalization" })
        await fs.writeFile(loaded.paths.finalizedPath, planDoc, "utf8")
        await h.invokeTool("realgoal_control", { action: "finalize" })
        await h.invokeCommand("realgoal", "publish plan")
        await h.invokeCommand("realgoal", `execute ${combo.exec} verify:${combo.verify}`)

        await h.invokeTool("realgoal_todo", {
          action: "append",
          items: [{ title: "Core feature", description: "Impl", difficulty: "medium" }],
        })
        await h.invokeTool("realgoal_todo", { action: "start", todoId: "T001" })
        await h.invokeTool("realgoal_todo", {
          action: "record_evidence",
          todoId: "T001",
          evidence: {
            id: "EV1",
            criterionIds: ["C001"],
            todoIds: ["T001"],
            method: "executable_test",
            result: "pass",
            commandOrObservation: "bun test -> pass",
          },
        })

        if (combo.exec === "subagent") {
          // Subagent-executed TODO cannot skip verify_pending!
          const premature = await h.invokeTool("realgoal_todo", {
            action: "complete",
            todoId: "T001",
            evidenceIds: ["EV1"],
          })
          expect(premature.isError).toBe(true)

          await h.invokeTool("realgoal_todo", {
            action: "submit_for_verification",
            todoId: "T001",
            implementationSummary: "Worker finished T001",
          })
        }

        if (combo.verify === "subagent") {
          // Subagent verification driver rejects completion without a passing subagent review!
          const missingSubReview = await h.invokeTool("realgoal_todo", {
            action: "complete",
            todoId: "T001",
            evidenceIds: ["EV1"],
          })
          expect(missingSubReview.isError).toBe(true)

          const okSubComplete = await h.invokeTool("realgoal_todo", {
            action: "complete",
            todoId: "T001",
            evidenceIds: ["EV1"],
            reviewSummary: {
              reviewerActor: "subagent",
              verdict: "pass",
              summary: "Independent subagent verified T001",
              workerJobId: "W001",
            },
          })
          expect(okSubComplete.isError).toBeUndefined()
        } else {
          const okDirectComplete = await h.invokeTool("realgoal_todo", {
            action: "complete",
            todoId: "T001",
            evidenceIds: ["EV1"],
          })
          expect(okDirectComplete.isError).toBeUndefined()
        }
      } finally {
        await h.cleanup()
      }
    }
  })

  test("D02, D03, D04: Tiered model inheritance, config overrides, ephemeral/unauthenticated block without silent swap, and thinking clamping warning", async () => {
    const defaultCfg = makeDefaultConfig(".pi")
    const baseParent = {
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      thinkingLevel: "high" as const,
      availableModels: [
        { provider: "anthropic", id: "claude-sonnet-4-5", reasoning: true, hasChildCredentials: true },
        { provider: "openai", id: "gpt-4o-mini", reasoning: false, hasChildCredentials: true },
        { provider: "openai", id: "o3-pro", reasoning: true, hasChildCredentials: false },
        {
          provider: "ephemeral-ext",
          id: "temp-model",
          reasoning: true,
          hasChildCredentials: true,
          isEphemeralParentOnly: true,
        },
      ],
    }

    // D02: Default inherit for light and heavy inherits parent model & thinkingLevel ("high")
    const lightRes = await Effect.runPromise(
      resolveWorkerModel({ difficulty: "light", config: defaultCfg, parent: baseParent }),
    )
    expect(lightRes.resolved.provider).toBe("anthropic")
    expect(lightRes.resolved.modelId).toBe("claude-sonnet-4-5")
    expect(lightRes.resolved.effectiveThinking).toBe("high")

    const heavyRes = await Effect.runPromise(
      resolveWorkerModel({ difficulty: "heavy", config: defaultCfg, parent: baseParent }),
    )
    expect(heavyRes.resolved.effectiveThinking).toBe("high")

    // D03 & D04: Non-reasoning tier model clamps thinking to 'off' with disclosed warning
    const clampedCfg = {
      ...defaultCfg,
      models: {
        ...defaultCfg.models,
        light: { model: "openai/gpt-4o-mini", thinking: "high" as const },
      },
    }
    const clampedRes = await Effect.runPromise(
      resolveWorkerModel({ difficulty: "light", config: clampedCfg, parent: baseParent }),
    )
    expect(clampedRes.resolved.modelId).toBe("gpt-4o-mini")
    expect(clampedRes.resolved.effectiveThinking).toBe("off")
    expect(clampedRes.resolved.thinkingClamped).toBe(true)
    expect(Option.isSome(clampedRes.warning)).toBe(true)

    // D04: Unauthenticated tier model blocks with WorkerValidationError (never swaps silently!)
    const unauthCfg = {
      ...defaultCfg,
      models: {
        ...defaultCfg.models,
        heavy: { model: "openai/o3-pro", thinking: "high" as const },
      },
    }
    const unauthOutcome = await Effect.runPromise(
      Effect.result(resolveWorkerModel({ difficulty: "heavy", config: unauthCfg, parent: baseParent })),
    )
    expect(unauthOutcome._tag).toBe("Failure")

    // D04: Ephemeral parent-only provider blocks cleanly under --no-extensions
    const ephOutcome = await Effect.runPromise(
      Effect.result(
        resolveWorkerModel({
          difficulty: "medium",
          config: defaultCfg,
          parent: { ...baseParent, provider: "ephemeral-ext", modelId: "temp-model" },
        }),
      ),
    )
    expect(ephOutcome._tag).toBe("Failure")

    // D03: Dispatched worker records immutable resolvedModel snapshot even if parent model changes later
    const h = await createPiTestHarness()
    try {
      await h.invokeCommand("goal", "Verify worker snapshot immutability")
      const delRes = await h.invokeTool("realgoal_delegate", {
        role: "verification",
        purpose: "Verify T001",
        scope: "Read-only check",
        todoId: "T001",
        difficulty: "light",
        enterWait: false,
      })
      expect(delRes.isError).toBeUndefined()
      const snapshotModel = (delRes.details as any).resolvedModel.modelId
      expect(snapshotModel).toBe("claude-sonnet-4-5")

      // Mutate parent model after dispatch -> existing WorkerJobRecord keeps claude-sonnet-4-5
      h.model = { provider: "openai", id: "gpt-5", reasoning: true }
      const loaded = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))
      expect(loaded.state.workers[0]?.resolvedModel.modelId).toBe("claude-sonnet-4-5")
    } finally {
      await h.cleanup()
    }
  })

  test("D05 & D06: Child exit-0 with assistant error/abort or missing result.json fails validation; child worker role guards block parent finish & out-of-scope writes", async () => {
    const dummyJob: WorkerJobRecord = {
      jobId: "W_TEST_1",
      role: "verification",
      workItemId: "rg_test_1",
      todoId: Option.some("T001"),
      purpose: "Verify T001",
      scope: "Read-only check",
      difficulty: "light",
      requestedModel: { model: "inherit", thinking: "low" },
      taskId: Option.some("t_bg_1"),
      status: "running",
      resolvedModel: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
        requestedThinking: "low",
        effectiveThinking: "low",
        thinkingClamped: false,
        resolutionSource: "tier_profile",
      },
      inputArtifactHash: Option.none(),
      inputManifestHash: Option.none(),
      requestPath: "/tmp/req.json",
      resultPath: "/tmp/res.json",
      transcriptPath: "/tmp/events.jsonl",
      allowedTools: ["read", "realgoal_worker_result"],
      allowedWritePaths: [],
      summary: Option.none(),
      needsInputQuestion: Option.none(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    // D05: Process exited 0, result.json exists, BUT final assistant stopReason is "error" -> MUST FAIL!
    const errTranscript = [
      JSON.stringify({ type: "session", id: "child-1" }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "Rate limit" },
      }),
    ].join("\n")
    const validResultJson = JSON.stringify({
      schemaVersion: 1,
      jobId: "W_TEST_1",
      workItemId: "rg_test_1",
      role: "verification",
      todoId: "T001",
      status: "completed",
      summary: "Looks good",
      filesChanged: [],
      deviations: [],
      checksRun: [],
      verdict: "pass",
      findings: [],
      timestamp: new Date().toISOString(),
    })

    const exitZeroAssistantErr = await Effect.runPromise(
      Effect.result(
        validateWorkerTranscriptAndResult({
          job: dummyJob,
          rawTranscript: errTranscript,
          rawResultJsonOption: Option.some(validResultJson),
        }),
      ),
    )
    expect(exitZeroAssistantErr._tag).toBe("Failure")

    // Missing result.json -> MUST FAIL!
    const okTranscript = [
      JSON.stringify({ type: "session", id: "child-1" }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "stop" },
      }),
      JSON.stringify({ type: "agent_settled", aborted: false }),
    ].join("\n")
    const missingResult = await Effect.runPromise(
      Effect.result(
        validateWorkerTranscriptAndResult({
          job: dummyJob,
          rawTranscript: okTranscript,
          rawResultJsonOption: Option.none(),
        }),
      ),
    )
    expect(missingResult._tag).toBe("Failure")

    // Valid transcript + valid result.json -> succeeds!
    const validValidation = await Effect.runPromise(
      validateWorkerTranscriptAndResult({
        job: dummyJob,
        rawTranscript: okTranscript,
        rawResultJsonOption: Option.some(validResultJson),
      }),
    )
    expect(validValidation.verdict).toEqual(Option.some("pass"))

    // D06: Role guard blocks child worker from calling parent realgoal_finish or realgoal_delegate
    const h = await createPiTestHarness()
    const prevRole = process.env["REALGOAL_WORKER_ROLE"]
    try {
      await h.invokeCommand("goal", "Test child role guard")
      process.env["REALGOAL_WORKER_ROLE"] = "implementation"

      const childFinish = await h.invokeTool("realgoal_finish", {
        summary: "Child attempting to finish parent",
        recordGoalLevelVerification: true,
      })
      expect(childFinish.isError).toBe(true)
      expect((childFinish.details as any).error.code).toBe("FinishRejectedError")

      const childDelegate = await h.invokeTool("realgoal_delegate", {
        role: "implementation",
        purpose: "Recursive child spawn",
        scope: "Forbidden",
      })
      expect(childDelegate.isError).toBe(true)
      expect((childDelegate.details as any).error.code).toBe("RoleGuardError")
    } finally {
      if (prevRole === undefined) delete process.env["REALGOAL_WORKER_ROLE"]
      else process.env["REALGOAL_WORKER_ROLE"] = prevRole
      await h.cleanup()
    }
  })

  test("D07, D08, D09, D10: Single-writer lock, stale revision, history crash recovery, projection divergence, fork read-only guard, and corrupt/schema/secret rejection", async () => {
    const h = await createPiTestHarness()
    try {
      await h.invokeCommand("goal", "Persistence resilience test")
      const loaded = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))

      // D07: Stale expectedRevision rejected with StaleRevisionError
      const staleMut = await h.invokeTool("realgoal_todo", {
        action: "start",
        todoId: "T001",
        expectedRevision: 999,
      })
      expect(staleMut.isError).toBe(true)
      expect((staleMut.details as any).error.code).toBe("StaleRevisionError")

      // D07: Rival writer with different sessionId/runtimeId rejected by OwnershipConflictError
      const rivalOwner: OwnerToken = {
        sessionId: "rival-session",
        runtimeId: "rival-runtime",
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        hostMode: "tui",
        readOnly: false,
      }
      const rivalClaim = await h.runtime.runPromise(
        Effect.result(
          PersistenceService.use((p) =>
            p.acquireOrVerifyOwnership(h.tempDir, ".pi", loaded.state, rivalOwner, false),
          ),
        ),
      )
      expect(rivalClaim._tag).toBe("Failure")

      // Advance revision so history/<rev>.json exists, then corrupt state.json AND manually tamper with todo.md (D08)
      await h.invokeTool("realgoal_todo", { action: "start", todoId: "T001" })
      await fs.writeFile(loaded.paths.statePath, "{ truncated crash json...", "utf8")
      await fs.appendFile(loaded.paths.todoPath, "\n- [x] Manually checked by user\n", "utf8")

      const recovered = await h.runtime.runPromise(
        PersistenceService.use((p) =>
          p.loadWorkItemBySafeDir(h.tempDir, ".pi", loaded.state.safeDirName),
        ),
      )
      expect(recovered.recoveredFromHistory).toBe(true)
      expect(recovered.projectionDivergences.length).toBeGreaterThan(0)
      expect(recovered.state.todos[0]?.status).toBe("in_progress")

      // D09: Forked session attaches read-only and blocks mutating realgoal_todo calls; copyWorkItemForFork creates independent copy
      await h.emitSessionStart("fork")
      const forkBlocked = await h.invokeTool("realgoal_todo", {
        action: "block",
        todoId: "T001",
        reason: "Should fail on read-only fork",
      })
      expect(forkBlocked.isError).toBe(true)
      expect((forkBlocked.details as any).blocked).toBe(true)

      const forkedCopy = await h.runtime.runPromise(
        ControllerService.use((c) =>
          c.copyWorkItemForFork({
            sourceState: recovered.state,
            newDisplayName: "Forked Goal Copy",
            nowIso: new Date().toISOString(),
          }),
        ),
      )
      expect(forkedCopy.state.id).not.toBe(recovered.state.id)
      expect(forkedCopy.state.safeDirName).not.toBe(recovered.state.safeDirName)

      // D10: Unsupported schemaVersion & secret keys / maxConcurrentWriters > 1 rejected cleanly
      const badSchemaDir = path.join(h.tempDir, ".pi", "realgoal", "draft", "future-schema")
      await fs.mkdir(badSchemaDir, { recursive: true })
      await fs.writeFile(
        path.join(badSchemaDir, "state.json"),
        JSON.stringify({ ...recovered.state, schemaVersion: 99 }),
        "utf8",
      )
      const badSchemaLoad = await h.runtime.runPromise(
        Effect.result(
          PersistenceService.use((p) => p.loadWorkItemBySafeDir(h.tempDir, ".pi", "future-schema")),
        ),
      )
      expect(badSchemaLoad._tag).toBe("Failure")

      const secretReject = await h.runtime.runPromise(
        Effect.result(
          ConfigService.use((cfg) =>
            cfg.decodeAndValidateLayer(JSON.stringify({ apiKey: "sk-secret" }), "test"),
          ),
        ),
      )
      expect(secretReject._tag).toBe("Failure")

      const multiWriterReject = await h.runtime.runPromise(
        Effect.result(
          ConfigService.use((cfg) =>
            cfg.decodeAndValidateLayer(
              JSON.stringify({ execution: { maxConcurrentWriters: 2 } }),
              "test",
            ),
          ),
        ),
      )
      expect(multiWriterReject._tag).toBe("Failure")
    } finally {
      await h.cleanup()
    }
  })

  test("D11 & D12: Unicode/spaces/Windows reserved names/case collisions/junction confinement, Windows shell quoting, and /realgoal doctor diagnostics", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "realgoal-paths-"))
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "realgoal-outside-"))
    try {
      // D11: Unicode, spaces, Windows reserved device names, case-insensitive collisions
      const unicodeStem = await Effect.runPromise(sanitizeTaskStem("計画: Auth Café 🚀 / v2"))
      expect(unicodeStem.length).toBeGreaterThan(0)
      expect(unicodeStem.includes("/")).toBe(false)

      const reservedStem = await Effect.runPromise(sanitizeTaskStem("CON"))
      expect(reservedStem.startsWith("task-con-")).toBe(true)

      const draftsDir = path.join(tmpRoot, "drafts")
      await fs.mkdir(draftsDir, { recursive: true })
      const stem1 = await Effect.runPromise(allocateUniqueSafeDirName(draftsDir, "Auth Flow", "rg_111111"))
      await fs.mkdir(path.join(draftsDir, stem1))
      const stem2 = await Effect.runPromise(allocateUniqueSafeDirName(draftsDir, "auth flow", "rg_222222"))
      expect(stem1.toLowerCase()).not.toBe(stem2.toLowerCase())

      // Symlink / junction escape blocked by resolveWithinRoot & checkWorkerWriteAllowed
      await fs.writeFile(path.join(outsideDir, "secret.txt"), "top-secret", "utf8")
      const linkPath = path.join(draftsDir, "escape-link")
      const symlinkType = process.platform === "win32" ? "junction" : "dir"
      await fs.symlink(outsideDir, linkPath, symlinkType)

      const escapeAttempt = await Effect.runPromise(
        Effect.result(resolveWithinRoot(draftsDir, "escape-link/secret.txt")),
      )
      expect(escapeAttempt._tag).toBe("Failure")

      const workerEscapeAllowed = await Effect.runPromise(
        checkWorkerWriteAllowed(tmpRoot, [draftsDir], path.join(linkPath, "pwned.txt")),
      )
      expect(workerEscapeAllowed).toBe(false)

      // Windows/POSIX worker command builder quotes paths with spaces safely and sets --no-extensions --no-mcp
      const cmd = buildSafeWorkerCommand({
        piExecutable: "C:\\Users\\My User\\bin\\pi.exe",
        workerExtensionPath: "C:\\Users\\My User\\realgoal\\extensions\\worker-entry.ts",
        resolvedModel: {
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
          requestedThinking: "medium",
          effectiveThinking: "medium",
          thinkingClamped: false,
          resolutionSource: "parent_inherit",
        },
        allowedTools: ["read", "realgoal_worker_result"],
        requestPath: "C:\\Users\\My User\\draft\\workers\\W001\\request.json",
        resultPath: "C:\\Users\\My User\\draft\\workers\\W001\\result.json",
        promptPath: "C:\\Users\\My User\\draft\\workers\\W001\\prompt.md",
        transcriptPath: "C:\\Users\\My User\\draft\\workers\\W001\\events.jsonl",
        stderrPath: "C:\\Users\\My User\\draft\\workers\\W001\\stderr.log",
        role: "verification",
      })
      expect(cmd).toContain("--mode json")
      expect(cmd).toContain("--no-session")
      expect(cmd).toContain("--no-extensions")
      expect(cmd).toContain("--no-mcp")
      expect(posixShellQuote("a'b c")).toBe("'a'\\''b c'")
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
      await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => undefined)
    }

    // D12: Doctor reports BLOCKED when realtasks is missing, and HEALTHY/DEGRADED when realtasks is active
    const hMissing = await createPiTestHarness({
      includeRealtasks: false,
      preExistingCommands: ["goal"],
    })
    try {
      await hMissing.invokeCommand("realgoal", "doctor")
      const doctorNotice = String(hMissing.sentMessages[hMissing.sentMessages.length - 1]?.content ?? "")
      expect(doctorNotice).toContain("BLOCKED")
      expect(doctorNotice).toContain("Missing required realtasks tools")
      expect(doctorNotice).toContain("goal")
    } finally {
      await hMissing.cleanup()
    }

    const hHealthy = await createPiTestHarness({ includeRealtasks: true })
    try {
      await hHealthy.invokeCommand("realgoal", "doctor")
      const healthyNotice = String(hHealthy.sentMessages[hHealthy.sentMessages.length - 1]?.content ?? "")
      expect(healthyNotice).toContain("All required tools present")
      expect(healthyNotice).toContain("Loopback preview HTTP server")
    } finally {
      await hHealthy.cleanup()
    }
  })
})
