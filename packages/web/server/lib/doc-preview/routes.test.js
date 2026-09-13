import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildConversionKey } from './converter.js';
import { registerDocPreviewRoutes } from './routes.js';
import { createDocPreviewRuntime } from './runtime.js';

const crypto = { createHash, createHmac, randomBytes, timingSafeEqual };

const PDF_BYTES = Buffer.from('%PDF-1.4\nconverted\n%%EOF\n');

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  const headers = new Map();
  let statusCode = 200;
  let body = null;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    type() {
      return this;
    },
    send(payload) {
      body = payload;
      return this;
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

const createRequest = ({ query = {} } = {}) => ({ query });

/**
 * Stands in for the LibreOffice sidecar: `/health`, `/cache/<key>` and
 * `/convert/<key>`. `conversions` records every upload so a test can assert
 * *whether* the document was sent — a cache hit must not re-upload it.
 */
const createConverterFetch = ({
  healthy = true,
  cached = null,
  converted = PDF_BYTES,
  convertStatus = 200,
  conversions = [],
} = {}) => vi.fn(async (url, init = {}) => {
  const href = String(url);
  if (href.endsWith('/health')) {
    return { ok: healthy, status: healthy ? 200 : 503, json: async () => ({ status: 'ok' }) };
  }
  if (href.includes('/cache/')) {
    return cached
      ? { ok: true, status: 200, arrayBuffer: async () => cached }
      : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  }
  if (href.includes('/convert/')) {
    conversions.push({ url: href, body: init.body });
    if (convertStatus !== 200) {
      return { ok: false, status: convertStatus, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => converted };
  }
  throw new Error(`unexpected converter request: ${href}`);
});

let workspace;
let fetchImpl;
let conversions;

const setup = async ({ env = {}, resolver, fsOverrides = {} } = {}) => {
  const registry = createRouteRegistry();
  const runtime = createDocPreviewRuntime({
    env: { OPENCHAMBER_DOC_PREVIEW_URL: 'http://office-convert:8000', ...env },
    fetchImpl: (...args) => fetchImpl(...args),
  });

  registerDocPreviewRoutes(registry.app, {
    crypto,
    fsPromises: { readFile, stat, realpath, ...fsOverrides },
    path,
    docPreviewRuntime: runtime,
    resolveReadPathFromContext: resolver || (async ({ targetPath }) => ({
      ok: true,
      base: workspace,
      resolved: path.resolve(workspace, targetPath),
    })),
  });

  return registry;
};

const invoke = async (handler, req) => {
  const res = createMockResponse();
  await handler(req, res);
  return res;
};

const writeDocument = async (name, contents = 'document body') => {
  const target = path.join(workspace, name);
  await writeFile(target, contents);
  return target;
};

const call = (registry, routePath, query) => invoke(
  registry.getRoute('GET', routePath),
  createRequest({ query }),
);

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'doc-preview-ws-'));
  conversions = [];
  fetchImpl = createConverterFetch({ conversions });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('conversion keys', () => {
  it('changes when any part of the file identity changes', () => {
    const base = { crypto, canonicalPath: '/repo/a.docx', mtimeMs: 1_000, size: 10 };
    const key = buildConversionKey(base);

    expect(key).toMatch(/^[a-f0-9]{40}$/);
    expect(buildConversionKey(base)).toBe(key);
    expect(buildConversionKey({ ...base, mtimeMs: 1_001 })).not.toBe(key);
    expect(buildConversionKey({ ...base, size: 11 })).not.toBe(key);
    expect(buildConversionKey({ ...base, canonicalPath: '/repo/b.docx' })).not.toBe(key);
  });
});

