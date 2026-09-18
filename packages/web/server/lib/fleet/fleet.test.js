import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  HOST_METRICS_FILE_NAME,
  createHostMetricsReader,
  normalizeHostMetrics,
} from './host-metrics.js';
import { createFleetSnapshotRuntime, summarizeFleet } from './snapshot.js';

const HELPER_PATH = '/data/host-metrics.json';

const helperPayload = ({ collectedAtMs, overrides = {} } = {}) => ({
  schemaVersion: 1,
  collectedAt: new Date(collectedAtMs).toISOString(),
  collectedAtMs,
  intervalSec: 15,
  host: { hostname: 'pigeoncore', platform: 'linux', kernel: '7.0.0-31', arch: 'x86_64' },
  uptimeSec: 501873,
  cpu: { count: 4, load1: 0.11, load5: 0.2, load15: 0.25 },
  memory: {
    totalBytes: 8077984 * 1024,
    availableBytes: 5798056 * 1024,
    usedBytes: (8077984 - 5798056) * 1024,
    swapTotalBytes: 11534324 * 1024,
    swapUsedBytes: (11534324 - 10357228) * 1024,
  },
  disks: [
    { mount: '/', filesystem: '/dev/vda1', totalBytes: 61255049216, usedBytes: 35862216704, availBytes: 25376055296 },
  ],
  network: {
    windowSec: 15,
    interfaces: [{ name: 'ens3', rxBytes: 10730567573, txBytes: 4940363790, rxBytesPerSec: 1200, txBytesPerSec: 800 }],
    totalRxBytesPerSec: 1200,
    totalTxBytesPerSec: 800,
  },
  containers: [
    { name: 'openchamber', image: 'pigeon-openchamber:1.24.0', state: 'running', health: 'healthy', status: 'Up 2 hours' },
  ],
  containersSummary: { total: 1, running: 1, healthy: 1, unhealthy: 0 },
  deploy: { sha: 'e98e5b8c5', image: 'pigeon-openchamber:1.24.0-e98e5b8c5', previousImage: 'x', at: '2026-09-18T15:40:00Z' },
  errors: [],
  ...overrides,
});

const makeFs = ({ files = {}, statfs } = {}) => {
  const fsPromises = {
    readFile: async (filePath) => {
      if (Object.prototype.hasOwnProperty.call(files, filePath)) {
        const value = files[filePath];
        if (value instanceof Error) throw value;
        return value;
      }
      const error = new Error(`ENOENT: ${filePath}`);
      error.code = 'ENOENT';
      throw error;
    },
  };
  if (statfs !== undefined) fsPromises.statfs = statfs;
  return fsPromises;
};

const makeReader = ({ files, statfs, nowMs = Date.now() } = {}) => createHostMetricsReader({
  fsPromises: makeFs({ files, statfs }),
  path,
  os: {
    cpus: () => [1, 2, 3, 4],
    hostname: () => 'pigeoncore',
    release: () => '7.0.0-31-generic',
    arch: () => 'x64',
    uptime: () => 1234,
  },
  spawn: () => { throw new Error('df must not be reached while statfs works'); },
  openchamberDataDir: '/data',
  filePath: HELPER_PATH,
  env: {},
});

const MEMINFO = [
  'MemTotal:        8077984 kB',
  'MemFree:         2686604 kB',
  'MemAvailable:    5819440 kB',
  'SwapTotal:       11534324 kB',
  'SwapFree:        10354688 kB',
].join('\n');

describe('host metrics normalization', () => {
  test('computes percentages and keeps every reported field', () => {
    const host = normalizeHostMetrics(helperPayload({ collectedAtMs: 1_700_000_000_000 }));
    expect(host.hostname).toBe('pigeoncore');
    expect(host.memory.usedPercent).toBeCloseTo(28.2, 1);
    expect(host.memory.swapUsedPercent).toBeCloseTo(10.2, 1);
    expect(host.disks[0].usedPercent).toBeCloseTo(58.5, 1);
    expect(host.network.interfaces[0].rxBytesPerSec).toBe(1200);
    expect(host.containersSummary.healthy).toBe(1);
    expect(host.deploy.sha).toBe('e98e5b8c5');
    expect(host.collectedAtMs).toBe(1_700_000_000_000);
  });

  test('refuses payloads that cannot carry a memory reading or a timestamp', () => {
    expect(normalizeHostMetrics(null)).toBeNull();
    expect(normalizeHostMetrics({ collectedAt: '2026-09-19T00:00:00Z' })).toBeNull();
    expect(normalizeHostMetrics({ collectedAtMs: 1, memory: { totalBytes: 0 } })).toBeNull();
    expect(normalizeHostMetrics({ memory: { totalBytes: 1024 } })).toBeNull();
  });
});

