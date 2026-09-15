---
feature: artifact-center
status: in-progress
updated: 2026-02-14
branch: 产物中心
commits: # filled at delivery
---

# Artifact Center and Version Management

## Report

**What was built** — Artifact Center for the workbench: collect deliverable files from the file tree, automatic content-hash version snapshots on a debounced watcher, name/restore/pull versions from an independent full-page surface, and a Google Drive OAuth cold tier with budget-based auto-demotion. Hot storage lives under the OpenChamber data dir and never dirties the project workspace.

**Verification** — `bun test server/lib/artifacts` (9 pass); `bunx tsc --noEmit` on `packages/web` and `packages/ui` (exit 0); dead-code report inspected (no new unused artifact exports). Drive OAuth/tiering is implemented against the REST API but not e2e-verified against a live Google account in this environment.

**Journey log**
- `collect` initially returned the nested snapshot envelope as `version`; tests caught it.
- Locale files that quote with `"` or escaped `'` needed a different insert anchor than the majority single-quote style.
- Label input was one shared draft for the whole timeline; fixed to per-version drafts.
- Root `.gitignore` `artifacts/` silently ignored every path segment named `artifacts`; narrowed to build outputs.
- Shared content hashes need refcount before blob delete (manual labeled versions can share a hash).

## [S1] Problem

The workbench has no curated place for agent deliverables. Reports, slides, spreadsheets, diagrams, and other non-code outputs sit mixed into the file tree and chat attachments. There is no version history: when an agent rewrites a document, the previous wording is gone unless the user copied the file by hand.

Users need a document-version-management style surface for those deliverables: collect important files into an artifact center, keep automatic snapshots as content changes, name versions, compare, restore, and keep old versions off a small server disk by archiving them to Google Drive.

## [S2] Design

### Product decisions

| Axis | Decision |
|---|---|
| Artifact definition | Explicitly collected deliverable files (docs, reports, images, office files, and other user-chosen paths). Not every workspace file. |
| Collection | UI first (file tree / file preview / open file). Server API shaped so an agent tool can call the same operations later. |
| Versioning | Automatic content-hash snapshots while an artifact stays collected. Debounced settle window. Same bytes never create a second version. |
| Hot storage | OpenChamber data dir (`OPENCHAMBER_DATA_DIR` or `~/.config/openchamber`). Never writes into the project workspace. |
| Cold storage | Google Drive via OAuth user authorization. Auto-tier older versions when hot store exceeds budget; pull back on demand. |
| UI | Independent full-page Artifact Center (same surface-page pattern as Archive / Worktrees), not a ContextPanel tab. |
| Runtime scope | Shared UI + Web server first. Electron/VS Code/mobile inherit the shared UI where the server is available; VS Code reports unsupported for Drive OAuth settings if no server. |

### Artifact identity

An artifact is a registry entry pointing at one workspace path at collection time:

```
{
  id,                    // stable id, `art_...`
  title,                 // display name; defaults to file basename
  sourcePath,            // absolute path at collect time
  directory,             // project/workspace directory key
  mimeType,
  sizeBytes,             // last observed
  contentHash,           // sha256 of last observed bytes
  collectedAt,
  updatedAt,
  latestVersionId,
  origin: 'user' | 'agent',
  driveFolderId?         // cold-tier folder once created
}
```

If the source file is later renamed or deleted, the registry keeps the last known path and marks the artifact `missing`; it does not silently drop history.

### Version model

A version is an immutable content snapshot:

```
{
  id,                    // `ver_...`
  artifactId,
  createdAt,
  contentHash,           // sha256
  sizeBytes,
  label,                 // optional user name ("终稿", "客户反馈前")
  source: 'auto' | 'manual' | 'restore',
  tier: 'hot' | 'cold' | 'restoring',
  driveFileId?,          // present when tier is cold
  restoredFromVersionId?
}
```

Snapshot rules:

1. Debounce file changes (~800 ms settle after last write).
2. Compute sha256; if it equals the latest version hash, do nothing.
3. Otherwise create a new `auto` version and store the blob under content-addressed hot storage.
4. Manual "保存为版本" creates a version even when hash matches only if the user also supplies a label; otherwise it is a no-op with a clear toast.

