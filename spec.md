# Realgoal — Pi Extension Specification

**Status:** Proposed v1 specification, informed by source research and confirmed product choices.  
**Deliverable for this request:** This `spec.md` only. No extension implementation, scaffolding, prototypes, or configuration is created now.  
**Reference platform:** `@earendil-works/pi-coding-agent` 1.5.0 and `st0nie/realtasks` 0.1.0 at commit `7b3df80cf2b630bd2e9d9d3578d39d11d23fb884`.

## 1. Purpose and scope

Realgoal turns a user's objective into an explicit, resumable workflow inside Pi.

- **`/goal`** is the lightweight path: set a goal → optional basic exploration → basic analysis → do the work → verify → explicitly finish.
- **`/plan`** is the interactive path: investigate deeply, ask questions, compare designs, preserve findings, finalize the design, optionally obtain an independent gap review, then let the user choose what to publish and whether to implement.
- **`/realgoal`** is the management menu. **`/realgoal <ACTION>`** exposes the same operations without navigating the menu.
- **Realtasks owns background execution.** Realgoal must integrate it for dependency waits and delegated Pi jobs, without inventing another process manager.
- A small file-backed TODO system keeps the agent following **lookup → implement → verify → lookup**, until the requested work is actually complete.

“Keep working” means requesting another agent run when authorized work remains and the agent would otherwise settle. It does **not** mean bypassing user cancellation, approval gates, permissions, provider failures, unanswered questions, unavailable dependencies, or safety restrictions.

### 1.1 Confirmed choices

The user explicitly selected:

1. Register `/goal` and `/plan` now; “reserved” means these are this extension's entry points.
2. Browser-based alternatives are selectable in the browser, with Pi/terminal fallback.
3. No fixed total-turn cap by default. Repeated lack of progress pauses the workflow for user input.

The original request also fixes:

- Draft findings, research, detailed appendable TODOs, and resumable state live under `./.pi/realgoal/draft/<TASK NAME>/`.
- The finalized design is `./.pi/realgoal/draft/<TASK NAME>/finalized.md`.
- The optional independent draft-verification gate is **disabled by default**.
- Published specifications go under **`./doc/`**, not `./docs/`.
- Implementation plans go to `./.pi/realgoal/plan/<TASK NAME>.md`.
- After writing an implementation plan, offer **direct-driven**, **subagent-driven**, and **stop here**.
- Subagents inherit the current model and thinking level unless configured otherwise, with light/medium/heavy task profiles.

Other defaults below are design proposals, not additional user-confirmed preferences.

### 1.2 Non-goals

V1 is not:

- A replacement for Pi, realtasks, a general-purpose agent framework, or a distributed workflow engine.
- A visual website builder or a production frontend generator during planning.
- A requirement to install or execute the entire Superpowers skill collection.
- A parallel multi-agent coding swarm, automatic branch manager, or mandatory commit/PR workflow.
- A guarantee that arbitrary model output is correct, or an OS-level security sandbox.
- Permission to install dependencies, change product code, commit, push, deploy, or expose a server publicly merely because planning started.

## 2. Research findings and architectural consequences

These are observations from documentation/source inspection, not claims of completed integration tests. Sources are listed in §21.

| Finding | Consequence for Realgoal |
|---|---|
| Pi 1.5.0 exposes `agent_before_settle`, which can append entries and request one continuation. `agent_end` may precede recovery or queued work. [P1] | Put the continuation decision at `agent_before_settle`, not in an unconditional `agent_end` callback. |
| Boundary handlers compose in registration order. Returned `entries` or `continue` replace that field; omitted fields preserve earlier proposals. [P1] | Preserve `event.entries`; do not erase realtasks notifications or override unrelated continuation decisions. |
| Abort/error responses remain hard exits; `continue: false` does not suppress natural work. [P1] | Realgoal must not promise to control every model request in Pi. It controls its own continuation requests and goal activity. |
| `ctx.executeTool()` exists on tool execution contexts, not ordinary command/event contexts. Nested calls pass through normal validation and tool hooks. [P1] | Tool-to-tool adapters invoke realtasks from Realgoal tools. Commands and event hooks cannot pretend to call `ctx.executeTool()`. |
| Realtasks overrides `bash` and exposes task tools, push notifications, readiness checks, and re-adoption. Its peer dependency is Pi 1.5.0. [R1–R5] | Depend on the existing tools; do not override `bash` again or read/write realtasks' private registry as an integration API. |
| Realtasks emits `realtasks` custom lifecycle entries and `task-notification` messages with structured item IDs. Its task tools expose structured `details`. [R2–R4] | Use version-tested structured adapters. Notifications trigger reconciliation; their prose is not the source of truth. |
| Reading task output normally advances its cursor and may consume the completion notice; `peek: true` does neither. [R1, R4] | Controller reconciliation uses peeks. Consumption of logs is deliberate, not a repeated readiness check. |
| Pi JSON mode can report an assistant error or abort without a nonzero process exit. [P3] | A child job needs valid terminal events and a structured result as well as an acceptable exit status. |
| Pi's example subagent launches an isolated process and supports inherited dispatch settings. It is an example, not a guaranteed installed tool. [P5] | Ship a defined worker adapter; an existing `subagent` extension may be an optional adapter, never an assumed dependency. |
| Superpowers separates brainstorming, written design, implementation planning, and execution; its visual companion uses browser alternatives. [S1–S4] | Reuse those separation-of-concern ideas, but retain the user's paths, optional review gate, and simpler TODO execution model. |

### 2.1 Chosen architecture

Use a **Pi extension with a persistent state machine**, a **thin realtasks adapter**, a **small local preview service**, and a **delegated-Pi worker adapter**.

Rejected alternatives:

- **Prompt-only reminders:** simple, but cannot reliably preserve waiting states, prevent accidental completion, or recover after interruption.
- **A second task scheduler/process registry:** duplicates realtasks and introduces conflicting lifecycle ownership.
- **Importing all of Superpowers:** introduces unrelated paths, mandatory gates, commits, and workflow assumptions.

Suggested responsibility boundaries, not a file scaffold created by this request:

1. Commands and terminal presentation.
2. Workflow reducer, guards, and continuation policy.
3. Persistent storage and recovery.
4. TODOs, evidence, and artifact publication.
5. Realtasks capability adapter.
6. Browser previews and question resolution.
7. Worker dispatch, model selection, and result validation.

### 2.2 Compatibility contract

- Target the inspected Earendil Pi 1.5.0 APIs first. Do not claim compatibility with older Pi releases or differently named forks without tests.
- Honor Pi's documented runtime requirement, including Node.js 22.19+ for the reference distribution.
- Require compatible realtasks capabilities for active managed workflows; inspection/export of existing artifacts remains usable if that dependency is unavailable.
- `/realgoal doctor` checks dependency tools, required Pi capabilities, command collisions, writable paths, worker launch prerequisites, and browser availability.
- Missing essential capabilities produce an actionable blocked state. Do not silently fall back to a busy-loop continuation or a private task-store integration.
- Realtasks' structured lifecycle/details shapes are source-observed compatibility surfaces, not a separately promised stable SDK. Pin/test the adapter against supported releases and reject unknown incompatible shapes.
- Default paths in this spec assume Pi's `.pi` configuration directory. A rebranded distribution should derive its equivalent from `CONFIG_DIR_NAME` and clearly display the resolved paths.
- On Windows, realtasks needs a supported Bash transport; the inspected source rejects the WSL Bash launcher and recommends Git Bash/MSYS2/Cygwin. PTY support is optional; it is not needed for the basic workflow.

### 2.3 Packaging and activation

The future implementation should be a TypeScript Pi package exposing its extension entry through Pi package metadata. Support normal Pi installation/discovery and explicit `-e` loading for development. Document realtasks installation as a separate prerequisite; do not install it or remove a conflicting Bash extension without permission.