describe('host metrics reader', () => {
  test('prefers the helper file and reports its age', async () => {
    const collectedAtMs = 1_700_000_000_000;
    const reader = makeReader({ files: { [HELPER_PATH]: JSON.stringify(helperPayload({ collectedAtMs })) } });
    const host = await reader.read({ nowMs: collectedAtMs + 4_000 });
    expect(host.source).toBe('helper');
    expect(host.ok).toBe(true);
    expect(host.ageMs).toBe(4_000);
    expect(host.stale).toBe(false);
    expect(host.network.interfaces[0].name).toBe('ens3');
  });

  test('a stale helper is reported as stale, not silently reused', async () => {
    const collectedAtMs = 1_700_000_000_000;
    const reader = makeReader({ files: { [HELPER_PATH]: JSON.stringify(helperPayload({ collectedAtMs })) } });
    const host = await reader.read({ nowMs: collectedAtMs + 5 * 60_000 });
    expect(host.stale).toBe(true);
    expect(host.notes).toContain('host-helper-stale');
  });

  test('falls back to /proc when the helper was never installed, without inventing network', async () => {
    const reader = makeReader({
      files: { '/proc/meminfo': MEMINFO, '/proc/loadavg': '0.11 0.20 0.25 1/443 5797', '/proc/uptime': '501873.41 357532.82' },
      statfs: async () => ({ bsize: 4096, blocks: 14_954_000, bfree: 6_200_000, bavail: 6_195_000 }),
    });
    const host = await reader.read({ nowMs: Date.now() });
    expect(host.ok).toBe(true);
    expect(host.source).toBe('in-process');
    expect(host.memory.totalBytes).toBe(8077984 * 1024);
    expect(host.memory.usedPercent).toBeCloseTo(28, 0);
    expect(host.disks[0].mount).toBe('/');
    expect(host.network).toBeNull();
    expect(host.notes).toContain('network-unavailable');
    expect(host.notes).toContain('host-helper-missing');
    expect(host.cpu).toEqual({ count: 4, load1: 0.11, load5: 0.2, load15: 0.25 });
  });

  test('an unreadable helper degrades the same way and says why', async () => {
    const reader = makeReader({
      files: { [HELPER_PATH]: '{ this is not json', '/proc/meminfo': MEMINFO, '/proc/uptime': '10 10' },
      statfs: async () => ({ bsize: 4096, blocks: 1000, bfree: 500, bavail: 500 }),
    });
    const host = await reader.read({ nowMs: Date.now() });
    expect(host.source).toBe('in-process');
    expect(host.notes).toContain('host-helper-unreadable');
  });

  test('no helper and no /proc is an explicit failure', async () => {
    const reader = makeReader({ files: {} });
    const host = await reader.read({ nowMs: Date.now() });
    expect(host.ok).toBe(false);
    expect(host.source).toBe('missing');
    expect(host.stale).toBe(true);
    expect(host.filePath ?? reader.filePath).toBe(HELPER_PATH);
    expect(reader.filePath.endsWith(HOST_METRICS_FILE_NAME)).toBe(true);
  });
});

const deviceRow = ({ id = 'dev_1', online = true, sshOk = true } = {}) => ({
  id,
  name: id,
  online,
  latencyMs: online ? 12 : null,
  transport: online ? 'tailscale' : null,
  checkedAt: '2026-09-19T00:00:00Z',
  ssh: { ok: sshOk, latencyMs: 12, target: 'h:22', kind: 'tailscale' },
  mcp: { ok: false, latencyMs: null, target: null, kind: null },
  attempted: [],
});

