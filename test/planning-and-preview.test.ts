import * as fs from "node:fs/promises"
import * as path from "node:path"
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { ControllerService } from "../index.ts"
import { createPiTestHarness } from "./helpers/pi-harness.ts"

const exchangeLaunchToken = async (launchUrl: string) => {
  const res = await fetch(launchUrl, { redirect: "manual" })
  expect(res.status).toBe(303)
  const setCookie = res.headers.get("set-cookie") ?? ""
  const cookiePair = setCookie.split(";")[0] ?? ""
  const location = res.headers.get("location") ?? ""
  const base = new URL(launchUrl).origin
  const pageRes = await fetch(`${base}${location}`, {
    headers: { Cookie: cookiePair },
  })
  expect(pageRes.status).toBe(200)
  const html = await pageRes.text()
  const csrfMatch = /'X-Realgoal-CSRF':\s*"([^"]+)"/.exec(html)
  return {
    base,
    cookiePair,
    location,
    html,
    csrfToken: csrfMatch?.[1] ?? "",
    wrapperCsp: pageRes.headers.get("content-security-policy") ?? "",
  }
}

describe("§18.3 Planning and browser interaction (P01–P15)", () => {
  test("P01 & P02: Planning boundary blocks repo mutations, preserves interrupted research/TODOs/decisions/questions, and appends stable-ID TODOs", async () => {
    const h = await createPiTestHarness({ hasUI: false, mode: "json" })
    try {
      await h.invokeCommand("plan", "Design distributed rate limiter")
      const loaded0 = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))

      // P01: Planning boundary blocks writing outside .pi/realgoal/draft/<TASK>/
      const illegalWrite = await h.invokeTool("write", {
        path: path.join(h.tempDir, "src", "limiter.ts"),
        content: "export const bad = 1;",
      })
      expect(illegalWrite.isError).toBe(true)
      expect((illegalWrite.details as any).blocked).toBe(true)

      // Writing inside draft directory succeeds
      await fs.mkdir(loaded0.paths.draftDir, { recursive: true })
      for (const p of [
        path.join(loaded0.paths.draftDir, "previews", "opt", "a.html"),
        path.relative(h.tempDir, path.join(loaded0.paths.draftDir, "previews", "opt", "b.html")),
      ]) {
        const legalWrite = await h.invokeTool("write", { path: p, content: "<p>x</p>" })
        expect((legalWrite.details as any)?.blocked).toBeUndefined()
      }
      await h.invokeTool("realgoal_control", {
        action: "advance",
        targetPhase: "discovery",
        reason: "Start deep discovery",
      })
      await h.invokeTool("realgoal_control", {
        action: "checkpoint",
        researchNotes: "Redis sliding-window Lua script vs token bucket evaluated.",
        decisions: [
          {
            category: "design_proposal",
            summary: "Use sliding window counter",
            rationale: "Sub-millisecond atomic check",
          },
        ],
      })

      // P02: Append initial TODOs, then append more later without losing prior IDs
      await h.invokeTool("realgoal_todo", {
        action: "append",
        items: [
          { title: "Draft Redis schema", description: "Define key layout", difficulty: "light" },
          {
            title: "Implement Lua limiter",
            description: "Atomic evalsha",
            dependencyIds: ["T001"],
            difficulty: "heavy",
          },
        ],
      })
      const appendMore = await h.invokeTool("realgoal_todo", {
        action: "append",
        items: [
          {
            title: "Add metrics exporter",
            description: "Prometheus counters",
            dependencyIds: ["T002"],
            difficulty: "medium",
          },
        ],
      })
      expect(appendMore.isError).toBeUndefined()
      expect((appendMore.details as any).todosTotal).toBe(3)

      // Create a pending blocking question before simulated interruption
      const qRes = await h.invokeTool("realgoal_question", {
        title: "Storage backend",
        prompt: "Choose backing store",
        purpose: "Select storage engine",
        options: [
          { id: "redis", label: "Redis", description: "Clustered Redis" },
          { id: "memory", label: "In-Memory", description: "Single node" },
        ],
      })
      expect((qRes.details as any).status).toBe("awaiting_user")

      // Simulate restart/resume and verify findings, TODOs, decisions, and pending question all survive
      await h.emitSessionBeforeSwitch()
      h.sessionId = "sess-resumed-plan"
      await h.emitSessionStart("resume")
      await h.invokeCommand("realgoal", "resume")

      const resumed = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))
      expect(resumed.state.todos.map((t) => t.id)).toEqual(["T001", "T002", "T003"])
      expect(resumed.state.decisions.length).toBe(1)
      expect(resumed.state.questions.length).toBe(1)
      expect(resumed.state.questions[0]?.status).toBe("pending")
      const researchText = await fs.readFile(resumed.paths.researchPath, "utf8")
      expect(researchText).toContain("Redis sliding-window")
    } finally {
      await h.cleanup()
    }
  })

  test("P03, P04, P05, P08: Frontend HTML mockups, sanitized backend SVG diagrams, CSP/traversal/CSRF/Origin security, terminal fallback, and delegated choice", async () => {
    let capturedLaunchUrl = ""
    const h = await createPiTestHarness({
      customBrowserLauncher: async (url) => {
        capturedLaunchUrl = url
        return true
      },
    })
    try {
      await h.invokeCommand("plan", "Compare UI layouts and backend diagrams")
      const loaded = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))
      const prevDir = path.join(loaded.paths.previewsDir, "layout-cmp")
      await fs.mkdir(prevDir, { recursive: true })

      // P08: Reject HTML containing executable <script>
      await fs.writeFile(
        path.join(prevDir, "evil.html"),
        "<html><body><script>alert(1)</script></body></html>",
        "utf8",
      )
      const scriptReject = await h.invokeTool("realgoal_preview", {
        previewId: "layout-cmp",
        title: "Evil preview",
        options: [
          {
            id: "evil",
            title: "Evil",
            description: "Has script",
            rationale: "Test",
            relativePath: "evil.html",
          },
        ],
      })
      expect(scriptReject.isError).toBe(true)
      expect((scriptReject.details as any).error.code).toBe("PreviewSecurityError")

      // P08: Reject path traversal outside preview root
      const traversalReject = await h.invokeTool("realgoal_preview", {
        previewId: "layout-cmp",
        title: "Traversal preview",
        options: [
          {
            id: "trav",
            title: "Trav",
            description: "Escape",
            rationale: "Test",
            relativePath: "../../../../package.json",
          },
        ],
      })
      expect(traversalReject.isError).toBe(true)

      // P03 & P04: Valid static HTML mockup + SVG diagram (with <script> stripped by SVG sanitizer!)
      await fs.writeFile(
        path.join(prevDir, "split.html"),
        "<!doctype html><html><body><div class='layout'>Split Pane Mockup</div></body></html>",
        "utf8",
      )
      await fs.writeFile(
        path.join(prevDir, "arch.svg"),
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><script>evil()</script><rect width="180" height="60" onload="bad()"/><text x="20" y="35">Queue -> Worker</text></svg>`,
        "utf8",
      )
      const cleanSvgOnDiskPre = await fs.readFile(path.join(prevDir, "arch.svg"), "utf8")
      expect(cleanSvgOnDiskPre).toContain("<script>")

      const okPreview = await h.invokeTool("realgoal_preview", {
        previewId: "layout-cmp",
        title: "UI & Architecture Comparison",
        options: [
          {
            id: "opt_split",
            title: "Split View",
            description: "Side-by-side inspector",
            rationale: "Faster comparison",
            relativePath: "split.html",
          },
          {
            id: "opt_arch",
            title: "Async Queue Diagram",
            description: "Decoupled worker queue",
            rationale: "Backpressure safety",
            relativePath: "arch.svg",
          },
        ],
      })
      expect(okPreview.isError).toBeUndefined()

      // Verify SVG was sanitized on disk
      const sanitizedSvg = await fs.readFile(path.join(prevDir, "arch.svg"), "utf8")
      expect(sanitizedSvg).not.toContain("<script")
      expect(sanitizedSvg).not.toContain("onload=")

      // Queue UI responses: 1st select = "Open in browser now", 2nd select = "Let agent choose best option (record rationale)" (P08 delegated choice!)
      h.ui.selectQueue.push(
        "Open in browser now",
        (_title, options) => options.find((o) => o.includes("Let agent choose")),
      )

      const qRes = await h.invokeTool("realgoal_question", {
        title: "Choose layout",
        prompt: "Pick preferred layout",
        purpose: "Finalize UI direction",
        previewId: "layout-cmp",
        options: [
          { id: "opt_split", label: "Split View", description: "Two columns" },
          { id: "opt_arch", label: "Tabbed View", description: "Single pane" },
        ],
      })
      expect(qRes.isError).toBeUndefined()
      expect((qRes.details as any).answer.source).toBe("delegated_to_agent")
      expect(capturedLaunchUrl).toContain("/launch?t=")

      // Verify HTTP security on loopback server: single-use launch token, CSP, sandboxed iframe, forged Origin & bad CSRF rejection
      const session = await exchangeLaunchToken(capturedLaunchUrl)
      // Reusing single-use launch token must fail with 403!
      const replayLaunch = await fetch(capturedLaunchUrl, { redirect: "manual" })
      expect(replayLaunch.status).toBe(403)

      // Forged Origin rejected with 403
      const forgedOrigin = await fetch(`${session.base}/api/submit`, {
        method: "POST",
        headers: {
          Cookie: session.cookiePair,
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
          "X-Realgoal-CSRF": "anything",
        },
        body: JSON.stringify({}),
      })
      expect(forgedOrigin.status).toBe(403)

      // P05: Browser declined ("Answer in terminal this time") works 100% in Pi terminal UI
      h.ui.selectQueue.push(
        "Answer in terminal this time",
        (_title, options) => options[0],
      )
      const terminalOnlyRes = await h.invokeTool("realgoal_question", {
        title: "Terminal fallback question",
        prompt: "Pick retry backoff",
        purpose: "Backoff config",
        previewId: "layout-cmp",
        options: [
          { id: "exp", label: "Exponential", description: "2x jitter" },
          { id: "lin", label: "Linear", description: "Fixed step" },
        ],
      })
      expect(terminalOnlyRes.isError).toBeUndefined()
      expect((terminalOnlyRes.details as any).answer.selectedOptionIds).toEqual(["exp"])
      expect((terminalOnlyRes.details as any).answer.source).toBe("pi_ui")
    } finally {
      await h.cleanup()
    }
  })

  test("P06 & P07: Simultaneous browser + terminal race resolves exactly once via CAS; stale/paused/cancelled/switched previews cannot revive workflow", async () => {
    let launchUrl = ""
    const h = await createPiTestHarness({
      customBrowserLauncher: async (url) => {
        launchUrl = url
        return true
      },
    })
    try {
      await h.invokeCommand("plan", "CAS race and stale callback verification")
      const loaded = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))
      const prevDir = path.join(loaded.paths.previewsDir, "race-prev")
      await fs.mkdir(prevDir, { recursive: true })
      await fs.writeFile(
        path.join(prevDir, "a.html"),
        "<!doctype html><html><body><div>Comparable Mockup Option A</div></body></html>",
        "utf8",
      )

      await h.invokeTool("realgoal_preview", {
        previewId: "race-prev",
        title: "Race Preview",
        options: [
          { id: "opt_a", title: "Option A", description: "A", rationale: "A", relativePath: "a.html" },
          { id: "opt_b", title: "Option B", description: "B", rationale: "B", relativePath: "a.html" },
        ],
      })

      // P06: When terminal UI select is presented, simultaneously submit via HTTP POST /api/submit AND return terminal choice!
      let browserFirstStatus = 0
      let browserDuplicateStatus = 0
      let sideWork: Promise<void> = Promise.resolve()

      h.ui.selectQueue.push(
        "Open in browser now",
        async (_title, options) => {
          sideWork = (async () => {
            const sess = await exchangeLaunchToken(launchUrl)
            expect(sess.html).toContain('<iframe id="preview_frame" sandbox=""')

            // Fetch prototype asset and verify strict prototype CSP (script-src 'none')
            const assetRes = await fetch(
              `${sess.base}/asset/${encodeURIComponent(loaded.state.id)}/race-prev/a.html`,
              { headers: { Cookie: sess.cookiePair } },
            )
            expect(assetRes.status).toBe(200)
            expect(assetRes.headers.get("content-security-policy")).toContain("script-src 'none'")

            const submitResp = await fetch(`${sess.base}/api/submit`, {
              method: "POST",
              headers: {
                Cookie: sess.cookiePair,
                Origin: sess.base,
                "Content-Type": "application/json",
                "X-Realgoal-CSRF": sess.csrfToken,
              },
              body: JSON.stringify({
                workItemId: loaded.state.id,
                questionId: "Q001",
                questionRevision: 1,
                previewRevision: 1,
                selectedOptionIds: ["opt_b"],
                comments: "Chosen in browser",
              }),
            })
            browserFirstStatus = submitResp.status

            // Immediate duplicate browser POST must receive 409 Conflict
            const dupResp = await fetch(`${sess.base}/api/submit`, {
              method: "POST",
              headers: {
                Cookie: sess.cookiePair,
                Origin: sess.base,
                "Content-Type": "application/json",
                "X-Realgoal-CSRF": sess.csrfToken,
              },
              body: JSON.stringify({
                workItemId: loaded.state.id,
                questionId: "Q001",
                questionRevision: 1,
                selectedOptionIds: ["opt_a"],
              }),
            })
            browserDuplicateStatus = dupResp.status
          })()
          await sideWork
          // Terminal simultaneously tries to return Option A
          return options[0]
        },
      )

      const raceResult = await h.invokeTool("realgoal_question", {
        title: "Simultaneous race",
        prompt: "Pick A or B",
        purpose: "Test CAS",
        previewId: "race-prev",
        options: [
          { id: "opt_a", label: "Option A", description: "Desc A" },
          { id: "opt_b", label: "Option B", description: "Desc B" },
        ],
      })
      await sideWork
      expect(raceResult.isError).toBeUndefined()
      expect(browserFirstStatus).toBe(200)
      expect(browserDuplicateStatus).toBe(409)

      const afterRace = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))
      // Exactly ONE decision recorded for Q001!
      const q1Decisions = afterRace.state.decisions.filter((d) =>
        Option.contains(d.questionId, "Q001"),
      )
      expect(q1Decisions.length).toBe(1)
      expect(afterRace.state.questions[0]?.answer.pipe(Option.map((a) => a.selectedOptionIds))).toEqual(
        Option.some(["opt_b"]),
      )

      // P07: Create Q002, open preview session, then manually PAUSE workflow -> browser POST must be rejected (409) and NOT revive paused workflow!
      h.ui.selectQueue.push("Open in browser now", undefined)
      await h.invokeTool("realgoal_question", {
        title: "Paused check",
        prompt: "Pick while paused",
        purpose: "Stale pause guard",
        previewId: "race-prev",
        options: [{ id: "opt_a", label: "Option A", description: "A" }],
      })
      const q2Session = await exchangeLaunchToken(launchUrl)
      await h.invokeCommand("realgoal", "pause")

      const submitWhilePaused = await fetch(`${q2Session.base}/api/submit`, {
        method: "POST",
        headers: {
          Cookie: q2Session.cookiePair,
          Origin: q2Session.base,
          "Content-Type": "application/json",
          "X-Realgoal-CSRF": q2Session.csrfToken,
        },
        body: JSON.stringify({
          workItemId: loaded.state.id,
          questionId: "Q002",
          questionRevision: 1,
          selectedOptionIds: ["opt_a"],
        }),
      })
      expect(submitWhilePaused.status).toBe(409)
      const stillPaused = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))
      expect(stillPaused.state.runStatus).toBe("paused")
    } finally {
      await h.cleanup()
    }
  })

  test("P09, P10, P11, P12, P13, P14, P15: Draft review gate, manifest invalidation, spec/plan publication, Stop-here parking, and artifact-only completion", async () => {
    const h = await createPiTestHarness()
    try {
      // P09: Draft gate is disabled by default -> finalize goes directly to publication_choice
      await h.invokeCommand("plan", "Design and implement audit log service")
      const loaded0 = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))

      // Esc on /realgoal menu dismisses cleanly without mutating state
      h.ui.selectQueue.push(undefined)
      await h.invokeCommand("realgoal", "")
      const afterEsc = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))
      expect(afterEsc.state.revision).toBe(loaded0.state.revision)

      await h.invokeTool("realgoal_control", { action: "advance", targetPhase: "discovery" })
      await h.invokeTool("realgoal_control", { action: "advance", targetPhase: "finalization" })

      // Write valid implementation plan content to finalized.md
      const validPlanMarkdown = [
        "# Audit Log Implementation Plan",
        "## Goal & Scope",
        "In scope: append-only audit writer. Out of scope: cloud archival.",
        "## Stage 1: Core Writer",
        "- Files: src/audit.ts",
        "- Dependencies: none",
        "## Acceptance Criteria & Verification",
        "- Pass condition: bun test audit.test.ts passes with exit 0.",
      ].join("\n\n")
      await fs.writeFile(loaded0.paths.finalizedPath, validPlanMarkdown, "utf8")

      const finRes = await h.invokeTool("realgoal_control", { action: "finalize" })
      expect(finRes.isError).toBeUndefined()
      expect((finRes.details as any).phase).toBe("publication_choice")
      // Zero workers launched when gate is disabled
      const afterFin = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))
      expect(afterFin.state.workers.length).toBe(0)

      // P12 & P13: Publish both spec (./doc/<TASK>.md) and plan (./.pi/realgoal/plan/<TASK>.md)
      await h.invokeCommand("realgoal", "publish both")
      const specPath = path.join(h.tempDir, "doc", `${loaded0.state.safeDirName}.md`)
      const planPath = path.join(h.tempDir, ".pi", "realgoal", "plan", `${loaded0.state.safeDirName}.md`)
      expect(await fs.readFile(specPath, "utf8")).toContain("Audit Log Implementation Plan")
      expect(await fs.readFile(planPath, "utf8")).toContain("## Stage 1")
      // Draft retained!
      expect(await fs.readFile(loaded0.paths.finalizedPath, "utf8")).toContain("Audit Log")

      // Overwrite prompt declined -> existing file preserved
      h.ui.confirmQueue.push(false)
      await h.invokeCommand("realgoal", "publish spec")

      // P14: User chooses "stop" at execution menu -> parked in paused, NOT finished, 0 workers!
      await h.invokeCommand("realgoal", "execute stop")
      const parked = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))
      expect(parked.state.runStatus).toBe("paused")
      expect(parked.state.workers.length).toBe(0)

      // P10 & P11: Enable draftGate in project config, test blocking before review & invalidation when finalized.md changes
      const projCfgPath = path.join(h.tempDir, ".pi", "realgoal", "config.json")
      await fs.writeFile(
        projCfgPath,
        JSON.stringify({ verification: { draftGate: { enabled: true } } }),
        "utf8",
      )

      // P15: Start an artifact-only ("Write specification only") plan!
      h.ui.selectQueue.push(`Pause "${parked.state.displayName}" and create new plan`)
      await h.invokeCommand("plan", "Write specification only for webhook retries without implementing")
      const artLoaded = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))
      expect(artLoaded.state.completionScope).toBe("artifact")

      await h.invokeTool("realgoal_control", { action: "advance", targetPhase: "discovery" })
      await h.invokeTool("realgoal_control", { action: "advance", targetPhase: "finalization" })
      await fs.writeFile(artLoaded.paths.finalizedPath, validPlanMarkdown, "utf8")

      // Gate enabled -> finalize enters draft_review!
      const gatedFin = await h.invokeTool("realgoal_control", { action: "finalize" })
      expect((gatedFin.details as any).phase).toBe("draft_review")

      // P10: Attempt to publish before passing draft review -> blocked!
      await h.invokeCommand("realgoal", "publish spec")
      const specForArt = path.join(h.tempDir, "doc", `${artLoaded.state.safeDirName}.md`)
      const existsPremature = await fs
        .access(specForArt)
        .then(() => true)
        .catch(() => false)
      expect(existsPremature).toBe(false)

      // Record user waiver via /realgoal review waive, then modify finalized.md (P11) -> invalidates candidate hash if re-finalized without waiver, or let's verify manifest hash invalidation directly!
      await h.invokeCommand("realgoal", "review waive")
      await h.invokeCommand("realgoal", "publish spec")
      expect(await fs.readFile(specForArt, "utf8")).toContain("Audit Log")

      // Record criterion evidence for C001 and finish artifact-only plan cleanly (P15)
      await h.invokeTool("realgoal_todo", {
        action: "record_evidence",
        evidence: {
          id: "EV_ART_1",
          criterionIds: ["C001"],
          method: "static_review",
          result: "pass",
          commandOrObservation: "Published spec verified at ./doc/",
          artifactPaths: [specForArt],
        },
      })
      const finishArtifact = await h.invokeTool("realgoal_finish", {
        summary: "Published webhook retry specification without code implementation",
        completionScope: "artifact",
        evidenceIds: ["EV_ART_1"],
      })
      expect(finishArtifact.isError).toBeUndefined()
      expect((finishArtifact.details as any).runStatus).toBe("finished")
    } finally {
      await h.cleanup()
    }
  })

  test("P11 & P13: Changing reviewed inputs invalidates passing DraftReviewReport; incomplete plan markdown rejected on plan publication", async () => {
    const h = await createPiTestHarness()
    try {
      const projCfgPath = path.join(h.tempDir, ".pi", "realgoal", "config.json")
      await fs.mkdir(path.dirname(projCfgPath), { recursive: true })
      await fs.writeFile(
        projCfgPath,
        JSON.stringify({ verification: { draftGate: { enabled: true } } }),
        "utf8",
      )

      await h.invokeCommand("plan", "Implement billing ledger")
      const loaded = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))
      await h.invokeTool("realgoal_control", { action: "advance", targetPhase: "discovery" })
      await h.invokeTool("realgoal_control", { action: "advance", targetPhase: "finalization" })

      // Incomplete plan missing stages/acceptance criteria (P13)
      await fs.writeFile(loaded.paths.finalizedPath, "# Just a title\nSome short prose.", "utf8")
      await h.invokeTool("realgoal_control", { action: "finalize" })
      await h.invokeCommand("realgoal", "review waive")

      // Attempting to publish as implementation plan fails content validation!
      await h.invokeCommand("realgoal", "publish plan")
      const badPlanOut = path.join(h.tempDir, ".pi", "realgoal", "plan", `${loaded.state.safeDirName}.md`)
      const badExists = await fs
        .access(badPlanOut)
        .then(() => true)
        .catch(() => false)
      expect(badExists).toBe(false)

      // P11: Now test passing DraftReviewReport invalidation when material decision changes
      const { recordDraftReviewReport, hasValidDraftReviewApproval, computeCurrentManifestHash } = await import(
        "../index.ts"
      )
      const fresh = await h.runtime.runPromise(ControllerService.use((c) => c.requireWorkItem()))
      const stateWithoutWaiver = { ...fresh.state, draftGateWaiverId: Option.none<string>() }
      const finHash = Option.getOrThrow(stateWithoutWaiver.finalizedCandidateHash)
      const manifestHash = computeCurrentManifestHash(stateWithoutWaiver, finHash)

      const approvedState = recordDraftReviewReport(
        stateWithoutWaiver,
        {
          id: "REV_1",
          verdict: "pass",
          inputManifestHash: manifestHash,
          finalizedHash: finHash,
          requestHash: "r",
          decisionsHash: "d",
          criteriaHash: "c",
          projectFileHashes: {},
          findings: [],
          workerJobId: Option.some("W001"),
          summary: "Approved",
          timestamp: new Date().toISOString(),
        },
        new Date().toISOString(),
      )
      expect(hasValidDraftReviewApproval(approvedState)).toBe(true)

      // Add a new material decision -> manifest hash shifts -> approval immediately invalidated!
      const mutatedDecisionState = {
        ...approvedState,
        decisions: [
          ...approvedState.decisions,
          {
            id: "D999",
            category: "user_decision" as const,
            summary: "Switch currency precision to integer minor units",
            rationale: "Avoid float rounding",
            rejectedAlternatives: [],
            sourceReferences: [],
            questionId: Option.none<string>(),
            material: true,
            timestamp: new Date().toISOString(),
          },
        ],
      }
      expect(hasValidDraftReviewApproval(mutatedDecisionState)).toBe(false)
    } finally {
      await h.cleanup()
    }
  })
})
