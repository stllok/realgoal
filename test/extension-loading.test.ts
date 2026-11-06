import * as path from "node:path"
import { describe, expect, test } from "bun:test"
import { createEventBus, createExtensionRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent"
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
})
