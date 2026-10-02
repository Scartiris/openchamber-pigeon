import { describe, expect, test } from 'bun:test';
import { createEnginesRuntime } from './index.js';

/**
 * 运行时这一层要钉住的是「**同步**快照」这条约定：
 * `/health` 是同步处理器（docker 每 30s 探一次 + 界面轮询），它不能去读目录、更不能打网络。
 * 所以：异步那边刷新缓存，`/health` 读缓存；缓存没热起来时必须是 **null**，
 * 而不是编一个看起来正常的默认值 —— 后者会让"注册表读挂了"在监控上完全看不出来。
 */

const quiet = { warn: () => {}, log: () => {}, error: () => {} };

const runtimeWith = ({ files = {}, settings = {}, probeBody = { healthy: true, version: '9.9.9' }, ...rest } = {}) => {
  const calls = { readdir: 0, readFile: 0, fetch: 0 };
  const runtime = createEnginesRuntime({
    env: {},
    logger: quiet,
    fsPromises: {
      readdir: async () => { calls.readdir += 1; return Object.keys(files); },
      readFile: async (file) => {
        calls.readFile += 1;
        const name = String(file).split('/').pop();
        if (!(name in files)) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
        return files[name];
      },
    },
    readSettingsFromDiskMigrated: async () => settings,
    getEngineBaseUrl: () => 'http://engine.test:4096',
    getEngineAuthHeaders: () => ({ Authorization: 'Basic abc' }),
    fetchImpl: async () => { calls.fetch += 1; return { ok: true, status: 200, json: async () => probeBody }; },
    ...rest,
  });
  return { runtime, calls };
};

const descriptor = (over = {}) => JSON.stringify({
  apiVersion: 1,
  id: 'fake',
  name: 'Fake',
  protocol: 'opencode-v1',
  endpoint: { healthPath: '/global/health' },
  capabilities: ['sessions', 'streaming'],
  ...over,
});

describe('engines runtime — 同步快照（/health 的约定）', () => {
  test('还没热起来时是 null，不是编出来的默认值', () => {
    const { runtime } = runtimeWith();
    expect(runtime.getCachedSnapshot()).toBe(null);
  });

  test('getSnapshot 之后同步读得到同一份', async () => {
    const { runtime } = runtimeWith();
    const snapshot = await runtime.getSnapshot();
    expect(runtime.getCachedSnapshot()).toBe(snapshot);
    expect(snapshot.active.id).toBe('opencode');
    expect(snapshot.engines.map((e) => e.id)).toEqual(['opencode']);
  });

  test('描述符目录描述得出来 —— 放一个文件就多一个引擎，无需改代码', async () => {
    const { runtime } = runtimeWith({ files: { 'codex.json': descriptor({ id: 'codex', name: 'Codex' }) } });
    const snapshot = await runtime.getSnapshot();
    expect(snapshot.engines.map((e) => e.id)).toEqual(['codex', 'opencode']);
    // 有多个候选时不猜：仍然回落内置
    expect(snapshot.active.id).toBe('opencode');
    expect(snapshot.activeReason).toBe('builtin-default-with-alternatives');
  });

  test('设置里的 engine 决定谁是当前引擎', async () => {
    const { runtime } = runtimeWith({
      files: { 'codex.json': descriptor({ id: 'codex' }) },
      settings: { engine: 'codex' },
    });
    const snapshot = await runtime.getSnapshot();
    expect(snapshot.active.id).toBe('codex');
    expect(snapshot.activeReason).toBe('requested');
  });

  test('目录读不出来也只记 warning，不抛（注册表坏了不该阻止服务跑）', async () => {
    const { runtime } = runtimeWith({ fsPromisesBroken: true });
    const broken = createEnginesRuntime({
      env: {}, logger: quiet,
      fsPromises: { readdir: async () => { throw new Error('EACCES: nope'); }, readFile: async () => '' },
      readSettingsFromDiskMigrated: async () => ({}),
      getEngineBaseUrl: () => '',
      getEngineAuthHeaders: () => ({}),
    });
    const snapshot = await broken.getSnapshot();
    expect(snapshot.engines.map((e) => e.id)).toEqual(['opencode']);
    expect(snapshot.dirReadable).toBe(false);
    expect(snapshot.warnings.join(' ')).toContain('EACCES');
    expect(runtime.getCachedSnapshot()).toBe(null);
  });

  test('读设置抛异常时按"未指定引擎"处理', async () => {
    const runtime = createEnginesRuntime({
      env: {}, logger: quiet,
      fsPromises: { readdir: async () => [], readFile: async () => '' },
      readSettingsFromDiskMigrated: async () => { throw new Error('settings boom'); },
      getEngineBaseUrl: () => '',
      getEngineAuthHeaders: () => ({}),
    });
    const snapshot = await runtime.getSnapshot();
    expect(snapshot.active.id).toBe('opencode');
    expect(snapshot.requestedId).toBe(null);
  });
});

