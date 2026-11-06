import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Option } from "effect"
import type { GoalPhase, WorkItemState } from "../domain/models.ts"
import { selectNextEligibleTodo } from "../domain/reducer.ts"

export const REALGOAL_ENTRY_TYPE = "realgoal"
export const REALGOAL_CONTINUATION_MESSAGE_TYPE = "realgoal-continuation"
export const REALGOAL_NOTICE_MESSAGE_TYPE = "realgoal-notice"

export const formatCompactStatusLine = (
  state: WorkItemState,
  uiPromptWaiting = false,
): string => {
  const prefix = state.kind === "goal" ? "Goal" : "Plan"
  const readOnlyTag = Option.match(state.owner, {
    onNone: () => "",
    onSome: (o) => (o.readOnly ? " [read-only]" : ""),
  })

  if (uiPromptWaiting) {
    return `${prefix}${readOnlyTag} · waiting for UI dialog · ${state.phase}`
  }

  switch (state.runStatus) {
    case "awaiting_user": {
      const pendingQ = state.questions.find((q) => q.status === "pending")
      if (pendingQ) {
        return `${prefix}${readOnlyTag} · awaiting answer · ${pendingQ.id} ${pendingQ.title}`
      }
      return `${prefix}${readOnlyTag} · awaiting choice · ${state.phase}`
    }
    case "waiting_task": {
      const wg = Option.getOrUndefined(state.activeWaitGroup)
      const firstId = wg?.taskIds[0]
      const binding = firstId ? state.trackedTasks.find((t) => t.taskId === firstId) : undefined
      const taskLabel = binding ? `${binding.taskId} ${binding.purpose}` : firstId ?? "task"
      const resumePhase = wg?.resumePhase ?? state.phase
      return `${prefix}${readOnlyTag} · waiting · ${taskLabel} · resume: ${resumePhase}`
    }
    case "paused": {
      const reasonShort = Option.match(state.pauseOrBlockReason, {
        onNone: () => "user paused",
        onSome: (r) => (r.length > 40 ? `${r.slice(0, 39)}…` : r),
      })
      return `${prefix}${readOnlyTag} · paused · ${reasonShort} · /realgoal resume`
    }
    case "blocked": {
      const reasonShort = Option.match(state.pauseOrBlockReason, {
        onNone: () => "blocked",
        onSome: (r) => (r.length > 40 ? `${r.slice(0, 39)}…` : r),
      })
      return `${prefix}${readOnlyTag} · blocked · ${reasonShort}`
    }
    case "finished":
      return `${prefix}${readOnlyTag} · finished (${state.completionScope}) · ${state.displayName}`
    case "cancelled":
      return `${prefix}${readOnlyTag} · cancelled · ${state.displayName}`
    case "running": {
      const total = state.todos.length
      const showTodoCount = state.kind === "goal" ? total > 1 : total > 0
      if (!showTodoCount) {
        return `${prefix}${readOnlyTag} · ${state.phase}`
      }
      const done = state.todos.filter((t) => t.status === "done").length
      return `${prefix}${readOnlyTag} · ${state.phase} · ${done}/${total} done`
    }
  }
}

export const formatDetailedStatusReport = (
  state: WorkItemState,
  draftDir: string,
): string => {
  const done = state.todos.filter((t) => t.status === "done").length
  const nextTodo = selectNextEligibleTodo(state.todos)
  const pendingQ = state.questions.filter((q) => q.status === "pending")
  const runningTasks = state.trackedTasks.filter(
    (t) => t.lastStatus === "running" || t.lastStatus === "ready" || t.lastStatus === "unavailable",
  )
  const waivedCriteria = state.acceptanceCriteria.filter(
    (c) => Option.isSome(c.waiverAuthorizationId) || !c.required,
  )

  return [
    `Work Item: ${state.displayName} (${state.id}, rev ${state.revision})`,
    `Kind / Scope: ${state.kind} (completionScope: ${state.completionScope})`,
    `Phase / Status: ${state.phase} · ${state.runStatus}`,
    `Objective: ${state.objective}`,
    `Next Action: ${state.nextAction}`,
    ...(Option.isSome(state.pauseOrBlockReason)
      ? [`Pause/Block Reason: ${state.pauseOrBlockReason.value}`]
      : []),
    `TODO Progress: ${done}/${state.todos.length} done${Option.match(nextTodo, {
      onNone: () => "",
      onSome: (t) => ` (next: ${t.id} [${t.status}] ${t.title})`,
    })}`,
    `Drivers: execution=${Option.getOrElse(state.executionDriver, () => "unselected")}, verification=${state.verificationDriver}`,
    ...(pendingQ.length > 0
      ? [`Pending Questions: ${pendingQ.map((q) => `${q.id} (${q.title})`).join(", ")}`]
      : []),
    ...(runningTasks.length > 0
      ? [
          `Tracked Tasks: ${runningTasks
            .map((t) => `${t.taskId} [${t.ownership}, ${t.lastStatus}]`)
            .join(", ")}`,
        ]
      : []),
    ...(waivedCriteria.length > 0
      ? [`Waived/Deferred Criteria: ${waivedCriteria.map((c) => c.id).join(", ")}`]
      : []),
    `Draft Path: ${draftDir}`,
    ...(state.publications.length > 0
      ? [
          `Published Artifacts: ${state.publications
            .map((p) => `${p.target}:${p.destinationPath} (${p.status})`)
            .join(", ")}`,
        ]
      : []),
  ].join("\n")
}

type WidgetColor = "success" | "muted" | "accent" | "warning" | "error"
type WidgetFg = (color: WidgetColor, text: string) => string

