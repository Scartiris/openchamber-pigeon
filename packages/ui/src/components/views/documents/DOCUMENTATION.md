# Document preview surface

Office and PDF previews in the right-hand context panel (`mode: 'doc'`).

## Where it lives

- `DocumentPreviewView.tsx` — the surface. Fetches `/api/doc-preview/config`,
  loads the document server API once, creates/destroys the OnlyOffice editor, and
  owns the toolbar (download / reload / fullscreen).
- `@/lib/toolHelpers` — `isDocumentPreviewable()` / `getDocumentPreviewKind()`
  decide which files belong here and how they are rendered.
- `@/stores/useUIStore` — the `doc` context panel mode and the
  `openContextDocument(directory, filePath)` action.
- `@/lib/surfaces/registry` — the `doc` rail surface, declared
  `availability: 'has-content'` so the rail icon only appears once a document tab
  exists.
- `@/components/layout/ContextPanel` — tab label/icon, the multi-instance tab
  list, and the render branch.

## Behaviour

| Kind | Renderer |
|---|---|
| `pdf` | `<iframe>` on the authenticated `/api/fs/raw` endpoint (browser-native viewer, no server round trip, no conversion). |
| `word` / `cell` / `slide` | OnlyOffice editor in an iframe owned by the document server — read-only by default, editable on request (below). |
| anything else | not previewable — callers fall back to the text editor or the download action. |

Entry points that open this surface: file paths in assistant markdown, file paths
in tool cards, and the "open document preview" action in the file view's binary
state. All of them are gated on `hasContextPanelSurface()` (`@/lib/runtimeSurface`),
because the panel is the only host of this surface.

## Editing

The surface **always opens read-only**. The toolbar's edit toggle is enabled only
when the server reports `editable: true` for that file (the OOXML trio); turning it
on re-requests the configuration with `?edit=1`, which is what makes the server
add `mode: 'edit'` and a save callback URL. Nothing about editing is assumed on the
client: the server decides both the permissions and which formats may be written.

Saving is the document server's own autosave calling back into OpenChamber; the
surface never uploads anything itself. Its only window into that is the editor's
`onDocumentStateChange` event, which drives the two states shown in the toolbar:

| Indicator | Meaning |
|---|---|
| `有未保存的修改` | The editor reports unsaved changes (`data === true`); the callback has not stored them yet. |
| `已保存` | The editor reported the changes were stored — i.e. the callback wrote the file back. |

While the surface is in edit mode the document server holds the authoritative copy;
the workspace file is replaced only when a save callback arrives. A save that
changes the file also changes its `path|mtimeMs|size` key, so reloading the tab
(or reopening the document) picks up the new version.

## Deliberate limits

- **Only in shells with a context panel.** The VS Code webview and the dedicated
  mobile shell never mount `ContextPanel`, so there the document entry points keep
  their previous behaviour (runtime editor / files view + download) instead of
  creating a tab nobody can see. Mobile document preview is a follow-up, not a
  silent dead click.
- **One live editor at a time.** The context panel mounts only the *active*
  document tab; switching tabs, switching to another surface (Git and back), or
  hiding the panel destroys the editor (`destroyEditor()`) and the next visit
  recreates it from the document server's converted copy. Keeping every open
  document hot would multiply the document server's memory use by the number of
  open tabs, which is not affordable on a small host.
- **Switching between view and edit recreates the editor**, because the mode is
  part of the configuration the server signs. Unsaved changes in the session are
  lost if the user switches before the document server has saved them.
- **No conflict handling.** Two tabs on the same document share one document key,
  so the server treats them as one session; an external change to the file while
  an editing session is open is not merged — the callback refuses a save whose
  document key no longer matches and the user is expected to reload.
- **The file tree is not refreshed after a save.** The bytes on disk are current;
  any view that caches file contents (an editor tab, a stale tree badge) updates
  when it next reads the file.
- **Fullscreen is two-level**: the panel's own expand action (header button) and
  the browser Fullscreen API from this surface's toolbar (which fills the editor
  area, not the whole window).
- **Download** streams the original bytes from `/api/fs/raw?download=true`; it is
  never a converted copy, so what the user downloads always matches the file.
- **Documents outside the workspace** are read with the same short-lived grant
  the file viewer uses: whoever opens the tab mints it first and the surface
  picks it up from the grant cache (desktop only — the grant flow is a desktop
  capability).
- **Degrades loudly.** `not-configured` / `document-server-unavailable` / failed
  conversions all render an explanatory card with a download action instead of a
  blank frame, so a document server outage never looks like a broken file.

## Server contract

See `packages/web/server/lib/doc-preview/DOCUMENTATION.md`. Two response shapes
matter here: `kind: 'pdf'`, and `kind: 'onlyoffice'` with `documentServerUrl` +
`editorConfig` (already signed with the shared JWT secret).
