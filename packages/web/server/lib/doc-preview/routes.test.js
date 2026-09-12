import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerDocPreviewRoutes } from './routes.js';
import { createDocPreviewRuntime } from './runtime.js';
import { signRawToken, verifyRawToken } from './token.js';

const crypto = { createHash, createHmac, randomBytes, timingSafeEqual };

const SECRET = 'unit-test-secret';

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

const createRequest = ({ query = {}, host = 'oc.example.com', protocol = 'https' } = {}) => ({
  query,
  protocol,
  get: (name) => (String(name).toLowerCase() === 'host' ? host : undefined),
});

const decodeJwtPayload = (token) => {
  const [, body] = token.split('.');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
};

let workspace;
let dataDir;
let fetchImpl;

const setup = async ({ env = {}, resolver, fsOverrides = {} } = {}) => {
  const registry = createRouteRegistry();
  const runtime = createDocPreviewRuntime({
    crypto,
    fsPromises: { readFile, writeFile, mkdir },
    path,
    openchamberDataDir: dataDir,
    env: {
      OPENCHAMBER_DOC_PREVIEW_URL: 'http://documentserver',
      OPENCHAMBER_DOC_PREVIEW_PUBLIC_URL: 'https://office.example.com',
      OPENCHAMBER_DOC_PREVIEW_JWT_SECRET: SECRET,
      OPENCHAMBER_DOC_PREVIEW_RAW_SECRET: SECRET,
      ...env,
    },
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

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'doc-preview-ws-'));
  dataDir = await mkdtemp(path.join(tmpdir(), 'doc-preview-data-'));
  fetchImpl = vi.fn(async () => ({
    ok: true,
    text: async () => 'true',
  }));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('doc preview tokens', () => {
  it('round-trips a signed token', () => {
    const token = signRawToken({
      crypto,
      secret: SECRET,
      payload: { p: '/repo/a.docx', m: 1, s: 2, e: Date.now() + 60_000 },
    });
    const verified = verifyRawToken({ crypto, secret: SECRET, token });
    expect(verified.ok).toBe(true);
    expect(verified.payload.p).toBe('/repo/a.docx');
  });

  it('rejects a tampered or foreign-signed token', () => {
    const token = signRawToken({
      crypto,
      secret: SECRET,
      payload: { p: '/repo/a.docx', m: 1, s: 2, e: Date.now() + 60_000 },
    });
    expect(verifyRawToken({ crypto, secret: SECRET, token: `${token}x` }).ok).toBe(false);
    expect(verifyRawToken({ crypto, secret: 'other', token }).reason).toBe('signature');
    expect(verifyRawToken({ crypto, secret: SECRET, token: 'garbage' }).reason).toBe('malformed');
  });

  it('rejects an expired token', () => {
    const token = signRawToken({
      crypto,
      secret: SECRET,
      payload: { p: '/repo/a.docx', m: 1, s: 2, e: Date.now() - 1 },
    });
    expect(verifyRawToken({ crypto, secret: SECRET, token }).reason).toBe('expired');
  });
});

describe('doc preview runtime', () => {
  it('is inert without configuration', async () => {
    const registry = await setup({ env: { OPENCHAMBER_DOC_PREVIEW_JWT_SECRET: '' } });
    const res = await invoke(registry.getRoute('GET', '/api/doc-preview/health'), createRequest());
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ available: false, configured: false, reason: 'not-configured' });
  });

  it('reports the document server as unavailable when the probe fails', async () => {
    fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const registry = await setup();
    const res = await invoke(registry.getRoute('GET', '/api/doc-preview/health'), createRequest());
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe('document-server-unavailable');
  });

  it('persists a generated capability secret in the data dir', async () => {
    const runtime = createDocPreviewRuntime({
      crypto,
      fsPromises: { readFile, writeFile, mkdir },
      path,
      openchamberDataDir: dataDir,
      env: {},
      fetchImpl,
    });
    const first = await runtime.readRawSecret();
    expect(first).toHaveLength(64);
    const second = await runtime.readRawSecret();
    expect(second).toBe(first);
    const onDisk = (await readFile(path.join(dataDir, 'doc-preview-secret'), 'utf8')).trim();
    expect(onDisk).toBe(first);
  });
});

