import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  AgentToolResult,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  InputEventResult,
  RegisteredCommand,
  SessionBoundaryDraft,
  SlashCommandInfo,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { createRealgoalExtension, makeRealgoalRuntime, type RealgoalRuntime } from "../../index.ts"

type ExtensionMode = ExtensionContext["mode"]

export interface MockUiController {
  selectQueue: Array<string | undefined | ((title: string, options: string[]) => string | undefined | Promise<string | undefined>)>
  confirmQueue: Array<boolean>
  inputQueue: Array<string | undefined>
  notifications: Array<{ readonly message: string; readonly type: string }>
  statuses: Map<string, string | undefined>
  widgets: Map<string, readonly string[] | undefined>
}

export interface MockTaskRecord {
  id: string
  label: string
  status: "running" | "completed" | "failed" | "timed_out" | "stopped" | "lost"
  exitCode?: number
  output: string
  cursor: number
  peekCalls: number
  consumingCalls: number
  notify: "wake" | "passive" | "silent"
  readyMessage?: string
}

export interface PiTestHarness {
  readonly tempDir: string
  readonly agentDir: string
  readonly runtime: RealgoalRuntime
  readonly ui: MockUiController
  readonly tasks: Map<string, MockTaskRecord>
  readonly stopCalls: Array<{ readonly id: string }>
  readonly sentMessages: Array<{ readonly customType: string; readonly content: unknown; readonly display: boolean }>
  readonly sentUserMessages: Array<string>
  sessionId: string
  mode: ExtensionMode
  hasUI: boolean
  isTrusted: boolean
  idle: boolean
  activeTools: string[]
  model: {
    provider: string
    id: string
    reasoning: boolean
    thinkingLevelMap?: Record<string, string | null | undefined>
  }
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  registeredProviders: string[]
  unauthenticatedModels: Set<string>
  mockStreamSimple:
    | ((model: any, context: any, options: any) => Promise<any> | any)
    | undefined
  readonly registerExtraHandler: (event: string, fn: (ev: any, ctx: any) => any) => void
  readonly invokeCommand: (name: string, args?: string, signal?: AbortSignal) => Promise<void>
  readonly invokeTool: (
    name: string,
    params: Record<string, unknown>,
    opts?: { toolCallId?: string; parentToolCallId?: string; signal?: AbortSignal },
  ) => Promise<AgentToolResult<any>>
  readonly emitSessionStart: (reason?: "startup" | "reload" | "new" | "resume" | "fork", signal?: AbortSignal) => Promise<void>
  readonly emitAgentStart: () => Promise<void>
  readonly emitAgentEnd: () => Promise<void>
  readonly emitInput: (text: string, source?: "interactive" | "rpc" | "extension") => Promise<InputEventResult>
  readonly emitBeforeAgentStart: (prompt?: string, signal?: AbortSignal) => Promise<BeforeAgentStartEventResult | undefined>
  readonly emitMessageEnd: (message: Record<string, unknown>, signal?: AbortSignal) => Promise<void>
  readonly emitAgentBeforeSettle: (params?: {
    entries?: SessionBoundaryDraft[]
    continue?: boolean
    outcome?: "completed" | "aborted" | "error"
    contextLen?: number
    signal?: AbortSignal
  }) => Promise<AgentBeforeSettleEventResult>
  readonly emitAgentSettled: (aborted?: boolean, signal?: AbortSignal) => Promise<void>
  readonly emitSessionBeforeSwitch: () => Promise<void>
  readonly emitSessionShutdown: (reason?: "quit" | "reload" | "new" | "resume" | "fork") => Promise<void>
  readonly cleanup: () => Promise<void>
}