Loading the package registers commands/tools and shows recoverable saved work; it does not start an objective automatically. Keep workflow-specific context/tool restrictions scoped to active work, restore prior session settings when leaving it, and avoid overriding Pi's global system prompt or unrelated extensions' tools.

## 3. Core concepts and invariants

### 3.1 Vocabulary

- **Work item:** one user objective and its durable history, identified by an immutable ID and a display name.
- **Phase:** what kind of work is being performed, such as research or verification.
- **Run status:** whether the workflow can currently make progress, such as running or waiting for a task.
- **TODO:** a small, checkable unit within a work item.
- **Realtasks task:** an external process/monitor tracked by realtasks; distinct from a TODO.
- **Evidence:** an observation supporting an acceptance criterion or verification result.
- **Artifact revision:** the content hash/revision of a draft, plan, or implementation being reviewed.
- **Owner:** the Pi session/runtime currently authorized to advance a work item.

### 3.2 Invariants

1. Only an explicit, validated completion action marks a work item `finished`. Text such as “done” is insufficient.
2. A finished background process is not a finished TODO, a passing verification, or a finished goal.
3. Waiting is durable and non-busy. It does not generate periodic model calls.
4. Manual pause, cancellation, and unresolved user questions cannot be cleared by a task notification.
5. Planning cannot silently become product implementation.
6. Only one work item is actively driven per Pi session. Multiple inactive drafts may coexist.
7. Only one owner may mutate a particular work item at a time.
8. A reviewer cannot mark the parent goal complete or rewrite the parent's workflow state.
9. Review approval is bound to the reviewed content revision; changing that content invalidates the approval.
10. All scope changes, user decisions, review waivers, and completion evidence are recoverable from disk.
11. Arbitrary model checkpoints, repeated status text, and timestamp changes are not proof of progress.
12. Terminal errors and missing information remain visible; no failed or unrun check is recorded as a pass.

## 4. Commands and management UX

### 4.1 Entry points

| Command | Behavior |
|---|---|
| `/goal <objective>` | Start the lightweight workflow. |
| `/goal` | Resume/manage an existing goal, or ask for a new objective. |
| `/plan <objective>` | Start deep interactive planning. Does not authorize implementation. |
| `/plan` | Select/resume a draft, or ask for a new planning objective. |
| `/realgoal` | Open a state-aware management menu. |
| `/realgoal <action> [arguments]` | Perform the equivalent quick action. |

Do not silently replace an active objective. Offer resume, pause-and-create, or cancel-and-create. Resolve command collisions explicitly rather than hijacking another extension's command.

### 4.2 Required quick actions

- `goal <text>`, `plan <text>`: aliases for the entry commands.
- `status [id]`: phase, run status, progress, current TODO, blockers, pending question, tracked jobs, and paths.
- `list`: saved work items, filterable by mode/status.
- `resume [id]`: reconcile disk/session/task state, then resume with user authorization.
- `pause [reason]`: stop Realgoal continuation immediately and checkpoint.
- `stop [reason]`: alias for pause; clearly state that background processes are separate.
- `cancel [id]`: terminally cancel the workflow after confirmation; retain artifacts.
- `todo [id]`: inspect/manage TODOs and evidence.
- `answer <question-id> <answer>`: answer a pending question without a browser or custom TUI.
- `preview [id]`: reopen an available visual choice or show its files/URL.
- `review [id]`: request/retry the draft gap review or inspect prior results.
- `publish [spec|plan|both]`: publish from an eligible finalized revision after confirmation.
- `execute [direct|subagent]`: choose execution for an approved implementation plan.
- `config`: inspect/edit settings and show effective values and their source.
- `doctor`: diagnostics and compatibility checks.
- `archive [id]`: hide a terminal/inactive item from the default list without deleting it.

Unknown actions show usage and valid actions. Missing arguments open a picker in interactive mode; headless mode returns a structured need-for-input result instead of guessing.

### 4.3 Menu behavior

The menu should expose only relevant next steps and explain disabled actions. Examples:

- Running: inspect, pause, inspect TODOs/jobs, adjust future dispatch settings.
- Waiting: show dependency and last known status, resume/reconcile, pause, open realtasks management.
- Planning: continue research, answer question, open preview, finalize/review.
- Finalized: write specification, write implementation plan, write both, refine, stop here.
- Plan published: execute directly, execute with subagents, stop here.
- Paused/stalled: inspect reason, provide guidance, resume, or cancel.

`Esc` dismisses a menu without authorizing a default action. `Esc` during agent execution must not be counteracted by the continuation hook.

### 4.4 Pause versus process termination

`pause`/`stop` disables this workflow's continuation and aborts the active parent run where appropriate. It does **not** imply that realtasks killed its background processes.

`cancel` makes the workflow terminal and cannot be undone implicitly. If tracked jobs remain, show their IDs and distinguish owned worker jobs from attached user jobs. Offer explicit termination through realtasks; never stop unrelated tasks or use `task_stop("all")` as generic cleanup.

Because command handlers lack `ctx.executeTool()`, they must not claim to have stopped a task merely by calling an unavailable API. V1 may offer the realtasks management UI, or queue one user-authorized cleanup tool action for the exact IDs. A cleanup action must not resume the cancelled workflow. If termination fails or is not confirmed, keep a visible warning that background work may still be running and writing files.

## 5. State model

Phase and run status are separate. Waiting is an overlay, not a duplicate of every phase.

### 5.1 Run statuses

| Status | Meaning | Realgoal requests continuation? |
|---|---|---|
| `running` | Authorized runnable work remains. | Yes, subject to guards. |
| `waiting_task` | Progress depends on identified realtasks jobs. | No; wake/reconcile on relevant completion. |
| `awaiting_user` | A question, approval, or next-action choice is unresolved. | No. |
| `paused` | User pause, interruption recovery, or stall guard. | No. |
| `blocked` | A missing capability, permission, resource, or external prerequisite prevents progress. | No. |
| `finished` | Completion contract passed and the completion tool committed it. | Never. |
| `cancelled` | User abandoned this work item. | Never. |

A transition records the reason, prior status/phase, revision, and origin: user, agent tool, dependency event, or recovery.

### 5.2 Lightweight phases

`intake → explore? → analyze → process → verify → complete`

- `explore` may be skipped with a brief recorded reason.
- Failed verification returns to `process`; newly discovered uncertainty may return to `explore`/`analyze`.
- `complete` is reached only through the finish contract.

### 5.3 Planning and implementation phases

`intake → discovery ↔ design ↔ analysis → finalization → draft_review? → publication_choice → publication → execution_choice`

If execution is selected:

`lookup → implement → verify_item → lookup … → verify_goal → complete`

- Discovery/design/analysis can iterate; the controller should not force an artificial one-way waterfall.
- An unresolved substantive question switches status to `awaiting_user` while retaining the phase.
- A failed draft review returns to the appropriate planning phase and invalidates the reviewed revision.
- Publication and execution choices are user gates, not autonomous transitions.

### 5.4 Meaning of “stop here”

“Stop here” after a published plan means **planning is complete; implementation has not been authorized**. Store the published artifact and a parked/paused handoff, not a claim that the software objective is implemented.

If the user's requested deliverable was explicitly only a specification or plan, publishing and validating that deliverable may satisfy the goal's completion contract. Track this as `completionScope: artifact`, separate from `completionScope: implementation`. Do not infer implementation completion from artifact completion.

## 6. Lightweight `/goal` workflow

### 6.1 Intake

Record the objective, scope, relevant constraints, and observable acceptance criteria. Infer straightforward criteria from a clear request; ask only when a missing decision changes the outcome.

Create one implicit TODO for a very small task. Do not force detailed brainstorming or a multi-stage implementation plan onto a simple change.

### 6.2 Optional exploration and basic analysis

Read enough existing code/documentation to identify the affected area, current behavior, and likely checks. Record a concise approach and major risks. Exploration can be skipped when the needed context is already established.

### 6.3 Process and verify

Carry out the authorized work. When a slow job starts, continue independent work if any exists; otherwise enter the realtasks wait state described in §11.

