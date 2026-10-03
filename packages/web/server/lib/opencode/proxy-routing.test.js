import { describe, expect, it } from 'vitest';

import { normalizeProxyTarget, pickProxyTarget } from './proxy.js';

/**
 * 多引擎路由的**决策**（2026-10-03 加）。
 *
 * 这一组测的是"引擎请求该发到哪"。它是这次改动里唯一会动到**生产数据面**的地方，
 * 所以判据要盯死两件事：
 *   ① **默认行为一点没变**：内置 opencode 没有自己的地址 → 与加这个功能之前完全一致；
 *   ② 引擎自己声明了地址时，**它优先**（这才让「选引擎」真的有意义）。
 */
describe('pickProxyTarget：代理目标怎么挑', () => {
  const FALLBACK = 'http://127.0.0.1:3902';

  it('没人声明 → 兜底（与原来一致）', () => {
    expect(pickProxyTarget({ engineOwnUrl: null, openCodePortUrl: null, externalBaseUrl: null, fallback: FALLBACK }))
      .toBe(FALLBACK);
  });

  it('内置 opencode：只有本地端口 → 用端口（默认路径没变）', () => {
    expect(pickProxyTarget({
      engineOwnUrl: null,
      openCodePortUrl: 'http://127.0.0.1:4096',
      externalBaseUrl: null,
      fallback: FALLBACK,
    })).toBe('http://127.0.0.1:4096');
  });

  it('外部引擎（OPENCODE_HOST）：没有端口时用 baseUrl（默认路径没变）', () => {
    expect(pickProxyTarget({
      engineOwnUrl: null,
      openCodePortUrl: null,
      externalBaseUrl: 'http://ocsplit-engine:4096',
      fallback: FALLBACK,
    })).toBe('http://ocsplit-engine:4096');
  });

  it('⭐ 引擎自己声明了地址 → 它优先，压过端口与 baseUrl', () => {
    expect(pickProxyTarget({
      engineOwnUrl: 'http://oc-codex-adapter:4096',
      openCodePortUrl: 'http://127.0.0.1:4096',
      externalBaseUrl: 'http://ocsplit-engine:4096',
      fallback: FALLBACK,
    })).toBe('http://oc-codex-adapter:4096');
  });

  it('端口优先于 baseUrl（保持原有次序：本地 > 外部）', () => {
    expect(pickProxyTarget({
      engineOwnUrl: null,
      openCodePortUrl: 'http://127.0.0.1:4096',
      externalBaseUrl: 'http://elsewhere:4096',
      fallback: FALLBACK,
    })).toBe('http://127.0.0.1:4096');
  });

  it('空串/空白等于"没声明"，不会把代理指到一个空地址上', () => {
    expect(pickProxyTarget({
      engineOwnUrl: '',
      openCodePortUrl: '   ',
      externalBaseUrl: 'http://ocsplit-engine:4096',
      fallback: FALLBACK,
    })).toBe('http://ocsplit-engine:4096');
  });

  it('非字符串（注册表读坏了给了个对象）也当"没声明"', () => {
    expect(pickProxyTarget({
      engineOwnUrl: { url: 'http://x' },
      openCodePortUrl: 42,
      externalBaseUrl: null,
      fallback: FALLBACK,
    })).toBe(FALLBACK);
  });

  it('结尾斜杠被去掉（否则拼出来的路径会带双斜杠）', () => {
    expect(pickProxyTarget({
      engineOwnUrl: 'http://oc-codex-adapter:4096///',
      openCodePortUrl: null,
      externalBaseUrl: null,
      fallback: FALLBACK,
    })).toBe('http://oc-codex-adapter:4096');
  });
});

describe('normalizeProxyTarget', () => {
  it('去空白、去结尾斜杠', () => {
    expect(normalizeProxyTarget('  http://x:1/  ')).toBe('http://x:1');
  });

  it('空值 → null', () => {
    expect(normalizeProxyTarget('')).toBeNull();
    expect(normalizeProxyTarget('   ')).toBeNull();
    expect(normalizeProxyTarget(null)).toBeNull();
    expect(normalizeProxyTarget(undefined)).toBeNull();
    expect(normalizeProxyTarget(123)).toBeNull();
  });
});