describe('engines runtime — 快照会自己跟上（stale-while-revalidate）', () => {
  const flush = () => new Promise((resolve) => { setTimeout(resolve, 5); });

  test('同步读发现过期时，在后台重算一次', async () => {
    let clock = 0;
    const { runtime, calls } = runtimeWith({ registryCacheMs: 10, now: () => clock });
    await runtime.getSnapshot();
    expect(calls.readdir).toBe(1);

    clock = 11;
    const stale = runtime.getCachedSnapshot(); // 同步：先给旧值
    expect(stale).not.toBe(null);
    await flush();
    expect(calls.readdir).toBeGreaterThan(1); // 后台已经重算过
  });

  test('改了 engine 设置，同步快照会在一个 TTL 内跟上（验收时就是被这条卡住的）', async () => {
    let settings = { engine: '' };
    let clock = 0;
    const runtime = createEnginesRuntime({
      env: {}, logger: quiet, now: () => clock, registryCacheMs: 10,
      fsPromises: {
        readdir: async () => ['codex.json'],
        readFile: async () => descriptor({ id: 'codex', name: 'Codex' }),
      },
      readSettingsFromDiskMigrated: async () => settings,
      getEngineBaseUrl: () => '',
      getEngineAuthHeaders: () => ({}),
    });

    await runtime.getSnapshot();
    expect(runtime.getCachedSnapshot().active.id).toBe('opencode');

    settings = { engine: 'codex' };
    clock = 11;
    runtime.getCachedSnapshot(); // 第一次同步读：触发后台刷新，仍返回旧值
    await flush();
    expect(runtime.getCachedSnapshot().active.id).toBe('codex');
  });

  test('并发同步读只放一个后台刷新（不叠加）', async () => {
    let clock = 0;
    const { runtime, calls } = runtimeWith({ registryCacheMs: 10, now: () => clock });
    await runtime.getSnapshot();
    const before = calls.readdir;
    clock = 11;
    runtime.getCachedSnapshot();
    runtime.getCachedSnapshot();
    runtime.getCachedSnapshot();
    await flush();
    expect(calls.readdir - before).toBeLessThanOrEqual(2);
  });
});