Verify against the acceptance criteria. Use project checks where available and label manual inspection accurately. If a check fails, fix/retry within scope. If a user decision, permission, or unavailable dependency is required, ask or block rather than endlessly retrying.

### 6.4 Completion

Call `realgoal_finish` with a summary and evidence references. The controller checks structural eligibility before committing `finished`.

If the agent merely ends a response while eligible work remains, Realgoal issues a concise continuation describing the current phase, next TODO, and unresolved acceptance criteria. It must not repost the entire original prompt or all research files every turn.

## 7. Deep `/plan` workflow

### 7.1 Persistent working set

Create the draft directory at planning start, before substantial research. Preserve:

- Original request, goals, non-goals, constraints, and acceptance criteria.
- Current understanding of the existing project and relevant external sources.
- Findings, uncertainties, hypotheses, and evidence that confirms or rejects them.
- Questions, answers, decisions, rejected alternatives, and rationale.
- A detailed TODO that can grow as research discovers additional work.
- Visual alternatives, selected options, feedback, and revisions.
- Finalized design revisions and optional independent review reports.
- The exact next action needed after interruption.

Research notes should distinguish **observed fact**, **user decision**, **design proposal**, and **unverified assumption**. URLs alone are insufficient: record the useful finding, its context, and retrieval/version information where available.

### 7.2 Interactive investigation

1. Inspect the supplied context and relevant project before asking questions it already answers.
2. Establish intended users, desired outcomes, constraints, and success criteria.
3. Investigate technical feasibility and existing behavior.
4. Compare meaningful approaches with trade-offs and a recommendation.
5. Ask when an unresolved decision materially changes requirements, architecture, cost, risk, or presentation.
6. Record answers immediately; update the TODO and affected design notes.
7. Repeat until there is enough detail to publish an actionable design.

Prefer one focused question at a time; small groups of independent questions are acceptable. Offer concise choices where useful and always allow a custom answer. Do not manufacture choices merely to make the workflow look interactive.

The user may delegate a choice to the agent. Record the resulting choice as an agent proposal/delegated decision, not fabricated user testimony.

### 7.3 Planning boundary

Planning permits reading, analysis, writing draft documents, and authorized nonfunctional prototypes inside the draft directory. It does not authorize unrelated product-code edits, dependency installation, live-data changes, commits, deployment, or destructive experiments.

A useful spike can be proposed with its purpose, boundaries, and cleanup expectations. It needs approval before changing the project or installing dependencies. Its output is not automatically promoted into production code.

### 7.4 Finalized design requirements

`finalized.md` must be coherent and useful without replaying the entire conversation. Include, as applicable:

1. Intent, users, goals, non-goals, and completion criteria.
2. Existing context and constraints.
3. Selected approach, alternatives, and rationale.
4. Functional requirements and behavior flows.
5. UI design decisions or architecture/data-flow diagrams.
6. Components, responsibilities, interfaces, and data/state models.
7. Error handling, interruption behavior, security/privacy, and relevant accessibility/performance requirements.
8. Verification strategy and observable acceptance conditions.
9. Risks, assumptions, remaining nonblocking questions, and explicitly deferred scope.
10. References to supporting research and selected preview artifacts.

No blocking requirement may be hidden under “TBD.” Nonblocking implementation choices may be left to the implementer if their boundaries are explicit.

Writing `finalized.md` creates a candidate revision; it is not itself approval, publication, or authorization to implement.

## 8. Browser-assisted visual design

### 8.1 When to use it

Use the browser when seeing the alternatives helps the user decide. Do not force every question into a browser.

Frontend topics include:

- Visual style, theme, typography, density, and color.
- Tone: casual, joyful, formal, business-oriented, or project-specific.
- Icon families and treatment; prefer a consistent library such as Iconify where suitable.
- Preset design languages such as Material 3, WinUI, or Bootstrap-inspired styling.
- Navigation, page layout, page design, responsive behavior, and sitemap.
- Important empty, loading, error, and success states where they affect the design.

Backend/system topics include:

- Component and deployment architecture.
- Data flow, request sequences, state transitions, trust boundaries, and storage relationships.
- Alternatives that are easier to compare as diagrams than as prose.

Adapt the medium to the question: static HTML/CSS, safe SVG, or rendered diagrams. Do not require a frontend framework or production build toolchain just to compare designs.

### 8.2 Preview interaction

- Ask permission before first opening the browser; a saved preference may pre-authorize subsequent opens.
- Provide two to four meaningful alternatives when alternatives exist. A refinement may show one proposal with targeted feedback controls.
- Each alternative has a stable option ID, title, description, rationale/trade-offs, and preview path.
- Produce actual nonfunctional visual mockups, not merely a list of style names.
- Multiple single-page HTML files are valid. For larger designs, an index may compare pages, flows, or sitemap views.
- Keep options comparable: use the same scenario/content where possible and identify what varies.
- A click may highlight/explore an option; an explicit **Submit choice** commits the decision. Do not treat the last incidental click as approval.
- Allow comments and a custom response. A browser selection does not mean the user approved every element in the mockup.
- Persist the submitted decision, question ID, preview revision, option IDs, and comments before advancing.
- When the workflow moves on, mark the old question resolved and show a waiting/resolved view rather than leaving a stale actionable choice.

### 8.3 Local preview service

A small Node HTTP service owned by the extension is sufficient. It serves approved draft assets, a controlled comparison UI, and a narrow choice-submission endpoint. This in-process UI service is not a second background task manager.

Requirements:

- Bind to loopback on an available port by default.
- Display the working URL; browser-launch failure must leave a usable Pi fallback.
- Use a random session capability and validate host/origin and submitted question/revision IDs.
- Keep prototype content in sandboxed frames. Selection controls belong to the trusted wrapper, not generated prototype scripts.
- Default prototypes are static: no script execution, forms, network requests, top navigation, or service-worker registration. Enforce this with both frame sandboxing and a restrictive per-document Content Security Policy; sandboxing alone does not stop image/CSS network requests.
- Give the trusted wrapper only the scripts/endpoints it needs. Reject cross-origin submissions, validate bounded payloads, and restrict the callback to known choices/custom-answer text rather than arbitrary commands or file writes.
- Restrict serving to the current preview asset root, resolve real paths, and reject traversal and symlink escapes.
- Prefer local/embedded assets. External fonts, image hosts, icon CDNs, and remote diagram services are not required.
- Sanitize imported SVG and check the license of the chosen icon set; Iconify does not give every icon set the same license.
- Do not embed secrets, credentials, raw session history, or unrelated project files.
- Do not put capability tokens in generated documents or persistent research logs. Exchange transient launch credentials for a controlled session and use a restrictive referrer policy.
- Stop/restart cleanly on reload, session change, and shutdown. Persist preview artifacts and pending question identity, not an assumption that an old port remains live.
- Remote users use a user-controlled tunnel or terminal fallback; never silently bind to `0.0.0.0`.

### 8.4 Answer delivery and race handling

Browser and Pi answers resolve the same durable question. A compare-and-set against question ID/revision ensures exactly one accepted answer; duplicates are harmless and stale submissions receive a clear rejection.

If a question tool is still awaiting a UI answer, resolve that tool rather than independently scheduling another run. If no tool is awaiting it, persist the answer and request at most one normal Pi continuation. Respect an intervening manual pause/cancel; a browser click must not revive a paused workflow.

The fallback must support keyboard selection and free text. In RPC mode, use supported UI request/response methods. In print/JSON mode without an input channel, save the pending question and return `needs_input`; never invent an answer.

## 9. Finalization, optional gap review, and publication

### 9.1 Author self-check

Before finalizing, the main agent checks that the user's requirements are covered, decisions are internally consistent, citations support important claims, and remaining TODOs are either completed or explicitly deferred with user consent.

Self-checking is always required. It is different from the optional independent draft gate.

### 9.2 Optional independent draft gate

