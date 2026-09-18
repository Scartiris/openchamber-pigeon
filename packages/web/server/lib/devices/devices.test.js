import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeviceRegistry } from './registry.js';
import { createDeviceMcpTokenRuntime } from './tokens.js';
import { evaluateDeviceApproval } from './approval.js';
import { createDeviceTransportResolver } from './transport.js';
import { createDeviceToolRuntime } from './tools.js';
import { createDeviceMcpHandler } from './mcp.js';
import { createDeviceAuditLog } from './audit.js';
import { createDeviceEnrollTokenRuntime } from './enroll.js';
import { buildJoinScript } from './join-script.js';
import { createDeviceStatusRuntime } from './status.js';

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-devices-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const makeRegistry = () => createDeviceRegistry({
  fsPromises: fs.promises,
  path,
  crypto,
  storePath: path.join(tempDir, 'registry.json'),
  secretsPath: path.join(tempDir, 'secrets.json'),
});

describe('device registry', () => {
  test('creates a device without echoing secrets', async () => {
    const registry = makeRegistry();
    const device = await registry.createDevice({
      name: '施工机',
      connection: {
        tailscale: { host: '100.1.2.3', sshPort: 22, mcpPort: 8000 },
      },
      capabilities: { shell: true, files: true, screen: true },
      sshPrivateKey: '-----BEGIN KEY-----\nsecret\n-----END KEY-----',
      mcpBearer: 'device-bearer-secret',
      approval: 'smart',
    });

    expect(device.id).toMatch(/^dev_/);
    expect(device.name).toBe('施工机');
    expect(device.approval).toBe('smart');
    expect(device.auth.hasSshKey).toBe(true);
    expect(device.auth.hasMcpBearer).toBe(true);
    expect(JSON.stringify(device)).not.toContain('secret');
    expect(JSON.stringify(device)).not.toContain('BEGIN KEY');
  });

  test('lists and deletes devices', async () => {
    const registry = makeRegistry();
    const created = await registry.createDevice({ name: 'A' });
    expect(await registry.listDevices()).toHaveLength(1);
    expect(await registry.deleteDevice(created.id)).toBe(true);
    expect(await registry.listDevices()).toHaveLength(0);
    expect(await registry.getDevice(created.id)).toBeNull();
  });

  test('updates approval mode and rejects unknown mode back to smart', async () => {
    const registry = makeRegistry();
    const created = await registry.createDevice({ name: 'A', approval: 'smart' });
    const updated = await registry.updateDevice(created.id, { approval: 'auto' });
    expect(updated.approval).toBe('auto');
    const bogus = await registry.updateDevice(created.id, { approval: 'yolo' });
    expect(bogus.approval).toBe('smart');
  });
});

describe('device mcp tokens', () => {
  test('issues and authenticates tokens, never lists plaintext', async () => {
    const tokens = createDeviceMcpTokenRuntime({
      fsPromises: fs.promises,
      path,
      crypto,
      storePath: path.join(tempDir, 'tokens.json'),
    });
    const created = await tokens.createToken({ label: 'codex' });
    expect(created.token.startsWith('oc_device_mcp_')).toBe(true);
    const listed = await tokens.listTokens();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.token);

    const actor = await tokens.authenticate(created.token);
    expect(actor?.label).toBe('codex');
    expect(await tokens.authenticate('oc_device_mcp_wrong')).toBeNull();
    expect(await tokens.revokeToken(created.id)).toBe(true);
    expect(await tokens.authenticate(created.token)).toBeNull();
  });
});

describe('approval', () => {
  test('deny blocks everything; smart allows reads and blocks writes; auto allows', () => {
    expect(evaluateDeviceApproval({ approval: 'deny', tool: 'devices.list' }).allowed).toBe(false);
    expect(evaluateDeviceApproval({ approval: 'smart', tool: 'devices.fs.read' }).allowed).toBe(true);
    const write = evaluateDeviceApproval({ approval: 'smart', tool: 'devices.shell.exec' });
    expect(write.allowed).toBe(false);
    expect(write.reason).toBe('approval_required');
    expect(evaluateDeviceApproval({ approval: 'auto', tool: 'devices.ui.click' }).allowed).toBe(true);
  });
});

