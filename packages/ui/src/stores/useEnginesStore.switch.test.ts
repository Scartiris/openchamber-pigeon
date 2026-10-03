import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * 「切引擎」这个动作的判据（界面上的下拉就调它）。
 *
 * 为什么值得单独测：它是**唯一**会写 `engine` 设置的地方，而且写完之后必须让界面
 * 与"代理真正在用的引擎"保持一致 —— 否则就会出现"界面说切到 codex 了、请求还发给 opencode"
 * 这种最难查的状态（2026-10-03 的路由验收就被这一类时序问题卡过一次）。
 */

type PutCall = { url: string; body: string };
let putCalls: PutCall[] = [];
let putOk = true;

/**
 * `/api/engines` 的**真实形状**：`active` 就是描述符本身、目录字段在**顶层**、没有 `registry` 键。
 * （第一版这里用的是我推的形状，于是测试全绿而线上坏掉 —— 见 useEnginesStore.realshape.test.ts）
 */
const enginesPayload = (activeId: string) => ({
  dir: '/etc/oc-engines',
  dirReadable: true,
  warnings: [],
  requestedId: activeId,
  activeReason: 'requested',
  engines: [
    { id: 'opencode', name: 'opencode', capabilities: ['sessions', 'streaming'], canServeChat: true },
    { id: 'codex', name: 'Codex', capabilities: ['sessions', 'streaming', 'parts'], canServeChat: true, endpointUrl: 'http://oc-codex-adapter:4096' },
  ],
  active: { id: activeId, name: activeId, capabilities: ['sessions', 'streaming'], canServeChat: true },
});

/** `/api/engines/active` 的形状：探活只在这个端点 */
const activePayload = (activeId: string) => ({
  engine: { id: activeId, name: activeId, capabilities: ['sessions', 'streaming'], canServeChat: true },
  probe: { ok: true, status: 200, version: '1.18.33', latencyMs: 3, error: null, baseUrl: 'http://ocsplit-engine:4096', source: 'host' },
});

// 类型靠推断（别标 unknown —— anti-slop 的 no-known-value-widening 会拦）
let listResponse = enginesPayload('opencode');

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'PUT') {
      putCalls.push({ url, body: String(init.body ?? '') });
      return { ok: putOk, status: putOk ? 200 : 500, json: async () => ({}) };
    }
    // load() 现在会**同时**取 /api/engines 与 /api/engines/active（探活只在后者）
    if (url.includes('/api/engines/active')) {
      return { ok: true, status: 200, json: async () => activePayload(listResponse.active.id) };
    }
    return { ok: true, status: 200, json: async () => listResponse };
  },
}));

const { useEnginesStore } = await import('./useEnginesStore');

beforeEach(async () => {
  putCalls = [];
  putOk = true;
  listResponse = enginesPayload('opencode');
  useEnginesStore.setState({ engines: [], activeId: null, error: null, switching: false, loadedAt: null });
  await useEnginesStore.getState().load({ force: true });
});

describe('setActiveEngine：切引擎', () => {
  test('切到另一个引擎：写设置 + 强制刷新（界面与代理用的是同一个引擎）', async () => {
    listResponse = enginesPayload('codex');
    const result = await useEnginesStore.getState().setActiveEngine('codex');

    expect(result.ok).toBe(true);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].url).toContain('/api/config/settings');
    expect(JSON.parse(putCalls[0].body)).toEqual({ engine: 'codex' });
    // 刷新后 activeId 跟着变 —— 这是"界面说的"与"代理在用的"一致的判据
    expect(useEnginesStore.getState().activeId).toBe('codex');
    expect(useEnginesStore.getState().switching).toBe(false);
  });

  test('切到**当前就是**的引擎：不写盘（省一次没意义的落盘）', async () => {
    const result = await useEnginesStore.getState().setActiveEngine('opencode');
    expect(result.ok).toBe(true);
    expect(putCalls).toHaveLength(0);
  });

  test('不认识的引擎 id：拒绝，且不写盘', async () => {
    const result = await useEnginesStore.getState().setActiveEngine('不存在的引擎');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown engine');
    expect(putCalls).toHaveLength(0);
  });

  test('写盘失败：**说出来**而不是静默当成功（选了个连不上的引擎会明确失败）', async () => {
    putOk = false;
    const result = await useEnginesStore.getState().setActiveEngine('codex');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('500');
    expect(useEnginesStore.getState().error).toContain('500');
    expect(useEnginesStore.getState().switching).toBe(false);
    // 失败时不能把 activeId 改成目标引擎（否则界面会撒谎）
    expect(useEnginesStore.getState().activeId).toBe('opencode');
  });

  test('空 id：直接拒绝', async () => {
    expect((await useEnginesStore.getState().setActiveEngine('')).ok).toBe(false);
    expect(putCalls).toHaveLength(0);
  });
});