Hot blobs live at `<data>/artifacts/blobs/<sha256>`. Index lives at `<data>/artifacts/index.json` with atomic temp-file + rename writes, matching `message-queue` persistence discipline. A malformed index is moved aside as `index.json.corrupt-<timestamp>`, never overwritten.

### Hot/cold tiering

Default hot budget: `OPENCHAMBER_ARTIFACTS_HOT_BUDGET_BYTES` (default 1 GiB). After each successful snapshot or restore:

1. Sum hot blob sizes across versions with `tier === 'hot'`.
2. While over budget, pick the oldest non-labeled hot versions (protect versions with a user label and the latest version of each artifact).
3. Upload each selected blob to Drive, record `driveFileId`, set `tier: 'cold'`, delete the local blob.

Pull-back (`restore from cold` or previewing a cold version):

1. Download by `driveFileId` into a temp file.
2. Verify sha256 against the version record.
3. Promote to hot blob path, set `tier: 'hot'`.
4. On hash mismatch or download failure, leave tier as cold and surface an error; never keep a corrupt hot blob.

Drive root folder: settings-configured or auto-created `OpenChamber Artifacts` under the user's My Drive. Per-artifact subfolders keep remote listing cheap.

### Google Drive OAuth

- User-configured OAuth client (`OPENCHAMBER_GOOGLE_DRIVE_CLIENT_ID` / `_SECRET`, or settings).
- Authorization code + PKCE via the workbench server; browser never holds the client secret.
- Tokens stored at `<data>/artifacts/drive-auth.json` with mode `0o600`.
- Scope: `drive.file` (app-created files only).
- Inert when unconfigured: Drive routes answer `not-configured`; hot versioning still works.

### Server module

New module `packages/web/server/lib/artifacts/`:

| File | Responsibility |
|---|---|
| `runtime.js` | Create runtime: load index, mutation queue, budget/tier loop, watcher subscription |
| `store.js` | Atomic index persistence + blob read/write/delete |
| `registry.js` | Collect/uncollect/list/get/rename artifact |
| `versions.js` | Snapshot, list, label, restore-to-source, content stream |
| `watcher.js` | Debounced fs watch on collected source paths |
| `drive/auth.js` | OAuth start/callback/refresh/status |
| `drive/client.js` | Drive upload/download/list/delete via `fetch` |
| `drive/tier.js` | Budget policy and promote/demote operations |
| `routes.js` | `registerArtifactRoutes(app, deps)` |
| `DOCUMENTATION.md` | Module contract |

Composition: create the runtime in `packages/web/server/index.js` after the data-dir path is known; register routes in `opencode/feature-routes-runtime.js` (before the generic OpenCode proxy); stop the watcher in `opencode/shutdown-runtime.js`. Enable JSON bodies for artifact routes in `core-routes.js`.

### HTTP API