describe('transport resolver', () => {
  test('prefers tailscale and falls back to tunnel', async () => {
    const calls = [];
    const resolver = createDeviceTransportResolver({
      net: {},
      probe: async ({ host, port }) => {
        calls.push(`${host}:${port}`);
        if (host === '100.9.9.9') return port === 22;
        if (host === '127.0.0.1') return port === 2201;
        return false;
      },
    });

    const viaTs = await resolver.resolve({
      connection: {
        tailscale: { host: '100.9.9.9', sshPort: 22 },
        tunnel: { sshPort: 2201, mcpPort: 8001 },
      },
    });
    expect(viaTs.kind).toBe('tailscale');
    expect(viaTs.ssh).toEqual({ host: '100.9.9.9', port: 22 });

    const viaTunnel = await resolver.resolve({
      connection: {
        tailscale: { host: '100.0.0.1', sshPort: 22 },
        tunnel: { sshPort: 2201, mcpPort: 8001 },
      },
    });
    expect(viaTunnel.kind).toBe('tunnel');
    expect(viaTunnel.ssh).toEqual({ host: '127.0.0.1', port: 2201 });
  });

  test('fails closed when nothing is reachable', async () => {
    const resolver = createDeviceTransportResolver({ net: {}, probe: async () => false });
    const result = await resolver.resolve({
      connection: { tailscale: { host: '100.1.1.1', sshPort: 22 } },
    });
    expect(result.kind).toBeNull();
    expect(result.error).toBe('transport_unavailable');
  });
});

