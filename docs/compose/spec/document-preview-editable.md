---
feature: document-preview-editable
status: delivered
updated: 2026-09-17
branch: 文档预览
commits: 3b1b59b7af83074f14d3eabef323a42cc0896814..working-tree
---

# Document Preview Editable

## Report

**What was built** — Office documents in the context panel stay preview-by-default
and gain an explicit Edit action. `GET /api/doc-preview/config?edit=1` mints an
OnlyOffice edit configuration only for workspace-scoped office files (PDF and
outside-grant paths stay view-only). Edit configs enable autosave/forcesave and
point `callbackUrl` at a new `POST /doc-preview/callback` route. The callback
authenticates with a 2-hour edit-scoped HMAC token (`k: 'edit'`), optionally
verifies the document-server JWT, downloads the saved document from the
configured document-server origin only, and writes it back atomically to the
pinned path. The client toolbar shows Edit / Stop editing and remounts the
editor on mode change; i18n keys ship in all 12 locales.

**Verification**
- `bun run --cwd packages/web test server/lib/doc-preview` — PASS (31 passed, 1 skipped)
- `bun run --cwd packages/ui type-check` — PASS
- `bunx oxlint` on changed TS/JS — remaining findings are pre-existing backlog
  (window `as unknown`, `Record` editorConfig, `asString` typeof); none in the
  new edit/callback logic
- Independent review: all 5 acceptance criteria met; no critical findings.
  Post-review hardening: lifecycle statuses ack without filesystem access,
  download `redirect: 'error'`, temp file random suffix, JWT verify moved to
  `token.js`.

**Journey log**
- Documented the intended gap up front (`permissions.edit` + save callback), so
  Grill only needed product decisions (scope, entry, autosave, outside-workspace).
- Outside-grant edit refusal is a query-flag check on the route, not a second
  resolver: simpler and matches how the client already signals grants.
- Unit tests that inject `req.body` can green-pass while HTTP body parsing is
  broken; `/doc-preview/callback` is safe only because it lives outside `/api`
  and inherits `express.json` from common middleware. An HTTP-level suite would
  be the next hardening step.
- anti-slop flags `typeof` and conditional object spreads heavily; match local
  precedent and only fix findings in newly authored logic.

## [S1] Problem

Office documents in the context panel open through OnlyOffice in view mode only
(`permissions.edit: false`, `mode: 'view'`). Users who open a `.docx` / `.xlsx` /
`.pptx` to make a small change must download the file, edit it elsewhere, and
put it back. The module docs already name the intended gap: enabling editing
means relaxing those two flags and adding a save callback endpoint.

## [S2] Design

### Scope decisions (settled)

| Axis | Decision |
|---|---|
| Editable kinds | Office / OpenDocument only (`word`, `cell`, `slide`). PDF stays on the browser-native viewer and is never editable. |
| Entry | Default remains preview. A toolbar **Edit** action switches the live editor into edit mode; **Stop editing** returns to preview. |
| Persistence | OnlyOffice autosave + callback write-back to the original workspace file. |
| Outside workspace | Never editable. Files opened with an outside-file grant keep view-only config. |

### Config surface

`GET /api/doc-preview/config` gains `edit=1` (string query). The server accepts
edit only when **all** of:

1. The resolved file is inside the active workspace (no `allowOutsideWorkspace` /
   outside grant path).
2. `kind` is `word` / `cell` / `slide`.
3. The document server is configured and healthy (already required for office).

If `edit=1` is requested but any condition fails, the response stays the current
**view** configuration (or the existing error statuses). It never mints an edit
config for a file the caller could not already write through the workspace.

When edit is granted, the signed editor payload differs from today's view payload
only in:

- `document.permissions.edit: true` (download/print/copy stay true).
- `editorConfig.mode: 'edit'`.
- `editorConfig.callbackUrl` — absolute URL the document server can POST to,
  built from `DOCUMENT_BASE_URL` (same base as `/doc-preview/raw`) plus
  `/doc-preview/callback?token=<raw-capability-token>`.
- `editorConfig.customization.autosave: true`, `forcesave: true`.
- `editorConfig.user.id` — include a stable per-path identity so concurrent
  editors of the same file are distinguishable on the document server
  (`oc-doc-<sha1(canonicalPath)[0..16]>`).

View mode is unchanged: no `callbackUrl`, `edit: false`, `mode: 'view'`,
`autosave: false`.

### Callback write-back

New route, registered next to `/doc-preview/raw` (deliberately **outside** `/api`
so the document server can reach it without UI cookies):

```
POST /doc-preview/callback?token=<raw-capability-token>
Authorization: Bearer <editor JWT>   # optional but verified when present
Content-Type: application/json
```

Body (OnlyOffice document server callback):

```jsonc
{
  "key": "<documentKey>",
  "status": 2,          // 2 = ready to save, 6 = forcesave, 1/4/7/… = no write
  "url": "https://documentserver/cache/files/…/output.docx",
  "forcesave": false
}
```

