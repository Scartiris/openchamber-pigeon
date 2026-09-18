/**
 * Document preview routes (Word / Excel / PowerPoint / PDF).
 *
 *   GET  /api/doc-preview/health   UI-authenticated. Reports whether the preview
 *                                  surface can render office files right now.
 *   GET  /api/doc-preview/config   UI-authenticated. Resolves one file inside the
 *                                  active workspace and returns everything the
 *                                  client needs: a native PDF descriptor or a
 *                                  signed OnlyOffice editor configuration. With
 *                                  `?edit=1` and an editor-safe format it also
 *                                  hands back a save callback URL.
 *   GET  /doc-preview/raw          Capability-token authenticated. Serves the
 *                                  document bytes to the document server.
 *   POST /doc-preview/callback     Capability token **and** the document
 *                                  server's own JWT. Receives a saved document
 *                                  and writes it back to the workspace file.
 *
 * `/doc-preview/raw` and `/doc-preview/callback` deliberately live **outside**
 * `/api`: the OnlyOffice Document Server calls them container-to-container
 * without cookies or an `Authorization` header, so the UI auth middleware cannot
 * apply. Each URL carries an HMAC token that pins one canonical path, and — for
 * the callback — the document key the editing session was opened with.
 */

import { createHash } from 'node:crypto';

import {
  buildDocumentKey,
  signJwt,
  signRawToken,
  verifyJwt,
  verifyRawToken,
} from './token.js';

const MAX_PREVIEW_BYTES = 100 * 1024 * 1024;
const RAW_TOKEN_TTL_MS = 10 * 60 * 1000;
// An editing session can stay open for hours, and the document server only calls
// back when the user saves or closes the document.
const WRITE_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const SAVED_VERSION_LIMIT = 5;

/**
 * Formats the editor may write back to the file it opened.
 *
 * Only the OOXML trio: the document server saves these in the format it read.
 * Legacy binary formats (.doc/.xls/.ppt) would be converted to OOXML on save —
 * silently changing the user's file type — and csv/rtf/odf round-trips lose
 * structure or formatting, so those stay read-only.
 */
export const DOCUMENT_EDITABLE_EXTENSIONS = Object.freeze(['docx', 'xlsx', 'pptx']);
const EDITABLE_EXTENSIONS = new Set(DOCUMENT_EDITABLE_EXTENSIONS);

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

const SAVE_DOWNLOAD_TIMEOUT_MS = 120 * 1000;

/**
 * The document server reports the saved file with a URL built from *its own*
 * host name, which from inside this container points at our own loopback. Keep
 * the cache path and re-attach it to the address we actually reach the server
 * on. Only `/cache/` paths are accepted, so a callback cannot aim this at an
 * arbitrary URL.
 */
const resolveDocumentServerDownloadUrl = ({ rawUrl, internalUrl }) => {
  if (!rawUrl || !internalUrl) {
    return '';
  }

  let parsed = null;
  try {
    parsed = new URL(rawUrl, 'http://document-server.invalid');
  } catch {
    return '';
  }
  if (!parsed.pathname.startsWith('/cache/')) {
    return '';
  }

  return `${internalUrl.replace(/\/+$/, '')}${parsed.pathname}${parsed.search}`;
};

/**
 * Writes to one document are serialised: the document server can deliver an
 * autosave and a close-save back to back, and two interleaved read-modify-write
 * cycles on the same file would lose one of them.
 */
const writeQueues = new Map();
const enqueueDocumentWrite = (key, task) => {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.catch(() => {}).finally(() => {
    if (writeQueues.get(key) === settled) {
      writeQueues.delete(key);
    }
  });
  writeQueues.set(key, settled);
  return next;
};

const pruneSavedVersions = async ({ fsPromises, path, dir }) => {
  try {
    const entries = (await fsPromises.readdir(dir)).sort();
    for (const entry of entries.slice(0, Math.max(0, entries.length - SAVED_VERSION_LIMIT))) {
      await fsPromises.rm(path.join(dir, entry), { force: true });
    }
  } catch (error) {
    console.warn('Failed to prune saved document versions:', error?.message || error);
  }
};

