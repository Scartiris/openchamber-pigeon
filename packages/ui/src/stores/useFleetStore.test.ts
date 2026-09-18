import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { FleetSnapshot } from '@/lib/fleet/types';
import { useFleetStore } from './useFleetStore';

const snapshot = (overrides: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
  checkedAt: '2026-09-19T03:00:00.000Z',
  cached: false,
  host: {
    ok: true,
    source: 'helper',
    ageMs: 3_000,
    stale: false,
    notes: [],
    error: null,
    collectedAt: '2026-09-19T03:00:00.000Z',
    hostname: 'pigeoncore',
    platform: 'linux',
    kernel: '7.0.0-31',
    arch: 'x86_64',
    uptimeSec: 501_873,
    cpu: { count: 4, load1: 0.1, load5: 0.2, load15: 0.3 },
    memory: {
      totalBytes: 8_077_984 * 1024,
      availableBytes: 5_798_056 * 1024,
      usedBytes: 2_279_928 * 1024,
      usedPercent: 28.2,
      swapTotalBytes: 11_534_324 * 1024,
      swapUsedBytes: 1_177_096 * 1024,
      swapUsedPercent: 10.2,
    },
    disks: [{ mount: '/', filesystem: '/dev/vda1', totalBytes: 61_255_049_216, usedBytes: 35_862_216_704, availBytes: 25_376_055_296, usedPercent: 58.5 }],
    network: { windowSec: 15, interfaces: [{ name: 'ens3', rxBytes: 1, txBytes: 2, rxBytesPerSec: 1200, txBytesPerSec: 800 }], totalRxBytesPerSec: 1200, totalTxBytesPerSec: 800 },
    containers: [{ name: 'openchamber', image: 'x', state: 'running', health: 'healthy', status: 'Up' }],
    containersSummary: { total: 3, running: 3, healthy: 3, unhealthy: 0 },
    deploy: { sha: 'e98e5b8c5', image: 'x', previousImage: 'y', at: '2026-09-18T15:40:00Z' },
  },
  devices: { checkedAt: '2026-09-19T03:00:00.000Z', total: 1, onlineCount: 1, items: [] },
  summary: {
    severity: 'ok',
    hostOk: true,
    hostStale: false,
    hostMemPercent: 28.2,
    hostSwapPercent: 10.2,
    hostDiskPercent: 58.5,
    hostSource: 'helper',
    devicesTotal: 1,
    devicesOnline: 1,
    devicesWithMetrics: 1,
    devicesWithErrors: 0,
    worstDiskPercent: 58.5,
  },
  ...overrides,
});

let handleRequest: (url: string) => Promise<Response>;
const network = spyOn(globalThis, 'fetch');
let requests = 0;

beforeEach(() => {
  useFleetStore.getState().resetForRuntimeSwitch();
  requests = 0;
  handleRequest = async () => Response.json(snapshot());
  network.mockImplementation((input) => {
    requests += 1;
    return handleRequest(input.toString());
  });
});

afterEach(() => {
  useFleetStore.getState().resetForRuntimeSwitch();
  network.mockReset();
});

afterAll(() => network.mockRestore());

describe('useFleetStore', () => {
  test('loads a snapshot and exposes it to the chip', async () => {
    const loaded = await useFleetStore.getState().ensureLoaded();
    expect(loaded?.host.hostname).toBe('pigeoncore');
    const state = useFleetStore.getState();
    expect(state.status).toBe('ready');
    expect(state.error).toBeNull();
    expect(state.snapshot?.summary.hostDiskPercent).toBe(58.5);
    expect(requests).toBe(1);
  });

  test('a second read inside the TTL is served from memory', async () => {
    await useFleetStore.getState().ensureLoaded();
    await useFleetStore.getState().ensureLoaded();
    expect(requests).toBe(1);
  });

  test('the refresh button bypasses the TTL and asks the server to re-probe', async () => {
    await useFleetStore.getState().ensureLoaded();
    await useFleetStore.getState().ensureLoaded({ force: true });
    expect(requests).toBe(2);
  });

  test('a failed refresh keeps the previous snapshot and records the error', async () => {
    await useFleetStore.getState().ensureLoaded();
    handleRequest = async () => new Response('nope', { status: 500 });
    await useFleetStore.getState().ensureLoaded({ force: true });

    const state = useFleetStore.getState();
    expect(state.status).toBe('ready');
    expect(state.error).toEqual({ code: 'load', status: 500, message: 'HTTP 500' });
    // The stale numbers stay on screen; they are not replaced by an empty board.
    expect(state.snapshot?.host.hostname).toBe('pigeoncore');
  });

  test('an unreadable payload is reported as a parse failure, not as zero devices', async () => {
    handleRequest = async () => Response.json({ ok: true });
    await useFleetStore.getState().ensureLoaded();
    const state = useFleetStore.getState();
    expect(state.snapshot).toBeNull();
    expect(state.status).toBe('error');
    expect(state.error?.code).toBe('parse');
  });

  test('switching runtime forgets the snapshot', async () => {
    await useFleetStore.getState().ensureLoaded();
    useFleetStore.getState().resetForRuntimeSwitch();
    const state = useFleetStore.getState();
    expect(state.snapshot).toBeNull();
    expect(state.lastUpdated).toBeNull();
    expect(state.status).toBe('idle');
  });

  test('concurrent callers share one request', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    handleRequest = async () => {
      await gate;
      return Response.json(snapshot());
    };
    const first = useFleetStore.getState().ensureLoaded();
    const second = useFleetStore.getState().ensureLoaded();
    release?.();
    await Promise.all([first, second]);
    expect(requests).toBe(1);
  });
});