Setting: `verification.draftGate.enabled`, default **false**.

When enabled:

1. Write the candidate `finalized.md` and record its content hash.
2. Dispatch a fresh reviewer/subprocess with that exact file plus necessary request, decisions, and relevant project context.
3. Ask specifically for requirement gaps, contradictory assumptions, unhandled edge cases, infeasibility, security/operational concerns, and missing acceptance conditions.
4. The reviewer returns a structured verdict and findings; it does not implement fixes or mutate the parent state.
5. Store its report under the draft directory and bind it to the input revision.
6. Resolve blocking findings by revising the draft and reviewing the new revision.
7. Pause for user guidance after the configured failed-review/stall threshold instead of silently disabling the gate.

The reviewed input manifest includes the finalized document and the request, acceptance criteria, and material decisions used by the reviewer. Changes to those inputs invalidate approval even if `finalized.md` itself has not yet changed. Include relevant project revisions when the verdict depends on existing code.

Verdicts: `pass`, `changes_required`, `blocked`. Each finding includes an ID, severity, location/requirement reference, explanation, and suggested resolution.

A gate passes only when the current revision has a valid `pass` and no unresolved blocking findings. Reviewer execution failure, invalid output, timeout, missing credentials, or an aborted response is **not** a pass.

Only an explicit user action may waive/disable an enabled gate for the current draft. Record who authorized it and why. The agent cannot waive its own failed review.

### 9.3 Publication choice

Once the draft is eligible, display the next-action menu:

1. **Write specification** → default `./doc/<TASK NAME>.md`.
2. **Write implementation plan** → `./.pi/realgoal/plan/<TASK NAME>.md`.
3. **Write both**.
4. **Continue refining**.
5. **Stop here** → retain the completed draft and pending handoff.

This extension menu may have more than four rows; it is not constrained by a particular external questionnaire tool.

Before writing, show the exact destination and a readable summary/link to the current finalized revision. The user's publication confirmation records approval of that design revision, not permission to implement. Do not overwrite unrelated existing files silently. Offer overwrite with confirmation, a new name, or cancel. Keep the draft and its supporting research; publication does not move or delete it.

Published files identify their source work item and finalized revision. Before committing publication, revalidate that the source revision and any required gate approval are unchanged. A change to the approved review inputs reopens the applicable gate.

### 9.4 Implementation plan requirements

A plan must be executable by an agent that did not participate in the planning conversation. It includes:

- Objective, source design/specification, constraints, and agreed non-goals.
- Stage-by-stage structure and ordering/dependencies.
- For each stage: **what to do**, **implementation goal**, **in scope**, **out of scope**, affected files/components, expected outputs/interfaces, checks, and **review pass conditions**.
- TODOs small enough to have a meaningful completion check.
- Exact commands and expected outcomes when known from the project; do not invent test commands as if verified.
- Failure/recovery considerations and final integration/acceptance checks.
- Explicit assumptions that an executor must validate before depending on them.

Prefer concrete decisions and interfaces over either vague “implement the feature” steps or an implementation transcript containing every future line of code.

After writing the plan, perform a consistency check against the finalized design, display the path, and offer:

- **Direct-driven:** the main agent implements the TODOs.
- **Subagent-driven:** delegated workers implement the TODOs.
- **Stop here:** no implementation; retain a resumable handoff.

Publishing both documents still requires this execution choice. Never infer execution permission from “write plan.”

## 10. TODO execution and completion contracts

### 10.1 Minimal TODO model

Each TODO has:

- Immutable ID, title, and description.
- Stage, order, and optional dependency IDs.
- Goal, scope/non-scope, and acceptance criteria.
- Difficulty: `light`, `medium`, or `heavy`, with a brief rationale.
- Status: `pending`, `in_progress`, `verify_pending`, `done`, `blocked`, or `skipped`.
- Current attempt, implementation notes, evidence references, and review result.
- Associated realtasks/worker IDs where relevant.

Support append, update, reorder, split, and dependency changes as research reveals new work. Keep IDs stable and preserve the history/reason for material scope changes. Reject cyclic dependencies and references to unknown IDs.

The TODO system is a checklist and next-step selector, not a general DAG scheduler. V1 uses one active implementation writer at a time.

### 10.2 Lookup → implement → verify

1. **Lookup:** reread the current plan/constraints and choose the first eligible unfinished TODO.
2. **Implement:** use the selected driver, recording what changed and any deviation.
3. **Verify:** run the prescribed checks using the selected verification driver.
4. **Complete TODO:** an explicit tool action supplies verification/evidence and moves it to `done` if eligible.
5. **Repeat lookup:** refresh state before selecting the next TODO.

A worker saying “done” moves the parent toward `verify_pending`, not directly to `done`. Failed verification reopens implementation. New discoveries may append TODOs; material scope changes require user confirmation.

`skipped` is not a way to conceal failure. Required work can be removed/deferred only with an explicit scope decision, after updating the affected acceptance criteria. A skipped required criterion otherwise prevents goal completion.

### 10.3 Independent execution and verification drivers

Execution and verification are separate choices:

| Implementation | Verification | Behavior |
|---|---|---|
| Direct | Direct | Main agent implements and checks. |
| Direct | Subagent | Main agent implements; a fresh reviewer checks. |
| Subagent | Direct | Worker implements; main agent checks. |
| Subagent | Subagent | Worker implements; a separate fresh reviewer checks. |

Default implementation is chosen at handoff; default verification is direct. Expose the verification choice/configuration before execution. Draft-gap verification remains a separate, default-disabled setting.

### 10.4 Evidence and verification results

Evidence records contain an ID, criterion/TODO IDs, method, result (`pass`, `fail`, `blocked`, `not_run`, or explicit user `waived`), relevant command/observation, timestamps, artifact/log references, and the reviewed revision.

- Capture exit status and relevant output for executed checks.
- Distinguish static review, executable tests, manual inspection, and user confirmation.
- Do not let an old passing result validate changed files without considering whether that change invalidates it.
- A timeout or unavailable service is blocked/not-run, not success.
- User-approved waivers remain visible in the final summary; they do not become passing tests.

The extension can validate evidence structure, references, and freshness. It cannot prove the semantic truth of every model claim. That limitation must be explicit in the UI and tests.

### 10.5 Goal finish contract

`realgoal_finish` may succeed only if:

- The caller is the owning parent workflow, not a child reviewer.
- The intended deliverable and completion scope are explicit.
- Required TODOs are done or removed from scope through an authorized decision.
- Acceptance criteria have current passing evidence or explicit, permitted user waivers.
- No blocking question, required review, unresolved failure, or mutating worker remains.
- No required dependency is still running or unresolved.
- Final goal-level verification has been recorded for implementation work.
- The current state revision is the expected one.

The transition is atomic and idempotent. Repeating the same successful finish action must not schedule more work. A rejected finish returns the exact missing conditions and leaves the goal unfinished.

Long-lived services may remain only when deliberately classified as retained resources, excluded from completion dependencies, and clearly disclosed to the user.

## 11. Realtasks integration

### 11.1 Ownership and supported surfaces

Realtasks remains the authority for process existence, status, output, readiness, signal delivery, and task lifetime. Realgoal stores references and its own dependency interpretation.

Use:

- `bash` with background/ready options for slow commands and delegated Pi launchers.
- `task_output` for one-shot reconciliation and output inspection.
- `task_wait` only for an intentional blocking wait when no other useful work remains; it is not the normal continuation mechanism.
- `task_input` for explicitly needed interactive processes.
- `task_stop` for explicitly authorized task termination.
- `task_list` for management/diagnostics, not a per-turn polling loop.
- `monitor` for event/log streams, not repeated `bash tail -f` invocations.

Do not import realtasks private manager objects, manipulate its notification latch, or assume an undocumented event-bus API exists.

### 11.2 Task binding

A binding records:

