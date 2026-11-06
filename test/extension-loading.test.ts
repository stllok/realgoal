import * as fs from "node:fs/promises"
import * as path from "node:path"
import { describe, expect, test } from "bun:test"
import {
  createEventBus,
  createExtensionRuntime,
  loadSkillsFromDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"
import { ControllerService, createRealgoalExtension, makeRealgoalRuntime } from "../index.ts"
import { createPiTestHarness } from "./helpers/pi-harness.ts"

describe("Extension loading lifecycle", () => {
  test("factory loads with Pi's uninitialized action methods", async () => {
    const runtime = makeRealgoalRuntime()
    try {
      const piRuntime = createExtensionRuntime()
      const extension = await loadExtensionFromFactory(
        (pi) => { createRealgoalExtension({ runtime })(pi) },
        path.resolve(import.meta.dir, ".."),
        createEventBus(),
        piRuntime,
      )
      expect(extension.tools.size).toBeGreaterThan(0)
      expect(extension.handlers.has("session_start")).toBe(true)
      expect(extension.commands.size).toBe(0)

      // Simulate runtime binding and a conflicting extension loaded after us.
      piRuntime.getCommands = () => [{
        name: "goal",
        description: "Existing goal",
        source: "extension",
        sourceInfo: extension.sourceInfo,
      }]
      const registerCommands = extension.handlers.get("session_start")![0]!
      await registerCommands({ type: "session_start", reason: "startup" }, {} as ExtensionContext)
      expect([...extension.commands.keys()]).toEqual(["plan", "realgoal"])
      const memory = await runtime.runPromise(ControllerService.use((c) => c.getMemory()))
      expect(memory.commandCollisions).toEqual(["goal"])

      // Later starts must not re-query or re-register our own commands.
      piRuntime.getCommands = () => { throw new Error("Command registration repeated") }
      await registerCommands({ type: "session_start", reason: "resume" }, {} as ExtensionContext)
      expect([...extension.commands.keys()]).toEqual(["plan", "realgoal"])
    } finally {
      await runtime.dispose()
    }
  })

  test("startup preserves existing goal and plan commands", async () => {
    const h = await createPiTestHarness({ preExistingCommands: ["goal", "plan"] })
    try {
      await h.invokeCommand("goal", "Must not start a workflow")
      await h.invokeCommand("plan", "Must not start a workflow")
      expect(h.sentUserMessages).toEqual([])
      const memory = await h.runtime.runPromise(ControllerService.use((c) => c.getMemory()))
      expect(memory.commandCollisions).toEqual(["goal", "plan"])
      await h.emitSessionStart("resume")
      const resumed = await h.runtime.runPromise(ControllerService.use((c) => c.getMemory()))
      expect(resumed.commandCollisions).toEqual(["goal", "plan"])
      await h.invokeCommand("realgoal", "goal Start through the namespaced command")
      expect(h.sentUserMessages.length).toBe(1)
    } finally {
      await h.cleanup()
    }
  })

  test("repeated session_start does not mistake Realgoal's own commands for collisions", async () => {
    const h = await createPiTestHarness()
    try {
      await h.emitSessionStart("new")
      const memory = await h.runtime.runPromise(ControllerService.use((c) => c.getMemory()))
      expect(memory.commandCollisions).toEqual([])
      await h.invokeCommand("goal", "Start after session replacement")
      expect(h.sentUserMessages.length).toBe(1)
    } finally {
      await h.cleanup()
    }
  })

  test("exposes tool prompt metadata, phase-aware active context, and valid bundled skill", async () => {
    const repoRoot = path.resolve(import.meta.dir, "..")
    const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      files: string[]
      pi: { skills?: string[] }
    }
    expect(pkg.files).toContain("skills/")
    expect(pkg.pi.skills).toEqual(["./skills"])

    const loadedSkills = loadSkillsFromDir({ dir: path.join(repoRoot, "skills"), source: "test" })
    expect(loadedSkills.diagnostics).toEqual([])
    expect(loadedSkills.skills.map((s) => s.name)).toEqual(["realgoal"])

    const runtime = makeRealgoalRuntime()
    try {
      const extension = await loadExtensionFromFactory(
        (pi) => { createRealgoalExtension({ runtime })(pi) },
        repoRoot,
        createEventBus(),
        createExtensionRuntime(),
      )
      for (const [, registered] of extension.tools) {
        expect(registered.definition.promptSnippet?.length).toBeGreaterThan(10)
      }
      const ctrlDef = extension.tools.get("realgoal_control")!.definition
      expect(ctrlDef.promptGuidelines?.length).toBeGreaterThan(0)
      const targetPhaseSchema = (ctrlDef.parameters as { properties: Record<string, { anyOf?: unknown[] }> }).properties["targetPhase"]
      expect(targetPhaseSchema?.anyOf?.length).toBe(16)
    } finally {
      await runtime.dispose()
    }

    const h = await createPiTestHarness()
    try {
      await h.invokeCommand("plan", "Design a modular IRC client")
      const injected = await h.emitBeforeAgentStart("continue")
      const content = String(injected?.message?.content ?? "")
      expect(content).toContain("Legal Next Phases: discovery, design, analysis")
      expect(content).toContain("Phase Contract:")
      expect(content).toContain("Do NOT read Realgoal extension source code")
    } finally {
      await h.cleanup()
    }
  })
})