const GOAL_STAGE_ITEMS: ReadonlyArray<{ readonly phase: GoalPhase; readonly label: string }> = [
  { phase: "intake", label: "Intake" },
  { phase: "explore", label: "Explore" },
  { phase: "analyze", label: "Analyze" },
  { phase: "process", label: "Process" },
  { phase: "verify", label: "Verify" },
]

export const formatTodoWidgetRows = (
  state: WorkItemState,
  fg: WidgetFg = (_c, s) => s,
): string[] => {
  if (state.kind === "goal" && state.todos.length <= 1) {
    const currentIdx =
      state.phase === "complete"
        ? GOAL_STAGE_ITEMS.length
        : GOAL_STAGE_ITEMS.findIndex((s) => s.phase === state.phase)
    const visitedExplore =
      state.phase === "explore" ||
      state.transitions.some((t) => t.fromPhase === "explore" || t.toPhase === "explore")
    const soleTodoBlocked = state.todos[0]?.status === "blocked"

    return GOAL_STAGE_ITEMS.map(({ phase, label }, idx) => {
      if (idx < currentIdx) {
        if (phase === "explore" && !visitedExplore) {
          return `${fg("muted", "−")} ${fg("muted", `${label} (skipped)`)}`
        }
        return `${fg("success", "✓")} ${fg("muted", label)}`
      }
      if (idx === currentIdx) {
        if (soleTodoBlocked) return `${fg("error", "✗")} ${label} (blocked)`
        return `${fg("accent", "▶")} ${label}`
      }
      return `${fg("muted", "○")} ${label}`
    })
  }

  return [...state.todos]
    .sort((a, b) => a.order - b.order)
    .slice(0, 8)
    .map((t) => {
      if (t.status === "done") return `${fg("success", "✓")} ${fg("muted", `${t.id} ${t.title}`)}`
      if (t.status === "in_progress") return `${fg("accent", "▶")} ${t.id} ${t.title}`
      if (t.status === "verify_pending") return `${fg("warning", "◎")} ${t.id} ${t.title} (verify)`
      if (t.status === "blocked") return `${fg("error", "✗")} ${t.id} ${t.title} (blocked)`
      if (t.status === "skipped") return `${fg("muted", "−")} ${fg("muted", `${t.id} ${t.title} (skipped)`)}`
      return `${fg("muted", "○")} ${t.id} ${t.title}`
    })
}

export const applyUiStatusAndWidgets = (
  ctx: ExtensionContext,
  stateOpt: Option.Option<WorkItemState>,
  uiPromptWaiting = false,
): void => {
  if (!ctx.hasUI) return

  Option.match(stateOpt, {
    onNone: () => {
      ctx.ui.setStatus("realgoal", undefined)
      ctx.ui.setWidget("realgoal-todos", undefined)
    },
    onSome: (state) => {
      if (state.archived) {
        ctx.ui.setStatus("realgoal", undefined)
        ctx.ui.setWidget("realgoal-todos", undefined)
        return
      }
      const line = formatCompactStatusLine(state, uiPromptWaiting)
      const color =
        state.runStatus === "finished"
          ? "success"
          : state.runStatus === "paused" || state.runStatus === "awaiting_user" || state.runStatus === "waiting_task"
            ? "warning"
            : state.runStatus === "blocked" || state.runStatus === "cancelled"
              ? "error"
              : "accent"

      const styled =
        typeof ctx.ui.theme?.fg === "function" ? ctx.ui.theme.fg(color, line) : line
      ctx.ui.setStatus("realgoal", styled)

      if (
        (state.runStatus === "running" || state.runStatus === "waiting_task") &&
        !isPlanningOnlyWidgetSkip(state)
      ) {
        const fg: WidgetFg =
          typeof ctx.ui.theme?.fg === "function"
            ? (c, s) => ctx.ui.theme.fg(c, s)
            : (_c, s) => s
        const rows = formatTodoWidgetRows(state, fg)
        ctx.ui.setWidget("realgoal-todos", rows.length > 0 ? rows : undefined)
      } else {
        ctx.ui.setWidget("realgoal-todos", undefined)
      }
    },
  })
}

const isPlanningOnlyWidgetSkip = (state: WorkItemState): boolean =>
  state.kind === "plan" &&
  (state.phase === "intake" ||
    state.phase === "discovery" ||
    state.phase === "design" ||
    state.phase === "analysis")

export const registerRealgoalRenderers = (pi: ExtensionAPI): void => {
  pi.registerMessageRenderer(REALGOAL_CONTINUATION_MESSAGE_TYPE, (message, options, theme) => {
    const body = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    const header = theme.fg("accent", theme.bold("Realgoal · Continuation"))
    const content = options.expanded ? `\n${theme.fg("muted", body)}` : ` ${theme.fg("dim", body.split("\n")[1] ?? "")}`
    return new Text(`${header}${content}`, options.outputPad, 0)
  })

  pi.registerMessageRenderer(REALGOAL_NOTICE_MESSAGE_TYPE, (message, options, theme) => {
    const body = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    return new Text(`${theme.fg("accent", "[realgoal]")} ${body}`, options.outputPad, 0)
  })

  pi.registerEntryRenderer(REALGOAL_ENTRY_TYPE, (entry, _options, theme) => {
    const data = (entry.data ?? {}) as Record<string, unknown>
    const summary = typeof data["summary"] === "string" ? data["summary"] : JSON.stringify(data)
    return new Text(`${theme.fg("dim", "· realgoal:")} ${theme.fg("muted", summary)}`, 0, 0)
  })
}