const makeSnapshot = ({ host, devices, metrics, calls = {}, now = () => Date.now() } = {}) => {
  const hostReads = { count: 0 };
  const hostReader = {
    read: async (options) => {
      hostReads.count += 1;
      calls.hostReads = hostReads.count;
      return host;
    },
  };
  const statusRuntime = { listStatus: async () => ({ checkedAt: 'now', total: devices.length, onlineCount: devices.filter((d) => d.online).length, devices }) };
  const registry = { listDevices: async () => devices.map((row) => ({ id: row.id, name: row.name, platform: row.platform || 'linux', approval: 'smart', capabilities: { shell: true } })) };
  const toolRuntime = {
    callTool: async (args) => {
      calls.toolCalls = [...(calls.toolCalls || []), args];
      const handler = metrics?.[args.args.device_id];
      if (!handler) return { ok: false, error: { code: 'no_fixture', message: 'no fixture' } };
      return handler();
    },
  };
  const runtime = createFleetSnapshotRuntime({ hostReader, registry, statusRuntime, toolRuntime, now });
  return { runtime, calls };
};

const metricsPayload = ({ collectedAtMs, rxBytes = 1000, txBytes = 2000 }) => ({
  platform: 'linux',
  hostname: 'relay',
  uptimeSec: 100,
  cpu: { count: 1, load1: 0.1, load5: 0.1, load15: 0.1 },
  memory: { totalBytes: 2048 * 1024 * 1024, availableBytes: 1024 * 1024 * 1024, usedBytes: 1024 * 1024 * 1024, usedPercent: 50 },
  disks: [{ mount: '/', filesystem: '/dev/vda1', totalBytes: 24 * 1024 ** 3, usedBytes: 3 * 1024 ** 3, availBytes: 21 * 1024 ** 3, usedPercent: 12.5 }],
  network: { interfaces: [{ name: 'eth0', rxBytes, txBytes }] },
  collectedAt: new Date(collectedAtMs).toISOString(),
});