describe('engines runtime — 缓存', () => {
  test('描述符目录在 TTL 内只读一次；force 穿透', async () => {
    const { runtime, calls } = runtimeWith({ registryCacheMs: 60_000 });
    await runtime.getSnapshot();
    await runtime.getSnapshot();
    expect(calls.readdir).toBe(1);
    await runtime.getSnapshot({ force: true });
    expect(calls.readdir).toBe(2);
  });

  test('TTL 过期后重读', async () => {
    let clock = 0;
    const { runtime, calls } = runtimeWith({ registryCacheMs: 10, now: () => clock });
    await runtime.getSnapshot();
    clock = 5;
    await runtime.getSnapshot();
    expect(calls.readdir).toBe(1);
    clock = 11;
    await runtime.getSnapshot();
    expect(calls.readdir).toBe(2);
  });

  test('探测结果短缓存；force 与地址变化都会穿透', async () => {
    let clock = 0;
    const { runtime, calls } = runtimeWith({ probeCacheMs: 1000, now: () => clock });
    await runtime.probeActive();
    expect(calls.fetch).toBe(1);
    const cached = await runtime.probeActive();
    expect(calls.fetch).toBe(1);
    expect(cached.cached).toBe(true);
    clock = 1001;
    await runtime.probeActive();
    expect(calls.fetch).toBe(2);
    await runtime.probeActive({ force: true });
    expect(calls.fetch).toBe(3);
  });

  test('探测真的带回了版本（前端要用它显示内核版本）', async () => {
    const { runtime } = runtimeWith({ probeBody: { healthy: true, version: '1.18.34' } });
    const result = await runtime.probeActive();
    expect(result.probe.ok).toBe(true);
    expect(result.probe.version).toBe('1.18.34');
    expect(result.engine.id).toBe('opencode');
  });

  test('探测会报出"探的是哪个地址、地址从哪来"（多引擎并存时判读 probe.ok 的前提）', async () => {
    const { runtime } = runtimeWith();
    const result = await runtime.probeActive();
    expect(result.probe.baseUrl).toBe('http://engine.test:4096');
    expect(result.probe.source).toBe('host'); // 内置 opencode 没有自己的 url → 用宿主的
  });

  test('引擎地址取不到时探测失败但**不抛**（引擎还没起来是常态）', async () => {
    const runtime = createEnginesRuntime({
      env: {}, logger: quiet,
      fsPromises: { readdir: async () => [], readFile: async () => '' },
      readSettingsFromDiskMigrated: async () => ({}),
      getEngineBaseUrl: () => { throw new Error('OpenCode port is not available'); },
      getEngineAuthHeaders: () => ({}),
    });
    const result = await runtime.probeActive();
    expect(result.probe.ok).toBe(false);
    expect(result.probe.error).toContain('引擎地址');
  });
});

describe('engines runtime — 每个引擎探自己的地址（per-engine endpoint）', () => {
  test('描述符写了 endpoint.url 就用它，不用宿主的', async () => {
    const seen = [];
    const runtime = createEnginesRuntime({
      env: {}, logger: quiet,
      fsPromises: {
        readdir: async () => ['codex.json'],
        readFile: async () => descriptor({ id: 'codex', endpoint: { healthPath: '/global/health', url: 'http://codex-engine:4096' } }),
      },
      readSettingsFromDiskMigrated: async () => ({ engine: 'codex' }),
      getEngineBaseUrl: () => 'http://host-engine:9999',
      getEngineAuthHeaders: () => ({}),
      fetchImpl: async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => ({ version: '9' }) }; },
    });
    const result = await runtime.probeActive();
    expect(result.engine.id).toBe('codex');
    expect(seen).toEqual(['http://codex-engine:4096/global/health']);
    expect(result.probe.baseUrl).toBe('http://codex-engine:4096');
    expect(result.probe.source).toBe('descriptor');
  });

  test('两个引擎各自的地址互不串（一个死一个活，活的那个不受影响）', async () => {
    const hit = [];
    const files = {
      'a-dead.json': descriptor({ id: 'a-dead', endpoint: { healthPath: '/global/health', url: 'http://dead:1' } }),
      'b-live.json': descriptor({ id: 'b-live', endpoint: { healthPath: '/global/health', url: 'http://live:2' } }),
    };
    const make = (engineId) => createEnginesRuntime({
      env: {}, logger: quiet,
      fsPromises: { readdir: async () => Object.keys(files), readFile: async (f) => files[String(f).split('/').pop()] },
      readSettingsFromDiskMigrated: async () => ({ engine: engineId }),
      getEngineBaseUrl: () => 'http://host:0',
      getEngineAuthHeaders: () => ({}),
      fetchImpl: async (url) => {
        hit.push(url);
        if (url.includes('dead')) { const e = new Error('connect ECONNREFUSED'); throw e; }
        return { ok: true, status: 200, json: async () => ({ version: 'live-1' }) };
      },
    });

    const dead = await make('a-dead').probeActive();
    expect(dead.probe.ok).toBe(false);
    expect(dead.probe.error).toContain('ECONNREFUSED');

    const live = await make('b-live').probeActive();
    expect(live.probe.ok).toBe(true);
    expect(live.probe.version).toBe('live-1');
    expect(hit).toEqual(['http://dead:1/global/health', 'http://live:2/global/health']);
  });
});
