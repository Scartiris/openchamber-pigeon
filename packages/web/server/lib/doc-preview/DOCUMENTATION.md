# Document preview routes

Optional Word / Excel / PowerPoint / PDF preview — and, for the OOXML trio,
in-place editing — for the context panel.

The surface is **inert unless configured**: with no document server URL and no
JWT secret every route answers `not-configured`, so upstream builds, the desktop
app and a plain `bun dev` keep their previous behaviour. The client only needs to
know how to render what these routes return.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/doc-preview/health` | UI session (bearer/cookie) | Whether office previews can render right now, plus the browser-facing document server origin. |
| `GET /api/doc-preview/config?path=&directory=&theme=&edit=1` | UI session | Resolves one file inside the active workspace and returns a render descriptor. With `edit=1` and an editor-safe format it also returns a save callback URL. |
| `GET /doc-preview/raw?token=` | HMAC capability token (read scope) | Serves document bytes to the document server (read into memory, bounded by `MAX_PREVIEW_BYTES`). |
| `POST /doc-preview/callback?token=` | HMAC capability token (write scope) **and** the document server's own JWT | Receives a saved document and writes it back to the workspace file. |

`/doc-preview/raw` and `/doc-preview/callback` are deliberately **outside `/api`**:
the document server calls them container-to-container with no cookie and no
`Authorization` header, so the UI auth middleware cannot apply. See "Capability
tokens" below.

### Editing

Editing is opt-in per request (`?edit=1`) and only offered for formats the editor
writes back in place — `DOCUMENT_EDITABLE_EXTENSIONS` = `docx`, `xlsx`, `pptx`.
Legacy binary formats (`.doc`/`.xls`/`.ppt`) would be *converted* on save and
silently change the user's file type; `csv`/`rtf`/ODF round-trips lose structure.
Those keep the read-only view and the response says `editable: false` so the
client can explain why.

In edit mode the configuration carries `mode: 'edit'`, `permissions.edit: true`,
`customization.autosave: true` and a `callbackUrl`. The document server then
posts the saved document to that URL:

- **Two independent checks** must pass: the URL's write-scoped capability token
  (bound to one canonical path *and* to the document key the session was opened
  with) and the JWT the document server signs over its own callback body. The
  token proves the request was minted for this file; the JWT proves the document
  server sent it. A save for a stale document key is refused with `409`.
- Only `status` 2 and 6 carry a document; 1/3/4/7 are acknowledged with
  `{"error":0}` and nothing is written.
- The saved bytes are downloaded from the document server's `/cache/` path
  (its reported URL points at its *own* host name, so the path is re-attached to
  `OPENCHAMBER_DOC_PREVIEW_URL`), bounded by `MAX_PREVIEW_BYTES`, and refused if
  empty. Any other URL shape is rejected, so a callback cannot aim the download
  at an arbitrary address.
- The file is replaced atomically: the new bytes land in a same-directory temp
  file which is then renamed over the original, so a crash mid-save cannot leave
  a half-written document in the workspace. Writes to one path are serialised,
  because the document server can deliver an autosave and a close-save back to
  back.
- The version being replaced is copied to `<data dir>/doc-preview-versions/<sha1>`
  (last `SAVED_VERSION_LIMIT` = 5, mode `0600`) — outside the workspace, so saving
  never litters the user's directory but a mangled document stays recoverable.

### `config` responses

```jsonc
// PDF: the browser renders it, no document server involved
{ "available": true, "kind": "pdf", "size": 12345 }

// Office: a signed OnlyOffice editor configuration
{
  "available": true,
  "kind": "onlyoffice",
  "documentType": "word",          // word | cell | slide
  "documentKey": "9f2c…",          // sha1(realpath|mtimeMs|size)
  "documentServerUrl": "https://office.example.com",
  "editorConfig": { "document": { … }, "editorConfig": { … }, "token": "…" }
}
```

Failures: `400` path missing/outside the workspace, `404` file missing,
`413` over `MAX_PREVIEW_BYTES` (100 MiB), `415` type has no preview,
`501 not-configured`, `503 document-server-unavailable`.

## Configuration

| Variable | Meaning |
|---|---|
| `OPENCHAMBER_DOC_PREVIEW_URL` | Document server base URL as reachable **from this server** (e.g. `http://documentserver`). Enables the feature together with the JWT secret. |
| `OPENCHAMBER_DOC_PREVIEW_PUBLIC_URL` | Document server origin the **browser** loads (e.g. `https://office.example.com`). Defaults to the internal URL. |
| `OPENCHAMBER_DOC_PREVIEW_DOCUMENT_BASE_URL` | Base URL the document server uses to fetch documents back from OpenChamber (e.g. `http://openchamber:3000`). Defaults to the request origin, which works but sends document bytes through the public origin. |
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

Both document-server-facing routes are authenticated by an HMAC-SHA256 token
signed with a local secret, and the payload carries a scope (`k`):

| Token | Payload | TTL | Used by |
|---|---|---|---|
| read | `{ k: 'read', p, m, s, e }` | 10 min | `GET /doc-preview/raw` |
| write | `{ k: 'write', p, d, e }` | 12 h | `POST /doc-preview/callback` |

A token is only accepted by the route whose scope it carries, so a link minted
for reading cannot be replayed against the callback (and vice versa). The write
token needs the longer TTL because an editing session can stay open for hours;
it carries the document key (`d`) instead of the file version, because the file
is expected to change — that key ties the save to the session it belongs to.

At fetch time the raw route re-runs `realpath` and refuses when it no longer
equals the signed path (which also closes the symlink gap in `GET /api/fs/raw`),
and it refuses with `409` when the file's size or mtime no longer match the token.
That second check matters because the editor's `document.key` is derived from
`path|mtimeMs|size`: serving newer bytes under an old key would hand the document
server a document that disagrees with its own cache entry. A client that hits the
409 reloads the configuration and gets a fresh key.

Minting happens only after `resolveReadPathFromContext` (the same workspace
confinement `/api/fs/raw` uses) plus a canonical containment re-check against the
resolved base, so a preview link can never address a file the caller could not
already open through the workspace. The callback's write token is minted by the
same check, which is what keeps a save from escaping the workspace.

The token is a **capability**: anyone holding the URL can read — or, with a write
token, replace — that one file until it expires. Tokens are therefore never
logged, and responses carry `Cache-Control: no-store` and `Referrer-Policy:
no-referrer`.

## Tests

`routes.test.js` covers the token round trip (tamper/expiry/foreign secret/scope),
the runtime's configured/unconfigured states, secret persistence, every `config`
status code, the signed editor configuration payload, the raw route's rejections,
and the save callback: the write itself, the reported-URL rewrite, the statuses
that carry no document, both required credentials, stale document keys, refused
URL shapes, and concurrent saves. Run: `bun run --cwd packages/web test server/lib/doc-preview`.
