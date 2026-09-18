# Document preview surface

Office and PDF previews. Hosts:

1. **Files management pane** (`FilesView`) — selecting a previewable office document
   mounts this surface in the main editor area (and fullscreen viewer). This is
   the default path: no side panel required.
2. **Right-hand context panel** (`mode: 'doc'`) — still available via
   `openContextDocument` when a context panel exists (markdown links, tool cards,
   optional secondary open).

PDFs in `FilesView` keep the existing raw `/api/fs/raw` iframe and do **not**
mount this surface.

## Where it lives

- `DocumentPreviewView.tsx` — the surface. Fetches `/api/doc-preview/config`,
  asks for the PDF to be produced when the file needs converting, renders it in an
  iframe, and owns the toolbar (download / reload / fullscreen / artifact status).
  Artifact collect/version status uses `ArtifactPathActions` against the same
  path; version timeline still lives in Artifact Center.
- `@/lib/toolHelpers` — `isDocumentPreviewable()` / `getDocumentPreviewKind()`
  decide which files belong here and how they are rendered.
- `@/stores/useUIStore` — the `doc` context panel mode and the
  `openContextDocument(directory, filePath)` action.
- `@/lib/surfaces/registry` — the `doc` rail surface, declared
  `availability: 'has-content'` so the rail icon only appears once a document tab
  exists.
- `@/components/views/FilesView` — lazy-mounts this surface when the selected
  path is document-previewable and not a PDF.
- `@/components/layout/ContextPanel` — tab label/icon, the multi-instance tab
  list, and the render branch.

## Behaviour

Every preview is the browser's own PDF viewer in an iframe; the two cases differ
only in where the PDF comes from.

| Kind | Renderer |
|---|---|
| `pdf` | `<iframe>` on the authenticated `/api/fs/raw` — the file itself, no round trip and no conversion. |
| `word` / `cell` / `slide` | `<iframe>` on `/api/doc-preview/pdf`, which streams a PDF converted server-side. `/api/doc-preview/convert` is awaited first, so the wait is a loading state rather than a blank frame. |
| anything else | not previewable — callers fall back to the text editor or the download action. |

Entry points that open this surface: selecting an office document in the file
management tree (inline in `FilesView`), file paths in assistant markdown, file
paths in tool cards, and the optional "open document preview" action on the
binary fallback card when a context panel is available. Markdown/tool/context
entries are gated on `hasContextPanelSurface()`; the FilesView host is not.

## Deliberate limits

- **Only in shells with a context panel.** The VS Code webview and the dedicated
  mobile shell never mount `ContextPanel`, so there the document entry points keep
  their previous behaviour (runtime editor / files view + download) instead of
  creating a tab nobody can see. Mobile document preview is a follow-up, not a
  silent dead click. **Exception:** `FilesView` hosts the surface inline, so any
  shell that already mounts `FilesView` gets office preview without a panel.
- **One preview at a time.** The context panel mounts only the *active* document
  tab, so switching tabs unmounts the previous iframe instead of keeping every
  open document loaded.
- **Fullscreen is two-level**: the panel's own expand action (header button) and
  the browser Fullscreen API from this surface's toolbar (which fills the preview
  area, not the whole window).
- **Download** streams the original bytes from `/api/fs/raw?download=true`; it is
  never a converted copy, so what the user downloads always matches the file.
- **Documents outside the workspace** are read with the same short-lived grant
  the file viewer uses: whoever opens the tab mints it first and the surface
  picks it up from the grant cache (desktop only — the grant flow is a desktop
  capability).
- **No editing, by design.** The preview shows a conversion, so there is nothing
  to write back. `?edit=1`, permissions and a save callback do not exist here.
- **A converted preview is a rendering, not the file.** Fidelity is LibreOffice's,
  which is why the surface always offers the original for download. Font
  substitution is the visible difference on documents that name fonts nobody has.
- **Degrades loudly.** `not-configured` / `converter-unavailable` / failed
  conversions all render an explanatory card with a download action instead of a
  blank frame, so a conversion-service outage never looks like a broken file.
- **The conversion is requested before the iframe is pointed at it.** Otherwise a
  failing conversion would render a JSON error body inside the frame.

## Server contract

See `packages/web/server/lib/doc-preview/DOCUMENTATION.md`. `config` answers
`kind: 'pdf'` in both cases; `converted: true` means the PDF has to be produced by
`/api/doc-preview/convert` first, and `converted: false` means the file is already
a PDF and `/api/fs/raw` serves it.