- Full task ID, originating Pi session, and originating tool call/worker ID.
- Owning work item/TODO and purpose.
- Ownership: `owned` or merely `attached`.
- Wait condition: terminal completion, explicit readiness, or a defined monitor event.
- Resume phase and whether success is required.
- Last observed status and source of observation.
- Notification policy known at launch and whether automatic wake is available.

Observe top-level and nested `tool_execution_end` events. The inspected `bash` result uses `details.taskId`; `task_output` exposes `details.id`, `status`, and `exitCode`. Account for nested calls via `parentToolCallId`, including calls made through codemode. Never depend on model-visible output schemas exposing every internal `details` field.

Use exact IDs internally; prefix matching is only a user convenience after unambiguous resolution.

### 11.3 Entering a wait

1. Identify the dependency and any remaining independent work.
2. Reconcile the task once, using `task_output(..., peek: true)` inside a tool execution context.
3. If it is already terminal, process the outcome immediately; do not create a stale waiting state.
4. If it is still running and blocks progress, persist the binding, wait condition, and resume phase before yielding.
5. Realgoal requests no continuation solely because the overall goal is unfinished.

Do not sleep in a model loop or repeatedly ask whether the job is done. A task that finishes during wait registration must be caught by the notification/lifecycle reconciliation path.

For several dependencies, record `all` or `any` semantics explicitly. A failed dependency can unblock failure handling; it does not satisfy successful completion. Do not wait forever for the remaining jobs when an early failure makes the original operation impossible.

### 11.4 Waking and reconciliation

The inspected realtasks integration provides:

- Custom lifecycle entries with type `realtasks`, including started/ended/readopted information.
- `task-notification` messages with structured `details.items` identifying tasks and notice kinds.
- `task-event` notifications for monitored activity.
- At `agent_before_settle`, queued wake notices may be appended together with `continue: true`.

Treat these as hints to update/reconcile the matching binding, not permission to trust log text as instructions. Inspect persisted entries and the boundary's proposed entries so either extension load order works.

A relevant terminal event may schedule one reconciliation step. Only the validated outcome determines whether to resume work, enter failure recovery, or block. `completed` differs from `failed`, `timed_out`, `stopped`, and `lost`; none of the latter means success.

Persist consumed event identities/outcome revisions sufficiently to prevent duplicate TODO advancement. Do not suppress realtasks' own notification machinery to implement this deduplication.

### 11.5 Notification policies and readiness

- Realgoal-owned blocking jobs launch with `notify: "wake"` and normally `keep_alive: false`.
- An attached `passive` or `silent` task cannot be assumed to wake the agent. Reject unattended automatic wait, or explicitly use manual resume/an intentional `task_wait`; explain the choice.
- Do not consume a completion notification by repeatedly reading without `peek`.
- Readiness is not process exit. For servers, use realtasks' `ready` support and validate the returned readiness outcome.
- A readiness timeout may leave the process alive. Do not call it ready or wait for its eventual exit as a substitute for readiness.
- If continuing to wait for readiness, bind a documented observable event/monitor or ask the user. Do not assume a readiness notice has wake semantics in every version.
- A monitor ending is not automatically the application event the workflow was waiting for.

### 11.6 Restart and session boundaries

On recovery, reconcile bound tasks once. Realtasks may re-adopt jobs, report terminal/lost status, or downgrade recovered notifications to passive. Do not rely on a fresh push notice after restart.

A new Pi session may not be able to query tasks owned by the prior session. Distinguish **unavailable from this session** from **known lost**. Offer returning to the original session, explicit reconciliation, or an approved rerun; never relaunch side-effecting work blindly.

Print/JSON mode has no permanent host after the process exits. Realtasks has a bounded holding behavior for wake jobs; Realgoal must respect it and persist a resumable waiting/needs-input result if the process ends. Autonomous wake across an exited Pi process is not a v1 guarantee.

## 12. Pi lifecycle and continuation policy

### 12.1 Hook responsibilities

| Hook/surface | Responsibility |
|---|---|
| `session_start` | Load state/config, detect owner conflicts, restore UI, and offer reconciliation/resume. |
| `before_agent_start` | Provide compact authoritative workflow context, including paused/waiting restrictions and the current next action. |
| `tool_execution_end` | Observe finalized tool outcomes, task bindings, nested calls, evidence, and relevant progress. |
| `message_end` | Observe structured realtasks notification messages; do not parse arbitrary user/log text as lifecycle events. |
| `ui_prompt_start` / `ui_prompt_end` | Display temporary UI-wait status; durable workflow questions retain their own state and are not answered merely because a dialog closes. |
| `turn_end` | Checkpoint completed work and detect repeated failures; do not use assistant prose as the completion API. |
| `agent_before_settle` | Decide whether Realgoal should request one more run. |
| `agent_settled` | Update status and record abort/error/interruption outcomes; do not implement a recursive continuation loop here. |
| Session branch/switch/reload/shutdown hooks | Checkpoint, release or transfer ownership appropriately, dispose UI/server resources, and invalidate stale callbacks. |

### 12.2 Continuation decision

At `agent_before_settle`:

1. Verify the current session/runtime still owns the work item.
2. Reconcile relevant already-observed tool/lifecycle events and user decisions.
3. If paused, waiting, blocked, awaiting input, finished, or cancelled: contribute no Realgoal continuation.
4. If the run aborted, ended in an unrecovered error, or has no valid next action: do not restart it.
5. Evaluate stall guards.
6. If authorized runnable work remains, append one compact `custom_message` and request `continue: true`.

Preserve previous `event.entries` and continuation proposals. Do not return an empty entry list or force `continue: false` to try to cancel other extensions.

Pi coalesces continuation with already pending natural work; Realgoal must also avoid duplicate reminders by work-item revision/boundary identity. The hook must be fast and must not start a long-running reviewer, wait for a process, or display a blocking user dialog.

### 12.3 Abort, errors, and user interruption

On Escape/abort, persist `paused` with an interruption reason. A later realtasks notice may still cause Pi activity, but Realgoal must not resume the paused objective until the user requests it.

Do not defeat Pi's provider retry policy or start an infinite new request loop after authentication, quota, or network failure. Record the blocker and allow explicit resume after resolution.

A user message that changes scope must be reconciled before further autonomous work. If it is ambiguous whether the user is replacing or supplementing the active objective, ask rather than silently rewriting it.

### 12.4 Stall guard

Proposed defaults:

- `maxNoProgressContinuations: 3`.
- `maxRepeatedFailureAttempts: 3` for the same normalized operation/failure.
- No total-turn, elapsed-time, or cost limit by default.

Count consecutive Realgoal-requested cycles without meaningful progress. Qualifying progress includes a verified TODO transition, a substantive new research finding/decision with a reference, resolving a blocker, or an accepted artifact revision. Merely touching a file, changing timestamps, repeating a checkpoint, or producing more prose does not necessarily reset the guard.

Use deterministic fingerprints for repeated operations/errors where possible and retain the evidence behind any progress classification. This is a practical guard, not a perfect semantic detector.

Waiting for a task or user is excluded from stall accounting. On a stall, pause, show what repeated, and offer guidance, a changed approach, explicit resume, or cancel. Optional budgets may be added/configured, but are not the default stopping mechanism.

## 13. Agent-facing tool contract

Names below are the proposed public v1 API. Schemas must be typed, bounded, and documented; outputs include structured status/error details, not just prose.

### 13.1 `realgoal_control`

Actions:

- `status`: return the compact current snapshot.
- `checkpoint`: record findings, artifact references, and the next action.
- `advance`: request a legal phase transition with required evidence.
- `wait`: bind identified realtasks dependencies and enter the wait state after reconciliation.
- `reconcile`: perform the required one-shot task/worker outcome check.
- `block` / `pause`: persist a reason without implying completion.
- `finalize`: register/hash the candidate finalized document and select the next required gate.
- `publish`: write a user-authorized artifact after eligibility/path checks.
- `cleanup`: stop only explicitly authorized tracked task IDs through realtasks.

