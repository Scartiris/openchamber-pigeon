/**
 * Document preview routes (Word / Excel / PowerPoint / PDF).
 *
 *   GET /api/doc-preview/health    UI-authenticated. Whether office files can be
 *                                  converted right now.
 *   GET /api/doc-preview/config    UI-authenticated. Resolves one file inside the
 *                                  active workspace and says how to render it.
 *   GET /api/doc-preview/convert   UI-authenticated. Converts one office file and
 *                                  answers when its PDF is ready.
 *   GET /api/doc-preview/pdf       UI-authenticated (also by `oc_url_token`).
 *                                  Streams the PDF the client renders in an iframe.
 *
 * Office formats are rendered as PDF, converted by a LibreOffice sidecar. PDFs
 * never touch the conversion service: the browser renders those straight from
 * `/api/fs/raw`, so a conversion-service outage only ever costs office previews.
 *
 * `pdf` is the only route an iframe loads, so it is the only one that has to be
 * on the URL-token allowlist in `lib/ui-auth/ui-auth.js`.
 *
 * `convert` writes a cache entry and is still a GET: the workspace-confinement
 * resolver reads `allowOutsideWorkspace` and `outsideFileGrant` from the query
 * string, and `/api/doc-preview` is not on the JSON-body middleware list. It is
 * idempotent for one file version — the cache key covers path, size and mtime —
 * and it exists so the client can show a real loading state and a real error
 * instead of leaving an iframe to render whatever the route returned.
 */

import { buildConversionKey } from './converter.js';

const MAX_PREVIEW_BYTES = 100 * 1024 * 1024;

/** Extension -> render kind. `pdf` is already what the browser wants. */
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

/** Failure reason -> HTTP status. Anything unlisted is an upstream failure. */
const CONVERSION_FAILURE_STATUS = Object.freeze({
  'too-large': 413,
  missing: 404,
  'converter-unavailable': 503,
  'conversion-timeout': 504,
  'conversion-failed': 502,
  'read-failed': 500,
});

const asString = (value) => (typeof value === 'string' ? value.trim() : '');