Handler contract:

1. Reject when the feature is not configured (`501` shape as raw).
2. Verify the query capability token with the existing raw-secret HMAC scheme
   (`signRawToken` / `verifyRawToken`). Payload pins the same `{p, m, s, e}`
   shape. Use a longer TTL for edit sessions than the 10-minute raw fetch TTL —
   **edit session TTL = 2 hours** — so long edits do not expire mid-session.
   Keep a distinct payload field `k: 'edit'` so a view-mode raw token cannot be
   reused as a write capability.
3. When an `Authorization: Bearer` JWT is present, verify it with the editor JWT
   secret (same `signJwt` HS256 scheme). Invalid JWT → `403`.
4. `status` ∈ {2, 6} → download `url` (document-server origin only: the URL host
   must match the configured document server internal or public URL) into a
   buffer, bound by `MAX_PREVIEW_BYTES`.
5. Re-check `realpath` still equals the signed path and the path is still inside
   the workspace. Write via temp-file + rename onto the canonical path (same
   durability pattern as `/api/fs/write`).
6. Respond `{ "error": 0 }` on success. `{ "error": 1 }` with a short reason on
   failure so the document server surfaces save errors instead of retrying
   forever on a 500.

Statuses 1, 4, 7 and unknown statuses respond `{ "error": 0 }` without touching
the filesystem (the document server requires a 200-shaped ack).

**Conflict policy (explicit):** the editor is authoritative for the session. If
the file's mtime/size changed since the token was minted, the callback still
writes the editor's version. A subsequent config fetch (reload / Stop editing)
mints a new `documentKey` from the new mtime/size, so the document server does
not serve a stale cache entry. External writers during an open edit session last
write wins from the editor's side — acceptable for v1 and recorded here.

### Client surface

`DocumentPreviewView`:

- Track `editMode: boolean`. Default `false`.
- Toolbar: when state is `onlyoffice`, the file is workspace-scoped, and the
  last config response was view, show **Edit** (`documentPreview.actions.edit`).
  When `editMode`, show **Stop editing** (`documentPreview.actions.stopEditing`)
  instead of Edit (reload / download / fullscreen stay).
- Edit click: refetch `/api/doc-preview/config` with `edit=1`, destroy the
  current editor, mount the new edit config.
- Stop editing: drop `editMode`, refetch without `edit=1`, remount view config.
  Autosave has already written prior edits, so no unsaved-work dialog is needed
  for the happy path; if the edit config fetch failed, Edit is unavailable and
  the error card remains the recovery path.
- Outside-grant documents never show Edit (the server would also refuse).
- PDF path never shows Edit.
- OnlyOffice's own toolbar already shows save state once `mode: 'edit'`; no
  extra OpenChamber save chrome.

### Security notes

- Write capability is the edit-scoped raw token (`k: 'edit'`, 2h TTL), not the
  UI session and not a long-lived URL secret.
- Download URL for the saved document must be same-origin with the configured
  document server (SSRF guard).
- The callback never accepts an arbitrary path: only the path already pinned in
  the token.
- Outside-workspace and non-office kinds cannot obtain an edit token.

### Runtime parity

Shared UI + OpenChamber server. VS Code webview and mobile never mount
`ContextPanel`, so they keep today's non-preview behaviour; no new surface is
opened for them. Electron and web share the same server routes.

## [S3] Out of Scope

- PDF editing or annotation.
- Collaborative multi-user presence UI beyond what OnlyOffice shows natively.
- Editing files outside the active workspace.
- Changing the live file-tree / open text editor buffers when a document save
  lands (file watchers may already refresh; we do not add a new fan-out).
- Forced save-on-tab-close beyond OnlyOffice `forcesave`.
- Mobile / VS Code document editing hosts.

## Tasks

- [x] T1: Server — edit-aware config + edit capability token — acceptance: `edit=1` for a workspace office file returns `mode: 'edit'`, `permissions.edit: true`, `callbackUrl` with `k: 'edit'` token; view and outside-grant responses unchanged (covers: S2)
- [x] T2: Server — `POST /doc-preview/callback` write-back — acceptance: valid edit token + status 2/6 writes downloaded bytes atomically to the pinned path; invalid token/JWT, foreign download URL, and non-write statuses are rejected or no-op with documented responses (covers: S2; depends: T1)
- [x] T3: Client — Edit / Stop editing toolbar and remount — acceptance: Edit appears only for workspace office previews, switches to edit config, Stop editing returns to view; PDF and outside-grant tabs never offer Edit (covers: S2)
- [x] T4: i18n — `documentPreview.actions.edit` and `documentPreview.actions.stopEditing` in every locale with real translations (covers: S2; depends: T3)
- [x] T5: Tests + docs — routes/callback tests, extension parity still green, update both DOCUMENTATION.md files (covers: S2; depends: T1, T2, T3)
