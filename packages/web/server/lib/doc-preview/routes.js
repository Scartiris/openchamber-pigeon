/**
 * Document preview routes (Word / Excel / PowerPoint / PDF).
 *
 *   GET  /api/doc-preview/health   UI-authenticated. Reports whether the preview
 *                                  surface can render office files right now.
 *   GET  /api/doc-preview/config   UI-authenticated. Resolves one file inside the
 *                                  active workspace and returns everything the
 *                                  client needs: a native PDF descriptor or a
 *                                  signed OnlyOffice editor configuration.
 *                                  `edit=1` mints an edit-mode config (office
 *                                  files inside the workspace only).
 *   GET  /doc-preview/raw          Capability-token authenticated. Serves the
 *                                  document bytes to the document server.
 *   POST /doc-preview/callback     Edit-capability-token authenticated. Receives
 *                                  OnlyOffice save/forcesave callbacks and writes
 *                                  the converted document back to the workspace.
 *
 * `/doc-preview/raw` and `/doc-preview/callback` deliberately live **outside**
 * `/api`: the OnlyOffice Document Server reaches them container-to-container
 * without cookies or an `Authorization` header, so the UI auth middleware cannot
 * apply. URLs carry a short-lived HMAC token that pins one canonical path and
 * one file version, are never logged, and only ever address a file the
 * requesting user could already open through the workspace. Callback tokens are
 * edit-scoped (`k: 'edit'`) with a longer TTL so long edit sessions survive.
 */

import {
  buildDocumentKey,
  signJwt,
  signRawToken,
  verifyJwt,
  verifyRawToken,
} from './token.js';

const MAX_PREVIEW_BYTES = 100 * 1024 * 1024;
const RAW_TOKEN_TTL_MS = 10 * 60 * 1000;
// Edit sessions outlive a single document fetch: autosave may fire for as long
// as the editor stays open, so the callback capability needs a longer window.
const EDIT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const EDIT_TOKEN_KIND = 'edit';

/** Extension -> OnlyOffice document type. `pdf` stays on the native viewer. */
export const DOCUMENT_PREVIEW_KINDS = Object.freeze({
  pdf: 'pdf',
  docx: 'word',
  docm: 'word',
  doc: 'word',
  odt: 'word',
  rtf: 'word',
  xlsx: 'cell',
  xlsm: 'cell',
  xls: 'cell',
  ods: 'cell',
  csv: 'cell',
  pptx: 'slide',
  pptm: 'slide',
  ppt: 'slide',
  odp: 'slide',
});

const PREVIEW_MIME_TYPES = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  docm: 'application/vnd.ms-word.document.macroenabled.12',
  doc: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroenabled.12',
  xls: 'application/vnd.ms-excel',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  csv: 'text/csv',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  ppt: 'application/vnd.ms-powerpoint',
  odp: 'application/vnd.oasis.opendocument.presentation',
});

const UI_THEMES = Object.freeze({
  light: 'theme-light',
  dark: 'theme-dark',
});

const asString = (value) => (typeof value === 'string' ? value.trim() : '');

const isTruthyQuery = (value) => asString(value).toLowerCase() === 'true' || asString(value) === '1';

/** Hosts the document server is allowed to hand back as a save-download URL. */
const isDocumentServerDownloadUrl = (rawUrl, runtime) => {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  const allowedOrigins = [runtime.getInternalUrl(), runtime.getPublicUrl()]
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return allowedOrigins.includes(parsed.origin);
};

/** Editor identity: stable per path so collaborators are distinguishable. */
const buildEditorUserId = (crypto, canonicalPath) => `oc-doc-${crypto
  .createHash('sha1')
  .update(canonicalPath)
  .digest('hex')
  .slice(0, 16)}`;

