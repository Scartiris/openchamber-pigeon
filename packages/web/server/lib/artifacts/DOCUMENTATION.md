# Artifacts Module

## Purpose

Own the Artifact Center: curated deliverable files with automatic content-hash
version snapshots, optional Google Drive cold tiering, and the HTTP API the
shared UI uses.

## Why server-side

Versions must survive a closed tab, a phone-only session, and a workbench that
is not the project workspace. Hot snapshots never write into the project
directory, so collecting a report cannot dirty git.

## Files

- `store.js` — atomic index + content-addressed blobs under
  `<openchamberDataDir>/artifacts/`
- `registry.js` — collect / uncollect / list / patch identity
- `versions.js` — snapshot, label, restore-to-source, content stream
- `watcher.js` — debounced watch of collected source paths
- `drive/auth.js` — Google OAuth (PKCE) + token refresh
- `drive/client.js` — Drive REST via `fetch` (no googleapis dependency)
- `drive/tier.js` — hot budget policy and promote/demote
- `runtime.js` — composition + `registerArtifactRoutes`
- `runtime.test.js` — engine and route-shape tests

## Persistence

`<data>/artifacts/index.json` (`OPENCHAMBER_DATA_DIR` or `~/.config/openchamber`):

```
{ version, revision, artifacts: { [id]: Artifact }, versions: { [artifactId]: Version[] } }
```

Blobs: `<data>/artifacts/blobs/<sha256>`. Drive tokens: `<data>/artifacts/drive-auth.json` mode `0o600`.

Malformed index is moved aside as `index.json.corrupt-<timestamp>` — never
overwritten. A failed load leaves the runtime empty but does not clobber the
file until a later successful load.

## Snapshot rules

1. Debounce (~800 ms) after a watched source change.
2. sha256 the file bytes.
3. Same hash as the latest version → no-op (auto) or no-op without a label (manual).
4. New hash → store blob, append `auto`/`manual`/`restore` version.

Restore refuses when the live file hash differs from the latest version
(`source_dirty`, 409) unless `force` is set.

## Hot/cold tiering

Default budget `OPENCHAMBER_ARTIFACTS_HOT_BUDGET_BYTES` (1 GiB). Protected from
demotion: each artifact's latest version and any labeled version. Older hot
versions upload to Drive (`drive.file` scope), record `driveFileId`, and the
local blob is deleted. Pull-back downloads, verifies sha256, then promotes.

Unconfigured Drive: hot path fully works; Drive routes answer
`drive_not_configured` / `not connected`.

## Routes

Registered from `opencode/feature-routes-runtime.js` before the OpenCode proxy.
JSON bodies enabled for `/api/artifacts` in `core-routes.js`.

| Method | Path |
|---|---|
| GET | `/api/artifacts` |
| POST | `/api/artifacts` |
| GET | `/api/artifacts/storage` |
| GET | `/api/artifacts/drive/status` |
| POST | `/api/artifacts/drive/auth` |
| GET | `/api/artifacts/drive/callback` |
| DELETE | `/api/artifacts/drive/auth` |
| GET/PATCH/DELETE | `/api/artifacts/:id` |
| POST | `/api/artifacts/:id/snapshot` |
| GET | `/api/artifacts/:id/versions` |
| PATCH | `/api/artifacts/:id/versions/:versionId` |
| GET | `/api/artifacts/:id/versions/:versionId/content` |
| POST | `/api/artifacts/:id/versions/:versionId/pull` |
| POST | `/api/artifacts/:id/versions/:versionId/restore` |

Collect resolves the path with the shared workspace read resolver
(`createReadPathResolver`). Failure is never an empty successful list.

## Agent API (reserved)

`POST /api/artifacts` accepts `origin: 'agent'`. A first-class OpenCode tool
wrapper is intentionally not shipped yet; the route shape must not block it.

## Tests

`bun run --cwd packages/web test server/lib/artifacts`

## Composition

Created in `packages/web/server/index.js` after `OPENCHAMBER_DATA_DIR` is known;
started immediately; `stop()` closes watchers on shutdown
(`opencode/shutdown-runtime.js`).
