# Document preview routes

Optional Word / Excel / PowerPoint / PDF preview for the context panel.

Office formats are rendered as **PDF**, converted server-side by a LibreOffice
sidecar (`deploy/office-convert/`); the browser then renders that PDF with its own
viewer, exactly as it already did for `.pdf` files. There is no document editor
and no editing: the surface is read-only, and the only thing that leaves the
workspace is a copy of one document sent to the conversion service on the compose
network.

The surface is **inert unless configured**: with no conversion-service URL every
office route answers `not-configured`, so upstream builds, the desktop app and a
plain `bun dev` keep their previous behaviour. PDFs keep previewing even then,
because the browser renders those itself.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/doc-preview/health` | UI session (bearer/cookie) | Whether office previews can render right now. |
| `GET /api/doc-preview/config?path=&directory=` | UI session | Resolves one file inside the active workspace and says how to render it. |
| `GET /api/doc-preview/convert?path=&directory=` | UI session | Converts one office file and answers once its PDF exists. |
| `GET /api/doc-preview/pdf?path=&directory=` | UI session, or `oc_url_token` | Streams the PDF an iframe renders. |

`pdf` is the only route a browser loads as a URL rather than through
`runtimeFetch`, so it is the only one on the URL-token allowlist
(`lib/ui-auth/ui-auth.js`).

### `config` responses

```jsonc
// A real PDF: the browser renders it from /api/fs/raw, nothing else involved
{ "available": true, "kind": "pdf", "converted": false, "size": 12345 }

// An office file: a PDF has to be produced first
{ "available": true, "kind": "pdf", "converted": true, "size": 23456, "fileName": "报告.docx" }
```

`kind` is always `pdf` — the client renders both cases in an iframe and only
differs in which endpoint it points at.

Failures: `400` path missing/outside the workspace, `404` file missing,
`413` over `MAX_PREVIEW_BYTES` (100 MiB), `415` type has no preview,
`501 not-configured`, `502 conversion-failed`, `503 converter-unavailable`,
`504 conversion-timeout`.

### Why `convert` is a GET

It writes a cache entry, so it would rather be a POST. It is not, for two
mechanical reasons: the workspace-confinement resolver reads
`allowOutsideWorkspace` and `outsideFileGrant` from the **query string**, and
`/api/doc-preview` is not on the JSON-body middleware list in `core-routes.js`,
so a POST body would arrive unparsed.

The call is idempotent for one file version — the conversion key covers path,
size and mtime — and it exists so the client can show a real loading state and a
real error card. Without it the iframe would be pointed at a route that might
answer with JSON, and the user would see raw JSON in a frame.

## Conversion keys

`buildConversionKey` (`converter.js`) is `sha1(canonicalPath|mtimeMs|size)`. It is
the cache identity of one file version on both sides of the wire:

- a different path, a save, or a truncation produces a different key, so a
  converted PDF can never be served for content it was not made from;
- saving a document simply misses the cache and converts again on next open;
- the service only ever uses it as a cache file name, so it needs to know
  nothing about the workspace it is serving.

The key is an identifier, not a credential: the route re-resolves the path and
re-checks the workspace on every request, and the service is only reachable from
the compose network.

## Configuration

| Variable | Meaning |
|---|---|
| `OPENCHAMBER_DOC_PREVIEW_URL` | Conversion-service base URL as reachable **from this server** (e.g. `http://office-convert:8000`). Enables the feature. |
| `OPENCHAMBER_DOC_PREVIEW_TIMEOUT_MS` | Per-conversion budget, default 120000, clamped to 5s–10min. |
| `OPENCHAMBER_DOC_PREVIEW_DISABLED` | `true` force-disables the surface even when otherwise configured. |

There is no shared secret and no capability token. Nothing but this server talks
to the conversion service, and nothing but the browser talks to these routes, so
there is no second party to authenticate — these are ordinary `/api`-authenticated
routes, and the one browser-loaded route is on the narrow URL-token allowlist.

## Tests

`routes.test.js` covers the conversion key, the runtime's configured/disabled
states and timeout clamping, every `config` status code, the cache-hit path (no
re-upload), the cache-miss path (upload, correct key, correct bytes), re-keying
after a save, conversion failures, timeouts, refusals, and both branches of
`pdf`. `extension-parity.test.js` keeps the server's extension table in step with
the client's. `lib/ui-auth/ui-auth.test.js` covers the URL-token allowlist entry.

Run: `bun run --cwd packages/web test server/lib/doc-preview`.
