# Realgoal Reference

## Storage Layout

| Path | Purpose |
|---|---|
| `./.pi/realgoal/draft/<TASK>/` | Working draft, durable `state.json`, `history/<rev>.json`, `todo.md`, `questions.md`, `spec.md`, `plan.md`, `previews/`, `reviews/`, `workers/` |
| `./doc/<TASK>.md` | Published user-approved specification |
| `./.pi/realgoal/plan/<TASK>.md` | Published implementation plan |
| `~/.pi/agent/realgoal.json` | Global configuration |
| `./.pi/realgoal/config.json` | Trusted project configuration |

## Configuration

Precedence: `defaults -> ~/.pi/agent/realgoal.json -> ./.pi/realgoal/config.json (trusted only) -> work item overrides`. Secret-like keys (`apiKey`, `token`, `secret`, `password`) are rejected.

```json
{
  "schemaVersion": 1,
  "execution": { "defaultDriver": "session", "defaultVerificationDriver": "session" },
  "planning": { "requireDraftReview": true, "autoOpenBrowser": true, "defaultPreviewMode": "auto" },
  "browser": { "host": "127.0.0.1", "port": 0 },
  "continuation": { "noProgressLimit": 3, "failureRetryLimit": 2 },
  "workers": {
    "maxConcurrentReads": 4,
    "maxConcurrentWriters": 1,
    "timeoutMs": 900000,
    "models": { "research": null, "review": null, "todoSimple": null, "todoMedium": null, "todoComplex": null }
  }
}
```

## Agent Tools

| Tool | Responsibility |
|---|---|
| `realgoal_control` | Inspect state, advance phase, enter durable `realtasks` waits (`waiting_task`), or run user-authorized task cleanup |
| `realgoal_todo` | Create/mutate TODO DAG items, record verification evidence, submit for review, complete, block, or skip (with authorization) |
| `realgoal_preview` | Register and launch confined static HTML prototypes or sanitized SVG diagrams on loopback HTTP |
| `realgoal_question` | Ask structured questions across browser preview and terminal UI simultaneously (`Effect.raceFirst` CAS first-answer-wins) |
| `realgoal_delegate` | Dispatch isolated headless JSON child `pi` workers (`research`, `review`, `execute`, `verify`) via `realtasks` |
| `realgoal_finish` | Verify all TODOs, acceptance criteria, draft review gates, and tracked tasks before atomic completion |

## Architecture Notes

- **Effect-TS (`effect@^4.1.2`)**: Services (`ConfigService`, `PersistenceService`, `RealtasksAdapter`, `PreviewService`, `WorkerService`, `DoctorService`, `ControllerService`) are composed with `Context.Service`, `Layer`, and `ManagedRuntime` in `src/bridge/pi-wrapper.ts`.
- **Pipeline-Only Convention**: All control flow uses `pipe` / `.pipe` combinators (`Effect.Do`, `Effect.bind`, `Effect.flatMap`, `Effect.matchEffect`, `Effect.raceFirst`). Generators (`Effect.gen`, `function*`, `yield*`) are not used anywhere in source or tests.
- **Realtasks Integration**: Inspects tasks with `task_output(..., peek: true)` so `<task-notification>` wake latches remain intact until `agent_before_settle`, reconciles `keep_alive` re-adoption across reloads/resumes, and never calls `task_stop("all")`.
- **Full Specification**: See [spec.md](../spec.md).
