# Realgoal

Resumable `/goal` and `/plan` workflow extension for Pi (`^1.5.0`), powered by [`st0nie/realtasks`](https://github.com/st0nie/realtasks).

## Installation

Requires Pi `^1.5.0` and `st0nie/realtasks`:

```bash
pi install git:github.com/st0nie/realtasks
pi install git:github.com/stllok/realgoal
```

Or load for a single session without persisting settings:

```bash
pi -e ./index.ts
```

Run `/realgoal doctor` inside Pi to verify `realtasks`, shell transport, loopback preview binding, and worker CLI availability.

## Usage

```text
/goal <objective>              Run a verified goal workflow with durable TODOs and evidence
/plan <objective>              Run a read-only planning workflow with previews, review, and publication
```

Management subcommands via `/realgoal`:

| Command | Action |
|---|---|
| `/realgoal status` / `list` | Show active workflow status or list saved work items |
| `/realgoal pause` / `resume [id]` | Pause active run or resume a saved work item |
| `/realgoal cancel` | Cancel active work item (prompts before stopping owned background tasks) |
| `/realgoal review` | Run or inspect independent draft review for an active `/plan` |
| `/realgoal publish [spec\|plan\|both\|refine\|stop]` | Publish finalized spec (`./doc/<TASK>.md`) and/or plan (`./.pi/realgoal/plan/<TASK>.md`) |
| `/realgoal execute` | Authorize implementation and choose execution/verification drivers |
| `/realgoal preview` / `questions` / `todo` | Inspect or reopen previews, pending questions, or TODOs |
| `/realgoal config` / `doctor` / `help` | Inspect resolved config, run diagnostics, or show help |

## Development

Uses [Bun](https://bun.sh):

```bash
bun install
bun run typecheck   # bunx tsc --noEmit
bun test            # Acceptance + Windows realtasks E2E suite
bun run check       # Typecheck + tests
```

## More Docs

- [Reference (storage, config, tools, architecture)](./docs/reference.md)
- [Full specification](./spec.md)