describe('GET /api/doc-preview/config', () => {
  it('requires a path', async () => {
    const registry = await setup();
    const res = await invoke(registry.getRoute('GET', '/api/doc-preview/config'), createRequest());
    expect(res.statusCode).toBe(400);
  });

  it('surfaces workspace confinement failures', async () => {
    const registry = await setup({
      resolver: async () => ({ ok: false, error: 'Path is outside of active workspace' }),
    });
    const res = await invoke(
      registry.getRoute('GET', '/api/doc-preview/config'),
      createRequest({ query: { path: '/etc/passwd.docx' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Path is outside of active workspace');
  });

  it('answers 404 for a missing file', async () => {
    const registry = await setup();
    const res = await invoke(
      registry.getRoute('GET', '/api/doc-preview/config'),
      createRequest({ query: { path: 'missing.docx' } }),
    );
    expect(res.statusCode).toBe(404);
  });

  it('answers 415 for a file type that has no preview', async () => {
    await writeFile(path.join(workspace, 'notes.txt'), 'hello');
    const registry = await setup();
    const res = await invoke(
      registry.getRoute('GET', '/api/doc-preview/config'),
      createRequest({ query: { path: 'notes.txt' } }),
    );
    expect(res.statusCode).toBe(415);
  });

  it('describes PDFs for the native viewer without touching the document server', async () => {
    await writeFile(path.join(workspace, 'report.pdf'), '%PDF-1.4');
    const registry = await setup();
    const res = await invoke(
      registry.getRoute('GET', '/api/doc-preview/config'),
      createRequest({ query: { path: 'report.pdf' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ available: true, kind: 'pdf' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers 503 when the document server is down', async () => {
    await writeFile(path.join(workspace, 'report.docx'), 'docx');
    fetchImpl = vi.fn(async () => {
      throw new Error('down');
    });
    const registry = await setup();
    const res = await invoke(
      registry.getRoute('GET', '/api/doc-preview/config'),
      createRequest({ query: { path: 'report.docx' } }),
    );
    expect(res.statusCode).toBe(503);
    expect(res.body.reason).toBe('document-server-unavailable');
  });

  it('returns a signed OnlyOffice configuration for a workspace document', async () => {
    await writeFile(path.join(workspace, '报告.docx'), 'docx-bytes');
    const registry = await setup();
    const res = await invoke(
      registry.getRoute('GET', '/api/doc-preview/config'),
      createRequest({ query: { path: '报告.docx', theme: 'dark' } }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.kind).toBe('onlyoffice');
    expect(res.body.documentType).toBe('word');
    expect(res.body.documentServerUrl).toBe('https://office.example.com');
    expect(res.body.editorConfig.document.title).toBe('报告.docx');
    expect(res.body.editorConfig.editorConfig.mode).toBe('view');
    expect(res.body.editorConfig.editorConfig.customization.uiTheme).toBe('theme-dark');
    expect(res.body.editorConfig.document.permissions.edit).toBe(false);

    const payload = decodeJwtPayload(res.body.editorConfig.token);
    expect(payload.document.key).toBe(res.body.documentKey);
    expect(payload.document.url).toContain('https://oc.example.com/doc-preview/raw?token=');

    const token = decodeURIComponent(new URL(payload.document.url).searchParams.get('token'));
    const verified = verifyRawToken({ crypto, secret: SECRET, token });
    expect(verified.ok).toBe(true);
    expect(verified.payload.p).toBe(path.join(workspace, '报告.docx'));
  });

  it('prefers the configured internal document base URL', async () => {
    await writeFile(path.join(workspace, 'report.docx'), 'docx');
    const registry = await setup({ env: { OPENCHAMBER_DOC_PREVIEW_DOCUMENT_BASE_URL: 'http://openchamber:3000' } });
    const res = await invoke(
      registry.getRoute('GET', '/api/doc-preview/config'),
      createRequest({ query: { path: 'report.docx' } }),
    );
    const payload = decodeJwtPayload(res.body.editorConfig.token);
    expect(payload.document.url.startsWith('http://openchamber:3000/doc-preview/raw')).toBe(true);
  });
});

describe('GET /doc-preview/raw', () => {
  const mintToken = async ({ filePath, secret = SECRET, exp = Date.now() + 60_000 }) => signRawToken({
    crypto,
    secret,
    payload: { p: filePath, m: 1, s: 1, e: exp },
  });

  it('rejects missing, tampered and expired tokens', async () => {
    const registry = await setup();
    const handler = registry.getRoute('GET', '/doc-preview/raw');
    const filePath = path.join(workspace, 'report.docx');
    await writeFile(filePath, 'docx');

    expect((await invoke(handler, createRequest())).statusCode).toBe(403);
    expect((await invoke(handler, createRequest({ query: { token: 'nope' } }))).statusCode).toBe(403);
    expect((await invoke(handler, createRequest({ query: { token: `${await mintToken({ filePath })}x` } }))).statusCode).toBe(403);
    expect((await invoke(handler, createRequest({
      query: { token: await mintToken({ filePath, exp: Date.now() - 1 }) },
    }))).statusCode).toBe(403);
  });

  it('serves the signed file with preview headers', async () => {
    const registry = await setup();
    const filePath = path.join(workspace, 'report.docx');
    await writeFile(filePath, 'docx-bytes');
    const res = await invoke(
      registry.getRoute('GET', '/doc-preview/raw'),
      createRequest({ query: { token: await mintToken({ filePath }) } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.toString('utf8')).toBe('docx-bytes');
    expect(res.getHeader('cache-control')).toBe('no-store');
    expect(res.getHeader('x-content-type-options')).toBe('nosniff');
    expect(res.getHeader('content-disposition')).toContain('report.docx');
  });

  it('refuses a path that no longer realpaths to itself', async () => {
    const linkPath = path.join(workspace, 'link.docx');
    const realFile = path.join(workspace, 'real.docx');
    await writeFile(linkPath, 'docx');
    await writeFile(realFile, 'docx');

    const registry = await setup({
      fsOverrides: {
        realpath: async (value) => (
          path.resolve(value) === path.resolve(linkPath) ? realFile : realpath(value)
        ),
      },
    });

    const res = await invoke(
      registry.getRoute('GET', '/doc-preview/raw'),
      createRequest({ query: { token: await mintToken({ filePath: linkPath }) } }),
    );
    expect(res.statusCode).toBe(403);
  });

  it('answers 404 when the signed file disappeared', async () => {
    const registry = await setup();
    const res = await invoke(
      registry.getRoute('GET', '/doc-preview/raw'),
      createRequest({ query: { token: await mintToken({ filePath: path.join(workspace, 'gone.docx') }) } }),
    );
    expect(res.statusCode).toBe(404);
  });
});