/**
 * Replace the workspace file with what the editor produced.
 *
 * Two properties matter here and both are deliberate: the copy of the version
 * being replaced goes to the server's data dir (never next to the user's file),
 * and the new bytes land through a same-directory temp file plus `rename`, so a
 * crash mid-save cannot leave a half-written document in the workspace.
 */
const writeSavedDocument = async ({ fsPromises, path, canonicalPath, bytes, versionsDir }) => {
  let previousStats = null;
  try {
    previousStats = await fsPromises.stat(canonicalPath);
    const previous = await fsPromises.readFile(canonicalPath);
    const digest = createHash('sha1').update(canonicalPath).digest('hex');
    const dir = path.join(versionsDir, digest);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(
      path.join(dir, `${Date.now()}-${previousStats.size}.bak`),
      previous,
      { mode: 0o600 },
    );
    await pruneSavedVersions({ fsPromises, path, dir });
  } catch (error) {
    // A document that vanished between the editor opening and the save should
    // still be written: the user's edits are newer than the missing file.
    if (error?.code !== 'ENOENT') {
      console.warn('Failed to keep the previous document version:', error?.message || error);
    }
  }

  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const tempPath = `${canonicalPath}.doc-preview-${suffix}.tmp`;
  try {
    await fsPromises.writeFile(tempPath, bytes, previousStats ? { mode: previousStats.mode } : undefined);
    await fsPromises.rename(tempPath, canonicalPath);
  } catch (error) {
    await fsPromises.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
};

export const registerDocPreviewRoutes = (app, dependencies) => {
  const {
    crypto,
    fsPromises,
    path,
    docPreviewRuntime,
    resolveReadPathFromContext,
    // Injected so the save callback's download can be driven in tests; the real
    // server always uses the global fetch.
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
        k: 'read',
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

    // Editing is opt-in per request and only offered for formats the editor can
    // write back in place; everything else keeps the read-only view and says so,
    // rather than leaving the client to guess why the toggle is missing.
    const editRequested = asString(req.query?.edit) === '1' || asString(req.query?.mode).toLowerCase() === 'edit';
    const editable = EDITABLE_EXTENSIONS.has(extension);
    const editMode = editRequested && editable;

    let callbackUrl;
    if (editMode) {
      const writeToken = signRawToken({
        crypto,
        secret: rawSecret,
        payload: {
          k: 'write',
          p: canonicalPath,
          d: documentKey,
          e: Date.now() + WRITE_TOKEN_TTL_MS,
        },
      });
      callbackUrl = `${documentBaseUrl}/doc-preview/callback?token=${encodeURIComponent(writeToken)}`;
    }

    const editorConfigPayload = {
      document: {
        fileType: extension,
        key: documentKey,
        title: fileName,
        url: documentUrl,
        permissions: {
          edit: editMode,
          download: true,
          print: true,
          copy: true,
          review: false,
          comment: false,
          fillForms: editMode,
          modifyFilter: editMode,
          modifyContentControl: editMode,
        },
      },
      documentType: kind,
      editorConfig: {
        mode: editMode ? 'edit' : 'view',
        ...(callbackUrl ? { callbackUrl } : {}),
        // The fork ships Simplified Chinese only (LOCALES = ['zh-CN']), so the
        // editor language is not a per-request choice; theme is, because the
        // app's light/dark switch is.
        lang: 'zh-CN',
        user: { id: 'openchamber', name: 'OpenChamber' },
        customization: {
          // In edit mode the document server saves on its own and calls us back
          // with the result; in view mode there is nothing to save.
          autosave: editMode,
          forcesave: false,
          compactHeader: true,
          hideRightMenu: !editMode,
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

    return res.json({
      available: true,
      kind: 'onlyoffice',
      documentType: kind,
      documentKey,
      documentServerUrl: docPreviewRuntime.getPublicUrl(),
      fileName,
      size: stats.size,
      mode: editMode ? 'edit' : 'view',
      editable,
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
        requireKind: 'read',
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
   * Save callback for an editing session.
   *
   * The document server posts the edited document here. Two independent things
   * have to hold: the URL's capability token (write-scoped, bound to one
   * canonical path and to the document key this session was opened with), and
   * the JWT the document server signs over its own callback body with the shared
   * secret. Neither alone is enough — the token proves the request was minted
   * for this file, the JWT proves it came from the document server.
   */
  app.post('/doc-preview/callback', async (req, res) => {
    if (!docPreviewRuntime?.isConfigured()) {
      return notConfigured(res);
    }

    try {
      const rawSecret = await docPreviewRuntime.readRawSecret();
      const verified = verifyRawToken({
        crypto,
        secret: rawSecret,
        token: asString(req.query?.token),
        requireKind: 'write',
      });
      if (!verified.ok) {
        if (verified.reason === 'signature') {
          console.warn('Rejected a document save callback with an invalid token');
        }
        // The document server reads `error` from the body, so a failure has to
        // be reported there as well as in the status line.
        return res.status(403).json({ error: 1 });
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const status = Number(body.status);
      if (!Number.isFinite(status)) {
        return res.status(400).json({ error: 1 });
      }

      const providedJwt = asString(body.token)
        || asString(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
      if (!verifyJwt({ crypto, secret: docPreviewRuntime.getJwtSecret(), token: providedJwt })) {
        console.warn('Rejected a document save callback without a valid document server token');
        return res.status(403).json({ error: 1 });
      }

      // status 1 = editing, 3 = save error, 4 = closed without changes,
      // 7 = force-save error. Only 2 and 6 carry a document to store.
      if (status !== 2 && status !== 6) {
        return res.json({ error: 0 });
      }

      if (asString(body.key) !== verified.payload.d) {
        // A save for a different version of this file: storing it would
        // overwrite newer content with an older editing session's output.
        console.warn('Rejected a document save callback for a stale document key');
        return res.status(409).json({ error: 1 });
      }

      const downloadUrl = resolveDocumentServerDownloadUrl({
        rawUrl: asString(body.url),
        internalUrl: docPreviewRuntime.getInternalUrl(),
      });
      if (!downloadUrl) {
        console.warn('Rejected a document save callback with an unusable document URL');
        return res.status(400).json({ error: 1 });
      }

      const response = await fetchImpl(downloadUrl, { signal: AbortSignal.timeout(SAVE_DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) {
        console.error(`Document save download failed: ${response.status}`);
        return res.status(502).json({ error: 1 });
      }
      const saved = Buffer.from(await response.arrayBuffer());
      if (saved.length === 0 || saved.length > MAX_PREVIEW_BYTES) {
        console.error(`Document save rejected: ${saved.length} bytes`);
        return res.status(413).json({ error: 1 });
      }

      const canonicalPath = verified.payload.p;
      await enqueueDocumentWrite(canonicalPath, () => writeSavedDocument({
        fsPromises,
        path,
        canonicalPath,
        bytes: saved,
        versionsDir: docPreviewRuntime.getVersionsDir(),
      }));

      console.log(`Document saved: ${canonicalPath} (${saved.length} bytes, status ${status})`);
      return res.json({ error: 0 });
    } catch (error) {
      console.error('Failed to store a saved document:', error);
      return res.status(500).json({ error: 1 });
    }
  });
};

export const DOC_PREVIEW_LIMITS = Object.freeze({
  maxPreviewBytes: MAX_PREVIEW_BYTES,
  rawTokenTtlMs: RAW_TOKEN_TTL_MS,
  writeTokenTtlMs: WRITE_TOKEN_TTL_MS,
  savedVersionLimit: SAVED_VERSION_LIMIT,
});
