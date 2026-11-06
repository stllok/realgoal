import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as http from "node:http"
import * as path from "node:path"
import { Context, Deferred, Effect, Layer, Option, Schema, SynchronizedRef } from "effect"
import {
  PreviewSecurityError,
  QuestionConflictError,
  type RealgoalError,
} from "../domain/errors.ts"
import type {
  DurableQuestion,
  PreviewArtifact,
  QuestionAnswer,
  WorkItemState,
} from "../domain/models.ts"
import { resolveWithinRoot, sanitizeSvgContent, sha256Hex } from "./path-safety.ts"

const MAX_SUBMIT_BODY_BYTES = 16 * 1024
const LAUNCH_TOKEN_TTL_MS = 10 * 60 * 1000

const BrowserSubmitPayloadSchema = Schema.Struct({
  workItemId: Schema.String,
  questionId: Schema.String,
  questionRevision: Schema.Int,
  previewRevision: Schema.OptionFromOptionalKey(Schema.Int),
  selectedOptionIds: Schema.Array(Schema.String),
  customText: Schema.OptionFromOptionalKey(Schema.String),
  comments: Schema.OptionFromOptionalKey(Schema.String),
})

interface LaunchTokenRecord {
  readonly workItemId: string
  readonly questionId: string
  readonly generation: number
  readonly expiresAtMs: number
}

interface SessionCredentialRecord {
  readonly sessionCookie: string
  readonly csrfToken: string
  readonly generation: number
}

interface ActivePreviewBinding {
  readonly workItemId: string
  readonly safeDirName: string
  readonly draftPrevewsRoot: string
  readonly externalAssetsAllowed: boolean
  readonly getStateSnapshot: () => Effect.Effect<Option.Option<WorkItemState>, never>
  readonly onBrowserSubmit: (params: {
    readonly workItemId: string
    readonly questionId: string
    readonly expectedQuestionRevision: number
    readonly answer: QuestionAnswer
  }) => Effect.Effect<WorkItemState, RealgoalError>
}

interface PreviewRuntimeState {
  readonly generation: number
  readonly host: string
  readonly portOpt: Option.Option<number>
  readonly serverOpt: Option.Option<http.Server>
  readonly launchTokens: ReadonlyMap<string, LaunchTokenRecord>
  readonly sessions: ReadonlyMap<string, SessionCredentialRecord>
  readonly bindings: ReadonlyMap<string, ActivePreviewBinding>
  readonly waiters: ReadonlyMap<string, Deferred.Deferred<QuestionAnswer, QuestionConflictError>>
}

const escapeHtml = (raw: string): string =>
  raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

const buildPrototypeCsp = (externalAssets: boolean): string => {
  const assetSrc = externalAssets ? "'self' data: https:" : "'self' data:"
  const styleSrc = externalAssets ? "'unsafe-inline' 'self' https:" : "'unsafe-inline' 'self'"
  return [
    "default-src 'none'",
    `style-src ${styleSrc}`,
    `img-src ${assetSrc}`,
    `font-src ${assetSrc}`,
    "script-src 'none'",
    "object-src 'none'",
    "media-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
  ].join("; ")
}

const buildWrapperCsp = (nonce: string): string =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "frame-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ")

const contentTypeForExt = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8"
    case ".svg":
      return "image/svg+xml; charset=utf-8"
    case ".css":
      return "text/css; charset=utf-8"
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".webp":
      return "image/webp"
    case ".woff2":
      return "font/woff2"
    default:
      return "application/octet-stream"
  }
}

const parseCookies = (cookieHeader: string | undefined): Record<string, string> => {
  if (!cookieHeader) return {}
  const out: Record<string, string> = {}
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=")
    if (eq > 0) {
      const k = part.slice(0, eq).trim()
      const v = part.slice(eq + 1).trim()
      out[k] = v
    }
  }
  return out
}