export const createPiTestHarness = async (options?: {
  readonly includeRealtasks?: boolean
  readonly useRealRealtasks?: boolean
  readonly loadRealtasksAfterRealgoal?: boolean
  readonly preExistingCommands?: ReadonlyArray<string>
  readonly customBrowserLauncher?: (url: string) => Promise<boolean>
  readonly hasUI?: boolean
  readonly mode?: ExtensionMode
  readonly isTrusted?: boolean
  readonly existingTempDir?: string
  readonly sessionId?: string
  readonly keepTempDirOnCleanup?: boolean
}): Promise<PiTestHarness> => {
  const tempDir = options?.existingTempDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "realgoal-test-")))
  const agentDir = path.join(tempDir, ".pi-global-agent")
  await fs.mkdir(agentDir, { recursive: true })
  process.env["PI_CODING_AGENT_DIR"] = agentDir

  const handlers = new Map<string, Array<(ev: any, ctx: any) => any>>()
  const tools = new Map<string, ToolDefinition<any, any, any>>()
  const commands = new Map<string, RegisteredCommand>()

  for (const preCmd of options?.preExistingCommands ?? []) {
    commands.set(preCmd, {
      name: preCmd,
      sourceInfo: { source: "test", scope: "user" } as any,
      description: "Pre-existing command",
      handler: async () => undefined,
    })
  }

  const ui: MockUiController = {
    selectQueue: [],
    confirmQueue: [],
    inputQueue: [],
    notifications: [],
    statuses: new Map(),
    widgets: new Map(),
  }

  const tasks = new Map<string, MockTaskRecord>()
  const stopCalls: Array<{ readonly id: string }> = []
  const sentMessages: Array<{ readonly customType: string; readonly content: unknown; readonly display: boolean }> = []
  const sentUserMessages: string[] = []

  const runtime = makeRealgoalRuntime()

  const harnessState = {
    sessionId: options?.sessionId ?? "sess-test-1",
    mode: (options?.mode ?? "tui") as ExtensionMode,
    hasUI: options?.hasUI ?? true,
    isTrusted: options?.isTrusted ?? true,
    idle: true,
    activeTools: [] as string[],
    model: {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      reasoning: true,
    } as {
      provider: string
      id: string
      reasoning: boolean
      thinkingLevelMap?: Record<string, string | null | undefined>
    },
    thinkingLevel: "medium" as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    registeredProviders: [] as string[],
    unauthenticatedModels: new Set<string>(),
    mockStreamSimple: undefined as
      | ((model: any, context: any, options: any) => Promise<any> | any)
      | undefined,
  }

  const registerMockRealtasks = (api: ExtensionAPI): void => {
    let seq = 1
    api.registerTool({
      name: "bash",
      label: "Bash (Realtasks)",
      description: "Mock realtasks bash",
      parameters: Type.Object({
        command: Type.String(),
        run_in_background: Type.Optional(Type.Boolean()),
        notify: Type.Optional(Type.String()),
        ready: Type.Optional(Type.Object({}, { additionalProperties: true })),
        rtk: Type.Optional(Type.String()),
      }),
      execute: async (_id, params: any): Promise<AgentToolResult<Record<string, unknown>>> => {
        if (params.run_in_background || params.ready) {
          const taskId = `t_bg_${seq++}`
          const notify = (params.notify ?? "wake") as "wake" | "passive" | "silent"
          const rec: MockTaskRecord = {
            id: taskId,
            label: params.command.slice(0, 40),
            status: "running",
            output: "started\n",
            cursor: 0,
            peekCalls: 0,
            consumingCalls: 0,
            notify,
          }
          tasks.set(taskId, rec)
          const text = params.ready
            ? rec.readyMessage ?? `Task ${taskId} is ready (port 3000)`
            : `Started background task ${taskId}`
          return {
            content: [{ type: "text", text }],
            details: {
              taskId,
              status: "running",
              requested: params.command,
              executed: params.command,
            },
          }
        }
        return {
          content: [{ type: "text", text: "sync ok" }],
          details: { requested: params.command, executed: params.command },
        }
      },
    })

    api.registerTool({
      name: "task_output",
      label: "Task Output",
      description: "Mock realtasks task_output",
      parameters: Type.Object({
        id: Type.String(),
        peek: Type.Optional(Type.Boolean()),
      }),
      execute: async (_callId, params: any) => {
        const rec = tasks.get(params.id)
        if (!rec) {
          return {
            content: [{ type: "text", text: `Unknown task: ${params.id}` }],
            details: undefined,
            isError: true,
          }
        }
        if (params.peek) {
          rec.peekCalls += 1
        } else {
          rec.consumingCalls += 1
          rec.cursor = rec.output.length
        }
        return {
          content: [{ type: "text", text: rec.output }],
          details: {
            id: rec.id,
            label: rec.label,
            status: rec.status,
            ...(rec.exitCode !== undefined ? { exitCode: rec.exitCode } : {}),
            cursor: rec.cursor,
          },
        }
      },
    })

    api.registerTool({
      name: "task_wait",
      label: "Task Wait",
      description: "Mock task_wait",
      parameters: Type.Object({ id: Type.String(), timeout_ms: Type.Number() }),
      execute: async (_c, p: any) => ({
        content: [{ type: "text", text: `waited ${p.id}` }],
        details: {},
      }),
    })

    api.registerTool({
      name: "task_stop",
      label: "Task Stop",
      description: "Mock task_stop",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_c, p: any) => {
        stopCalls.push({ id: p.id })
        const rec = tasks.get(p.id)
        if (rec) {
          rec.status = "stopped"
        }
        return {
          content: [{ type: "text", text: `Stopped ${p.id}` }],
          details: { id: p.id, status: "stopped" },
        }
      },
    })

    api.registerTool({
      name: "task_list",
      label: "Task List",
      description: "Mock task_list",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: `${tasks.size} tasks` }],
        details: {},
      }),
    })

    api.registerTool({
      name: "monitor",
      label: "Monitor",
      description: "Mock monitor",
      parameters: Type.Object({ description: Type.String() }),
      execute: async () => ({
        content: [{ type: "text", text: "monitoring" }],
        details: { taskId: `t_mon_${seq++}`, status: "running" },
      }),
    })
  }

  const piApi: ExtensionAPI = {
    on(event: string, handler: any) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const cur = handlers.get(event) ?? []
        handlers.set(
          event,
          cur.filter((h) => h !== handler),
        )
      }
    },
    registerTool(tool: ToolDefinition<any, any, any>) {
      tools.set(tool.name, tool)
      if (!harnessState.activeTools.includes(tool.name)) {
        harnessState.activeTools.push(tool.name)
      }
    },
    registerCommand(name: string, cmd: any) {
      commands.set(name, {
        name,
        sourceInfo: { source: "realgoal", scope: "project" } as any,
        description: cmd.description,
        getArgumentCompletions: cmd.getArgumentCompletions,
        handler: cmd.handler,
      })
    },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag() {
      return undefined
    },
    sendMessage(msg: any) {
      sentMessages.push({
        customType: msg.customType,
        content: msg.content,
        display: Boolean(msg.display),
      })
    },
    sendUserMessage(content: any) {
      sentUserMessages.push(typeof content === "string" ? content : JSON.stringify(content))
    },
    appendEntry() {},
    setSessionName() {},
    getSessionName() {
      return undefined
    },
    setLabel() {},
    getActiveTools() {
      return [...harnessState.activeTools]
    },
    setActiveTools(names: string[]) {
      harnessState.activeTools = [...names]
    },
    getAllTools() {
      return [...tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })) as any
    },
    refreshTools() {},
    getCommands(): SlashCommandInfo[] {
      return [...commands.values()].map((c) => ({
        name: c.name,
        description: c.description ?? "",
        source: "extension",
      })) as any
    },
    getSettings() {
      return {} as any
    },
    async setModel() {
      return true
    },
    getThinkingLevel() {
      return harnessState.thinkingLevel
    },
    setThinkingLevel(lvl: any) {
      harnessState.thinkingLevel = lvl
    },
  } as unknown as ExtensionAPI

  const registerInstalledRealtasks = async (api: ExtensionAPI): Promise<void> => {
    const rtRoot = path.join(os.homedir(), ".pi", "agent", "git", "github.com", "st0nie", "realtasks")
    const stagedRoot = path.join(tempDir, "_realtasks_pkg")
    const repoNodeModules = path.resolve(import.meta.dir, "..", "..", "node_modules")
    const nmLink = path.join(tempDir, "node_modules")
    await fs.symlink(repoNodeModules, nmLink, "junction").catch(() => undefined)
    await fs.mkdir(stagedRoot, { recursive: true })
    await fs.copyFile(path.join(rtRoot, "index.ts"), path.join(stagedRoot, "index.ts"))
    await fs.cp(path.join(rtRoot, "src"), path.join(stagedRoot, "src"), { recursive: true })
    const mod = (await import(pathToFileURL(path.join(stagedRoot, "index.ts")).href)) as {
      default: (pi: ExtensionAPI) => void
    }
    mod.default(api)
  }

  const includeRt = options?.includeRealtasks !== false
  if (includeRt && !options?.loadRealtasksAfterRealgoal) {
    if (options?.useRealRealtasks) {
      await registerInstalledRealtasks(piApi)
    } else {
      registerMockRealtasks(piApi)
    }
  }

  createRealgoalExtension({
    runtime,
    customBrowserLauncher: options?.customBrowserLauncher ?? (async () => true),
  })(piApi)

  if (includeRt && options?.loadRealtasksAfterRealgoal) {
    if (options?.useRealRealtasks) {
      await registerInstalledRealtasks(piApi)
    } else {
      registerMockRealtasks(piApi)
    }
  }

  const makeBaseCtx = (signal?: AbortSignal): ExtensionContext =>
    ({
      ui: {
        async select(title: string, opts: string[], dialogOpts?: { signal?: AbortSignal }) {
          const next = ui.selectQueue.shift()
          if (typeof next === "function") {
            if (dialogOpts?.signal?.aborted) return undefined
            return next(title, opts)
          }
          return next
        },
        async confirm(_title: string, _msg: string) {
          return ui.confirmQueue.shift() ?? false
        },
        async input(_title: string, _placeholder?: string) {
          return ui.inputQueue.shift()
        },
        notify(message: string, type = "info") {
          ui.notifications.push({ message, type })
        },
        setStatus(key: string, text: string | undefined) {
          ui.statuses.set(key, text)
        },
        setWidget(key: string, lines: readonly string[] | undefined) {
          ui.widgets.set(key, lines)
        },
        theme: {
          fg: (_c: string, s: string) => s,
          bold: (s: string) => s,
        },
      },
      mode: harnessState.mode,
      hasUI: harnessState.hasUI,
      cwd: tempDir,
      sessionManager: {
        getSessionId: () => harnessState.sessionId,
      },
      modelRegistry: {
        getAll: () => [
          harnessState.model,
          { provider: "anthropic", id: "claude-haiku-4-5", reasoning: false },
          { provider: "openai", id: "gpt-5", reasoning: true },
        ],
        hasConfiguredAuth: (m: { provider: string; id: string }) =>
          !harnessState.unauthenticatedModels.has(`${m.provider}/${m.id}`),
        getRegisteredProviderIds: () => harnessState.registeredProviders,
        ...(harnessState.mockStreamSimple
          ? {
              streamSimple: (model: any, context: any, opts: any) => ({
                result: async () => harnessState.mockStreamSimple!(model, context, opts),
              }),
            }
          : {}),
      },
      model: harnessState.model,
      scopedModels: [],
      thinkingLevel: harnessState.thinkingLevel,
      isIdle: () => harnessState.idle,
      isProjectTrusted: () => harnessState.isTrusted,
      signal,
      abort() {},
      hasPendingMessages: () => false,
      shutdown() {},
      getContextUsage: () => undefined,
      compact() {},
      getSystemPrompt: () => "",
    }) as unknown as ExtensionContext

  const invokeTool = async (
    name: string,
    params: Record<string, unknown>,
    callOpts?: { toolCallId?: string; parentToolCallId?: string; signal?: AbortSignal },
  ): Promise<AgentToolResult<any>> => {
    const callId = callOpts?.toolCallId ?? `tc_${Math.random().toString(36).slice(2, 9)}`
    const baseCtx = makeBaseCtx(callOpts?.signal)

    for (const h of handlers.get("tool_call") ?? []) {
      const guardRes = (await h(
        {
          type: "tool_call",
          toolCallId: callId,
          toolName: name,
          input: params,
          parentToolCallId: callOpts?.parentToolCallId,
        } as ToolCallEvent,
        baseCtx,
      )) as ToolCallEventResult | undefined
      if (guardRes?.block) {
        return {
          content: [{ type: "text", text: guardRes.reason ?? `Blocked ${name}` }],
          details: { blocked: true, reason: guardRes.reason },
          isError: true,
          ...(guardRes.terminate ? { terminate: true } : {}),
        }
      }
    }

    const toolDef = tools.get(name)
    if (!toolDef) {
      return {
        content: [{ type: "text", text: `Tool not found: ${name}` }],
        details: undefined,
        isError: true,
      }
    }

    for (const h of handlers.get("tool_execution_start") ?? []) {
      await h(
        {
          type: "tool_execution_start",
          toolCallId: callId,
          toolName: name,
          args: params,
          parentToolCallId: callOpts?.parentToolCallId,
        },
        baseCtx,
      )
    }

    const toolCtx: ExtensionToolContext = {
      ...baseCtx,
      tools: [],
      executeTool: async (nestedName: string, nestedArgs: unknown, execOpts?: { signal?: AbortSignal }) => {
        const nestedRes = await invokeTool(nestedName, (nestedArgs ?? {}) as Record<string, unknown>, {
          toolCallId: `${callId}/1`,
          parentToolCallId: callId,
          signal: execOpts?.signal,
        })
        return {
          toolCall: { type: "toolCall", id: `${callId}/1`, name: nestedName, arguments: nestedArgs as any },
          result: nestedRes,
          isError: Boolean(nestedRes.isError),
        }
      },
    }

    const res = await toolDef.execute(callId, params, callOpts?.signal, undefined, toolCtx)

    for (const h of handlers.get("tool_execution_end") ?? []) {
      await h(
        {
          type: "tool_execution_end",
          toolCallId: callId,
          toolName: name,
          result: res,
          isError: Boolean(res.isError),
          parentToolCallId: callOpts?.parentToolCallId,
        },
        baseCtx,
      )
    }

    return res
  }

  const harness: PiTestHarness = {
    tempDir,
    agentDir,
    runtime,
    ui,
    tasks,
    stopCalls,
    sentMessages,
    sentUserMessages,
    get sessionId() {
      return harnessState.sessionId
    },
    set sessionId(v: string) {
      harnessState.sessionId = v
    },
    get mode() {
      return harnessState.mode
    },
    set mode(v: ExtensionMode) {
      harnessState.mode = v
    },
    get hasUI() {
      return harnessState.hasUI
    },
    set hasUI(v: boolean) {
      harnessState.hasUI = v
    },
    get isTrusted() {
      return harnessState.isTrusted
    },
    set isTrusted(v: boolean) {
      harnessState.isTrusted = v
    },
    get idle() {
      return harnessState.idle
    },
    set idle(v: boolean) {
      harnessState.idle = v
    },
    get activeTools() {
      return harnessState.activeTools
    },
    set activeTools(v: string[]) {
      harnessState.activeTools = v
    },
    get model() {
      return harnessState.model
    },
    set model(v: { provider: string; id: string; reasoning: boolean }) {
      harnessState.model = v
    },
    get thinkingLevel() {
      return harnessState.thinkingLevel
    },
    set thinkingLevel(v) {
      harnessState.thinkingLevel = v
    },
    get registeredProviders() {
      return harnessState.registeredProviders
    },
    set registeredProviders(v: string[]) {
      harnessState.registeredProviders = v
    },
    get unauthenticatedModels() {
      return harnessState.unauthenticatedModels
    },
    set unauthenticatedModels(v: Set<string>) {
      harnessState.unauthenticatedModels = v
    },
    get mockStreamSimple() {
      return harnessState.mockStreamSimple
    },
    set mockStreamSimple(v) {
      harnessState.mockStreamSimple = v
    },
    registerExtraHandler(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
    },
    async invokeCommand(name: string, args = "", signal?: AbortSignal) {
      const cmd = commands.get(name)
      if (!cmd) throw new Error(`Command not registered: /${name}`)
      const cmdCtx = {
        ...makeBaseCtx(signal),
        getSystemPromptOptions: () => ({}),
        waitForIdle: async () => undefined,
        newSession: async () => ({ cancelled: false }),
        fork: async () => ({ cancelled: false }),
        navigateTree: async () => ({ cancelled: false }),
        switchSession: async () => ({ cancelled: false }),
        reload: async () => undefined,
      } as unknown as ExtensionCommandContext
      await cmd.handler(args, cmdCtx)
    },
    invokeTool,
    async emitSessionStart(reason = "startup", signal?: AbortSignal) {
      const ctx = makeBaseCtx(signal)
      for (const h of handlers.get("session_start") ?? []) {
        await h({ type: "session_start", reason }, ctx)
      }
    },
    async emitAgentStart() {
      const ctx = makeBaseCtx()
      for (const h of handlers.get("agent_start") ?? []) {
        await h({ type: "agent_start" }, ctx)
      }
    },
    async emitAgentEnd() {
      const ctx = makeBaseCtx()
      for (const h of handlers.get("agent_end") ?? []) {
        await h({ type: "agent_end", messages: [] }, ctx)
      }
    },
    async emitInput(text: string, source = "interactive") {
      const ctx = makeBaseCtx()
      let finalRes: InputEventResult = { action: "continue" }
      for (const h of handlers.get("input") ?? []) {
        const r = await h({ type: "input", text, source }, ctx)
        if (r) finalRes = r
      }
      return finalRes
    },
    async emitBeforeAgentStart(prompt = "user prompt", signal?: AbortSignal) {
      const ctx = makeBaseCtx(signal)
      let out: BeforeAgentStartEventResult | undefined
      for (const h of handlers.get("before_agent_start") ?? []) {
        const r = await h({ type: "before_agent_start", messageType: "user", prompt }, ctx)
        if (r) out = r
      }
      return out
    },
    async emitMessageEnd(message: Record<string, unknown>, signal?: AbortSignal) {
      const ctx = makeBaseCtx(signal)
      for (const h of handlers.get("message_end") ?? []) {
        await h({ type: "message_end", message }, ctx)
      }
    },
    async emitAgentBeforeSettle(params) {
      const ctx = makeBaseCtx(params?.signal)
      let entries: SessionBoundaryDraft[] = [...(params?.entries ?? [])]
      let cont = Boolean(params?.continue)
      const outcome = params?.outcome ?? "completed"
      const contextEntries = Array.from({ length: params?.contextLen ?? 1 }, (_, i) => ({ id: `e_${i}` })) as any
      for (const h of handlers.get("agent_before_settle") ?? []) {
        const ev: AgentBeforeSettleEvent = {
          type: "agent_before_settle",
          entries,
          continue: cont,
          outcome,
          context: {
            contextEntries,
            contextMessages: [],
            llmMessages: [],
            pendingMessages: [],
            canContinue: outcome === "completed",
          },
        }
        const res = (await h(ev, ctx)) as AgentBeforeSettleEventResult | undefined
        if (res?.entries !== undefined) entries = res.entries
        if (res?.continue !== undefined) cont = res.continue
      }
      return { entries, continue: cont }
    },
    async emitAgentSettled(aborted = false, signal?: AbortSignal) {
      const ctx = makeBaseCtx(signal)
      for (const h of handlers.get("agent_settled") ?? []) {
        await h({ type: "agent_settled", aborted }, ctx)
      }
    },
    async emitSessionBeforeSwitch() {
      const ctx = makeBaseCtx()
      for (const h of handlers.get("session_before_switch") ?? []) {
        await h({ type: "session_before_switch", reason: "new" }, ctx)
      }
    },
    async emitSessionShutdown(reason = "quit") {
      const ctx = makeBaseCtx()
      for (const h of handlers.get("session_shutdown") ?? []) {
        await h({ type: "session_shutdown", reason }, ctx)
      }
    },
    async cleanup() {
      const ctx = makeBaseCtx()
      for (const h of handlers.get("session_shutdown") ?? []) {
        await Promise.resolve(h({ type: "session_shutdown", reason: "quit" }, ctx)).catch(() => undefined)
      }
      await runtime.dispose().catch(() => undefined)
      if (!options?.keepTempDirOnCleanup) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }

  await harness.emitSessionStart("startup")
  return harness
}