describe('doc preview runtime', () => {
  it('is inert without a conversion service', async () => {
    const registry = await setup({ env: { OPENCHAMBER_DOC_PREVIEW_URL: '' } });
    const res = await call(registry, '/api/doc-preview/health');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ available: false, configured: false, reason: 'not-configured' });
  });

  it('stays disabled when the feature is switched off explicitly', async () => {
    const registry = await setup({
      env: { OPENCHAMBER_DOC_PREVIEW_DISABLED: 'true' },
    });
    const res = await call(registry, '/api/doc-preview/health');
    expect(res.body).toEqual({ available: false, configured: false, reason: 'disabled' });
  });

  it('reports the conversion service as unavailable when the probe fails', async () => {
    fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/health');
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe('converter-unavailable');
  });

  it('clamps the conversion budget to a sane window', () => {
    const short = createDocPreviewRuntime({ env: { OPENCHAMBER_DOC_PREVIEW_URL: 'http://x', OPENCHAMBER_DOC_PREVIEW_TIMEOUT_MS: '10' } });
    const long = createDocPreviewRuntime({ env: { OPENCHAMBER_DOC_PREVIEW_URL: 'http://x', OPENCHAMBER_DOC_PREVIEW_TIMEOUT_MS: '99999999' } });
    const unset = createDocPreviewRuntime({ env: { OPENCHAMBER_DOC_PREVIEW_URL: 'http://x' } });

    expect(short.getConversionTimeoutMs()).toBe(5_000);
    expect(long.getConversionTimeoutMs()).toBe(600_000);
    expect(unset.getConversionTimeoutMs()).toBe(120_000);
  });
});

describe('GET /api/doc-preview/config', () => {
  it('requires a path', async () => {
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/config');
    expect(res.statusCode).toBe(400);
  });

  it('surfaces workspace confinement failures', async () => {
    const registry = await setup({
      resolver: async () => ({ ok: false, error: 'Path is outside of active workspace' }),
    });
    const res = await call(registry, '/api/doc-preview/config', { path: 'a.docx' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Path is outside of active workspace');
  });

  it('answers 404 for a missing file', async () => {
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/config', { path: 'missing.docx' });
    expect(res.statusCode).toBe(404);
  });

  it('answers 415 for a format nothing can preview', async () => {
    await writeDocument('notes.txt');
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/config', { path: 'notes.txt' });
    expect(res.statusCode).toBe(415);
  });

  it('answers 413 over the preview size limit', async () => {
    await writeDocument('huge.docx');
    const registry = await setup({
      // A spread of a real Stats loses `isFile` (it lives on the prototype), so
      // the fake has to carry it explicitly.
      fsOverrides: {
        stat: async (target) => ({
          ...(await stat(target)),
          size: 100 * 1024 * 1024 + 1,
          isFile: () => true,
        }),
      },
    });
    const res = await call(registry, '/api/doc-preview/config', { path: 'huge.docx' });
    expect(res.statusCode).toBe(413);
  });

  it('keeps PDFs on the native viewer without touching the converter', async () => {
    await writeDocument('report.pdf', '%PDF-1.4\noriginal\n');
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/config', { path: 'report.pdf' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ available: true, kind: 'pdf', converted: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is not-configured for office files when no conversion service is set', async () => {
    await writeDocument('report.docx');
    const registry = await setup({ env: { OPENCHAMBER_DOC_PREVIEW_URL: '' } });
    const res = await call(registry, '/api/doc-preview/config', { path: 'report.docx' });

    expect(res.statusCode).toBe(501);
    expect(res.body).toEqual({ available: false, reason: 'not-configured' });
  });

  it('answers 503 when the conversion service is down', async () => {
    await writeDocument('report.docx');
    fetchImpl = createConverterFetch({ healthy: false });
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/config', { path: 'report.docx' });

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ available: false, reason: 'converter-unavailable' });
  });

  it('describes an office file as a PDF that still has to be converted', async () => {
    await writeDocument('report.docx');
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/config', { path: 'report.docx' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ available: true, kind: 'pdf', converted: true, fileName: 'report.docx' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/doc-preview/convert', () => {
  it('returns a cached conversion without uploading the document again', async () => {
    await writeDocument('report.docx');
    fetchImpl = createConverterFetch({ cached: PDF_BYTES, conversions });
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/convert', { path: 'report.docx' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ available: true, converted: true, cached: true, bytes: PDF_BYTES.length });
    expect(conversions).toHaveLength(0);
  });

  it('converts and uploads the document on a cache miss', async () => {
    const target = await writeDocument('report.docx', 'first version');
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/convert', { path: 'report.docx' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ available: true, converted: true, cached: false, bytes: PDF_BYTES.length });
    expect(conversions).toHaveLength(1);
    expect(conversions[0].url).toContain('name=report.docx');
    expect(Buffer.from(conversions[0].body).toString()).toBe('first version');

    // The cache key the service is asked to store under has to be the identity
    // of the bytes that were just uploaded.
    const stats = await stat(await realpath(target));
    const expectedKey = buildConversionKey({
      crypto,
      canonicalPath: await realpath(target),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    });
    expect(conversions[0].url).toContain(`/convert/${expectedKey}?`);
  });

  it('keys the conversion by file version, so a save converts again', async () => {
    await writeDocument('report.docx', 'first version');
    const registry = await setup();
    await call(registry, '/api/doc-preview/convert', { path: 'report.docx' });

    await writeDocument('report.docx', 'a much longer second version');
    await call(registry, '/api/doc-preview/convert', { path: 'report.docx' });

    expect(conversions).toHaveLength(2);
    const firstKey = conversions[0].url.split('/convert/')[1].split('?')[0];
    const secondKey = conversions[1].url.split('/convert/')[1].split('?')[0];
    expect(secondKey).not.toBe(firstKey);
  });

  it('does nothing for a document that is already a PDF', async () => {
    await writeDocument('report.pdf', '%PDF-1.4\noriginal\n');
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/convert', { path: 'report.pdf' });

    expect(res.body).toMatchObject({ available: true, converted: false, cached: true });
    expect(conversions).toHaveLength(0);
  });

  it('reports a conversion the service could not do', async () => {
    await writeDocument('report.docx');
    fetchImpl = createConverterFetch({ convertStatus: 422, conversions });
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/convert', { path: 'report.docx' });

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ available: false, reason: 'conversion-failed' });
  });

  it('reports a document the service refused as too large', async () => {
    await writeDocument('report.docx');
    fetchImpl = createConverterFetch({ convertStatus: 413, conversions });
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/convert', { path: 'report.docx' });

    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ available: false, reason: 'too-large' });
  });

  it('reports a conversion that ran out of time', async () => {
    await writeDocument('report.docx');
    fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith('/health')) {
        return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
      }
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      throw timeout;
    });
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/convert', { path: 'report.docx' });

    expect(res.statusCode).toBe(504);
    expect(res.body).toEqual({ available: false, reason: 'conversion-timeout' });
  });
});

