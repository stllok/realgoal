---
name: realgoal
description: Reference for Realgoal (/goal and /plan) workflows — legal phase transitions, finalized.md plan requirements, realgoal_todo verification/evidence lifecycle, static HTML/SVG realgoal_preview rules, and realgoal_delegate child workers. Read only when unsure about a realgoal_* contract or rejected transition; never read Realgoal extension source files.
---

# Realgoal Workflow Reference

Only call `realgoal_*` tools when `[Realgoal Active Work Item]` is present in context. Never edit `<draftDir>/state.json`, `todo.md`, or `questions.md` directly — mutate state exclusively through `realgoal_*` tools.

## 1. Phase Graphs (`realgoal_control` `action: "advance"`)

### `/goal` (lightweight verified execution)
- `intake` -> `explore` | `analyze`
- `explore` -> `analyze` | `explore`
- `analyze` -> `process` | `explore` | `analyze`
- `process` -> `verify` | `analyze` | `explore` | `process`
- `verify` -> `process` | `analyze` | `explore` | `verify` -> finish via `realgoal_finish`

### `/plan` (read-only planning -> optional review -> publish -> optional execution)
- **Planning phases (writes outside `<draftDir>` and mutating git/rm commands are blocked):**
  - `intake` -> `discovery` | `design` | `analysis`
  - `discovery` | `design` | `analysis` -> `discovery` | `design` | `analysis` | `finalization`
  - `finalization`: write `<draftDir>/finalized.md`, then call `realgoal_control(action: "finalize")` (moves automatically to `draft_review` if draft gate is enabled, else `publication_choice` with `awaiting_user`).
  - `draft_review` -> `publication_choice` | `discovery` | `design` | `analysis`
  - `publication_choice` -> `publication` -> `execution_choice` (driven by user `/realgoal publish` and `/realgoal execute`).
- **Authorized execution phases (after user runs `/realgoal execute`):**
  - `lookup` -> `implement` | `verify_goal`
  - `implement` -> `verify_item` | `lookup`
  - `verify_item` -> `lookup` | `implement` | `verify_goal`
  - `verify_goal` -> `lookup` | `implement` -> finish via `realgoal_finish`

## 2. `finalized.md` Requirements (`/plan`)

Before calling `realgoal_control(action: "finalize")`:
1. All `blocking: true` questions must be answered.
2. Write non-empty `<draftDir>/finalized.md`.
3. If publishing as an implementation plan (`plan` or `both`), `finalized.md` is validated for:
   - **Objective / Goal** and constraints (`objective` or `goal` keyword)
   - **Stage structure** (`## ` headings / `stage`)
   - **Scope boundaries** (`in scope` / `out of scope` / `scope`)
   - **Verification checks** (`acceptance`, `pass condition`, or `check`)
   - **No `TBD` placeholders** (word `TBD` is rejected)

## 3. TODO & Finish Contract (`realgoal_todo` + `realgoal_finish`)

`/goal` starts with implicit `T001` and criterion `C001`. Every required TODO must follow:
1. `realgoal_todo(action: "start", todoId: "T001")`
2. Implement changes, then `realgoal_todo(action: "submit_for_verification", todoId: "T001", implementationSummary: "...")`
3. Run checks and record passing evidence linking acceptance criteria IDs:
   `realgoal_todo(action: "record_evidence", todoId: "T001", evidence: { criterionIds: ["C001"], method: "executable_test", result: "pass", commandOrObservation: "...", exitCode: 0 })`
4. `realgoal_todo(action: "complete", todoId: "T001")` (for `subagent` verification driver, also pass `reviewSummary: { reviewerActor: "subagent", verdict: "pass", summary: "..." }`)
5. Finish workflow:
   `realgoal_finish(summary: "...", recordGoalLevelVerification: true)` (`recordGoalLevelVerification: true` is required whenever `completionScope` is `"implementation"`).

## 4. Visual Previews & Questions (`realgoal_preview` + `realgoal_question`)

When comparing 1–4 concrete UI/architecture layouts in `/plan`:
1. Write static `.html` or `.svg` files (>= 20 chars) under `<draftDir>/previews/<previewId>/<file>.html`.
   - Forbidden: `<script>` tags, inline `on*=` event attributes, and external `http(s)://` `src`/`href` URLs (unless `browser.externalAssets` is enabled). Inline CSS and inline SVG are allowed.
2. Register with `realgoal_preview(previewId, title, options: [{ id, title, description, rationale, relativePath }])` (`relativePath` is relative to `<draftDir>/previews/<previewId>/`).
3. Present with `realgoal_question(title, prompt, purpose, previewId, options: [...])`.

## 5. Delegated Child Workers & Background Tasks

- `realgoal_delegate(role: "implementation" | "verification" | "draft_review", purpose, scope, enterWait: true)` launches an isolated Pi worker via `realtasks` and suspends until completion.
- For long `realtasks` jobs started directly, bind and suspend via `realgoal_control(action: "wait", waitRequests: [{ taskId, purpose, waitCondition: "terminal" | "ready" }])` instead of polling.