describe('device tools + mcp handler', () => {
  const build = async () => {
    const registry = makeRegistry();
    const tokens = createDeviceMcpTokenRuntime({
      fsPromises: fs.promises,
      path,
      crypto,
      storePath: path.join(tempDir, 'tokens.json'),
    });
    const audit = createDeviceAuditLog({
      fsPromises: fs.promises,
      path,
      storePath: path.join(tempDir, 'audit.json'),
    });
    const toolRuntime = createDeviceToolRuntime({
      registry,
      transportResolver: createDeviceTransportResolver({
        net: {},
        probe: async ({ host, port }) => host === '127.0.0.1' && port === 2201,
      }),
      sshClient: {
        exec: async () => ({ ok: true, exitCode: 0, stdout: 'hello', stderr: '' }),
        list: async () => ({ ok: true, exitCode: 0, stdout: '[]', stderr: '' }),
        read: async () => ({ ok: true, exitCode: 0, content: 'file', encoding: 'utf8' }),
        write: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' }),
      },
      windowsMcp: {
        capture: async () => ({ content: [{ type: 'image', data: 'abc' }] }),
        click: async () => ({ ok: true }),
        type: async () => ({ ok: true }),
        elements: async () => ({ elements: [] }),
      },
      audit,
    });
    const mcpHandler = createDeviceMcpHandler({
      toolRuntime,
      authenticateToken: (token) => tokens.authenticate(token),
    });
    return { registry, tokens, audit, toolRuntime, mcpHandler };
  };

  test('smart mode blocks shell exec and allows list', async () => {
    const { registry, toolRuntime } = await build();
    await registry.createDevice({
      name: 'dev',
      approval: 'smart',
      capabilities: { shell: true, files: true, screen: false },
      connection: { tunnel: { sshPort: 2201 } },
    });
    const devices = await registry.listDevices();
    const id = devices[0].id;

    const listResult = await toolRuntime.callTool({ tool: 'devices.list', args: {} });
    expect(listResult.ok).toBe(true);

    const execResult = await toolRuntime.callTool({
      tool: 'devices.shell.exec',
      args: { device_id: id, command: 'whoami' },
    });
    expect(execResult.ok).toBe(false);
    expect(execResult.error.code).toBe('approval_required');
  });

  test('auto mode runs shell exec and audits allow', async () => {
    const { registry, toolRuntime, audit } = await build();
    await registry.createDevice({
      name: 'dev',
      approval: 'auto',
      capabilities: { shell: true, files: true, screen: false },
      connection: { tunnel: { sshPort: 2201 } },
    });
    const id = (await registry.listDevices())[0].id;
    const result = await toolRuntime.callTool({
      tool: 'devices.shell.exec',
      args: { device_id: id, command: 'whoami' },
      actor: 'test',
    });
    expect(result.ok).toBe(true);
    expect(result.data.stdout).toBe('hello');
    const entries = await audit.listRecent(10);
    expect(entries[0].decision).toBe('allow');
    expect(entries[0].tool).toBe('devices.shell.exec');
  });

  test('mcp handler rejects bad token and serves tools/list + tools/call', async () => {
    const { tokens, mcpHandler, registry } = await build();
    const unauthorized = await mcpHandler.handle({
      authorization: 'Bearer nope',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(unauthorized.status).toBe(401);

    const created = await tokens.createToken({ label: 'agent' });
    await registry.createDevice({
      name: 'dev',
      approval: 'auto',
      capabilities: { shell: true, files: true, screen: false },
      connection: { tunnel: { sshPort: 2201 } },
    });

    const listed = await mcpHandler.handle({
      authorization: `Bearer ${created.token}`,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(listed.status).toBe(200);
    expect(listed.json.result.tools.length).toBeGreaterThan(5);

    const called = await mcpHandler.handle({
      authorization: `Bearer ${created.token}`,
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'devices.list', arguments: {} },
      },
    });
    expect(called.status).toBe(200);
    expect(called.json.result.structuredContent.devices).toHaveLength(1);
  });
});

describe('enroll tokens + join script', () => {
  const makeEnroll = () => createDeviceEnrollTokenRuntime({
    fsPromises: fs.promises,
    path,
    crypto,
    storePath: path.join(tempDir, 'enroll-tokens.json'),
  });

  test('creates, peeks, consumes once, and rejects reuse', async () => {
    const enroll = makeEnroll();
    const created = await enroll.createToken({ label: 'join' });
    expect(created.token.startsWith('oc_enroll_')).toBe(true);

    const peeked = await enroll.peekToken(created.token);
    expect(peeked.ok).toBe(true);

    const consumed = await enroll.consumeToken(created.token);
    expect(consumed.ok).toBe(true);

    const again = await enroll.consumeToken(created.token);
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('invalid_token');

    const listed = await enroll.listTokens();
    expect(listed).toHaveLength(0);
  });

  test('rejects expired tokens', async () => {
    const enroll = makeEnroll();
    const created = await enroll.createToken({ label: 'old', ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const peeked = await enroll.peekToken(created.token);
    expect(peeked.ok).toBe(false);
    expect(peeked.reason).toBe('token_expired');
  });

  test('join script embeds server origin and token', () => {
    const script = buildJoinScript({
      serverOrigin: 'https://core.example',
      enrollToken: 'oc_enroll_abc',
      approval: 'smart',
      enableWindowsMcp: true,
    });
    expect(script).toContain('https://core.example');
    expect(script).toContain('oc_enroll_abc');
    expect(script).toContain('/api/devices/enroll');
    expect(script).toContain('windows-mcp install');
    expect(script).toContain('streamable-http');
    expect(script).toContain('auth_key');
    expect(script).toContain('Startup');
    expect(script).toContain('ANONYMIZED_TELEMETRY');
  });
});

describe('device status snapshot', () => {
  test('reports online latency and fails closed when nothing answers', async () => {
    const registry = makeRegistry();
    await registry.createDevice({
      name: 'live',
      approval: 'auto',
      capabilities: { shell: true, files: true, screen: false },
      connection: { tunnel: { sshPort: 2201 } },
    });
    await registry.createDevice({
      name: 'dead',
      approval: 'auto',
      capabilities: { shell: true, files: true, screen: false },
      connection: { tunnel: { sshPort: 2299 } },
    });

    const statusRuntime = createDeviceStatusRuntime({
      net: {},
      registry,
    });
    // Override probe via net.connect — simpler: inject by monkey-patching probeLatency is hard.
    // Use a fake net that succeeds only for 2201.
    const fakeNet = {
      connect: ({ port }) => {
        const listeners = {};
        const socket = {
          setTimeout: (_ms, cb) => {
            if (port !== 2201) setTimeout(cb, 1);
          },
          once: (event, cb) => {
            listeners[event] = cb;
            if (event === 'connect' && port === 2201) setTimeout(cb, 0);
            if (event === 'error' && port !== 2201) setTimeout(cb, 1);
          },
          destroy: () => {},
        };
        return socket;
      },
    };
    const runtime = createDeviceStatusRuntime({ net: fakeNet, registry });
    const snapshot = await runtime.listStatus();
    expect(snapshot.total).toBe(2);
    expect(snapshot.onlineCount).toBe(1);
    const live = snapshot.devices.find((d) => d.name === 'live');
    const dead = snapshot.devices.find((d) => d.name === 'dead');
    expect(live?.online).toBe(true);
    expect(Number.isFinite(live?.latencyMs)).toBe(true);
    expect(dead?.online).toBe(false);
    expect(dead?.latencyMs).toBeNull();
    // unused var silence
    void statusRuntime;
  });
});

describe('device platforms and tunnel addressing', () => {
  test('platform is explicit, defaults to windows, and survives updates', async () => {
    const registry = makeRegistry();
    const linux = await registry.createDevice({ name: 'relay', platform: 'linux' });
    const implicit = await registry.createDevice({ name: 'pc' });
    const bogus = await registry.createDevice({ name: 'weird', platform: 'plan9' });

    expect(linux.platform).toBe('linux');
    expect(implicit.platform).toBe('windows');
    expect(bogus.platform).toBe('windows');

    // An approval change must not quietly turn a Linux device into a Windows one.
    const updated = await registry.updateDevice(linux.id, { approval: 'auto' });
    expect(updated.approval).toBe('auto');
    expect(updated.platform).toBe('linux');
    expect((await registry.updateDevice(linux.id, { platform: 'windows' })).platform).toBe('windows');
  });

  test('a tunnel host other than loopback is honoured — a container cannot reach the host loopback', async () => {
    const seen = [];
    const resolver = createDeviceTransportResolver({
      net: {},
      probe: async ({ host, port }) => {
        seen.push(`${host}:${port}`);
        return host === '172.17.0.1' && port === 2201;
      },
    });
    const resolved = await resolver.resolve({
      connection: { tunnel: { host: '172.17.0.1', sshPort: 2201 } },
    });
    expect(resolved.kind).toBe('tunnel');
    expect(resolved.ssh).toEqual({ host: '172.17.0.1', port: 2201 });
    expect(seen).toContain('172.17.0.1:2201');

    const defaulted = await createDeviceTransportResolver({
      net: {},
      probe: async ({ host }) => host === '127.0.0.1',
    }).resolve({ connection: { tunnel: { sshPort: 2201 } } });
    expect(defaulted.ssh).toEqual({ host: '127.0.0.1', port: 2201 });
  });

  test('registry keeps the tunnel host it was given', async () => {
    const registry = makeRegistry();
    const device = await registry.createDevice({
      name: 'tunnelled',
      connection: { tunnel: { host: '172.17.0.1', sshPort: 2201, mcpPort: 8001 } },
    });
    expect(device.connection.tunnel).toEqual({ host: '172.17.0.1', sshPort: 2201, mcpPort: 8001 });
  });
});

describe('devices.metrics tool', () => {
  const buildMetricsTool = async ({ approval = 'smart' } = {}) => {
    const registry = makeRegistry();
    await registry.createDevice({
      name: 'relay',
      platform: 'linux',
      approval,
      capabilities: { shell: true, files: true, screen: false },
      connection: { tunnel: { sshPort: 2201 } },
    });
    const audit = createDeviceAuditLog({
      fsPromises: fs.promises,
      path,
      storePath: path.join(tempDir, 'metrics-audit.json'),
    });
    const collected = [];
    const toolRuntime = createDeviceToolRuntime({
      registry,
      transportResolver: createDeviceTransportResolver({
        net: {},
        probe: async ({ port }) => port === 2201,
      }),
      sshClient: { exec: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' }) },
      windowsMcp: {},
      audit,
      metricsRuntime: {
        collect: async ({ device }) => {
          collected.push(device.id);
          return {
            ok: true,
            metrics: {
              platform: device.platform,
              hostname: 'relay',
              memory: { totalBytes: 2048, availableBytes: 1024, usedBytes: 1024, usedPercent: 50 },
              disks: [],
              network: { interfaces: [] },
            },
          };
        },
      },
    });
    const id = (await registry.listDevices())[0].id;
    return { toolRuntime, audit, id, collected };
  };

  test('smart approval allows the read and reports the device platform', async () => {
    const { toolRuntime, id, collected } = await buildMetricsTool({ approval: 'smart' });
    const result = await toolRuntime.callTool({ tool: 'devices.metrics', args: { device_id: id }, actor: 'test' });
    expect(result.ok).toBe(true);
    expect(result.data.platform).toBe('linux');
    expect(collected).toEqual([id]);
  });

  test('deny mode refuses metrics like any other tool', async () => {
    const { toolRuntime, id, collected } = await buildMetricsTool({ approval: 'deny' });
    const result = await toolRuntime.callTool({ tool: 'devices.metrics', args: { device_id: id } });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('permission_denied');
    expect(collected).toEqual([]);
  });

  test('audit can be skipped for timer-driven polling but stays on by default', async () => {
    const { toolRuntime, audit, id } = await buildMetricsTool({ approval: 'smart' });

    await toolRuntime.callTool({ tool: 'devices.metrics', args: { device_id: id }, actor: 'ui-fleet', audit: false });
    expect(await audit.listRecent(10)).toHaveLength(0);

    await toolRuntime.callTool({ tool: 'devices.metrics', args: { device_id: id }, actor: 'mcp' });
    const entries = await audit.listRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBe('mcp');
    expect(entries[0].tool).toBe('devices.metrics');
  });
});