const readBoundedBody = (req: http.IncomingMessage, maxBytes: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on("data", (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        req.destroy()
        reject(new Error(`Payload exceeds limit (${maxBytes} bytes)`))
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })

const renderResolvedOrPausedPage = (
  title: string,
  statusBadge: string,
  detail: string,
): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="referrer" content="no-referrer" />
<title>${escapeHtml(title)} — Realgoal Preview</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { max-width: 560px; background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 28px; box-shadow: 0 10px 30px rgba(0,0,0,0.4); }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; background: #334155; color: #93c5fd; font-size: 12px; font-weight: 600; text-transform: uppercase; margin-bottom: 12px; }
  h1 { margin: 0 0 10px; font-size: 20px; }
  p { margin: 0; color: #94a3b8; line-height: 1.5; }
</style>
</head>
<body>
  <main class="card" role="main">
    <span class="badge">${escapeHtml(statusBadge)}</span>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
  </main>
</body>
</html>`

const renderQuestionComparisonPage = (params: {
  readonly state: WorkItemState
  readonly question: DurableQuestion
  readonly previewOpt: Option.Option<PreviewArtifact>
  readonly csrfToken: string
  readonly nonce: string
}): string => {
  const preview = Option.getOrUndefined(params.previewOpt)
  const optionRows = params.question.options.map((opt, idx) => {
    const previewMatch = preview?.options.find((po) => po.id === opt.id)
    const assetUrl =
      preview && previewMatch
        ? `/asset/${encodeURIComponent(params.state.id)}/${encodeURIComponent(preview.id)}/${previewMatch.relativeHtmlOrSvgPath
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`
        : ""
    const rationale = Option.getOrElse(opt.rationale, () => previewMatch?.rationale ?? "")
    return `
      <div class="opt-card" data-opt-id="${escapeHtml(opt.id)}" data-asset-url="${escapeHtml(assetUrl)}" tabindex="0" role="button" aria-pressed="false">
        <div class="opt-head">
          <input type="${params.question.multiSelect ? "checkbox" : "radio"}" name="rg_choice" value="${escapeHtml(opt.id)}" id="opt_${idx}" />
          <label for="opt_${idx}"><strong>${escapeHtml(opt.label)}</strong></label>
        </div>
        <div class="opt-desc">${escapeHtml(opt.description)}</div>
        ${rationale ? `<div class="opt-rat">Trade-offs: ${escapeHtml(rationale)}</div>` : ""}
      </div>`
  })

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="referrer" content="no-referrer" />
<title>${escapeHtml(params.question.title)} — Realgoal Design Review</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0b1120; color: #e2e8f0; height: 100vh; display: grid; grid-template-columns: 380px 1fr; }
  aside { border-right: 1px solid #1e293b; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; background: #0f172a; }
  main { display: flex; flex-direction: column; height: 100vh; background: #020617; }
  h1 { font-size: 18px; margin: 0; }
  .meta { font-size: 12px; color: #94a3b8; }
  .prompt { font-size: 14px; line-height: 1.45; color: #cbd5e1; }
  .opt-card { border: 1px solid #334155; border-radius: 8px; padding: 12px; cursor: pointer; background: #1e293b; transition: border-color 0.15s; }
  .opt-card.active { border-color: #38bdf8; background: #172554; }
  .opt-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .opt-desc { font-size: 13px; color: #cbd5e1; }
  .opt-rat { font-size: 12px; color: #94a3b8; margin-top: 6px; }
  textarea { width: 100%; min-height: 68px; border-radius: 6px; border: 1px solid #334155; background: #1e293b; color: #f8fafc; padding: 8px; font-family: inherit; }
  button.submit-btn { padding: 10px 16px; border-radius: 8px; border: none; background: #0284c7; color: white; font-weight: 600; cursor: pointer; font-size: 14px; }
  button.submit-btn:hover { background: #0369a1; }
  .frame-bar { padding: 10px 16px; border-bottom: 1px solid #1e293b; font-size: 13px; color: #94a3b8; background: #0f172a; }
  iframe { flex: 1; width: 100%; border: none; background: #ffffff; }
  #status_msg { font-size: 13px; min-height: 18px; }
</style>
</head>
<body>
  <aside aria-label="Question options and decision controls">
    <div class="meta">${escapeHtml(params.state.displayName)} · ${escapeHtml(params.question.id)} (rev ${params.question.revision})</div>
    <h1>${escapeHtml(params.question.title)}</h1>
    <div class="prompt">${escapeHtml(params.question.prompt)}</div>
    <div id="options_list">${optionRows.join("\n")}</div>
    ${
      params.question.allowFreeText
        ? `<div><label for="custom_text" class="meta">Custom answer (optional):</label><textarea id="custom_text" placeholder="Type a custom direction..."></textarea></div>`
        : ""
    }
    <div>
      <label for="comments_text" class="meta">Comments / refinement notes (optional):</label>
      <textarea id="comments_text" placeholder="Specific elements you want kept or changed..."></textarea>
    </div>
    <button type="button" class="submit-btn" id="submit_btn">Submit choice</button>
    <div id="status_msg" role="status" aria-live="polite"></div>
  </aside>
  <main aria-label="Sandboxed visual mockup preview">
    <div class="frame-bar" id="frame_label">Select an option card on the left to inspect its static preview. Clicking a card only previews; click "Submit choice" to commit.</div>
    <iframe id="preview_frame" sandbox="" referrerpolicy="no-referrer" title="Design alternative preview"></iframe>
  </main>
  <script nonce="${escapeHtml(params.nonce)}">
    (function() {
      const cards = Array.from(document.querySelectorAll('.opt-card'));
      const frame = document.getElementById('preview_frame');
      const frameLabel = document.getElementById('frame_label');
      const statusMsg = document.getElementById('status_msg');
      const submitBtn = document.getElementById('submit_btn');

      function focusPreview(card) {
        cards.forEach(c => { c.classList.remove('active'); c.setAttribute('aria-pressed', 'false'); });
        card.classList.add('active');
        card.setAttribute('aria-pressed', 'true');
        const url = card.getAttribute('data-asset-url');
        const id = card.getAttribute('data-opt-id');
        if (url) {
          frame.src = url;
          frameLabel.textContent = 'Previewing option: ' + id + ' (static sandboxed frame)';
        } else {
          frame.removeAttribute('src');
          frameLabel.textContent = 'Option ' + id + ' has no visual attachment.';
        }
      }

      cards.forEach((card, index) => {
        card.addEventListener('click', (e) => {
          const input = card.querySelector('input');
          if (e.target !== input && input) {
            if (input.type === 'radio') input.checked = true;
            else input.checked = !input.checked;
          }
          focusPreview(card);
        });
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            card.click();
          }
        });
        if (index === 0) focusPreview(card);
      });

      submitBtn.addEventListener('click', async () => {
        const selected = Array.from(document.querySelectorAll('input[name="rg_choice"]:checked')).map(i => i.value);
        const customEl = document.getElementById('custom_text');
        const commentsEl = document.getElementById('comments_text');
        const customText = customEl && customEl.value.trim() ? customEl.value.trim() : undefined;
        const comments = commentsEl && commentsEl.value.trim() ? commentsEl.value.trim() : undefined;

        submitBtn.disabled = true;
        statusMsg.textContent = 'Submitting decision...';
        try {
          const payload = {
            workItemId: ${JSON.stringify(params.state.id)},
            questionId: ${JSON.stringify(params.question.id)},
            questionRevision: ${params.question.revision},
            ${preview ? `previewRevision: ${preview.revision},` : ""}
            selectedOptionIds: selected,
            ...(customText ? { customText } : {}),
            ...(comments ? { comments } : {})
          };
          const res = await fetch('/api/submit', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Realgoal-CSRF': ${JSON.stringify(params.csrfToken)}
            },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (!res.ok) {
            statusMsg.style.color = '#f87171';
            statusMsg.textContent = data.error || 'Submission rejected';
            submitBtn.disabled = false;
            return;
          }
          window.location.reload();
        } catch (err) {
          statusMsg.style.color = '#f87171';
          statusMsg.textContent = String(err);
          submitBtn.disabled = false;
        }
      });
    })();
  </script>
</body>
</html>`
}

export interface ValidatedPreviewInputOption {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly rationale: string
  readonly relativePath: string
}

export class PreviewService extends Context.Service<
  PreviewService,
  {
    readonly validateAndRegisterPreview: (params: {
      readonly draftDir: string
      readonly previewId: string
      readonly revision: number
      readonly title: string
      readonly questionId: Option.Option<string>
      readonly options: ReadonlyArray<ValidatedPreviewInputOption>
      readonly externalAssetsAllowed: boolean
      readonly iconSetLicenseNote: Option.Option<string>
      readonly nowIso: string
    }) => Effect.Effect<PreviewArtifact, RealgoalError>
    readonly ensureServerAndCreateLaunchUrl: (params: {
      readonly host: string
      readonly binding: ActivePreviewBinding
      readonly questionId: string
    }) => Effect.Effect<{ readonly launchUrl: string; readonly port: number }, PreviewSecurityError>
    readonly registerQuestionWaiter: (
      workItemId: string,
      questionId: string,
    ) => Effect.Effect<Deferred.Deferred<QuestionAnswer, QuestionConflictError>, never>
    readonly resolveQuestionWaiter: (
      workItemId: string,
      questionId: string,
      answer: QuestionAnswer,
    ) => Effect.Effect<boolean, never>
    readonly clearQuestionWaiter: (workItemId: string, questionId: string) => Effect.Effect<void, never>
    readonly invalidateGenerationAndStop: () => Effect.Effect<void, never>
  }
>()("realgoal/services/PreviewService") {
  static readonly layer = Layer.effect(
    PreviewService,
    Effect.Do.pipe(
      Effect.bind("stateRef", () =>
        SynchronizedRef.make<PreviewRuntimeState>({
          generation: 1,
          host: "127.0.0.1",
          portOpt: Option.none(),
          serverOpt: Option.none(),
          launchTokens: new Map(),
          sessions: new Map(),
          bindings: new Map(),
          waiters: new Map(),
        }),
      ),
      Effect.bind("service", ({ stateRef }) => {
        const waiterKey = (workItemId: string, questionId: string): string => `${workItemId}::${questionId}`

        const closeServerIfAny = (srvOpt: Option.Option<http.Server>): Effect.Effect<void, never> =>
          Option.match(srvOpt, {
            onNone: () => Effect.void,
            onSome: (srv) =>
              Effect.callback<void>((resume) => {
                srv.close(() => resume(Effect.void))
              }).pipe(
                Effect.timeout("2 seconds"),
                Effect.ignore,
              ),
          })

        const invalidateAll = (): Effect.Effect<void, never> =>
          SynchronizedRef.modifyEffect(stateRef, (st) =>
            Effect.forEach([...st.waiters.values()], (d) =>
              Deferred.fail(
                d,
                new QuestionConflictError({
                  workItemId: "invalidated",
                  questionId: "invalidated",
                  status: "paused_or_cancelled",
                  message: "Preview session invalidated by reload, session switch, or shutdown",
                }),
              ).pipe(Effect.ignore),
            ).pipe(
              Effect.flatMap(() => closeServerIfAny(st.serverOpt)),
              Effect.map(
                () =>
                  [
                    undefined,
                    {
                      generation: st.generation + 1,
                      host: st.host,
                      portOpt: Option.none(),
                      serverOpt: Option.none(),
                      launchTokens: new Map(),
                      sessions: new Map(),
                      bindings: new Map(),
                      waiters: new Map(),
                    } satisfies PreviewRuntimeState,
                  ] as const,
              ),
            ),
          )

        const isAllowedHostHeader = (hostHeader: string | undefined, expectedPort: number): boolean => {
          if (!hostHeader) return false
          return (
            hostHeader === `127.0.0.1:${expectedPort}` ||
            hostHeader === `localhost:${expectedPort}` ||
            hostHeader === `[::1]:${expectedPort}`
          )
        }

        const isAllowedOriginHeader = (originHeader: string | undefined, expectedPort: number): boolean => {
          if (!originHeader) return false
          return (
            originHeader === `http://127.0.0.1:${expectedPort}` ||
            originHeader === `http://localhost:${expectedPort}` ||
            originHeader === `http://[::1]:${expectedPort}`
          )
        }

        const handleHttpRequest = (
          req: http.IncomingMessage,
          res: http.ServerResponse,
        ): void => {
          void Effect.runPromise(
            SynchronizedRef.get(stateRef).pipe(
              Effect.flatMap((st): Effect.Effect<void, never> => {
                const port = Option.getOrElse(st.portOpt, () => 0)
                res.setHeader("Referrer-Policy", "no-referrer")
                res.setHeader("X-Content-Type-Options", "nosniff")

                if (!isAllowedHostHeader(req.headers.host, port)) {
                  res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" })
                  res.end("Forbidden host")
                  return Effect.void
                }

                const parsedUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`)

                if (req.method === "GET" && parsedUrl.pathname === "/launch") {
                  const token = parsedUrl.searchParams.get("t") ?? ""
                  return SynchronizedRef.modify(stateRef, (cur) => {
                    const found = cur.launchTokens.get(token)
                    if (
                      !found ||
                      found.generation !== cur.generation ||
                      Date.now() > found.expiresAtMs
                    ) {
                      return [Option.none<{ cookie: string; redirect: string }>(), cur] as const
                    }
                    const nextLaunch = new Map(cur.launchTokens)
                    nextLaunch.delete(token)
                    const sessionCookie = crypto.randomBytes(24).toString("hex")
                    const csrfToken = crypto.randomBytes(24).toString("hex")
                    const nextSessions = new Map(cur.sessions)
                    nextSessions.set(sessionCookie, {
                      sessionCookie,
                      csrfToken,
                      generation: cur.generation,
                    })
                    return [
                      Option.some({
                        cookie: sessionCookie,
                        redirect: `/q/${encodeURIComponent(found.workItemId)}/${encodeURIComponent(found.questionId)}`,
                      }),
                      {
                        ...cur,
                        launchTokens: nextLaunch,
                        sessions: nextSessions,
                      },
                    ] as const
                  }).pipe(
                    Effect.tap((sessionOpt) =>
                      Effect.sync(() => {
                        if (Option.isNone(sessionOpt)) {
                          res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" })
                          res.end(
                            renderResolvedOrPausedPage(
                              "Launch Link Expired or Invalid",
                              "Unauthorized",
                              "Request a fresh preview link from Pi using /realgoal preview.",
                            ),
                          )
                          return
                        }
                        res.writeHead(303, {
                          Location: sessionOpt.value.redirect,
                          "Set-Cookie": `rg_session=${sessionOpt.value.cookie}; HttpOnly; SameSite=Strict; Path=/`,
                        })
                        res.end()
                      }),
                    ),
                    Effect.asVoid,
                  )
                }

                const cookies = parseCookies(req.headers.cookie)
                const sessionRec = cookies["rg_session"] ? st.sessions.get(cookies["rg_session"]) : undefined
                if (!sessionRec || sessionRec.generation !== st.generation) {
                  res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" })
                  res.end(
                    renderResolvedOrPausedPage(
                      "Preview Session Required",
                      "Forbidden",
                      "Open this preview via the active launch URL generated by Realgoal in Pi.",
                    ),
                  )
                  return Effect.void
                }

                if (req.method === "GET" && parsedUrl.pathname.startsWith("/q/")) {
                  const segs = parsedUrl.pathname.slice(3).split("/").map(decodeURIComponent)
                  const workItemId = segs[0] ?? ""
                  const questionId = segs[1] ?? ""
                  const binding = st.bindings.get(workItemId)
                  if (!binding) {
                    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" })
                    res.end(renderResolvedOrPausedPage("Unknown Work Item", "Not Found", "No active preview binding."))
                    return Effect.void
                  }
                  return binding.getStateSnapshot().pipe(
                    Effect.tap((snapOpt) =>
                      Effect.sync(() => {
                        const nonce = crypto.randomBytes(16).toString("base64")
                        res.setHeader("Content-Security-Policy", buildWrapperCsp(nonce))
                        if (Option.isNone(snapOpt)) {
                          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" })
                          res.end(renderResolvedOrPausedPage("State Unavailable", "Missing", "Work item not found."))
                          return
                        }
                        const snap = snapOpt.value
                        const question = snap.questions.find((q) => q.id === questionId)
                        if (!question) {
                          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" })
                          res.end(
                            renderResolvedOrPausedPage("Question Not Found", "Not Found", `No question ${questionId}.`),
                          )
                          return
                        }
                        if (
                          question.status !== "pending" ||
                          snap.runStatus === "paused" ||
                          snap.runStatus === "cancelled" ||
                          snap.runStatus === "finished"
                        ) {
                          const badge =
                            question.status === "answered" ? "Decision Recorded" : snap.runStatus
                          const detail =
                            question.status === "answered"
                              ? "Your choice has been saved to the draft and this question is now closed. Return to Pi to continue."
                              : `This workflow is currently ${snap.runStatus}; stale choices cannot be submitted here.`
                          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
                          res.end(renderResolvedOrPausedPage(question.title, badge, detail))
                          return
                        }

                        const previewOpt = Option.flatMap(question.previewId, (pid) =>
                          Option.fromUndefinedOr(snap.previews.find((p) => p.id === pid)),
                        )
                        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
                        res.end(
                          renderQuestionComparisonPage({
                            state: snap,
                            question,
                            previewOpt,
                            csrfToken: sessionRec.csrfToken,
                            nonce,
                          }),
                        )
                      }),
                    ),
                    Effect.asVoid,
                  )
                }

                if (req.method === "GET" && parsedUrl.pathname.startsWith("/asset/")) {
                  const rest = parsedUrl.pathname.slice("/asset/".length).split("/").map(decodeURIComponent)
                  const workItemId = rest[0] ?? ""
                  const previewId = rest[1] ?? ""
                  const relAsset = rest.slice(2).join("/")
                  const binding = st.bindings.get(workItemId)
                  if (!binding || !previewId || !relAsset) {
                    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
                    res.end("Not found")
                    return Effect.void
                  }

                  return resolveWithinRoot(binding.draftPrevewsRoot, previewId).pipe(
                    Effect.flatMap((previewRoot) => resolveWithinRoot(previewRoot, relAsset)),
                    Effect.flatMap((safeAssetPath) =>
                      Effect.tryPromise({
                        try: () => fs.readFile(safeAssetPath),
                        catch: () => null,
                      }).pipe(
                        Effect.orElseSucceed(() => null),
                        Effect.flatMap((buf) => {
                          if (buf === null) {
                            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
                            res.end("Asset not found")
                            return Effect.void
                          }
                          const ext = path.extname(safeAssetPath).toLowerCase()
                          if (ext === ".svg") {
                            return sanitizeSvgContent(buf.toString("utf8"), binding.externalAssetsAllowed).pipe(
                              Effect.tap((cleanSvg) =>
                                Effect.sync(() => {
                                  res.writeHead(200, {
                                    "Content-Type": contentTypeForExt(safeAssetPath),
                                    "Content-Security-Policy": buildPrototypeCsp(binding.externalAssetsAllowed),
                                  })
                                  res.end(cleanSvg)
                                }),
                              ),
                              Effect.catch(() =>
                                Effect.sync(() => {
                                  res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
                                  res.end("Invalid SVG")
                                }),
                              ),
                            )
                          }
                          res.writeHead(200, {
                            "Content-Type": contentTypeForExt(safeAssetPath),
                            "Content-Security-Policy": buildPrototypeCsp(binding.externalAssetsAllowed),
                          })
                          res.end(buf)
                          return Effect.void
                        }),
                      ),
                    ),
                    Effect.catch(() =>
                      Effect.sync(() => {
                        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" })
                        res.end("Forbidden asset path")
                      }),
                    ),
                  )
                }

                if (req.method === "POST" && parsedUrl.pathname === "/api/submit") {
                  if (!isAllowedOriginHeader(req.headers.origin, port)) {
                    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" })
                    res.end(JSON.stringify({ ok: false, error: "Cross-origin callback rejected" }))
                    return Effect.void
                  }
                  const csrfHeader = req.headers["x-realgoal-csrf"]
                  if (csrfHeader !== sessionRec.csrfToken) {
                    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" })
                    res.end(JSON.stringify({ ok: false, error: "Invalid CSRF capability token" }))
                    return Effect.void
                  }

                  return Effect.tryPromise({
                    try: () => readBoundedBody(req, MAX_SUBMIT_BODY_BYTES),
                    catch: (err) => (err as Error).message,
                  }).pipe(
                    Effect.flatMap((rawBody) =>
                      Effect.try({
                        try: () => JSON.parse(rawBody) as unknown,
                        catch: () => "Malformed JSON payload",
                      }),
                    ),
                    Effect.flatMap((parsed) =>
                      Schema.decodeUnknownEffect(BrowserSubmitPayloadSchema)(parsed).pipe(
                        Effect.mapError((e) => `Invalid submission payload: ${e.message}`),
                      ),
                    ),
                    Effect.flatMap((payload) => {
                      const binding = st.bindings.get(payload.workItemId)
                      if (!binding) {
                        return Effect.fail("Work item preview binding is no longer active")
                      }
                      const answer: QuestionAnswer = {
                        selectedOptionIds: payload.selectedOptionIds,
                        customText: payload.customText,
                        comments: payload.comments,
                        source: "browser",
                        answeredAt: new Date().toISOString(),
                        previewRevision: payload.previewRevision,
                      }
                      return binding
                        .onBrowserSubmit({
                          workItemId: payload.workItemId,
                          questionId: payload.questionId,
                          expectedQuestionRevision: payload.questionRevision,
                          answer,
                        })
                        .pipe(
                          Effect.map(() => ({ payload, answer })),
                          Effect.mapError((err) =>
                            err._tag === "QuestionConflictError" ? err.message : String(err),
                          ),
                        )
                    }),
                    Effect.matchEffect({
                      onSuccess: ({ payload, answer }) =>
                        Effect.sync(() => {
                          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
                          res.end(JSON.stringify({ ok: true }))
                        }).pipe(
                          Effect.flatMap(() =>
                            SynchronizedRef.modifyEffect(stateRef, (cur) => {
                              const key = waiterKey(payload.workItemId, payload.questionId)
                              const waiter = cur.waiters.get(key)
                              if (!waiter) return Effect.succeed([undefined, cur] as const)
                              const nextWaiters = new Map(cur.waiters)
                              nextWaiters.delete(key)
                              return Deferred.succeed(waiter, answer).pipe(
                                Effect.ignore,
                                Effect.as([undefined, { ...cur, waiters: nextWaiters }] as const),
                              )
                            }),
                          ),
                        ),
                      onFailure: (errMsg) =>
                        Effect.sync(() => {
                          res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" })
                          res.end(JSON.stringify({ ok: false, error: errMsg }))
                        }),
                    }),
                  )
                }

                res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
                res.end("Not found")
                return Effect.void
              }),
            ),
          )
        }

        const startLoopbackServer = (
          host: string,
        ): Effect.Effect<{ readonly server: http.Server; readonly port: number }, PreviewSecurityError> => {
          if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
            return Effect.fail(
              new PreviewSecurityError({
                reason: `Refusing to bind preview server to non-loopback host: ${host}`,
                path: Option.none(),
              }),
            )
          }
          return Effect.callback<{ readonly server: http.Server; readonly port: number }, PreviewSecurityError>(
            (resume) => {
              const server = http.createServer(handleHttpRequest)
              server.once("error", (err) => {
                resume(
                  Effect.fail(
                    new PreviewSecurityError({
                      reason: `Failed binding loopback preview server on ${host}: ${err.message}`,
                      path: Option.none(),
                    }),
                  ),
                )
              })
              server.listen(0, host, () => {
                const addr = server.address()
                if (!addr || typeof addr === "string") {
                  server.close()
                  resume(
                    Effect.fail(
                      new PreviewSecurityError({
                        reason: "Unexpected Unix socket address on preview server",
                        path: Option.none(),
                      }),
                    ),
                  )
                  return
                }
                resume(Effect.succeed({ server, port: addr.port }))
              })
            },
          )
        }

        return Effect.acquireRelease(
          Effect.succeed(
            PreviewService.of({
              validateAndRegisterPreview: (params) =>
                Effect.Do.pipe(
                  Effect.tap((): Effect.Effect<void, RealgoalError> => {
                    if (params.options.length < 1 || params.options.length > 4) {
                      return Effect.fail(
                        new PreviewSecurityError({
                          reason: `Preview must provide 1 to 4 visual options (got ${params.options.length})`,
                          path: Option.none(),
                        }),
                      )
                    }
                    return Effect.void
                  }),
                  Effect.bind("previewsRoot", () => resolveWithinRoot(params.draftDir, "previews")),
                  Effect.bind("previewDir", ({ previewsRoot }) =>
                    resolveWithinRoot(previewsRoot, params.previewId),
                  ),
                  Effect.bind("validatedOptions", ({ previewDir }) =>
                    Effect.forEach(params.options, (opt) =>
                      resolveWithinRoot(previewDir, opt.relativePath).pipe(
                        Effect.flatMap((fullPath): Effect.Effect<PreviewArtifact["options"][number], RealgoalError> => {
                          const ext = path.extname(fullPath).toLowerCase()
                          if (ext !== ".html" && ext !== ".htm" && ext !== ".svg") {
                            return Effect.fail(
                              new PreviewSecurityError({
                                reason: `Preview option ${opt.id} must be static .html or .svg (got ${ext || "no ext"})`,
                                path: Option.some(opt.relativePath),
                              }),
                            )
                          }
                          return Effect.tryPromise({
                            try: () => fs.readFile(fullPath, "utf8"),
                            catch: (err) =>
                              new PreviewSecurityError({
                                reason: `Preview file unreadable (${opt.relativePath}): ${(err as Error).message}`,
                                path: Option.some(opt.relativePath),
                              }),
                          }).pipe(
                            Effect.flatMap((rawContent) => {
                              if (rawContent.trim().length < 20) {
                                return Effect.fail(
                                  new PreviewSecurityError({
                                    reason: `Preview option ${opt.id} must be an actual visual mockup, not an empty/stub label`,
                                    path: Option.some(opt.relativePath),
                                  }),
                                )
                              }
                              if (ext === ".svg") {
                                return sanitizeSvgContent(rawContent, params.externalAssetsAllowed).pipe(
                                  Effect.tap((cleanSvg) =>
                                    Effect.tryPromise({
                                      try: () => fs.writeFile(fullPath, cleanSvg, "utf8"),
                                      catch: (err) =>
                                        new PreviewSecurityError({
                                          reason: `Failed writing sanitized SVG: ${(err as Error).message}`,
                                          path: Option.some(opt.relativePath),
                                        }),
                                    }),
                                  ),
                                  Effect.map((cleanSvg) => ({
                                    id: opt.id,
                                    title: opt.title,
                                    description: opt.description,
                                    rationale: opt.rationale,
                                    relativeHtmlOrSvgPath: opt.relativePath.replace(/\\/g, "/"),
                                    sha256: sha256Hex(cleanSvg),
                                  })),
                                )
                              }
                              if (/<script\b/i.test(rawContent) || /\bon[a-z]+\s*=/i.test(rawContent)) {
                                return Effect.fail(
                                  new PreviewSecurityError({
                                    reason: `Preview HTML (${opt.relativePath}) must be static and must not include executable <script> tags or inline event handlers`,
                                    path: Option.some(opt.relativePath),
                                  }),
                                )
                              }
                              if (
                                !params.externalAssetsAllowed &&
                                /\b(?:src|href)\s*=\s*["']https?:\/\//i.test(rawContent)
                              ) {
                                return Effect.fail(
                                  new PreviewSecurityError({
                                    reason: `Preview HTML (${opt.relativePath}) references external HTTP(S) assets while browser.externalAssets is false`,
                                    path: Option.some(opt.relativePath),
                                  }),
                                )
                              }
                              return Effect.succeed({
                                id: opt.id,
                                title: opt.title,
                                description: opt.description,
                                rationale: opt.rationale,
                                relativeHtmlOrSvgPath: opt.relativePath.replace(/\\/g, "/"),
                                sha256: sha256Hex(rawContent),
                              })
                            }),
                          )
                        }),
                      ),
                    ),
                  ),
                  Effect.map(({ validatedOptions }): PreviewArtifact => ({
                    id: params.previewId,
                    revision: params.revision,
                    title: params.title,
                    questionId: params.questionId,
                    rootRelativeDir: `previews/${params.previewId}`,
                    options: validatedOptions,
                    iconSetLicenseNote: params.iconSetLicenseNote,
                    createdAt: params.nowIso,
                  })),
                ),

              ensureServerAndCreateLaunchUrl: (params) =>
                SynchronizedRef.modifyEffect(stateRef, (st) =>
                  (Option.isSome(st.serverOpt) && Option.isSome(st.portOpt)
                    ? Effect.succeed({ server: st.serverOpt.value, port: st.portOpt.value })
                    : startLoopbackServer(params.host)
                  ).pipe(
                    Effect.map(({ server, port }) => {
                      const transientToken = crypto.randomBytes(24).toString("hex")
                      const nextLaunch = new Map(st.launchTokens)
                      nextLaunch.set(transientToken, {
                        workItemId: params.binding.workItemId,
                        questionId: params.questionId,
                        generation: st.generation,
                        expiresAtMs: Date.now() + LAUNCH_TOKEN_TTL_MS,
                      })
                      const nextBindings = new Map(st.bindings)
                      nextBindings.set(params.binding.workItemId, params.binding)
                      const urlHost = params.host === "::1" ? "[::1]" : params.host
                      const launchUrl = `http://${urlHost}:${port}/launch?t=${transientToken}`
                      return [
                        { launchUrl, port },
                        {
                          ...st,
                          host: params.host,
                          serverOpt: Option.some(server),
                          portOpt: Option.some(port),
                          launchTokens: nextLaunch,
                          bindings: nextBindings,
                        },
                      ] as const
                    }),
                  ),
                ),

              registerQuestionWaiter: (workItemId, questionId) =>
                Deferred.make<QuestionAnswer, QuestionConflictError>().pipe(
                  Effect.tap((deferred) =>
                    SynchronizedRef.update(stateRef, (st) => {
                      const next = new Map(st.waiters)
                      next.set(waiterKey(workItemId, questionId), deferred)
                      return { ...st, waiters: next }
                    }),
                  ),
                ),

              resolveQuestionWaiter: (workItemId, questionId, answer) =>
                SynchronizedRef.modifyEffect(stateRef, (st) => {
                  const key = waiterKey(workItemId, questionId)
                  const waiter = st.waiters.get(key)
                  if (!waiter) return Effect.succeed([false, st] as const)
                  const next = new Map(st.waiters)
                  next.delete(key)
                  return Deferred.succeed(waiter, answer).pipe(
                    Effect.map((done) => [done, { ...st, waiters: next }] as const),
                  )
                }),

              clearQuestionWaiter: (workItemId, questionId) =>
                SynchronizedRef.update(stateRef, (st) => {
                  const next = new Map(st.waiters)
                  next.delete(waiterKey(workItemId, questionId))
                  return { ...st, waiters: next }
                }),

              invalidateGenerationAndStop: invalidateAll,
            }),
          ),
          () => invalidateAll(),
        )
      }),
      Effect.map(({ service }) => service),
    ),
  )
}
