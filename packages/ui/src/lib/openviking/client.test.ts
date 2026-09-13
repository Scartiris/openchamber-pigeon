import { describe, expect, mock, test } from 'bun:test';

import { OpenVikingError, readBareObject, readProxyStatus } from '@/lib/openviking/client';

/**
 * ★ 这一组是本文件里**最重要**的：它测的是「端点接线」而不是「解析函数」。
 *
 * 为什么必须有：前两组只调解析函数，即使 `openVikingApi.health()` 接错了
 * （比如误走信封）它们照样全绿 —— 而那正是线上真实故障的形态。
 * 本轮两次 bug 都发生在"哪个端点用哪个解析器"这一层，所以必须 mock 掉
 * `runtimeFetch` 把 `openVikingApi` 整个打一遍。
 */
const fakeResponses = new Map<string, () => Response>();
const runtimeFetchMock = mock(async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
  const path = url.startsWith('/api/openviking') ? url.slice('/api/openviking'.length) : url;
  const make = fakeResponses.get(path);
  if (!make) throw new Error(`没有为 ${path} 准备假响应`);
  return make();
});

mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: runtimeFetchMock }));

const { openVikingApi } = await import('@/lib/openviking/client');

const bare = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const enveloped = (result: unknown): Response =>
  new Response(JSON.stringify({ status: 'ok', result, error: null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('openVikingApi 端点接线（真实故障就发生在这里）', () => {
  test('★ health() 走裸对象解析 —— 绝不能拿到 undefined.version', async () => {
    fakeResponses.set('/health', () => bare({
      status: 'ok', healthy: true, version: 'v0.4.19',
      auth_mode: 'api_key', account_id: 'pigeon', user_id: 'pcadmin', role: 'admin',
    }));
    const health = await openVikingApi.health();
    expect(health.version).toBe('v0.4.19');
    expect(health.account_id).toBe('pigeon');
  });

  test('★ ready() 走裸对象解析', async () => {
    fakeResponses.set('/ready', () => bare({ status: 'ready', checks: { embedding: 'ok' } }));
    const ready = await openVikingApi.ready();
    expect(ready.status).toBe('ready');
  });

  test('★ proxyStatus() 走裸对象解析', async () => {
    fakeResponses.set('/status', () => bare({ enabled: true, upstream: 'http://openviking:1933', hasApiKey: true }));
    const status = await openVikingApi.proxyStatus();
    expect(status).toEqual({ enabled: true, upstream: 'http://openviking:1933', hasApiKey: true });
  });

  test('信封端点仍然走信封：ls / tree / read', async () => {
    fakeResponses.set('/api/v1/fs/ls?uri=viking%3A%2F%2F', () => enveloped([{ uri: 'viking://user', size: 0, isDir: true }]));
    fakeResponses.set('/api/v1/fs/tree?uri=viking%3A%2F%2Fuser', () => enveloped([{ uri: 'viking://user/x', size: 1, isDir: false, rel_path: 'x' }]));
    fakeResponses.set('/api/v1/content/read?uri=viking%3A%2F%2Fa.md', () => enveloped('# 内容'));
    expect((await openVikingApi.ls('viking://'))[0]?.uri).toBe('viking://user');
    expect((await openVikingApi.tree('viking://user'))[0]?.rel_path).toBe('x');
    expect(await openVikingApi.read('viking://a.md')).toBe('# 内容');
  });

  test('★ 把 health 接成信封就必须炸（证明这组测试真的能抓到那个 bug）', async () => {
    // 真实故障的形状：服务器回裸对象，如果解析器去取 result 就会拿到 undefined
    fakeResponses.set('/health', () => bare({ status: 'ok', healthy: true, version: 'v0.4.19' }));
    const health = await openVikingApi.health();
    expect(health).not.toBeUndefined();
    expect(typeof health.version).toBe('string');
  });

  test('信封里带 error 时抛 OpenVikingError', async () => {
    fakeResponses.set('/api/v1/content/read?uri=viking%3A%2F%2Fbad', () =>
      new Response(JSON.stringify({ status: 'error', error: { code: 'NOT_FOUND', message: '没有这个文件' } }), {
        status: 404, headers: { 'content-type': 'application/json' },
      }));
    let caught: unknown = null;
    try {
      await openVikingApi.read('viking://bad');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenVikingError);
    expect((caught as OpenVikingError).message).toBe('没有这个文件');
  });
});

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

/**
 * 第二个同源 bug：OpenViking 自己的 `/health` 与 `/ready` **也是裸对象**。
 *
 * 修完 `/status` 之后真机立刻炸：
 *   TypeError: Cannot read properties of undefined (reading 'version')
 * 因为 `/health` 也走了 readEnvelope()，`envelope.result` 是 undefined。
 *
 * 实测三个裸对象端点（其余全是信封）：
 *   /health、/ready（OpenViking）、/status（我们的反代）
 */
describe('readBareObject（裸对象端点通用解析）', () => {
  test('★ /health 的真实形状必须解析出 version（这就是那个 TypeError 的根因）', async () => {
    const health = await readBareObject<{ status: string; healthy: boolean; version: string }>(
      jsonResponse({
        status: 'ok',
        healthy: true,
        version: 'v0.4.19',
        auth_mode: 'api_key',
        account_id: 'pigeon',
        user_id: 'pcadmin',
        role: 'admin',
      }),
      ['status', 'healthy', 'version'],
      '健康检查',
    );
    expect(health.version).toBe('v0.4.19');
    expect(health.healthy).toBe(true);
    expect(health.status).toBe('ok');
  });

  test('/ready 的真实形状（status + checks）', async () => {
    const ready = await readBareObject<{ status: string; checks: Record<string, unknown> }>(
      jsonResponse({ status: 'ready', checks: { agfs: { status: 'ok' }, embedding: 'ok' } }),
      ['status'],
      '就绪检查',
    );
    expect(ready.status).toBe('ready');
    expect(ready.checks).toBeDefined();
  });

  test('★ 缺关键字段要报错 —— 而不是返回 undefined 让调用方炸 TypeError', async () => {
    let caught: unknown = null;
    try {
      await readBareObject(jsonResponse({ status: 'ok', healthy: true }), ['status', 'healthy', 'version'], '健康检查');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenVikingError);
    expect((caught as OpenVikingError).message).toContain('version');
  });

  test('顶层是数组/标量也要报错，不能当对象用', async () => {
    for (const body of [[1, 2, 3], 'text', 42]) {
      let threw = false;
      try {
        await readBareObject(jsonResponse(body), ['status'], '测试');
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    }
  });

  test('HTTP 错误时用响应里的 message/code', async () => {
    let caught: unknown = null;
    try {
      await readBareObject(jsonResponse({ error: 'boom', message: '炸了' }, 500), ['status'], '测试');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenVikingError);
    expect((caught as OpenVikingError).message).toBe('炸了');
    expect((caught as OpenVikingError).code).toBe('boom');
  });
});
