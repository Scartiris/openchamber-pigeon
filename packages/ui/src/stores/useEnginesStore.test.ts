import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
  enginesResponseSchema,
  toEngineDescriptorView,
  toEngineProbeView,
} from './useEnginesStore';

/**
 * 测的是「服务端回什么形状 → UI 怎么理解」这一段（**边界解析 + 域映射**）。
 *
 * 为什么值得单独测：这几个端点是 M4 新加的，服务端**故意做成纯增量**（老字段不动），
 * 所以 UI 必须能容忍"字段缺失/形状不同"（老宿主、坏描述符、被丢掉的能力），
 * 而不是一缺字段就整页崩 —— 但也**不能把不认识的东西放进来**。
 */

/** 参数类型直接取 schema 的输入类型 —— 不是 `unknown`，边界解析在这里面做。 */
const view = (raw: z.input<typeof enginesResponseSchema>) => {
  const parsed = enginesResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const first = parsed.data.engines?.[0];
  return first ? toEngineDescriptorView(first) : null;
};

describe('引擎描述符：服务端形状 → UI 视图', () => {
  test('正常一条：能力被收成闭集内的、地址取 endpointUrl', () => {
    expect(view({
      engines: [{
        id: 'codex',
        name: 'Codex（经适配器）',
        protocol: 'opencode-v1',
        endpointUrl: 'http://oc-codex-adapter:4096',
        capabilities: ['sessions', 'streaming', 'parts'],
        canServeChat: true,
      }],
    })).toEqual({
      id: 'codex',
      name: 'Codex（经适配器）',
      protocol: 'opencode-v1',
      endpointUrl: 'http://oc-codex-adapter:4096',
      capabilities: ['sessions', 'streaming', 'parts'],
      canServeChat: true,
    });
  });

  test('地址写在 endpoint.url 里也能取到（兜底）', () => {
    const got = view({ engines: [{ id: 'x', endpoint: { url: 'http://x:1', healthPath: '/global/health' } }] });
    expect(got?.endpointUrl).toBe('http://x:1');
  });

  test('没写地址 → endpointUrl 是 null（界面据此提示"探测分不清是谁"）', () => {
    expect(view({ engines: [{ id: 'opencode', capabilities: ['sessions', 'streaming'] }] })?.endpointUrl).toBeNull();
  });

  test('能力里的陌生项被丢掉（服务端已报过 warning，UI 不该渲染它）', () => {
    expect(view({ engines: [{ id: 'x', capabilities: ['sessions', 'telepathy', 'streaming'] }] })?.capabilities)
      .toEqual(['sessions', 'streaming']);
  });

  test('缺 id 的条目被 schema 拦掉（而不是渲染成一行空白）', () => {
    // 用 safeParse 直接喂非法形状：view() 的参数是 schema 的输入类型，缺 id 在这里就已经不合法了
    expect(enginesResponseSchema.safeParse({ engines: [{ name: '没有 id' }] }).success).toBe(false);
    expect(enginesResponseSchema.safeParse({ engines: [{ id: '' }] }).success).toBe(false);
    expect(view({ engines: [] })).toBeNull();
  });

  test('缺 name/protocol 时有兜底，不会渲染出 undefined', () => {
    const got = view({ engines: [{ id: 'x' }] });
    expect(got?.name).toBe('x');
    expect(got?.protocol).toBe('unknown');
    expect(got?.canServeChat).toBe(false); // 没声明就是 false，不猜
  });

  test('多出来的字段不会被当成域字段（passthrough 只保证解析不失败）', () => {
    const got = view({ engines: [{ id: 'x', 未来字段: 1, capabilities: [] }] });
    expect(Object.keys(got ?? {})).toEqual(['id', 'name', 'protocol', 'endpointUrl', 'capabilities', 'canServeChat']);
  });

  test('整段形状不对（engines 不是数组）→ 解析失败，界面走错误分支而不是崩', () => {
    expect(enginesResponseSchema.safeParse({ engines: '不是数组' }).success).toBe(false);
    expect(enginesResponseSchema.safeParse({ engines: [{ id: '' }] }).success).toBe(false); // 空 id 也算不合法
  });
});

describe('探活结果：能区分"探通了"与"探的是谁"', () => {
  test('descriptor 来源 + 自己的地址', () => {
    const probe = toEngineProbeView({
      ok: true, status: 200, version: '1.18.33', latencyMs: 4,
      baseUrl: 'http://oc-codex-adapter:4096', source: 'descriptor',
    });
    expect(probe.ok).toBe(true);
    expect(probe.source).toBe('descriptor');
    expect(probe.baseUrl).toBe('http://oc-codex-adapter:4096');
  });

  test('失败时带回错误原文（界面要能显示"为什么探不通"）', () => {
    const probe = toEngineProbeView({ ok: false, error: 'Unable to connect. Is the computer able to access the url?' });
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain('Unable to connect');
  });

  test('host 来源能被识别（看到这个值就该警觉：探测分不清是谁在应答）', () => {
    expect(toEngineProbeView({ source: 'host' }).source).toBe('host');
  });

  test('字段缺失时给 null 而不是 undefined（界面少写一层判空）', () => {
    const probe = toEngineProbeView({});
    expect(probe.ok).toBe(false);
    expect(probe.version).toBeNull();
    expect(probe.latencyMs).toBeNull();
  });
});
