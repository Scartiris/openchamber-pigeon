import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerDocPreviewRoutes } from './routes.js';
import { createDocPreviewRuntime } from './runtime.js';
import { signJwt, signRawToken, verifyJwt, verifyRawToken } from './token.js';

const crypto = { createHash, createHmac, randomBytes, timingSafeEqual };

const SECRET = 'unit-test-secret';

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
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

const createRequest = ({ query = {}, host = 'oc.example.com', protocol = 'https', body, headers = {} } = {}) => ({
  query,
  protocol,
  body,
  headers,
  get: (name) => {
    const key = String(name).toLowerCase();
    if (key === 'host') return host;
    const header = headers[key] ?? headers[String(name)];
    return header;
  },
});

const decodeJwtPayload = (token) => {
  const [, body] = token.split('.');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
};

let workspace;
let dataDir;
let fetchImpl;
let saveFetchImpl;

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
    fsPromises: { readFile, stat, realpath, readdir, rename, rm, mkdir, writeFile, ...fsOverrides },
    path,
    docPreviewRuntime: runtime,
    resolveReadPathFromContext: resolver || (async ({ targetPath }) => ({
      ok: true,
      base: workspace,
      resolved: path.resolve(workspace, targetPath),
    })),
    fetchImpl: (...args) => saveFetchImpl(...args),
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
  // The save callback downloads the saved document from the document server.
  saveFetchImpl = vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode('edited-bytes').buffer,
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

  it('refuses a token minted for the other direction', () => {
    const readToken = signRawToken({
      crypto,
      secret: SECRET,
      payload: { k: 'read', p: '/repo/a.docx', m: 1, s: 2, e: Date.now() + 60_000 },
    });
    expect(verifyRawToken({ crypto, secret: SECRET, token: readToken, requireKind: 'write' }).reason).toBe('scope');
    expect(verifyRawToken({ crypto, secret: SECRET, token: readToken, requireKind: 'read' }).ok).toBe(true);
  });

  it('verifies a JWT signed with the shared secret and rejects any other', () => {
    const token = signJwt({ crypto, secret: SECRET, payload: { status: 2, key: 'abc' } });
    expect(verifyJwt({ crypto, secret: SECRET, token })?.status).toBe(2);
    expect(verifyJwt({ crypto, secret: 'other', token })).toBeNull();
    expect(verifyJwt({ crypto, secret: SECRET, token: 'garbage' })).toBeNull();
    const expired = signJwt({ crypto, secret: SECRET, payload: { status: 2, exp: 1 } });
    expect(verifyJwt({ crypto, secret: SECRET, token: expired })).toBeNull();
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

  it('refuses a path whose realpath leaves the workspace', async () => {
    // The lexical check runs before symlinks are resolved, so a link inside the
    // workspace that points outside it has to be caught by the canonical
    // containment re-check.
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'doc-preview-outside-'));
    const outsideFile = path.join(outsideDir, 'escape.docx');
    const insidePath = path.join(workspace, 'escape.docx');
    await writeFile(outsideFile, 'docx');
    await writeFile(insidePath, 'docx');

    try {
      const registry = await setup({
        fsOverrides: {
          realpath: async (value) => (
            path.resolve(value) === path.resolve(insidePath) ? outsideFile : realpath(value)
          ),
        },
      });

      const res = await invoke(
        registry.getRoute('GET', '/api/doc-preview/config'),
        createRequest({ query: { path: 'escape.docx' } }),
      );
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('outside');
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
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

  it('offers editing with a save callback for an editor-safe format', async () => {
    await writeFile(path.join(workspace, 'report.docx'), 'docx');
    const registry = await setup({ env: { OPENCHAMBER_DOC_PREVIEW_DOCUMENT_BASE_URL: 'http://openchamber:3000' } });
    const res = await invoke(
      registry.getRoute('GET', '/api/doc-preview/config'),
      createRequest({ query: { path: 'report.docx', edit: '1' } }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.mode).toBe('edit');
    expect(res.body.editable).toBe(true);
    expect(res.body.editorConfig.document.permissions.edit).toBe(true);
    expect(res.body.editorConfig.editorConfig.mode).toBe('edit');
    expect(res.body.editorConfig.editorConfig.customization.autosave).toBe(true);
    expect(res.body.editorConfig.editorConfig.callbackUrl)
      .toContain('http://openchamber:3000/doc-preview/callback?token=');

    const callbackToken = decodeURIComponent(
      new URL(res.body.editorConfig.editorConfig.callbackUrl).searchParams.get('token'),
    );
    const verified = verifyRawToken({ crypto, secret: SECRET, token: callbackToken, requireKind: 'write' });
    expect(verified.ok).toBe(true);
    expect(verified.payload.p).toBe(path.join(workspace, 'report.docx'));
    // The callback is bound to the document key this session was opened with.
    expect(verified.payload.d).toBe(res.body.documentKey);
  });

  it('keeps a format the editor cannot round-trip read-only, and says so', async () => {
    await writeFile(path.join(workspace, 'legacy.doc'), 'doc');
    const registry = await setup();
    const res = await invoke(
      registry.getRoute('GET', '/api/doc-preview/config'),
      createRequest({ query: { path: 'legacy.doc', edit: '1' } }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.editable).toBe(false);
    expect(res.body.mode).toBe('view');
    expect(res.body.editorConfig.document.permissions.edit).toBe(false);
    expect(res.body.editorConfig.editorConfig.callbackUrl).toBeUndefined();
  });

  it('defaults to the read-only view when editing is not requested', async () => {
    await writeFile(path.join(workspace, 'report.docx'), 'docx');
    const registry = await setup();
    const res = await invoke(
      registry.getRoute('GET', '/api/doc-preview/config'),
      createRequest({ query: { path: 'report.docx' } }),
    );

    expect(res.body.mode).toBe('view');
    expect(res.body.editable).toBe(true);
    expect(res.body.editorConfig.document.permissions.edit).toBe(false);
    expect(res.body.editorConfig.editorConfig.callbackUrl).toBeUndefined();
  });
});

describe('GET /doc-preview/raw', () => {
  const mintToken = async ({ filePath, secret = SECRET, exp = Date.now() + 60_000, mtimeMs, size, kind = 'read' }) => {
    const stats = await stat(filePath).catch(() => null);
    return signRawToken({
      crypto,
      secret,
      payload: {
        k: kind,
        p: filePath,
        m: mtimeMs ?? Math.trunc(stats?.mtimeMs ?? 0),
        s: size ?? Math.trunc(stats?.size ?? 0),
        e: exp,
      },
    });
  };

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

  it('answers not-configured and touches nothing when the sidecar is absent', async () => {
    const registry = await setup({ env: { OPENCHAMBER_DOC_PREVIEW_JWT_SECRET: '' } });
    const res = await invoke(
      registry.getRoute('GET', '/doc-preview/raw'),
      createRequest({ query: { token: 'garbage' } }),
    );
    expect(res.statusCode).toBe(501);
    // The capability secret must not be created for an unauthenticated request
    // against a deployment that does not use the feature at all.
    await expect(stat(path.join(dataDir, 'doc-preview-secret'))).rejects.toThrow();
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

  it('refuses a token minted for a different version of the file', async () => {
    const registry = await setup();
    const filePath = path.join(workspace, 'report.docx');
    await writeFile(filePath, 'docx-bytes');

    const staleSize = await invoke(
      registry.getRoute('GET', '/doc-preview/raw'),
      createRequest({ query: { token: await mintToken({ filePath, size: 3 }) } }),
    );
    expect(staleSize.statusCode).toBe(409);

    const staleMtime = await invoke(
      registry.getRoute('GET', '/doc-preview/raw'),
      createRequest({ query: { token: await mintToken({ filePath, mtimeMs: 1 }) } }),
    );
    expect(staleMtime.statusCode).toBe(409);
  });

  // Control characters are legal in POSIX filenames but not on Windows, and the
  // header-injection risk this guards against only exists where such a file can
  // be created in the first place.
  it.skipIf(process.platform === 'win32')('sanitises control characters out of the inline filename', async () => {
    const registry = await setup();
    const filePath = path.join(workspace, `odd\u0007.docx`);
    await writeFile(filePath, 'docx');
    const res = await invoke(
      registry.getRoute('GET', '/doc-preview/raw'),
      createRequest({ query: { token: await mintToken({ filePath }) } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-disposition')).not.toMatch(/[\u0000-\u001f\u007f]/);
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

describe('POST /doc-preview/callback', () => {
  const mintWriteToken = ({ filePath, documentKey = 'key-1', exp = Date.now() + 60_000, kind = 'write', secret = SECRET }) => signRawToken({
    crypto,
    secret,
    payload: { k: kind, p: filePath, d: documentKey, e: exp },
  });

  const callbackBody = ({ status = 2, key = 'key-1', url = 'http://localhost:8080/cache/files/data/out.docx/output.docx', withJwt = true }) => {
    const body = { status, key, url, users: ['openchamber'] };
    if (withJwt) {
      body.token = signJwt({ crypto, secret: SECRET, payload: { ...body } });
    }
    return body;
  };

  const post = (registry, req) => invoke(registry.getRoute('POST', '/doc-preview/callback'), req);

  it('writes the saved document back to the workspace file', async () => {
    const registry = await setup();
    const filePath = path.join(workspace, 'report.docx');
    await writeFile(filePath, 'original-bytes');

    const res = await post(registry, createRequest({
      query: { token: mintWriteToken({ filePath }) },
      body: callbackBody({}),
    }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ error: 0 });
    expect(await readFile(filePath, 'utf8')).toBe('edited-bytes');
    // The version being replaced is kept outside the workspace.
    const versionsRoot = path.join(dataDir, 'doc-preview-versions');
    const [digestDir] = await readdir(versionsRoot);
    const saved = await readdir(path.join(versionsRoot, digestDir));
    expect(saved).toHaveLength(1);
  });

  it('downloads from the address this server reaches, not the one in the callback', async () => {
    const registry = await setup();
    const filePath = path.join(workspace, 'report.docx');
    await writeFile(filePath, 'original-bytes');

    await post(registry, createRequest({
      query: { token: mintWriteToken({ filePath }) },
      body: callbackBody({ url: 'http://localhost:8080/cache/files/data/out.docx/output.docx?md5=abc' }),
    }));

    expect(saveFetchImpl).toHaveBeenCalledTimes(1);
    expect(saveFetchImpl.mock.calls[0][0]).toBe(
      'http://documentserver/cache/files/data/out.docx/output.docx?md5=abc',
    );
  });

  it('ignores the statuses that carry no document', async () => {
    const registry = await setup();
    const filePath = path.join(workspace, 'report.docx');
    await writeFile(filePath, 'original-bytes');

    for (const status of [1, 3, 4, 7]) {
      const res = await post(registry, createRequest({
        query: { token: mintWriteToken({ filePath }) },
        body: callbackBody({ status }),
      }));
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ error: 0 });
    }

    expect(await readFile(filePath, 'utf8')).toBe('original-bytes');
    expect(saveFetchImpl).not.toHaveBeenCalled();
  });

  it('requires both the capability token and the document server signature', async () => {
    const registry = await setup();
    const filePath = path.join(workspace, 'report.docx');
    await writeFile(filePath, 'original-bytes');

    const noToken = await post(registry, createRequest({ body: callbackBody({}) }));
    expect(noToken.statusCode).toBe(403);

    const readToken = await post(registry, createRequest({
      query: { token: mintWriteToken({ filePath, kind: 'read' }) },
      body: callbackBody({}),
    }));
    expect(readToken.statusCode).toBe(403);

    const foreignSecret = await post(registry, createRequest({
      query: { token: mintWriteToken({ filePath, secret: 'other-secret' }) },
      body: callbackBody({}),
    }));
    expect(foreignSecret.statusCode).toBe(403);

    const noJwt = await post(registry, createRequest({
      query: { token: mintWriteToken({ filePath }) },
      body: callbackBody({ withJwt: false }),
    }));
    expect(noJwt.statusCode).toBe(403);

    expect(await readFile(filePath, 'utf8')).toBe('original-bytes');
    expect(saveFetchImpl).not.toHaveBeenCalled();
  });

  it('accepts the document server token from the authorization header too', async () => {
    const registry = await setup();
    const filePath = path.join(workspace, 'report.docx');
    await writeFile(filePath, 'original-bytes');
    const body = callbackBody({ withJwt: false });

    const res = await post(registry, createRequest({
      query: { token: mintWriteToken({ filePath }) },
      body,
      headers: { authorization: `Bearer ${signJwt({ crypto, secret: SECRET, payload: { ...body } })}` },
    }));

    expect(res.statusCode).toBe(200);
    expect(await readFile(filePath, 'utf8')).toBe('edited-bytes');
  });

  it('refuses a save for a different version of the file', async () => {
    const registry = await setup();
    const filePath = path.join(workspace, 'report.docx');
    await writeFile(filePath, 'original-bytes');

    const res = await post(registry, createRequest({
      query: { token: mintWriteToken({ filePath, documentKey: 'key-1' }) },
      body: callbackBody({ key: 'key-2' }),
    }));

    expect(res.statusCode).toBe(409);
    expect(await readFile(filePath, 'utf8')).toBe('original-bytes');
  });

  it('refuses a callback URL that is not a document server cache path', async () => {
    const registry = await setup();
    const filePath = path.join(workspace, 'report.docx');
    await writeFile(filePath, 'original-bytes');

    const res = await post(registry, createRequest({
      query: { token: mintWriteToken({ filePath }) },
      body: callbackBody({ url: 'http://169.254.169.254/latest/meta-data/' }),
    }));

    expect(res.statusCode).toBe(400);
    expect(saveFetchImpl).not.toHaveBeenCalled();
  });

  it('serialises concurrent saves of the same document', async () => {
    const registry = await setup();
    const filePath = path.join(workspace, 'report.docx');
    await writeFile(filePath, 'original-bytes');

    let call = 0;
    saveFetchImpl = vi.fn(async () => {
      call += 1;
      const payload = `edited-${call}`;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(payload).buffer };
    });

    const token = mintWriteToken({ filePath });
    const [first, second] = await Promise.all([
      post(registry, createRequest({ query: { token }, body: callbackBody({}) })),
      post(registry, createRequest({ query: { token }, body: callbackBody({}) })),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Whichever order they landed in, the file holds one complete payload.
    const content = await readFile(filePath, 'utf8');
    expect(['edited-1', 'edited-2']).toContain(content);
    // Nothing is left behind next to the user's file.
    const siblings = await readdir(workspace);
    expect(siblings.filter((entry) => entry.includes('.tmp'))).toHaveLength(0);
  });
});