Mutations require work-item ID, expected state revision, and an operation ID. The controller rejects stale writes and invalid phase transitions. User-only decisions require a previously recorded user authorization; an agent argument claiming consent is insufficient.

### 13.2 `realgoal_todo`

Actions: list, append, update, reorder, start, submit-for-verification, complete, block, reopen, and record an authorized skip/scope change.

`complete` requires TODO ID and evidence/review references. It validates the TODO's completion contract and dependency state. Bulk appends may support research expansion; bulk completion without per-item evidence must not bypass checks.

### 13.3 `realgoal_question`

Create a durable question with its purpose, blocking status, choices or free-text input, and optional preview reference. Present it via available UI and return either the accepted answer or a structured pending result.

All answer paths use the same question ID/revision. Cancellation leaves the question unresolved or pauses the workflow; it never selects a default silently.

### 13.4 `realgoal_preview`

Register/present draft-contained visual alternatives, validate their paths, start/reuse the local preview service, and associate them with a question. It does not authorize arbitrary shell commands or product implementation.

### 13.5 `realgoal_delegate`

Dispatch an `implementation`, `verification`, or `draft_review` job with:

- Work item/TODO, purpose, scope, and input artifact revision.
- Difficulty and optional authorized model override.
- Allowed tool/write scope and required result contract.
- Relevant context and acceptance conditions.

Inside its tool execution context, use `ctx.executeTool()` to launch through realtasks, forward cancellation/update signals where supported, and inspect `isError` on every nested result. Persist the returned task binding and dispatch configuration before yielding.

### 13.6 `realgoal_finish`

The explicit goal-completion tool. Inputs include expected revision, completion scope, summary, acceptance/evidence references, and any disclosed retained resources. It enforces §10.5.

Tools that enter a pending wait/question may return Pi's termination hint when appropriate, but that hint only suppresses the next model call if the entire finalized tool batch is terminating. The durable state and continuation hook remain authoritative; do not assume the hint can cancel sibling work or other extensions.

## 14. Persistence and recovery

### 14.1 Proposed layout

The following is the future runtime layout, not files created by this specification request:

```text
.pi/realgoal/
  config.json
  draft/
    <TASK NAME>/
      state.json
      request.md
      todo.md
      research.md
      decisions.md
      questions.md
      finalized.md
      previews/
        <preview-id>/
          index.html
          <option-id>.html
          assets/
      reviews/
        <review-id>.json
        <review-id>.md
      workers/
        <job-id>/
          request.json
          result.json
          transcript.jsonl
      history/
        <revision>.json
  plan/
    <TASK NAME>.md

doc/
  <TASK NAME>.md
```

Small goals may omit unused research/preview/review files. Do not generate empty bureaucracy for every phase.

### 14.2 State ownership

`state.json` is the authoritative machine-readable workflow snapshot, including TODO state and pending questions. `todo.md` and `questions.md` are readable projections; their headers identify them as managed views.

The agent appends/updates TODOs through the tool, which updates the snapshot and regenerates the file. Raw edits to a managed projection are not silently interpreted as completion. Detect divergence and offer an explicit import/reconciliation if needed.

Research and decision prose remain editable artifacts, referenced by state. Review and publication hashes bind approval to their relevant content. A Pi custom entry mirrors important transitions for session visibility, but the session transcript is not the only durable store.

### 14.3 Required state fields

- Schema version, work-item ID, display name, safe directory name, timestamps, and state revision.
- Canonical workspace identity and originating/owning session information.
- Workflow kind, phase, run status, objective, constraints, acceptance criteria, and completion scope.
- TODOs, pending questions, decisions/authorizations, and evidence index.
- Artifact paths/hashes, review results, publication records, and execution/verification choices.
- Tracked jobs, wait condition/resume phase, last observations, and event deduplication data.
- Next action, last meaningful progress, stall/failure counters, and pause/block reason.
- Effective config snapshot and resolved dispatch settings for already started jobs.

Store durable results and concise rationale, not private model chain-of-thought or credentials.

### 14.4 Writes and ownership protection

- Serialize mutations under an owner lock and expected-revision check.
- Write state using a temporary file in the same directory and atomic replacement where supported; retain a recoverable last-valid revision.
- Commit the authoritative snapshot before reporting a successful mutation. Markdown projections can be regenerated after a crash.
- Treat publication as a recoverable operation with source hash, destination, and completion record; do not claim a cross-file atomic transaction that the filesystem does not provide.
- Detect partial writes, schema mismatch, external modification, and full/read-only disks. Pause rather than advance with missing state.
- Use a lock owner token including session/runtime identity. Do not steal a lock solely because a PID exists or a timestamp is old; account for PID reuse and require safe recovery/confirmation.
- Avoid building a database/event-sourcing platform for v1: snapshots plus a compact revision history are sufficient.

### 14.5 Names and path safety

Preserve the user's task name as display text. Derive `<TASK NAME>` as a filesystem-safe directory/file stem, with a short immutable suffix when needed to avoid collisions.

Reject traversal, absolute-path injection, reserved Windows names, ambiguous case collisions, and empty/special names. Normalize and resolve paths before access. Custom export paths outside the workspace require explicit user confirmation.

A rename must not change the immutable work-item ID. Never overwrite another draft because two names sanitize to the same path.

### 14.6 Resuming and branching

On resume:

1. Acquire/validate ownership and load the last valid snapshot.
2. Check workspace identity, schema, artifacts, and managed projection consistency.
3. Reconcile tracked tasks and child results once.
4. Invalidate stale reviews/evidence affected by changed inputs.
5. Restore any pending question and next action.
6. Show a compact resume summary and obtain authorization after a process restart or uncertain interruption.

An intentional same-session extension reload may restore the prior state after reconciliation; a process restart or ambiguous ownership starts paused rather than silently editing files.

A session fork/branch must not create a second writer for the same work item. Use read-only attachment by default and offer an explicit ownership transfer or a new work-item copy. Copied work items must not inherit live task ownership or approval for changed content.

Compaction may replace conversational context but must not erase disk state. Reinject a concise state summary and paths on subsequent runs rather than all historical research.

## 15. Delegated Pi execution and model selection

### 15.1 Default worker strategy

Use an isolated Pi subprocess launched through realtasks. A small trusted launcher/worker integration may translate its JSON event stream into a durable result; realtasks still owns the outer task's process lifecycle.

Do not assume an installed `subagent` tool. An optional adapter can use one only when it meets the same cancellation, isolation, model inheritance, and result contracts.

V1 runs implementation workers sequentially in the current workspace. Review workers are fresh contexts, separate from the implementer. Parallel mutating workers and automatic worktree management are deferred.

### 15.2 Worker inputs and capabilities

Provide a scoped context packet:

- Objective and current TODO/stage.
- Finalized design/plan revision and relevant decisions.
- Required files/components, allowed write scope, and non-goals.
- Interfaces/dependencies, acceptance criteria, and verification commands.
- Required result fields and escalation instructions.

Do not dump the entire parent conversation or inject unrelated secrets.

For the reference CLI, use JSON mode with explicit model/thinking selection and isolated resource loading. `--no-extensions` still permits explicit `-e` worker extensions. Disable unwanted MCP, skills, prompt templates, and context-file discovery as appropriate, and supply only the trusted worker resources.

The worker must not load Realgoal's parent continuation controller recursively. A child environment/role marker and restricted tool set prevent parent-only state transitions and recursive delegation by default.

A reviewer defaults to read/search tools, with its report delivered through a dedicated result channel. Do not grant arbitrary shell access under the claim that it is “read-only.” When executable checks are needed, run them through a narrowly scoped approved mechanism or have the parent execute them. Permission controls are defense in depth, not an OS sandbox.

### 15.3 Launch and output handling

