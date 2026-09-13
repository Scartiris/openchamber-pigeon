import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import express from 'express';

import {
  OPENVIKING_PREFIX,
  registerOpenVikingRoutes,
  resolveOpenVikingApiKey,
  resolveOpenVikingUrl,
  stripPrefix,
} from './routes.js';

/** 起一个假的 OpenViking，记录收到的请求，按路径回可辨认的内容 */
const startFakeUpstream = async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      cookie: req.headers.cookie ?? null,
      authorization: req.headers.authorization ?? null,
      apiKey: req.headers['x-api-key'] ?? null,
    });
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', healthy: true }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`upstream:${req.url}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, seen, url: `http://127.0.0.1:${port}` };
};

const startProxy = async (options) => {
  const app = express();
  const registration = registerOpenVikingRoutes(app, options);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}`, registration };
};

const silentLogger = { log: () => {}, error: () => {} };

describe('stripPrefix', () => {
  test('剥掉挂载前缀，保留 OpenViking 侧的路径', () => {
    expect(stripPrefix('/api/openviking/api/v1/fs/ls')).toBe('/api/v1/fs/ls');
    expect(stripPrefix('/api/openviking/health')).toBe('/health');
    expect(stripPrefix('/api/openviking/ready')).toBe('/ready');
  });

  test('前缀本身就是根', () => {
    expect(stripPrefix('/api/openviking')).toBe('/');
    expect(stripPrefix('/api/openviking/')).toBe('/');
  });

  test('不像素的路径原样返回（不该发生，但别静默改掉）', () => {
    expect(stripPrefix('/somewhere/else')).toBe('/somewhere/else');
  });

  test('不会把 /api/openvikingX 误判为前缀内', () => {
    expect(stripPrefix('/api/openvikingX/health')).toBe('/api/openvikingX/health');
  });
});

describe('resolveOpenVikingUrl', () => {
  test('没配就是 null —— 整条链路惰性关闭', () => {
    expect(resolveOpenVikingUrl({})).toBeNull();
    expect(resolveOpenVikingUrl({ OPENVIKING_URL: '' })).toBeNull();
    expect(resolveOpenVikingUrl({ OPENVIKING_URL: '   ' })).toBeNull();
  });

  test('去掉结尾斜杠，避免拼出双斜杠 URL', () => {
    expect(resolveOpenVikingUrl({ OPENVIKING_URL: 'http://openviking:1933/' }))
      .toBe('http://openviking:1933');
    expect(resolveOpenVikingUrl({ OPENVIKING_URL: 'http://openviking:1933///' }))
      .toBe('http://openviking:1933');
  });

  test('原样保留正常地址', () => {
    expect(resolveOpenVikingUrl({ OPENVIKING_URL: 'http://openviking:1933' }))
      .toBe('http://openviking:1933');
  });
});

describe('resolveOpenVikingApiKey', () => {
  test('没配 / 空白就是 null', () => {
    expect(resolveOpenVikingApiKey({})).toBeNull();
    expect(resolveOpenVikingApiKey({ OPENVIKING_API_KEY: '' })).toBeNull();
    expect(resolveOpenVikingApiKey({ OPENVIKING_API_KEY: '  ' })).toBeNull();
  });

  test('原样返回（顺带去掉首尾空白）', () => {
    expect(resolveOpenVikingApiKey({ OPENVIKING_API_KEY: ' acct.user.secret ' }))
      .toBe('acct.user.secret');
  });
});

describe('未配置时', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await startProxy({ env: {}, logger: silentLogger });
  });
  afterAll(() => ctx.server.close());

  test('status 如实说没配', async () => {
    const res = await fetch(`${ctx.base}${OPENVIKING_PREFIX}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, upstream: null, hasApiKey: false });
  });

  test('返回注册结果，调用方据此决定要不要提示用户', () => {
    expect(ctx.registration).toEqual({ enabled: false, upstream: null });
  });

  test('★ 整个前缀都被显式堵住，不会落到 SPA 兜底', async () => {
    for (const path of ['/api/v1/fs/ls', '/health', '/api/v1/search/find']) {
      const res = await fetch(`${ctx.base}${OPENVIKING_PREFIX}${path}`);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('openviking_not_configured');
    }
  });
});

describe('只有地址没有 key 时也算未配置', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await startProxy({
      env: { OPENVIKING_URL: 'http://openviking:1933' },
      logger: silentLogger,
    });
  });
  afterAll(() => ctx.server.close());

  test('★ 半配置不放行 —— 否则每个请求都会以 OpenViking 的 401 浮上来', async () => {
    expect(ctx.registration.enabled).toBe(false);
    const res = await fetch(`${ctx.base}${OPENVIKING_PREFIX}/status`);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(body.upstream).toBe('http://openviking:1933');
    expect(body.hasApiKey).toBe(false);
  });
});

