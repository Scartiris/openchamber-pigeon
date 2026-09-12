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
| `word` / `cell` / `slide` | OnlyOffice editor in an iframe owned by the document server, in view mode (`permissions.edit: false`). |
| anything else | not previewable — callers fall back to the text editor or the download action. |

Entry points that open this surface: file paths in assistant markdown, file paths
in tool cards, the file tree / file view binary states, and the command palette.

## Deliberate limits

- **One live editor at a time.** The context panel mounts only the *active*
  document tab; switching tabs destroys the previous editor (`destroyEditor()`)
  and the next switch recreates it from the document server's converted copy.
  Keeping every open document hot would multiply the document server's memory
  use by the number of open tabs, which is not affordable on a small host.
- **Fullscreen is two-level**: the panel's own expand action (header button) and
  the browser Fullscreen API from this surface's toolbar.
- **Download** streams the original bytes from `/api/fs/raw?download=true`; it is
  never a converted copy, so what the user downloads always matches the file.
- **No editing.** `permissions.edit` is false and the editor runs in `view` mode.
  Enabling editing later means relaxing both and adding a save callback endpoint.
- **Degrades loudly.** `not-configured` / `document-server-unavailable` / failed
  conversions all render an explanatory card with a download action instead of a
  blank frame, so a document server outage never looks like a broken file.

## Server contract

See `packages/web/server/lib/doc-preview/DOCUMENTATION.md`. Two response shapes
matter here: `kind: 'pdf'`, and `kind: 'onlyoffice'` with `documentServerUrl` +
`editorConfig` (already signed with the shared JWT secret).