- Construct launch parameters from validated configuration; do not interpolate user prompts into shell commands.
- Put the context packet in a draft-contained request file and pass its safe path to the trusted launcher.
- Use platform-correct quoting and preserve exact executable paths, including paths with spaces on Windows.
- Disable command rewriting for protocol-sensitive worker launches where necessary, such as realtasks' `rtk: "off"`.
- Preserve raw JSONL output separately from bounded model-visible summaries.
- Validate final assistant/session events and an explicit schema-versioned worker result. In the reference JSON protocol, wait for `agent_settled`, inspect its abort outcome and final assistant error/abort state, and verify the result matches the requested role and input manifest. Accept a valid terminating result-tool flow without requiring an extra prose reply. Process exit zero alone is insufficient.
- Missing/truncated output, a model `error`/`aborted`/unfinished result, or a mismatched work-item/revision makes the result failed/blocked.
- Parent reconciliation, not the child, updates TODO status or records final completion.
- If a worker needs clarification, return `needs_input`; route the question through the parent rather than trying to open an unattended child TUI.

### 15.4 Model and thinking inheritance

Resolve each new job in this order:

1. Explicit user-authorized override for that job.
2. The configured light/medium/heavy profile, field by field.
3. The current parent model/provider and effective thinking level at dispatch time.

The default value for every profile field is `inherit`. Do not substitute a cheaper model or raise reasoning intensity just because the job is called a subagent/reviewer.

Difficulty is suggested with a reason and can be changed. Typical guidance:

- **Light:** narrow lookup, small local change, or tightly scoped check.
- **Medium:** normal multi-file implementation or review.
- **Heavy:** broad architectural decisions, complex cross-cutting changes, or high-consequence analysis.

Persist the requested and resolved provider/model/thinking level. A parent's later model change affects only future jobs.

If the inherited thinking level is unsupported, record the effective supported value and notify the user; never claim it was identical. If a model/provider or its authentication is unavailable in the child, block with an actionable explanation. Custom providers registered only in the parent process may require an explicitly approved provider adapter; do not silently switch models or serialize credentials into the draft.

## 16. Configuration and presentation

### 16.1 Configuration layers

Proposed locations:

- Global: `~/.pi/agent/realgoal.json`.
- Project: `./.pi/realgoal/config.json`.
- Work-item overrides persisted in its state.

Precedence: built-in defaults → global → trusted project → explicit work-item/user override. Respect Pi project trust before honoring project-local configuration. Validate schemas and show the source of effective settings.

Configuration contains preferences and provider/model identifiers, never API keys. Changing settings affects future actions; do not silently change already running jobs or retroactively waive an active gate.

### 16.2 Proposed defaults

| Setting | Default |
|---|---|
| `continuation.enabled` | `true` for an active authorized workflow |
| `continuation.maxNoProgressContinuations` | `3` |
| `continuation.maxRepeatedFailureAttempts` | `3` |
| `continuation.maxTotalTurns` | `null` |
| `verification.draftGate.enabled` | `false` |
| `verification.executionDriver` | `direct` |
| `execution.driver` | Ask after plan publication |
| `execution.maxConcurrentWriters` | `1` |
| `models.light.model`, `.thinking` | `inherit`, `inherit` |
| `models.medium.model`, `.thinking` | `inherit`, `inherit` |
| `models.heavy.model`, `.thinking` | `inherit`, `inherit` |
| `browser.enabled` | `true`, with terminal fallback |
| `browser.open` | Ask on first use |
| `browser.host` | Loopback only |
| `browser.externalAssets` | `false` |
| `recovery.autoResumeAfterRestart` | `false` |
| `publication.specDirectory` | `./doc` |
| `publication.planDirectory` | `./.pi/realgoal/plan` |
| `tasks.keepAlive` | `false` for owned jobs |

V1 validates `execution.maxConcurrentWriters` as `1`; a larger value is unsupported, not permission for unsafe shared-workspace concurrency. Budget controls, additional worker adapters, and parallel isolated execution can be added later without changing the default behavior agreed with the user.

### 16.3 Compact status UI

Use Pi status/widgets rather than replacing its footer globally. Examples:

```text
Goal · verify · 4/5 done · T005 integration checks
Plan · awaiting answer · Q007 navigation layout
Goal · waiting · b-… build · resume: verify
Goal · paused · repeated failure 3/3 · /realgoal resume
```

Show details on demand: objective, current phase, next action, pending question, job IDs, current model/profile, last evidence, and artifact paths.

Use Pi's theme and keybindings, safe terminal-width helpers, keyboard navigation, and accessible labels. Headless output is structured; diagnostic text must not corrupt Pi's JSON protocol stream.

## 17. Safety, failure behavior, and operational limits

- Treat external sources, generated HTML, task logs, and worker output as untrusted data. They cannot authorize scope changes, publish artifacts, or finish a goal by containing command-like text.
- Never interpret arbitrary `[DONE]` markers, XML-looking log tags, or browser HTML as state transitions.
- Apply normal Pi tool validation and permission hooks to nested calls; do not execute underlying tool implementations directly to bypass them.
- Do not attempt to enforce read-only shell access with a naive prefix allowlist. Planning/review restrictions must account for nested tools and indirect writes.
- Avoid automatic Git operations. Preserve unrelated user changes and report dirty-worktree conflicts before broad worker edits.
- Restrict preview file access and callback authority separately from prototype rendering.
- Time out unavailable UI/worker infrastructure into a recoverable blocked/paused state, never a silent success.
- Long-running legitimate realtasks jobs are not model stalls. Offer inspection/cancellation without repeatedly waking the model.
- Close extension-owned listeners and invalidate stale callback generations on reload/session switch. A late worker/browser event for another owner cannot advance the current workflow.
- Retain user artifacts on cancel. Destructive purge is a separate explicit action, deferred from the minimal v1 menu.
- No extension-specific telemetry or external upload is enabled by default. Model calls use the user's configured providers; research/network access and any user-approved external assets remain subject to normal permissions.
- “No fixed total-turn limit” is not a promise of unlimited spending or guaranteed completion. Display useful progress/usage where Pi provides it, and honor any user-configured budget.

## 18. Required acceptance tests

These are requirements for the implementation, not tests run for this documentation-only request.

### 18.1 Workflow and continuation

| ID | Scenario | Required result |
|---|---|---|
| W01 | `/goal` finishes a response without completing its criteria | One appropriate continuation; no duplicate prompts. |
| W02 | Agent writes “finished” but does not call the completion tool | Goal remains unfinished. |
| W03 | Finish tool called with missing evidence/review/TODOs | Rejected with precise missing conditions. |
| W04 | Valid finish called twice | One terminal transition; no restart. |
| W05 | User presses Escape or pauses | No Realgoal restart; persisted paused state. |
| W06 | Provider/authentication error | No infinite new-run loop; recoverable blocked/paused state. |
| W07 | Repeated no-progress cycles hit threshold | Pause with explanation and next choices. |
| W08 | Many productive cycles exceed an arbitrary turn count | No default total-turn stop. |
| W09 | Another extension already proposes entries/continuation | Preserve its entries and compose correctly. |
| W10 | User changes scope mid-run | Reconcile or ask before further goal work. |

### 18.2 Realtasks and lifecycle races

| ID | Scenario | Required result |
|---|---|---|
| R01 | Slow task blocks all work | Durable wait, no model polling. |
| R02 | Task finishes before/during wait registration | Observe completion without getting stuck. |
| R03 | Both extension load orders; notification arrives at settle | One reconciliation/advance; notification preserved. |
| R04 | Duplicate terminal notification or reconnect | No duplicate TODO completion. |
| R05 | Unrelated task completes | No change to this goal's dependency state. |
| R06 | Task failed/stopped/timed out/lost | Recovery/blocking, never success. |
| R07 | User pauses; task then finishes | Record outcome but remain paused. |
| R08 | Attached silent/passive task | Explain lack of auto-wake; no fake unattended wait. |
| R09 | Peek versus consuming output read | Controller peeks do not consume the notification/cursor. |
| R10 | Service becomes ready but keeps running | Resume on verified readiness, not exit. |
| R11 | Readiness timeout leaves service alive | Not marked ready; visible unresolved resource. |
| R12 | Task started through nested/codemode call | Correct binding from structured details and parent IDs. |
| R13 | Resume after re-adoption/passive recovered notice | One reconciliation restores accurate state. |
| R14 | New session cannot query old task | Unavailable is not mislabeled as lost or rerun silently. |
| R15 | Cancellation with unrelated tasks running | Only explicitly authorized IDs are stoppable. |
| R16 | Print/JSON host exits while waiting | Persist resumable state; no promise of wake after host exit. |

