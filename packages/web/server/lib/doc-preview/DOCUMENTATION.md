# Document preview routes

Optional Word / Excel / PowerPoint preview (view or edit) and PDF preview for
the context panel.

The surface is **inert unless configured**: with no document server URL and no
JWT secret every route answers `not-configured`, so upstream builds, the desktop
app and a plain `bun dev` keep their previous behaviour. The client only needs to
know how to render what these routes return.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/doc-preview/health` | UI session (bearer/cookie) | Whether office previews can render right now, plus the browser-facing document server origin. |
| `GET /api/doc-preview/config?path=&directory=&theme=&edit=` | UI session | Resolves one file inside the active workspace and returns a render descriptor. `edit=1` requests an edit-mode OnlyOffice config (workspace office files only). |
| `GET /doc-preview/raw?token=` | HMAC capability token | Serves document bytes to the document server (read into memory, bounded by `MAX_PREVIEW_BYTES`). |
| `POST /doc-preview/callback?token=` | HMAC edit-capability token (+ optional editor JWT) | Receives OnlyOffice save/forcesave callbacks and writes the converted document back to the pinned workspace path. |

`/doc-preview/raw` and `/doc-preview/callback` are deliberately **outside `/api`**:
the document server reaches them container-to-container with no cookie and no
`Authorization` header, so the UI auth middleware cannot apply. See "Capability
tokens" below.

### `config` responses

```jsonc
// PDF: the browser renders it, no document server involved
{ "available": true, "kind": "pdf", "size": 12345 }

// Office view (default)
{
  "available": true,
  "kind": "onlyoffice",
  "documentType": "word",          // word | cell | slide
  "documentKey": "9f2c…",          // sha1(realpath|mtimeMs|size)
  "documentServerUrl": "https://office.example.com",
  "editable": false,
  "editorConfig": { "document": { … }, "editorConfig": { … }, "token": "…" }
}

// Office edit (`edit=1`, workspace only): same shape plus
// "editable": true and editorConfig.editorConfig.{mode:"edit", callbackUrl, autosave:true}
```

Failures: `400` path missing/outside the workspace, `404` file missing,
`413` over `MAX_PREVIEW_BYTES` (100 MiB), `415` type has no preview,
`501 not-configured`, `503 document-server-unavailable`.

`edit=1` is ignored (view config returned) when the path was resolved through an
outside-file grant, the kind is PDF, or the document server cannot serve an edit
session. The response then still has `editable: false`.

### Callback responses

Always JSON in the OnlyOffice envelope. Success and lifecycle acks:
`{ "error": 0 }`. Write-path failures: `{ "error": 1, "reason": "…" }` with
reasons `path-missing` | `invalid-download-url` | `download-failed` |
`too-large` | `write-failed` | `failed`. Authentication failures use HTTP
`403` with `{ "error": "…" }` (no capability → no ack).

Only `status` 2 (ready to save) and 6 (forcesave) download and write. Other
statuses are acked `{ "error": 0 }` without touching the filesystem — even when
the path is gone — so the document server never retries a harmless lifecycle
ping. Download URLs must share an origin with the configured document server
(internal or public URL) and redirects are refused (`redirect: 'error'`).

## Configuration

| Variable | Meaning |
|---|---|
| `OPENCHAMBER_DOC_PREVIEW_URL` | Document server base URL as reachable **from this server** (e.g. `http://documentserver`). Enables the feature together with the JWT secret. |
| `OPENCHAMBER_DOC_PREVIEW_PUBLIC_URL` | Document server origin the **browser** loads (e.g. `https://office.example.com`). Defaults to the internal URL. |
| `OPENCHAMBER_DOC_PREVIEW_DOCUMENT_BASE_URL` | Base URL the document server uses to fetch documents back from OpenChamber (e.g. `http://openchamber:3000`). Also the base for `callbackUrl`. Defaults to the request origin, which works but sends document bytes through the public origin. |
| `OPENCHAMBER_DOC_PREVIEW_JWT_SECRET` | Shared HS256 secret; must equal `JWT_SECRET` on the document server. |
| `OPENCHAMBER_DOC_PREVIEW_RAW_SECRET` | Overrides the generated capability-token secret. |
| `OPENCHAMBER_DOC_PREVIEW_DISABLED` | `true` force-disables the surface even when otherwise configured. |

The capability secret is generated once into `<data dir>/doc-preview-secret`
(mode `0600`) when `OPENCHAMBER_DOC_PREVIEW_RAW_SECRET` is not set.

The document server must run with `JWT_ENABLED=true`, `JWT_HEADER=Authorization`,
`JWT_IN_BODY=true` and — when `DOCUMENT_BASE_URL` points at a private address —
`ALLOW_PRIVATE_IP_ADDRESS=true` (verified against 9.3.0: without it the document
server refuses the download).

## Capability tokens

`GET /doc-preview/raw` is authenticated by an HMAC-SHA256 token signed with a
local secret. The payload pins `{ p: canonical path, m: mtimeMs, s: size, e: expiry }`;
the TTL is 10 minutes and only the exact canonical path is signed.

`POST /doc-preview/callback` uses the same scheme with an additional
`k: 'edit'` field and a 2-hour TTL, so a long edit session can autosave without
the capability expiring mid-session. A view-scoped raw token (no `k`) is
rejected by the callback: reading a file once is not a write capability.

At fetch time the raw route re-runs `realpath` and refuses when it no longer
equals the signed path (which also closes the symlink gap in `GET /api/fs/raw`),
and it refuses with `409` when the file's size or mtime no longer match the
token. That second check matters because the editor's `document.key` is derived
from `path|mtimeMs|size`: serving newer bytes under an old key would hand the
document server a document that disagrees with its own cache entry. A client that
hits the 409 reloads the configuration and gets a fresh key.

Minting happens only after `resolveReadPathFromContext` (the same workspace
confinement `/api/fs/raw` uses) plus a canonical containment re-check against the
resolved base, so a preview link can never address a file the caller could not
already open through the workspace.

The token is a **capability**: anyone holding the URL can read that one file for
the token TTL (or write it, for an edit token). It is therefore never logged, and
responses carry `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

## Tests

`routes.test.js` covers the token round trip (tamper/expiry/foreign secret), the
runtime's configured/unconfigured states, secret persistence, every `config`
status code, the signed editor configuration payload (view and edit), the raw
route's rejections, and the callback write-back / SSRF / lifecycle ack paths.
Run: `bun run --cwd packages/web test server/lib/doc-preview`.
