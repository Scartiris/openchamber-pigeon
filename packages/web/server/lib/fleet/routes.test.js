import { describe, expect, test } from 'bun:test';
import { registerFleetRoutes } from './routes.js';

/**
 * Route-level coverage for the fleet HTTP surface. The module tests exercise the
 * snapshot; this exercises the thing the browser actually talks to: handler
 * registration, the `?refresh=1` switch, and that a failure is an error response
 * rather than a 200 with an empty body.
 */

const createApp = () => {
  const routes = new Map();
  const app = {
    get: (path, handler) => {
      routes.set(path, handler);
    },
  };
  return { app, routes };
};

const createResponse = () => {
  const state = { statusCode: 200, body: null, headers: {} };
  const res = {
    status: (code) => {
      state.statusCode = code;
      return res;
    },
    json: (body) => {
      state.body = body;
      return res;
    },
    setHeader: (name, value) => {
      state.headers[name] = value;
    },
  };
  return { res, state };
};

const snapshot = {
  checkedAt: '2026-09-19T03:00:00.000Z',
  cached: false,
  host: { ok: true, source: 'helper', stale: false, hostname: 'pigeoncore' },
  devices: { checkedAt: '2026-09-19T03:00:00.000Z', total: 0, onlineCount: 0, items: [] },
  summary: { severity: 'ok', hostOk: true, devicesTotal: 0, devicesOnline: 0 },
};

const setup = (read) => {
  const calls = [];
  const snapshotRuntime = {
    read: async (options) => {
      calls.push(options ?? {});
      if (read) return read(options);
      return snapshot;
    },
  };
  const { app, routes } = createApp();
  registerFleetRoutes(app, { snapshotRuntime });
  return { routes, calls };
};

describe('fleet routes', () => {
  test('registers the status and host endpoints', () => {
    const { routes } = setup();
    expect([...routes.keys()].sort()).toEqual(['/api/fleet/host', '/api/fleet/status']);
  });

  test('serves the snapshot without a forced refresh by default', async () => {
    const { routes, calls } = setup();
    const { res, state } = createResponse();
    await routes.get('/api/fleet/status')({ query: {} }, res);
    expect(state.statusCode).toBe(200);
    expect(state.body.host.hostname).toBe('pigeoncore');
    expect(calls).toEqual([{ force: false }]);
  });

  test('the refresh button maps to a forced read', async () => {
    const { routes, calls } = setup();
    const { res } = createResponse();
    await routes.get('/api/fleet/status')({ query: { refresh: '1' } }, res);
    await routes.get('/api/fleet/status')({ query: { refresh: 'true' } }, res);
    await routes.get('/api/fleet/status')({ query: { refresh: '0' } }, res);
    expect(calls.map((call) => call.force)).toEqual([true, true, false]);
  });

  test('the host endpoint exposes host + summary only', async () => {
    const { routes } = setup();
    const { res, state } = createResponse();
    await routes.get('/api/fleet/host')({}, res);
    expect(state.statusCode).toBe(200);
    expect(Object.keys(state.body).sort()).toEqual(['checkedAt', 'host', 'summary']);
    expect(state.body.devices).toBeUndefined();
  });

  test('a failing snapshot is a 500 with a code, never an empty 200', async () => {
    const { routes } = setup(async () => {
      throw Object.assign(new Error('host helper exploded'), { code: 'fleet_unavailable' });
    });
    const { res, state } = createResponse();
    await routes.get('/api/fleet/status')({ query: {} }, res);
    expect(state.statusCode).toBe(500);
    expect(state.body).toEqual({ error: 'host helper exploded', code: 'fleet_unavailable' });
  });
});