const getExtension = (filePath) => {
  const base = filePath.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

const getFileName = (filePath) => filePath.split(/[\\/]/).pop() || filePath;

const withPdfExtension = (fileName) => {
  const dot = fileName.lastIndexOf('.');
  return `${dot > 0 ? fileName.slice(0, dot) : fileName}.pdf`;
};

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
    fallback: (asciiOnly || 'document.pdf').replace(/["\\]/g, '_'),
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

  const sendConversionFailure = (res, reason) => res
    .status(CONVERSION_FAILURE_STATUS[reason] || CONVERSION_FAILURE_STATUS['conversion-failed'])
    .json({ available: false, reason: reason || 'conversion-failed' });

  /**
   * Resolve a client-supplied path to a canonical file inside the workspace.
   * Mirrors `/api/fs/raw`: the workspace confinement decision happens here, and
   * everything downstream works on the canonical path it returns.
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

  /**
   * The whole admission decision for one preview request: confined path, known
   * extension, size within budget. Answers the request itself and returns null
   * when it refused, so every route below has one shape to handle.
   */
  const admitPreviewRequest = async (req, res) => {
    const filePath = asString(req.query?.path);
    if (!filePath) {
      res.status(400).json({ error: 'Path is required' });
      return null;
    }

    let target;
    try {
      target = await resolvePreviewTarget(req, filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
        return null;
      }
      console.error('Failed to resolve a document preview target:', error);
      res.status(500).json({ error: error?.message || 'Failed to resolve file' });
      return null;
    }

    if (!target.ok) {
      res.status(target.status).json({ error: target.error });
      return null;
    }

    const { canonicalPath, stats } = target;
    const extension = getExtension(canonicalPath);
    const kind = DOCUMENT_PREVIEW_KINDS[extension];
    if (!kind) {
      res.status(415).json({ error: 'File type is not previewable' });
      return null;
    }

    if (stats.size > MAX_PREVIEW_BYTES) {
      res.status(413).json({ error: 'File too large to preview' });
      return null;
    }

    return { canonicalPath, stats, extension, kind };
  };

  /**
   * Hand back the converted PDF for one target, converting it if this version
   * has not been converted yet. The key covers path, size and mtime, so a saved
   * document simply misses the cache and gets converted again on next open.
   */
  const ensureConverted = async ({ canonicalPath, stats }) => {
    const key = buildConversionKey({
      crypto,
      canonicalPath,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    });

    const cached = await docPreviewRuntime.readConverted(key);
    if (cached.hit) {
      return { ok: true, bytes: cached.bytes, cached: true };
    }

    let source;
    try {
      source = await fsPromises.readFile(canonicalPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { ok: false, reason: 'missing' };
      }
      console.error('Failed to read a document for conversion:', error);
      return { ok: false, reason: 'read-failed' };
    }

    const converted = await docPreviewRuntime.convert({
      key,
      fileName: getFileName(canonicalPath),
      bytes: source,
    });
    return converted.ok ? { ok: true, bytes: converted.bytes, cached: false } : converted;
  };

  const sendPdf = (res, bytes, fileName) => {
    const { fallback, encoded } = encodeFileName(fileName);
    res.setHeader('Content-Disposition', `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.type('application/pdf').send(bytes);
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

    const probe = await docPreviewRuntime.probeConverter();
    return res.json({
      available: probe.available,
      configured: true,
      reason: probe.reason,
    });
  });

  app.get('/api/doc-preview/config', async (req, res) => {
    const target = await admitPreviewRequest(req, res);
    if (!target) {
      return undefined;
    }

    if (target.kind === 'pdf') {
      return res.json({ available: true, kind: 'pdf', converted: false, size: target.stats.size });
    }

    if (!docPreviewRuntime?.isConfigured()) {
      return notConfigured(res);
    }

    const probe = await docPreviewRuntime.probeConverter();
    if (!probe.available) {
      return sendConversionFailure(res, probe.reason);
    }

    return res.json({
      available: true,
      kind: 'pdf',
      converted: true,
      size: target.stats.size,
      fileName: getFileName(target.canonicalPath),
    });
  });

  app.get('/api/doc-preview/convert', async (req, res) => {
    const target = await admitPreviewRequest(req, res);
    if (!target) {
      return undefined;
    }

    if (target.kind === 'pdf') {
      return res.json({ available: true, converted: false, cached: true, bytes: target.stats.size });
    }

    if (!docPreviewRuntime?.isConfigured()) {
      return notConfigured(res);
    }

    const probe = await docPreviewRuntime.probeConverter();
    if (!probe.available) {
      return sendConversionFailure(res, probe.reason);
    }

    const result = await ensureConverted(target);
    if (!result.ok) {
      return sendConversionFailure(res, result.reason);
    }

    return res.json({
      available: true,
      converted: true,
      cached: result.cached,
      bytes: result.bytes.length,
    });
  });

  app.get('/api/doc-preview/pdf', async (req, res) => {
    const target = await admitPreviewRequest(req, res);
    if (!target) {
      return undefined;
    }

    // A PDF needs no conversion; the route stays total by serving it as-is
    // rather than refusing a document whose preview would have worked.
    if (target.kind === 'pdf') {
      try {
        return sendPdf(res, await fsPromises.readFile(target.canonicalPath), getFileName(target.canonicalPath));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return res.status(404).json({ error: 'File not found' });
        }
        console.error('Failed to serve a document preview:', error);
        return res.status(500).json({ error: error?.message || 'Failed to read file' });
      }
    }

    if (!docPreviewRuntime?.isConfigured()) {
      return notConfigured(res);
    }

    const result = await ensureConverted(target);
    if (!result.ok) {
      return sendConversionFailure(res, result.reason);
    }

    return sendPdf(res, result.bytes, withPdfExtension(getFileName(target.canonicalPath)));
  });
};

export const DOC_PREVIEW_LIMITS = Object.freeze({
  maxPreviewBytes: MAX_PREVIEW_BYTES,
});