describe('GET /api/doc-preview/pdf', () => {
  it('serves the converted PDF under the document name', async () => {
    await writeDocument('report.docx');
    fetchImpl = createConverterFetch({ cached: PDF_BYTES, conversions });
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/pdf', { path: 'report.docx' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(PDF_BYTES);
    expect(res.getHeader('content-disposition')).toContain('report.pdf');
    expect(res.getHeader('cache-control')).toBe('no-store');
    expect(res.getHeader('x-content-type-options')).toBe('nosniff');
  });

  it('serves an original PDF as-is', async () => {
    await writeDocument('report.pdf', '%PDF-1.4\noriginal\n');
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/pdf', { path: 'report.pdf' });

    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.body).toString()).toContain('original');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('converts on its own when the client did not pre-warm the cache', async () => {
    await writeDocument('report.docx');
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/pdf', { path: 'report.docx' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(PDF_BYTES);
    expect(conversions).toHaveLength(1);
  });

  it('answers with the failure instead of a broken frame', async () => {
    await writeDocument('report.docx');
    fetchImpl = createConverterFetch({ convertStatus: 422, conversions });
    const registry = await setup();
    const res = await call(registry, '/api/doc-preview/pdf', { path: 'report.docx' });

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ available: false, reason: 'conversion-failed' });
  });

  it('needs a configured conversion service for office files', async () => {
    await writeDocument('report.docx');
    const registry = await setup({ env: { OPENCHAMBER_DOC_PREVIEW_URL: '' } });
    const res = await call(registry, '/api/doc-preview/pdf', { path: 'report.docx' });

    expect(res.statusCode).toBe(501);
  });
});
