import { describe, expect, it } from 'vitest';

import { createOpenCodeNetworkRuntime } from './network-runtime.js';

/**
 * 多引擎路由的**总接缝**：`buildOpenCodeUrl` 是全仓约 30 个模块问"引擎在哪"的唯一函数
 * （事件流、通知、权限、会话、定时任务…）。改这一处，等于所有跟引擎说话的地方一起改道。
 *
 * 所以判据盯死两条：
 *   ① **默认行为一字未改**：没声明地址时，端口/OPENCODE_HOST/前缀/抛错 全部同前；
 *   ② 声明了地址时**改道**，而且**不再因为 opencode 端口未知而抛错**。
 */

const makeRuntime = ({ state = {}, resolveActiveEngineUrl } = {}) => createOpenCodeNetworkRuntime({
  state: {
    openCodePort: null,
    openCodeBaseUrl: null,
    openCodeApiPrefix: '',
    ...state,
  },
  getOpenCodeAuthHeaders: () => ({}),
  ...(resolveActiveEngineUrl ? { resolveActiveEngineUrl } : {}),
});

describe('buildOpenCodeUrl：默认行为（没声明引擎地址）', () => {
  it('端口未知 → 抛错（一字未改）', () => {
    const runtime = makeRuntime();
    expect(() => runtime.buildOpenCodeUrl('/session')).toThrow('OpenCode port is not available');
  });

  it('按端口拼（本地 opencode）', () => {
    const runtime = makeRuntime({ state: { openCodePort: 4096 } });
    expect(runtime.buildOpenCodeUrl('/session')).toBe('http://127.0.0.1:4096/session');
  });

  it('OPENCODE_HOST 优先于端口（外部引擎）', () => {
    const runtime = makeRuntime({ state: { openCodePort: 4096, openCodeBaseUrl: 'http://ocsplit-engine:4096' } });
    expect(runtime.buildOpenCodeUrl('/global/health')).toBe('http://ocsplit-engine:4096/global/health');
  });

  it('path 不带前导斜杠也认', () => {
    const runtime = makeRuntime({ state: { openCodePort: 4096 } });
    expect(runtime.buildOpenCodeUrl('session')).toBe('http://127.0.0.1:4096/session');
  });

  it('注入了但返回 null → 完全按原路（这就是内置 opencode 的情形）', () => {
    const runtime = makeRuntime({ state: { openCodePort: 4096 }, resolveActiveEngineUrl: () => null });
    expect(runtime.buildOpenCodeUrl('/session')).toBe('http://127.0.0.1:4096/session');
  });
});

describe('buildOpenCodeUrl：引擎自己声明了地址 → 改道', () => {
  it('⭐ 所有引擎请求都去它那儿（压过端口与 OPENCODE_HOST）', () => {
    const runtime = makeRuntime({
      state: { openCodePort: 4096, openCodeBaseUrl: 'http://ocsplit-engine:4096' },
      resolveActiveEngineUrl: () => 'http://oc-codex-adapter:4096',
    });
    expect(runtime.buildOpenCodeUrl('/session')).toBe('http://oc-codex-adapter:4096/session');
    expect(runtime.buildOpenCodeUrl('/global/event')).toBe('http://oc-codex-adapter:4096/global/event');
  });

  it('⭐ 不套 opencode 的 API 前缀（自定义引擎按自己的根路径提供服务）', () => {
    const runtime = makeRuntime({
      state: { openCodePort: 4096, openCodeApiPrefix: '/api' },
      resolveActiveEngineUrl: () => 'http://oc-codex-adapter:4096',
    });
    expect(runtime.buildOpenCodeUrl('/session')).toBe('http://oc-codex-adapter:4096/session');
  });

  it('⭐ 不再因为 opencode 端口未知而抛错（切到外部引擎时那个端口与本次请求无关）', () => {
    const runtime = makeRuntime({
      state: { openCodePort: null },
      resolveActiveEngineUrl: () => 'http://oc-codex-adapter:4096',
    });
    expect(runtime.buildOpenCodeUrl('/session')).toBe('http://oc-codex-adapter:4096/session');
  });

  it('结尾斜杠被归一化（免得拼出双斜杠）', () => {
    const runtime = makeRuntime({ resolveActiveEngineUrl: () => 'http://oc-codex-adapter:4096///' });
    expect(runtime.buildOpenCodeUrl('/session')).toBe('http://oc-codex-adapter:4096/session');
  });

  it('空串/空白 = 没声明（不会把请求发到空地址）', () => {
    const runtime = makeRuntime({ state: { openCodePort: 4096 }, resolveActiveEngineUrl: () => '   ' });
    expect(runtime.buildOpenCodeUrl('/session')).toBe('http://127.0.0.1:4096/session');
  });

  it('解析器抛错 → 当"没声明"，绝不因此弄坏引擎请求', () => {
    const runtime = makeRuntime({
      state: { openCodePort: 4096 },
      resolveActiveEngineUrl: () => { throw new Error('注册表读挂了'); },
    });
    expect(runtime.buildOpenCodeUrl('/session')).toBe('http://127.0.0.1:4096/session');
  });
});
