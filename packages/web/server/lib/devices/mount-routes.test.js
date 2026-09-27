import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeviceRegistry } from './registry.js';
import { createDeviceMountRegistry } from './mount-registry.js';
import { registerDeviceRoutes } from './routes.js';

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mount-routes-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const makeApp = () => {
  const routes = new Map();
  const app = {
    get: (p, handler) => routes.set(`GET ${p}`, handler),
    post: (p, _parser, handler) => routes.set(`POST ${p}`, handler || _parser),
    put: (p, _parser, handler) => routes.set(`PUT ${p}`, handler || _parser),
    patch: (p, _parser, handler) => routes.set(`PATCH ${p}`, handler || _parser),
    delete: (p, handler) => routes.set(`DELETE ${p}`, handler),
  };
  return { app, routes };
};

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
  return res;
};

const setup = async () => {
  const registry = createDeviceRegistry({
    fsPromises: fs.promises,
    path,
    crypto,
    storePath: path.join(tempDir, 'registry.json'),
    secretsPath: path.join(tempDir, 'secrets.json'),
  });
  const mountRegistry = createDeviceMountRegistry({
    fsPromises: fs.promises,
    path,
    storePath: path.join(tempDir, 'device-mounts.json'),
    mountParent: '/mnt/oc-devices',
  });
  const device = await registry.createDevice({
    name: '施工机',
    auth: { sshUser: 'alice' },
    connection: { tailscale: { host: '100.1.2.3', sshPort: 22 } },
    capabilities: { shell: true, files: true, screen: false },
    sshPrivateKey: 'key',
    approval: 'smart',
  });
  const { app, routes } = makeApp();
  registerDeviceRoutes(app, {
    registry,
    tokens: {},
    enrollTokens: {},
    audit: { list: async () => [] },
    toolRuntime: { callTool: async () => ({ ok: true }) },
    mcpHandler: { handle: async () => ({ status: 200, json: {} }) },
    statusRuntime: { listStatus: async () => ({}) },
    mountRegistry,
    express: { json: () => (req, _res, next) => next() },
  });
  return { registry, mountRegistry, device, routes };
};

const asJsonReq = (body) => ({ body, params: {}, headers: {} });

describe('device mount routes', () => {
  test('PUT configures a mount and returns health', async () => {
    const { device, routes } = await setup();
    const handler = routes.get('PUT /api/devices/:id/mount');
    const res = makeRes();
    await handler({ ...asJsonReq({ remoteRoot: 'C:\\Users\\alice\\proj' }), params: { id: device.id } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.mount.remoteRoot).toBe('C:/Users/alice/proj');
    expect(res.body.mount.ssh.host).toBe('100.1.2.3');
    expect(res.body.mount.ssh.user).toBe('alice');
    expect(res.body.health.state).toBe('mounting');
    expect(res.body.mount.mountRoot).toBe(`/mnt/oc-devices/${device.id}`);
  });

  test('ensure returns projectPath for a remote child path', async () => {
    const { device, routes } = await setup();
    const ensure = routes.get('POST /api/devices/:id/mount/ensure');
    const res = makeRes();
    await ensure(
      {
        ...asJsonReq({ remoteRoot: 'C:/Users/alice', remotePath: 'C:/Users/alice/proj/foo' }),
        params: { id: device.id },
      },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.projectPath).toBe(`/mnt/oc-devices/${device.id}/proj/foo`);
  });

  test('ensure rejects path escape', async () => {
    const { device, routes } = await setup();
    const ensure = routes.get('POST /api/devices/:id/mount/ensure');
    const res = makeRes();
    await ensure(
      {
        ...asJsonReq({ remoteRoot: 'C:/Users/alice', remotePath: 'C:/Users/bob/x' }),
        params: { id: device.id },
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('path_escape');
  });

  test('GET mount reports absent before configuration', async () => {
    const { device, routes } = await setup();
    const handler = routes.get('GET /api/devices/:id/mount');
    const res = makeRes();
    await handler({ params: { id: device.id }, headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.health.state).toBe('absent');
    expect(res.body.mount).toBe(null);
  });

  test('DELETE disables the mount', async () => {
    const { device, routes } = await setup();
    const put = routes.get('PUT /api/devices/:id/mount');
    await put({ ...asJsonReq({ remoteRoot: 'C:/Users/alice' }), params: { id: device.id } }, makeRes());
    const del = routes.get('DELETE /api/devices/:id/mount');
    const res = makeRes();
    await del({ params: { id: device.id }, headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.mount.enabled).toBe(false);
    expect(res.body.health.state).toBe('disabled');
  });
});