### 18.3 Planning and browser interaction

| ID | Scenario | Required result |
|---|---|---|
| P01 | Interrupted deep research | Resume findings, TODOs, decisions, and pending question from draft. |
| P02 | New finding requires more work | Append stable-ID TODOs without losing prior progress. |
| P03 | Frontend design alternatives requested | Actual comparable mockups, not only prose labels. |
| P04 | Backend architecture comparison | Usable diagrams with text fallback. |
| P05 | Browser unavailable or user declines | Full question/answer flow remains usable in Pi. |
| P06 | Browser and terminal answer simultaneously | Exactly one accepted answer; stale answer explained. |
| P07 | Old preview submits after revision/pause/cancel | Reject or record without unauthorized resume. |
| P08 | Malicious preview script, traversal, forged callback | No script authority, file escape, or unauthorized decision. |
| P09 | Draft gate disabled | No independent reviewer is launched automatically. |
| P10 | Gate enabled; reviewer fails or returns invalid result | Publication remains blocked. |
| P11 | Reviewed document, request, acceptance criteria, or material decision changes | Approval invalidated; new review needed if enabled. |
| P12 | Publish spec | Correct `./doc/` path; draft retained; no silent overwrite. |
| P13 | Publish plan | Required stage content/pass conditions and correct plan path. |
| P14 | User chooses stop after plan | No implementation tool calls or workers launched. |
| P15 | Planning-only request completes | Artifact completion reported without claiming implementation. |

### 18.4 Workers, state, and platforms

| ID | Scenario | Required result |
|---|---|---|
| D01 | All four implementation/verification driver combinations | Same TODO contracts; correct responsible actor. |
| D02 | No model override | Inherit current provider/model/effective thinking at dispatch. |
| D03 | Tier override or parent model changes | Deterministic resolution; existing job unchanged. |
| D04 | Unavailable model/provider or unsupported thinking | Actionable block or disclosed effective thinking; no silent model swap. |
| D05 | Child exits zero with assistant error/abort | Invalid/failed worker result. |
| D06 | Worker tries to finish parent or recursively delegate | Rejected by role/capability guards. |
| D07 | Two writers claim same work item | One owner; no lost update. |
| D08 | Crash between snapshot/projection/publication writes | Recover last valid state and reconcile partial publication. |
| D09 | Fork, compaction, reload, session switch | No duplicate ownership, lost state, or stale callback advancement. |
| D10 | Malformed state/new schema/readonly disk | Safe error and no false advancement. |
| D11 | Spaces, Unicode, reserved names, case collisions, symlinks | Safe paths on Windows/macOS/Linux. |
| D12 | Missing realtasks or unsupported Pi surface | Doctor explains problem; no invented fallback API. |

Test the state reducer/guards with deterministic unit tests, UI interactions with component tests, and lifecycle integration against the supported Pi/realtasks versions. Include at least one real end-to-end scenario on Windows and one POSIX platform. Mock tests alone cannot establish actual re-adoption, shell quoting, or abort behavior.

## 19. V1 delivery boundaries

A useful implementation sequence, without authorizing implementation now:

1. State/ownership persistence, command UX, completion contracts, and lightweight goals.
2. Realtasks waiting/reconciliation, abort behavior, and continuation-race tests.
3. Deep planning, durable questions/TODOs, finalization, and publication gates.
4. Browser alternatives with safe callback handling and terminal fallback.
5. Worker dispatch, tiered model inheritance, draft reviews, and execution/verification drivers.
6. Recovery, platform checks, and end-to-end acceptance coverage.

V1 is complete only when the requested planning, visual selection, optional gate, both execution drivers, and resumability are present—not merely when the continuation loop works.

Deferred: distributed execution, concurrent mutating workers, automatic Git/worktree/PR workflows, arbitrary remote preview hosting, and a general plugin SDK for workflow definitions.

## 20. Research limits and implementation validation

This specification was developed from the user's requirements, three confirmed design choices, installed Pi documentation/examples, and direct inspection of realtasks and Superpowers sources.

- No extension code was implemented or executed to validate these integrations.
- Broad web search was unavailable because no search API key was configured; direct source fetching worked.
- Source-observed realtasks metadata needs compatibility tests before being treated as a reliable adapter contract.
- Child provider availability, project trust, exact abort behavior, Windows process transport, and nested-tool composition need end-to-end validation.
- The current Pi plan-mode example is useful UI inspiration, but its assistant-text completion markers are deliberately not used as Realgoal's completion authority.
- Superpowers is inspiration, not a runtime dependency. Its mandatory builder review, paths, commits, and other skill rules are not inherited. In particular, this user's independent draft review remains optional and disabled by default.
- Remaining engineering choices may change internals, but must not silently alter the confirmed commands, paths, approval gates, wait semantics, or model-inheritance contract.

## 21. Sources

### Pi documentation and examples

The research used the locally installed **1.5.0** documentation under `@earendil-works/pi-coding-agent`; the repository links below provide browsable upstream counterparts and may evolve.

- **[P1]** [Pi extensions: lifecycle, commands, tools, nested tool calls, UI, and state](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- **[P2]** [Pi terminal UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)
- **[P3]** [Pi CLI integration and JSON-process semantics](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli-integration.md)
- **[P4]** [Pi command-line options and resource isolation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)
- **[P5]** [Pi subagent example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)
- **[P6]** [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- **[P7]** [Pi plan-mode example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/plan-mode)

### Realtasks — inspected revision pinned

- **[R1]** [README](https://github.com/st0nie/realtasks/blob/7b3df80cf2b630bd2e9d9d3578d39d11d23fb884/README.md)
- **[R2]** [Extension entry point and lifecycle integration](https://github.com/st0nie/realtasks/blob/7b3df80cf2b630bd2e9d9d3578d39d11d23fb884/index.ts)
- **[R3]** [Notification implementation](https://github.com/st0nie/realtasks/blob/7b3df80cf2b630bd2e9d9d3578d39d11d23fb884/src/notify.ts)
- **[R4]** [Task tools and structured result details](https://github.com/st0nie/realtasks/blob/7b3df80cf2b630bd2e9d9d3578d39d11d23fb884/src/tools/tasks.ts)
- **[R5]** [Package metadata and compatibility](https://github.com/st0nie/realtasks/blob/7b3df80cf2b630bd2e9d9d3578d39d11d23fb884/package.json)
- **[R6]** [Architecture document](https://github.com/st0nie/realtasks/blob/7b3df80cf2b630bd2e9d9d3578d39d11d23fb884/docs/realtasks-architecture.md)
- **[R7]** [Task manager and re-adoption](https://github.com/st0nie/realtasks/blob/7b3df80cf2b630bd2e9d9d3578d39d11d23fb884/src/manager.ts)
- **[R8]** [Background Bash integration](https://github.com/st0nie/realtasks/blob/7b3df80cf2b630bd2e9d9d3578d39d11d23fb884/src/tools/bash.ts)
- **[R9]** [Task status and record types](https://github.com/st0nie/realtasks/blob/7b3df80cf2b630bd2e9d9d3578d39d11d23fb884/src/types.ts)

### Superpowers — design references, not dependencies

- **[S1]** [Brainstorming](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md)
- **[S2]** [Visual companion](https://github.com/obra/superpowers/blob/main/skills/brainstorming/visual-companion.md)
- **[S3]** [Writing plans](https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md)
- **[S4]** [Executing plans](https://github.com/obra/superpowers/blob/main/skills/executing-plans/SKILL.md)
