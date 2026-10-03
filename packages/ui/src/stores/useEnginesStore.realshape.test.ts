import { describe, expect, test } from 'bun:test';

import {
  activeEngineResponseSchema,
  enginesResponseSchema,
  toEngineDescriptorView,
  toEngineProbeView,
  toEngineRegistryView,
} from './useEnginesStore';

/**
 * 用**服务器真实响应**钉住形状（2026-10-03 从线上取的原文，见 `ops/split/dump-engines-shape.sh`）。
 *
 * 为什么必须单独有这一条：
 *   原来的测试用的夹具是**我自己按"以为的形状"造的** —— schema 写错，夹具也跟着错，
 *   于是测试全绿、线上却是坏的：`activeId` 恒为 null，界面显示「当前引擎：未知」。
 *   **拿真响应当夹具**才能挡住这一类错。
 *
 * 两个端点的真实形状（原文摘录）：
 *   GET /api/engines        → { dir, dirReadable, warnings, requestedId, activeReason, active:<描述符>, engines:[<描述符>] }
 *                             ⚠️ **没有 `registry` 键**；`active` **就是描述符本身**（不是 {engine,probe,reason}）
 *   GET /api/engines/active → { engine:<描述符>, probe:{…}, cached }
 *                             ⚠️ **探活只在这个端点**，`/api/engines` 里没有
 */

/** 线上 /api/engines 的原文（只裁掉能力数组里重复的部分，键名与嵌套一字未改） */
const REAL_LIST_RESPONSE = {
  dir: '/etc/oc-engines',
  dirReadable: true,
  warnings: [],
  requestedId: 'opencode',
  activeReason: 'requested',
  active: {
    id: 'opencode',
    name: 'OpenCode',
    protocol: 'opencode-v1',
    surface: 'chat',
    builtin: true,
    source: null,
    capabilities: ['sessions', 'streaming', 'parts', 'tools', 'permissions', 'questions', 'todos', 'providers', 'agents', 'mcp', 'skills', 'commands', 'diffs', 'attachments', 'projects'],
    capabilitiesApiVersion: 1,
    canServeChat: true,
    missingForChat: [],
    healthPath: '/global/health',
    endpointUrl: null,
    authType: 'basic',
    versionProbe: { path: '/global/health', field: 'version' },
  },
  engines: [
    {
      id: 'codex',
      name: 'Codex（经适配器）',
      protocol: 'opencode-v1',
      surface: 'chat',
      builtin: false,
      source: '/etc/oc-engines/codex.json',
      capabilities: ['sessions', 'streaming', 'parts'],
      capabilitiesApiVersion: 1,
      canServeChat: true,
      missingForChat: [],
      healthPath: '/global/health',
      endpointUrl: 'http://oc-codex-adapter:4096',
      authType: 'basic',
      versionProbe: { field: 'version' },
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      protocol: 'opencode-v1',
      surface: 'chat',
      builtin: true,
      source: null,
      capabilities: ['sessions', 'streaming'],
      capabilitiesApiVersion: 1,
      canServeChat: true,
      missingForChat: [],
      healthPath: '/global/health',
      endpointUrl: null,
      authType: 'basic',
      versionProbe: { path: '/global/health', field: 'version' },
    },
  ],
};

/** 线上 /api/engines/active 的原文 */
const REAL_ACTIVE_RESPONSE = {
  engine: {
    id: 'opencode',
    name: 'OpenCode',
    protocol: 'opencode-v1',
    surface: 'chat',
    builtin: true,
    source: null,
    capabilities: ['sessions', 'streaming'],
    capabilitiesApiVersion: 1,
    canServeChat: true,
    missingForChat: [],
    healthPath: '/global/health',
    endpointUrl: null,
    authType: 'basic',
    versionProbe: { path: '/global/health', field: 'version' },
  },
  probe: { ok: true, status: 200, version: '1.18.33', latencyMs: 4, error: null, baseUrl: 'http://ocsplit-engine:4096', source: 'host' },
  cached: false,
};

describe('引擎注册表：真实响应形状', () => {
  test('⭐ activeId 取自 `active.id`（active 就是描述符本身，不是 {engine:…}）', () => {
    const parsed = enginesResponseSchema.safeParse(REAL_LIST_RESPONSE);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // 这正是坏掉的那一处：第一版读 `active.engine.id` → 恒为 null → 界面「当前引擎：未知」
    expect(parsed.data.active?.id).toBe('opencode');
    expect(parsed.data.activeReason).toBe('requested');
    expect(parsed.data.requestedId).toBe('opencode');
  });

  test('engines 两条都解析出来，codex 带自己的地址', () => {
    const parsed = enginesResponseSchema.parse(REAL_LIST_RESPONSE);
    const views = parsed.engines?.map(toEngineDescriptorView) ?? [];
    expect(views.map((e) => e.id)).toEqual(['codex', 'opencode']);
    expect(views[0]?.endpointUrl).toBe('http://oc-codex-adapter:4096');
    expect(views[1]?.endpointUrl).toBeNull();
    expect(views.every((e) => e.canServeChat)).toBe(true);
  });

  test('⭐ 目录信息来自**顶层**字段（没有嵌套的 registry 对象）', () => {
    const parsed = enginesResponseSchema.parse(REAL_LIST_RESPONSE);
    const registry = toEngineRegistryView(parsed);
    expect(registry.dir).toBe('/etc/oc-engines');
    expect(registry.readable).toBe(true);
    expect(registry.warnings).toEqual([]);
    expect(registry.count).toBe(2);
  });

  test('⭐ 探活来自 `/api/engines/active`（`/api/engines` 里没有这个字段）', () => {
    expect('probe' in enginesResponseSchema.parse(REAL_LIST_RESPONSE)).toBe(false);

    const parsed = activeEngineResponseSchema.safeParse(REAL_ACTIVE_RESPONSE);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.engine?.id).toBe('opencode');
    const probe = parsed.data.probe ? toEngineProbeView(parsed.data.probe) : null;
    expect(probe).toEqual({
      ok: true,
      status: 200,
      version: '1.18.33',
      latencyMs: 4,
      error: null,
      baseUrl: 'http://ocsplit-engine:4096',
      source: 'host',
    });
  });

  test('老形状（我第一版推的 {active:{engine,probe,reason}, registry}）现在**直接解析失败**', () => {
    // 这比"解析成功但字段为 undefined"更好：形状不对就明确报错，
    // 而不是让界面拿一个恒为 null 的 activeId 显示「未知」——那正是线上坏掉时的样子。
    const oldShape = {
      active: { engine: { id: 'opencode' }, probe: { ok: true }, reason: 'requested' },
      registry: { dir: '/etc/oc-engines', readable: true, count: 2, warnings: [] },
    };
    expect(enginesResponseSchema.safeParse(oldShape).success).toBe(false);
  });
});
