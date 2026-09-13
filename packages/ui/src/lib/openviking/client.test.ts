import { describe, expect, test } from 'bun:test';

import { OpenVikingError, readProxyStatus } from '@/lib/openviking/client';

/**
 * 回归测试：反代 `/status` **没有 OpenViking 的信封**。
 *
 * 这个 bug 的真实表现（2026-09-13 用户报「设置里点开记忆相关设置一直加载中」）：
 * `/api/openviking/status` 回了 200，但客户端走统一的 `readEnvelope()` 去取
 * `envelope.result`，而反代返回的是**裸对象** `{enabled, upstream, hasApiKey}`，
 * 于是 `result` 永远是 `undefined` → `status` 永远是 falsy →
 * 两个设置页**永远停在「加载中…」**，且 `/health`、`/ready` 压根不会发。
 *
 * 为什么 store 单测没抓到：那里 mock 了 `openVikingApi.proxyStatus()`，
 * 直接返回了正确的对象，把"响应怎么解析"这一层整个跳过了。
 * 所以这一层必须**用真实 Response 打**。
 */
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('readProxyStatus（反代裸对象，不走信封）', () => {
  test('★ 裸对象必须被正确解析 —— 这就是那个"一直加载中"的根因', async () => {
    const result = await readProxyStatus(
      jsonResponse({ enabled: true, upstream: 'http://openviking:1933', hasApiKey: true }),
    );
    expect(result.enabled).toBe(true);
    expect(result.upstream).toBe('http://openviking:1933');
    expect(result.hasApiKey).toBe(true);
  });

  test('未配置时的形状（enabled=false）也要能解析', async () => {
    const result = await readProxyStatus(
      jsonResponse({ enabled: false, upstream: null, hasApiKey: false }),
    );
    expect(result.enabled).toBe(false);
    expect(result.upstream).toBeNull();
    expect(result.hasApiKey).toBe(false);
  });

  test('upstream 缺失时回落成 null，而不是 undefined', async () => {
    const result = await readProxyStatus(jsonResponse({ enabled: true }));
    expect(result.upstream).toBeNull();
    expect(result.hasApiKey).toBe(false);
  });

  test('★ 缺 enabled 字段要报错，而不是静默返回一个 falsy 状态（否则又是永远加载中）', async () => {
    let threw = false;
    try {
      await readProxyStatus(jsonResponse({ upstream: 'http://x' }));
    } catch (error) {
      threw = error instanceof OpenVikingError;
    }
    expect(threw).toBe(true);
  });

  test('未配置时反代回的 404 信封（openviking_not_configured）要变成可识别的错误', async () => {
    let caught: unknown = null;
    try {
      await readProxyStatus(
        jsonResponse({ error: 'openviking_not_configured', message: '这台工作台没有配置 OpenViking。' }, 404),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenVikingError);
    expect((caught as OpenVikingError).notConfigured).toBe(true);
    expect((caught as OpenVikingError).status).toBe(404);
  });

  test('非 JSON 响应要报错而不是崩', async () => {
    let threw = false;
    try {
      await readProxyStatus(new Response('<html>gateway</html>', { status: 200 }));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('★ 防止回归：绝不能再去读 envelope.result', async () => {
    // 如果哪天有人把实现改回 `readEnvelope()`，下面这个"带信封"的形状会通过，
    // 而真实的裸对象会返回 undefined —— 两个断言一起守住。
    const bare = await readProxyStatus(jsonResponse({ enabled: true, upstream: 'u', hasApiKey: true }));
    expect(bare).not.toBeUndefined();
    expect(typeof bare.enabled).toBe('boolean');
  });
});