const getExtension = (filePath) => {
  const base = filePath.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

const getFileName = (filePath) => filePath.split(/[\\/]/).pop() || filePath;

const isPathWithinRoot = (target, root, path) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const encodeFileName = (fileName) => {
  // Everything outside printable ASCII goes: the fallback lands in a quoted
  // header parameter, where a stray quote, backslash or control character
  // (a legal character in a POSIX filename) would make setHeader throw.
  const asciiOnly = fileName.replace(/[^\u0020-\u007E]/g, '');
  return {
    fallback: (asciiOnly || 'document').replace(/["\\]/g, '_'),
    encoded: encodeURIComponent(fileName),
  };
};

export const registerDocPreviewRoutes = (app, dependencies) => {
  const {
    crypto,
    fsPromises,
    path,
    docPreviewRuntime,
    resolveReadPathFromContext,
    fetchImpl = globalThis.fetch,
  } = dependencies;

  const notConfigured = (res) => res.status(501).json({
    available: false,
    reason: docPreviewRuntime?.isDisabled() ? 'disabled' : 'not-configured',
  });

  /**
   * Resolve a client-supplied path to a canonical file inside the workspace.
   * Mirrors `/api/fs/raw`: the workspace confinement decision happens here and
   * only the resulting canonical path is ever signed into a token.
   */
  const resolvePreviewTarget = async (req, targetPath) => {
    const resolved = await resolveReadPathFromContext({ req, targetPath, scope: 'raw' });
    if (!resolved?.ok) {
      return { ok: false, status: 400, error: resolved?.error || 'Path is outside of active workspace' };
    }

    const canonicalPath = await fsPromises.realpath(resolved.resolved);

    // Canonical containment re-check: the lexical check above ran on a path that
    // may still contain symlinks, so a link inside the workspace pointing out of
    // it would otherwise escape through realpath.
    if (resolved.base) {
      const canonicalBase = await fsPromises.realpath(resolved.base).catch(() => null);
      if (canonicalBase && !isPathWithinRoot(canonicalPath, canonicalBase, path)) {
        return { ok: false, status: 400, error: 'Path is outside of active workspace' };
      }
    }

    const stats = await fsPromises.stat(canonicalPath);
    if (!stats.isFile()) {
      return { ok: false, status: 400, error: 'Specified path is not a file' };
    }

    return { ok: true, canonicalPath, stats };
  };

  app.get('/api/doc-preview/health', async (_req, res) => {
    const describe = docPreviewRuntime?.describe?.() || { configured: false };
    if (!docPreviewRuntime?.isConfigured()) {
      return res.json({
        available: false,
        configured: false,
        reason: describe.disabled ? 'disabled' : 'not-configured',
      });
    }

    const probe = await docPreviewRuntime.probeDocumentServer();
    return res.json({
      available: probe.available,
      configured: true,
      reason: probe.reason,
      documentServerUrl: docPreviewRuntime.getPublicUrl() || null,
    });
  });

  app.get('/api/doc-preview/config', async (req, res) => {
    const filePath = asString(req.query?.path);
    if (!filePath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    let target;
    try {
      target = await resolvePreviewTarget(req, filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' });
      }
      console.error('Failed to resolve a document preview target:', error);
      return res.status(500).json({ error: error?.message || 'Failed to resolve file' });
    }

    if (!target.ok) {
      return res.status(target.status).json({ error: target.error });
    }

    const { canonicalPath, stats } = target;
    const extension = getExtension(canonicalPath);
    const kind = DOCUMENT_PREVIEW_KINDS[extension];
    if (!kind) {
      return res.status(415).json({ error: 'File type is not previewable' });
    }

    if (stats.size > MAX_PREVIEW_BYTES) {
      return res.status(413).json({ error: 'File too large to preview' });
    }

    if (kind === 'pdf') {
      return res.json({ available: true, kind: 'pdf', size: stats.size });
    }

    if (!docPreviewRuntime?.isConfigured()) {
      return notConfigured(res);
    }

    const probe = await docPreviewRuntime.probeDocumentServer();
    if (!probe.available) {
      return res.status(503).json({ available: false, reason: probe.reason || 'document-server-unavailable' });
    }

    // Edit is a workspace-only capability: outside-grant paths (and any other
    // non-workspace resolution) never mint a write token, and the client hides
    // the Edit action on the same condition.
    const wantsEdit = isTruthyQuery(req.query?.edit);
    const outsideWorkspace = asString(req.query?.allowOutsideWorkspace) === 'true';
    const editAllowed = wantsEdit && !outsideWorkspace;

    const rawSecret = await docPreviewRuntime.readRawSecret();
    const documentKey = buildDocumentKey({
      crypto,
      canonicalPath,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    });
    const rawToken = signRawToken({
      crypto,
      secret: rawSecret,
      payload: {
        p: canonicalPath,
        m: Math.trunc(stats.mtimeMs),
        s: Math.trunc(stats.size),
        e: Date.now() + RAW_TOKEN_TTL_MS,
      },
    });

    // The document server downloads the document from this base URL, so it is
    // the one value an unvalidated request header could otherwise steer. The
    // caller already receives the token in this same response, so it is not a
    // privilege boundary — but a deployment that reaches the document server
    // over a private network must set OPENCHAMBER_DOC_PREVIEW_DOCUMENT_BASE_URL
    // explicitly rather than rely on the Host header.
    const requestBase = `${req.protocol}://${req.get('host')}`;
    const documentBaseUrl = docPreviewRuntime.getDocumentBaseUrl() || requestBase;
    const documentUrl = `${documentBaseUrl}/doc-preview/raw?token=${encodeURIComponent(rawToken)}`;
    const requestedTheme = asString(req.query?.theme).toLowerCase();
    const fileName = getFileName(canonicalPath);

    let callbackUrl;
    if (editAllowed) {
      const editToken = signRawToken({
        crypto,
        secret: rawSecret,
        payload: {
          p: canonicalPath,
          m: Math.trunc(stats.mtimeMs),
          s: Math.trunc(stats.size),
          e: Date.now() + EDIT_TOKEN_TTL_MS,
          k: EDIT_TOKEN_KIND,
        },
      });
      callbackUrl = `${documentBaseUrl}/doc-preview/callback?token=${encodeURIComponent(editToken)}`;
    }

    const editorConfigPayload = {
      document: {
        fileType: extension,
        key: documentKey,
        title: fileName,
        url: documentUrl,
        permissions: {
          edit: editAllowed,
          download: true,
          print: true,
          copy: true,
          review: false,
          comment: false,
          fillForms: false,
          modifyFilter: false,
          modifyContentControl: false,
        },
      },
      documentType: kind,
      editorConfig: {
        mode: editAllowed ? 'edit' : 'view',
        // The fork ships Simplified Chinese only (LOCALES = ['zh-CN']), so the
        // editor language is not a per-request choice; theme is, because the
        // app's light/dark switch is.
        lang: 'zh-CN',
        user: {
          id: editAllowed ? buildEditorUserId(crypto, canonicalPath) : 'openchamber',
          name: 'OpenChamber',
        },
        customization: {
          autosave: editAllowed,
          forcesave: editAllowed,
          compactHeader: true,
          hideRightMenu: true,
          help: false,
          about: false,
          feedback: false,
          toolbarNoTabs: false,
          uiTheme: UI_THEMES[requestedTheme] || UI_THEMES.light,
        },
      },
      width: '100%',
      height: '100%',
    };
    if (callbackUrl) {
      editorConfigPayload.editorConfig.callbackUrl = callbackUrl;
    }

    return res.json({
      available: true,
      kind: 'onlyoffice',
      documentType: kind,
      documentKey,
      documentServerUrl: docPreviewRuntime.getPublicUrl(),
      fileName,
      size: stats.size,
      editable: editAllowed,
      editorConfig: {
        ...editorConfigPayload,
        token: signJwt({
          crypto,
          secret: docPreviewRuntime.getJwtSecret(),
          payload: editorConfigPayload,
        }),
      },
    });
  });

  app.get('/doc-preview/raw', async (req, res) => {
    // Answer before touching the secret or the filesystem: an unauthenticated
    // caller with a garbage token must not be able to make this server create
    // its capability secret, and a disabled feature has nothing to serve.
    if (!docPreviewRuntime?.isConfigured()) {
      return notConfigured(res);
    }

    try {
      const rawSecret = await docPreviewRuntime.readRawSecret();
      const verified = verifyRawToken({
        crypto,
        secret: rawSecret,
        token: asString(req.query?.token),
      });
      if (!verified.ok) {
        if (verified.reason === 'signature') {
          console.warn('Rejected a document preview request with an invalid token');
        }
        return res.status(403).json({ error: 'Preview link is invalid or expired' });
      }

      const canonicalPath = verified.payload.p;
      const currentPath = await fsPromises.realpath(canonicalPath);
      if (currentPath !== canonicalPath) {
        // The signed path no longer resolves to itself: a symlink was swapped
        // underneath us, so refuse rather than serve an unexpected file.
        return res.status(403).json({ error: 'Preview link is invalid or expired' });
      }

      const stats = await fsPromises.stat(canonicalPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Specified path is not a file' });
      }
      if (stats.size > MAX_PREVIEW_BYTES) {
        return res.status(413).json({ error: 'File too large to preview' });
      }

      // The token pins the version the editor configuration was built for, and
      // the document server caches its conversion under that version's key.
      // Serving different bytes under the same key would show a document that
      // does not match its own cache entry, so the client has to reload the
      // configuration (and get a new key) instead.
      if (Math.trunc(stats.mtimeMs) !== verified.payload.m || Math.trunc(stats.size) !== verified.payload.s) {
        return res.status(409).json({ error: 'Document changed since the preview was opened' });
      }

      const extension = getExtension(canonicalPath);
      const mimeType = PREVIEW_MIME_TYPES[extension] || 'application/octet-stream';
      const { fallback, encoded } = encodeFileName(getFileName(canonicalPath));
      const content = await fsPromises.readFile(canonicalPath);

      res.setHeader('Content-Disposition', `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.type(mimeType).send(content);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' });
      }
      console.error('Failed to serve a document preview:', error);
      return res.status(500).json({ error: error?.message || 'Failed to read file' });
    }
  });

  /**
   * OnlyOffice document-server save callback. The server POSTs here when the
   * user saves (status 2) or forces a save (status 6); other statuses are
   * lifecycle acks that must still answer `{ error: 0 }`.
   *
   * Authentication is the edit-scoped capability token in the query (the same
   * HMAC family as `/doc-preview/raw`, with `k: 'edit'` so a view fetch token
   * cannot be replayed as a write capability). When the document server also
   * sends its editor JWT, that JWT is verified against the shared secret.
   */
  app.post('/doc-preview/callback', async (req, res) => {
    // Always answer with the OnlyOffice error envelope, not an HTTP error
    // page: the document server retries on non-2xx and surfaces `error` to
    // the editor UI.
    const acknowledge = (error, reason) => {
      const payload = { error };
      if (reason) {
        payload.reason = reason;
      }
      return res.json(payload);
    };

    if (!docPreviewRuntime?.isConfigured()) {
      return notConfigured(res);
    }

    try {
      const rawSecret = await docPreviewRuntime.readRawSecret();
      const verified = verifyRawToken({
        crypto,
        secret: rawSecret,
        token: asString(req.query?.token),
      });
      if (!verified.ok || verified.payload.k !== EDIT_TOKEN_KIND) {
        return res.status(403).json({ error: 'Callback link is invalid or expired' });
      }

      const authorization = asString(req.headers?.authorization);
      if (authorization.toLowerCase().startsWith('bearer ')) {
        const verifiedJwt = verifyJwt({
          crypto,
          secret: docPreviewRuntime.getJwtSecret(),
          token: authorization.slice(7).trim(),
        });
        if (!verifiedJwt.ok) {
          return res.status(403).json({ error: 'Callback link is invalid or expired' });
        }
      }

      const rawBody = req.body;
      const status = Number(rawBody?.status);
      const canonicalPath = verified.payload.p;

      // Lifecycle statuses that do not carry a document to write are acked
      // without touching the filesystem, so a deleted path cannot induce
      // document-server retries on an otherwise harmless status 1/4/7.
      if (status !== 2 && status !== 6) {
        return acknowledge(0);
      }

      const currentPath = await fsPromises.realpath(canonicalPath).catch(() => null);
      if (currentPath !== canonicalPath) {
        return acknowledge(1, 'path-missing');
      }

      const downloadUrl = asString(rawBody?.url);
      if (!downloadUrl || !isDocumentServerDownloadUrl(downloadUrl, docPreviewRuntime)) {
        return acknowledge(1, 'invalid-download-url');
      }

      // redirect: 'error' keeps the SSRF origin pin honest — a same-origin
      // open redirect must not become an arbitrary download.
      const download = await fetchImpl(downloadUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
      if (!download.ok) {
        return acknowledge(1, 'download-failed');
      }

      const content = Buffer.from(await download.arrayBuffer());
      if (content.byteLength > MAX_PREVIEW_BYTES) {
        return acknowledge(1, 'too-large');
      }

      // The editor is authoritative for the session: an external writer during
      // an open edit loses to the next autosave. Atomic temp+rename so a
      // concurrent reader never sees a truncated office file.
      const temporaryPath = `${canonicalPath}.oc-save-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await fsPromises.writeFile(temporaryPath, content);
        await fsPromises.rename(temporaryPath, canonicalPath);
      } catch (error) {
        await fsPromises.unlink(temporaryPath).catch(() => {});
        console.error('Failed to write a document save callback:', error);
        return acknowledge(1, 'write-failed');
      }

      return acknowledge(0);
    } catch (error) {
      console.error('Document save callback failed:', error);
      return acknowledge(1, 'failed');
    }
  });
};

export const DOC_PREVIEW_LIMITS = Object.freeze({
  maxPreviewBytes: MAX_PREVIEW_BYTES,
  rawTokenTtlMs: RAW_TOKEN_TTL_MS,
  editTokenTtlMs: EDIT_TOKEN_TTL_MS,
});