describe('fleet snapshot', () => {
  test('reads host + devices, and derives byte rates from two samples', async () => {
    let clock = 1_700_000_000_000;
    const collectedAtMs = clock;
    const { runtime, calls } = makeSnapshot({
      host: { ok: true, source: 'helper', stale: false, ageMs: 0, memory: { totalBytes: 100, usedBytes: 50, usedPercent: 50 }, disks: [{ mount: '/', usedPercent: 40 }], network: null },
      devices: [deviceRow({ id: 'dev_1' })],
      metrics: {
        dev_1: () => ({ ok: true, data: metricsPayload({ collectedAtMs, rxBytes: 1000 + (calls.toolCalls.length - 1) * 3000, txBytes: 2000 }) }),
      },
      now: () => clock,
    });

    const first = await runtime.read({});
    expect(first.cached).toBe(false);
    expect(first.devices.items[0].online).toBe(true);
    // One sample is not a rate: the first poll must say null, not zero.
    expect(first.devices.items[0].metrics.network.interfaces[0].rxBytesPerSec).toBeNull();
    expect(first.summary.devicesWithMetrics).toBe(1);
    expect(calls.toolCalls[0].audit).toBe(false);
    expect(calls.toolCalls[0].tool).toBe('devices.metrics');

    // Exactly one metrics TTL later the counters are re-read: 3000 bytes over
    // 30s is 100 B/s, derived from the workbench clock rather than the device's.
    clock += 30_000;
    const second = await runtime.read({});
    const iface = second.devices.items[0].metrics.network.interfaces[0];
    expect(iface.rxBytesPerSec).toBe(100);
    expect(iface.txBytesPerSec).toBe(0);
    expect(second.devices.items[0].metrics.network.windowSec).toBe(30);
  });

  test('offline devices never get measured and still appear', async () => {
    const { runtime, calls } = makeSnapshot({
      host: { ok: true, source: 'helper', stale: false, memory: { usedPercent: 10 }, disks: [{ mount: '/', usedPercent: 10 }], network: null },
      devices: [deviceRow({ id: 'dev_off', online: false })],
    });
    const snapshot = await runtime.read({});
    expect(calls.toolCalls).toBeUndefined();
    expect(snapshot.devices.items[0].online).toBe(false);
    expect(snapshot.devices.items[0].metrics).toBeNull();
    expect(snapshot.devices.items[0].error.code).toBe('device_offline');
    expect(snapshot.summary.severity).toBe('warn');
  });

  test('a device whose metrics fail carries the code instead of a blank row', async () => {
    const { runtime } = makeSnapshot({
      host: { ok: true, source: 'helper', stale: false, memory: { usedPercent: 10 }, disks: [{ mount: '/', usedPercent: 10 }], network: null },
      devices: [deviceRow({ id: 'dev_1' })],
      metrics: { dev_1: () => ({ ok: false, error: { code: 'timeout', message: 'ssh timed out' } }) },
    });
    const snapshot = await runtime.read({});
    expect(snapshot.devices.items[0].metrics).toBeNull();
    expect(snapshot.devices.items[0].error).toEqual({ code: 'timeout', message: 'ssh timed out' });
    expect(snapshot.summary.devicesWithErrors).toBe(1);
  });

  test('serves the cached snapshot inside the TTL and rebuilds on force', async () => {
    let clock = 1_700_000_000_000;
    const { runtime, calls } = makeSnapshot({
      host: { ok: true, source: 'helper', stale: false, memory: { usedPercent: 10 }, disks: [{ mount: '/', usedPercent: 10 }], network: null },
      devices: [],
      now: () => clock,
    });
    await runtime.read({});
    clock += 5_000;
    const cached = await runtime.read({});
    expect(cached.cached).toBe(true);
    expect(calls.hostReads).toBe(1);

    await runtime.read({ force: true });
    expect(calls.hostReads).toBe(2);
  });

  test('concurrent polls share one read instead of doubling device probes', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const hostReader = { read: async () => { await gate; return { ok: true, source: 'helper', stale: false, memory: { usedPercent: 10 }, disks: [], network: null }; } };
    const runtime = createFleetSnapshotRuntime({
      hostReader,
      registry: { listDevices: async () => [] },
      statusRuntime: { listStatus: async () => ({ checkedAt: 'now', total: 0, onlineCount: 0, devices: [] }) },
      toolRuntime: { callTool: async () => ({ ok: false }) },
    });
    const [a, b] = [runtime.read({}), runtime.read({ force: true })];
    release();
    const [first, second] = await Promise.all([a, b]);
    expect(first.checkedAt).toBe(second.checkedAt);
    expect(first.cached).toBe(false);
  });
});

describe('fleet summary', () => {
  const host = (overrides = {}) => ({
    ok: true,
    stale: false,
    source: 'helper',
    memory: { usedPercent: 20, swapUsedPercent: 0 },
    disks: [{ mount: '/', usedPercent: 30 }],
    ...overrides,
  });

  test('an unreachable or stale host outranks everything', () => {
    expect(summarizeFleet({ host: host({ stale: true }), devices: [] }).severity).toBe('error');
    expect(summarizeFleet({ host: { ok: false, stale: true }, devices: [] }).severity).toBe('error');
    expect(summarizeFleet({ host: host({ ok: false, stale: true }), devices: [] }).hostOk).toBe(false);
  });

  test('warns on offline devices and 80% pressure, errors at 90%', () => {
    const online = [{ id: 'a', online: true, error: null, metrics: { disks: [] } }];
    const offline = [...online, { id: 'b', online: false, error: { code: 'device_offline' }, metrics: null }];

    expect(summarizeFleet({ host: host(), devices: online }).severity).toBe('ok');
    expect(summarizeFleet({ host: host(), devices: offline }).severity).toBe('warn');
    expect(summarizeFleet({ host: host({ memory: { usedPercent: 85 } }), devices: [] }).severity).toBe('warn');
    expect(summarizeFleet({ host: host({ disks: [{ mount: '/', usedPercent: 95 }] }), devices: [] }).severity).toBe('error');
    expect(summarizeFleet({
      host: host(),
      devices: [{ id: 'c', online: true, error: null, metrics: { disks: [{ mount: 'C:', usedPercent: 92 }] } }],
    }).worstDiskPercent).toBe(92);
  });
});
