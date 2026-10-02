import { describe, expect, test } from 'bun:test';
import { loadEngineDescriptors, resolveActiveEngine } from './registry.js';
import { BUILTIN_OPENCODE_DESCRIPTOR } from './descriptor.js';
import { probeEngine } from './probe.js';

/** 内存文件系统的 IO 替身 —— 注册表的容错行为必须能在不起真目录的情况下逐条钉住。 */
const io = (files) => ({
  readdir: async () => {
    if (files === null) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    return Object.keys(files);
  },
  readFile: async (file) => {
    const text = files[file.replace(/^\/etc\/oc-engines\//, '')];
    if (text === undefined) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    return text;
  },
});

const quiet = { warn: () => {}, log: () => {}, error: () => {} };
const validJson = (overrides = {}) => JSON.stringify({
  apiVersion: 1,
  id: 'fake-engine',
  name: 'Fake',
  protocol: 'opencode-v1',
  endpoint: { healthPath: '/global/health' },
  capabilities: ['sessions', 'streaming'],
  ...overrides,
});

describe('engine registry — 目录读取的容错', () => {
  test('目录不存在是正常状态：只剩内置引擎，没有 warning', async () => {
    const result = await loadEngineDescriptors({ dir: '/etc/oc-engines', ...io(null), logger: quiet });
    expect(result.dirReadable).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.descriptors.map((d) => d.id)).toEqual(['opencode']);
    expect(result.descriptors[0].builtin).toBe(true);
  });

  test('坏文件被跳过，好文件照常生效（一个手滑的文件不该搞瘫注册表）', async () => {
    const result = await loadEngineDescriptors({
      dir: '/etc/oc-engines',
      ...io({ 'a-broken.json': '{ not json', 'b-good.json': validJson() }),
      logger: quiet,
    });
    expect(result.descriptors.map((d) => d.id)).toEqual(['fake-engine', 'opencode']);
    expect(result.warnings.join(' ')).toContain('a-broken.json');
    // 好文件不该被连累出任何 warning
    expect(result.warnings.some((w) => w.includes('b-good.json'))).toBe(false);
  });

  test('非 .json 文件被忽略', async () => {
    const result = await loadEngineDescriptors({
      dir: '/etc/oc-engines',
      ...io({ 'README.md': '# hi', 'codex.json': validJson({ id: 'codex' }) }),
      logger: quiet,
    });
    expect(result.descriptors.map((d) => d.id)).toEqual(['codex', 'opencode']);
    expect(result.warnings).toEqual([]);
  });

  test('文件可以覆盖内置的同名引擎（显式配置胜过隐式默认）', async () => {
    const result = await loadEngineDescriptors({
      dir: '/etc/oc-engines',
      ...io({ 'opencode.json': validJson({ id: 'opencode', endpoint: { healthPath: '/custom/health' } }) }),
      logger: quiet,
    });
    const opencode = result.descriptors.find((d) => d.id === 'opencode');
    expect(opencode.builtin).toBe(false);
    expect(opencode.endpoint.healthPath).toBe('/custom/health');
    expect(result.warnings.join(' ')).toContain('覆盖了内置');
  });

  test('两个文件抢同一个 id：先出现的赢，后一个跳过并报出来', async () => {
    const result = await loadEngineDescriptors({
      dir: '/etc/oc-engines',
      ...io({ 'a-first.json': validJson({ id: 'dup', name: 'First' }), 'b-second.json': validJson({ id: 'dup', name: 'Second' }) }),
      logger: quiet,
    });
    const dup = result.descriptors.find((d) => d.id === 'dup');
    expect(dup.name).toBe('First');
    expect(result.warnings.join(' ')).toContain('b-second.json');
    expect(result.warnings.join(' ')).toContain('被跳过');
  });
});

describe('engine registry — 谁是当前引擎', () => {
  const descriptors = [
    BUILTIN_OPENCODE_DESCRIPTOR,
    { id: 'codex', builtin: false, capabilities: ['sessions', 'streaming'] },
  ];

  test('显式请求优先', () => {
    expect(resolveActiveEngine({ descriptors, requestedId: 'codex' }).engine.id).toBe('codex');
    expect(resolveActiveEngine({ descriptors, requestedId: 'codex' }).reason).toBe('requested');
  });

  test('设置里没写时看环境变量 OC_ENGINE', () => {
    expect(resolveActiveEngine({ descriptors, env: { OC_ENGINE: 'codex' } }).engine.id).toBe('codex');
  });

  test('请求了一个不存在的 id → 回落内置，且理由说得清（不是静默）', () => {
    const result = resolveActiveEngine({ descriptors, requestedId: 'nope' });
    expect(result.engine.id).toBe('opencode');
    expect(result.reason).toBe('builtin-default-with-alternatives');
  });

  test('目录里只有内置一个 → only-one', () => {
    expect(resolveActiveEngine({ descriptors: [BUILTIN_OPENCODE_DESCRIPTOR] }).reason).toBe('only-one');
  });

  test('不按文件名字母序挑引擎（有多个候选时一律回落内置）', () => {
    const result = resolveActiveEngine({
      descriptors: [BUILTIN_OPENCODE_DESCRIPTOR, { id: 'aaa', builtin: false }, { id: 'zzz', builtin: false }],
    });
    expect(result.engine.id).toBe('opencode');
    expect(result.reason).toBe('builtin-default');
  });
});

describe('engine probe — 探测', () => {
  const descriptor = {
    id: 'fake', endpoint: { healthPath: '/global/health' }, versionProbe: { field: 'version' },
  };
  const okFetch = (body, status = 200) => async () => ({
    ok: status >= 200 && status < 300, status, json: async () => body,
  });

  test('成功时带回版本与耗时', async () => {
    let t = 0;
    const result = await probeEngine({
      descriptor, baseUrl: 'http://engine:4096', fetchImpl: okFetch({ healthy: true, version: '1.2.3' }), now: () => (t += 7),
    });
    expect(result.ok).toBe(true);
    expect(result.version).toBe('1.2.3');
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.healthPath).toBe('/global/health');
  });

  test('版本字段兜底顺序：先描述符指定的，再 version / openCodeVersion', async () => {
    const r1 = await probeEngine({ descriptor, baseUrl: 'http://e', fetchImpl: okFetch({ version: 'v-a', openCodeVersion: 'v-b' }) });
    expect(r1.version).toBe('v-a');
    const r2 = await probeEngine({
      descriptor: { ...descriptor, versionProbe: { field: 'openCodeVersion' } },
      baseUrl: 'http://e', fetchImpl: okFetch({ version: 'v-a', openCodeVersion: 'v-b' }),
    });
    expect(r2.version).toBe('v-b');
  });

  test('HTTP 非 2xx → ok:false 且带状态码', async () => {
    const result = await probeEngine({ descriptor, baseUrl: 'http://e', fetchImpl: okFetch({}, 503) });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toContain('503');
  });

  test('没有地址 / 没有 healthPath → 说清原因，不是抛异常', async () => {
    expect((await probeEngine({ descriptor, baseUrl: '' })).error).toContain('引擎地址');
    expect((await probeEngine({ descriptor: { id: 'x' }, baseUrl: 'http://e' })).error).toContain('healthPath');
  });

  test('超时被识别成"探测超时"而不是一个裸 AbortError', async () => {
    const aborting = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    const result = await probeEngine({ descriptor, baseUrl: 'http://e', fetchImpl: aborting, timeoutMs: 1234 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('1234');
  });

  test('认证头被原样带上（引擎那边的 Basic 认证）', async () => {
    let seen = null;
    const capture = async (_url, init) => { seen = init?.headers; return { ok: true, status: 200, json: async () => ({ version: 'x' }) }; };
    await probeEngine({ descriptor, baseUrl: 'http://e', authHeaders: { Authorization: 'Basic abc' }, fetchImpl: capture });
    expect(seen.Authorization).toBe('Basic abc');
  });
});