describe('配置了上游时', () => {
  const KEY = 'pigeon.pcadmin.super-secret';
  let upstream;
  let ctx;
  beforeAll(async () => {
    upstream = await startFakeUpstream();
    ctx = await startProxy({
      env: { OPENVIKING_URL: upstream.url, OPENVIKING_API_KEY: KEY },
      logger: silentLogger,
    });
  });
  afterAll(() => {
    ctx.server.close();
    upstream.server.close();
  });

  test('status 报出上游地址与"有 key"，但不回显 key', async () => {
    const res = await fetch(`${ctx.base}${OPENVIKING_PREFIX}/status`);
    const body = await res.json();
    expect(body).toEqual({ enabled: true, upstream: upstream.url, hasApiKey: true });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  test('★ 前缀被剥掉后才转发（这是最容易写错的一处）', async () => {
    upstream.seen.length = 0;
    const res = await fetch(`${ctx.base}${OPENVIKING_PREFIX}/api/v1/fs/ls?uri=viking%3A%2F%2F`);
    expect(await res.text()).toBe('upstream:/api/v1/fs/ls?uri=viking%3A%2F%2F');
    expect(upstream.seen[0].url).toBe('/api/v1/fs/ls?uri=viking%3A%2F%2F');
  });

  test('★ 查询串原样带过去（含中文与 viking:// 编码）', async () => {
    upstream.seen.length = 0;
    await fetch(`${ctx.base}${OPENVIKING_PREFIX}/api/v1/content/read?uri=viking%3A%2F%2Fuser%2Fpcadmin%2Fmemories%2Fprofile.md`);
    expect(upstream.seen[0].url)
      .toBe('/api/v1/content/read?uri=viking%3A%2F%2Fuser%2Fpcadmin%2Fmemories%2Fprofile.md');
  });

  test('★ 服务器注入 x-api-key —— 浏览器自己不必也不该带', async () => {
    upstream.seen.length = 0;
    await fetch(`${ctx.base}${OPENVIKING_PREFIX}/health`);
    expect(upstream.seen[0].apiKey).toBe(KEY);
  });

  test('★ 浏览器自带凭据会被剥掉，不能冒用别的身份', async () => {
    upstream.seen.length = 0;
    await fetch(`${ctx.base}${OPENVIKING_PREFIX}/health`, {
      headers: {
        cookie: 'openchamber_session=secret',
        authorization: 'Bearer attacker-token',
        'x-api-key': 'attacker-key',
      },
    });
    expect(upstream.seen[0].cookie).toBeNull();
    expect(upstream.seen[0].authorization).toBeNull();
    // 仍然是被服务器改写过的那个 key，而不是调用方塞进来的
    expect(upstream.seen[0].apiKey).toBe(KEY);
  });

  test('POST 与中文 JSON 请求体也能过', async () => {
    upstream.seen.length = 0;
    const res = await fetch(`${ctx.base}${OPENVIKING_PREFIX}/api/v1/search/find`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '端到端写入探针', limit: 5 }),
    });
    expect(res.status).toBe(200);
    expect(upstream.seen[0].method).toBe('POST');
    expect(upstream.seen[0].url).toBe('/api/v1/search/find');
  });

  test('DELETE 也能过（浏览页以后要支持删）', async () => {
    upstream.seen.length = 0;
    await fetch(`${ctx.base}${OPENVIKING_PREFIX}/api/v1/fs?uri=viking%3A%2F%2Fresources%2Fprobe`, {
      method: 'DELETE',
    });
    expect(upstream.seen[0].method).toBe('DELETE');
    expect(upstream.seen[0].url).toBe('/api/v1/fs?uri=viking%3A%2F%2Fresources%2Fprobe');
  });
});

describe('上游连不上时', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await startProxy({
      env: { OPENVIKING_URL: 'http://127.0.0.1:1', OPENVIKING_API_KEY: 'k' },
      logger: silentLogger,
      timeoutMs: 1_000,
    });
  });
  afterAll(() => ctx.server.close());

  test('★ 回 502 且说明是人话，而不是挂死到超时', async () => {
    const res = await fetch(`${ctx.base}${OPENVIKING_PREFIX}/health`);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('openviking_unreachable');
    expect(body.message).toContain('OpenViking');
  });

  test('status 仍然可用 —— 界面靠它区分「没配」和「配了连不上」', async () => {
    const res = await fetch(`${ctx.base}${OPENVIKING_PREFIX}/status`);
    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toBe(true);
  });
});