All routes UI-session authenticated.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/artifacts` | List artifacts (`directory` filter optional) |
| POST | `/api/artifacts` | Collect `{ path, directory, title?, origin? }` |
| GET | `/api/artifacts/:id` | Artifact detail |
| PATCH | `/api/artifacts/:id` | Rename title / update metadata |
| DELETE | `/api/artifacts/:id` | Uncollect (keeps workspace file; optionally purge versions with `?purge=1`) |
| POST | `/api/artifacts/:id/snapshot` | Force snapshot now |
| GET | `/api/artifacts/:id/versions` | Version list (metadata only) |
| PATCH | `/api/artifacts/:id/versions/:versionId` | Set/clear label |
| GET | `/api/artifacts/:id/versions/:versionId/content` | Stream version bytes (hot, or 409 `cold` with tier hint) |
| POST | `/api/artifacts/:id/versions/:versionId/pull` | Cold → hot |
| POST | `/api/artifacts/:id/versions/:versionId/restore` | Write version bytes back to `sourcePath` (conflict check) |
| GET | `/api/artifacts/drive/status` | OAuth + folder readiness |
| POST | `/api/artifacts/drive/auth` | Start OAuth; returns authorize URL |
| GET | `/api/artifacts/drive/callback` | OAuth redirect target |
| DELETE | `/api/artifacts/drive/auth` | Disconnect |
| GET | `/api/artifacts/storage` | Hot usage, budget, cold counts |

Failure contract: never turn a fetch failure into an empty successful list. Missing artifact is 404. Cold content without pull is 409 with `{ error: 'version_cold' }`. Drive down during tier does not fail the snapshot; it leaves the version hot and retries later.

### Shared UI

- `packages/ui/src/components/views/artifacts/ArtifactCenterView.tsx` — full-page surface (list left, detail + version timeline right).
- `packages/ui/src/components/views/artifacts/VersionTimeline.tsx` — chronological versions with tier badge, label, restore, pull.
- `packages/ui/src/lib/artifacts/client.ts` — `runtimeFetch` client; no credentials in the browser.
- `useUIStore`: `isArtifactCenterPageOpen` + `setArtifactCenterOpen`, mutually exclusive with Archive/Worktrees/Scheduled/MultiRun, included in `closeMainSurfaces`.
- Collect actions: FilesView context menu + open-file toolbar ("收集为产物").
- Entry: command palette + sidebar/project actions menu + Header title when the surface is open (same as Archive).
- Settings: Drive connection status and connect/disconnect under Integrations (web/desktop; not VS Code).

Version preview reuses existing doc-preview / markdown / image preview against a content endpoint, not against the workspace path (so cold or historical versions preview correctly).

### i18n

All user-facing strings go through `@/lib/i18n`. Add keys under `artifacts.*` in `en.ts` and fully translated copies in every non-English dictionary. Pigeon fork Chinese UI remains the primary authored language for new copy quality review.

### Agent API (reserved, not first implementation)

`POST /api/artifacts` with `origin: 'agent'` is accepted from the start. A first-class OpenCode tool wrapper is out of scope for this delivery; the route shape must not block adding one later.

## [S3] Out of Scope

- Collaborative multi-user artifact ACLs.
- In-browser editing of artifacts.
- Non-Google cold backends (S3, generic rclone) — interface may stay narrow but no second backend ships.
- VS Code native OAuth without a reachable OpenChamber server.
- Automatic scanning of the whole workspace for "likely artifacts".
- Real-time multiplayer sync of the artifact index beyond the web server's SSE/event patterns already used elsewhere.

## Tasks

- [x] T1: Artifact hot store + registry + version engine — acceptance: collect, auto-snapshot on content change (debounced, hash-deduped), list versions, label, restore-to-source, uncollect; unit tests cover persistence corruption, missing file, and hash no-op. (covers: S2)
- [x] T2: Watcher wiring + server composition — acceptance: runtime starts with the web server, watches collected paths, stops cleanly; routes register before the OpenCode proxy. (covers: S2; depends: T1)
- [x] T3: HTTP API + focused route tests — acceptance: every route above has a tested happy path and the documented failure codes; fetch failure is never an empty success. (covers: S2; depends: T1)
- [x] T4: Artifact Center page + version timeline UI — acceptance: full-page surface opens from command palette/menu, lists artifacts by project, shows versions with tier/label, restores and labels work; uses theme tokens and i18n. (covers: S2; depends: T3)
- [x] T5: Collect entry points — acceptance: file tree context menu and file toolbar can collect the current file; toast confirms; already-collected path offers "打开产物中心" instead of duplicate collect. (covers: S2; depends: T3)
- [x] T6: Locale dictionaries — acceptance: `artifacts.*` keys exist in `en` and every non-English dictionary with real translations. (covers: S2; depends: T4)
- [x] T7: Google Drive OAuth + tiering — acceptance: connect/disconnect from settings; auto-tier over budget to Drive and pull-back verifies sha256; unconfigured Drive leaves hot path fully working; tokens stored `0o600`. (covers: S2; depends: T1)
- [x] T8: Module documentation + validation — acceptance: `packages/web/server/lib/artifacts/DOCUMENTATION.md` matches behavior; focused tests, type-check, and lint pass for touched packages; `dead-code` run if exports/files changed. (covers: S2; depends: T2, T3, T4, T5, T7)
