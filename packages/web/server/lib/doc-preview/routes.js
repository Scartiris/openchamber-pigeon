/**
 * Document preview routes (Word / Excel / PowerPoint / PDF).
 *
 *   GET /api/doc-preview/health   UI-authenticated. Reports whether the preview
 *                                 surface can render office files right now.
 *   GET /api/doc-preview/config   UI-authenticated. Resolves one file inside the
 *                                 active workspace and returns everything the
 *                                 client needs: a native PDF descriptor or a
 *                                 signed OnlyOffice editor configuration.
 *   GET /doc-preview/raw          Capability-token authenticated. Serves the
 *                                 document bytes to the document server.
 *
 * `/doc-preview/raw` deliberately lives **outside** `/api`: the OnlyOffice
 * Document Server fetches it container-to-container without cookies or an
 * `Authorization` header, so the UI auth middleware cannot apply. The URL
 * carries a short-lived HMAC token that pins one canonical path and one file
 * version, is never logged, and only ever exposes a file the requesting user
 * could already open through the workspace.
 */

import {
  buildDocumentKey,
  signJwt,
  signRawToken,
  verifyRawToken,
} from './token.js';

const MAX_PREVIEW_BYTES = 100 * 1024 * 1024;
const RAW_TOKEN_TTL_MS = 10 * 60 * 1000;

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
  const asciiOnly = fileName.replace(/[^\u0000-\u007F]/g, '');
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
        p: canonicalPath,
        m: Math.trunc(stats.mtimeMs),
        s: Math.trunc(stats.size),
        e: Date.now() + RAW_TOKEN_TTL_MS,
      },
    });

    const requestBase = `${req.protocol}://${req.get('host')}`;
    const documentBaseUrl = docPreviewRuntime.getDocumentBaseUrl() || requestBase;
    const documentUrl = `${documentBaseUrl}/doc-preview/raw?token=${encodeURIComponent(rawToken)}`;
    const requestedTheme = asString(req.query?.theme).toLowerCase();
    const fileName = getFileName(canonicalPath);

    const editorConfigPayload = {
      document: {
        fileType: extension,
        key: documentKey,
        title: fileName,
        url: documentUrl,
        permissions: {
          edit: false,
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
        mode: 'view',
        lang: 'zh-CN',
        user: { id: 'openchamber', name: 'OpenChamber' },
        customization: {
          autosave: false,
          forcesave: false,
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

    return res.json({
      available: true,
      kind: 'onlyoffice',
      documentType: kind,
      documentKey,
      documentServerUrl: docPreviewRuntime.getPublicUrl(),
      fileName,
      size: stats.size,
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

    try {
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
};

export const DOC_PREVIEW_LIMITS = Object.freeze({
  maxPreviewBytes: MAX_PREVIEW_BYTES,
  rawTokenTtlMs: RAW_TOKEN_TTL_MS,
});
