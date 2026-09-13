import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import express from 'express';

import {
  PIGEON_BRAIN_PREFIX,
  registerPigeonBrainRoutes,
  resolveBrainUrl,
  stripPrefix,
} from './routes.js';

/** 起一个假的 brain，记录收到的请求，按路径回可辨认的内容 */
const startFakeBrain = async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      cookie: req.headers.cookie ?? null,
      authorization: req.headers.authorization ?? null,
    });
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`upstream:${req.url}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, seen, url: `http://127.0.0.1:${port}` };
};

/** 起一个挂了反代的 Express（Express 5），返回 base url */
const startProxy = async (options) => {
  const app = express();
  const registration = registerPigeonBrainRoutes(app, options);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}`, registration };
};

const silentLogger = { log: () => {}, error: () => {} };

describe('stripPrefix', () => {
  test('剥掉挂载前缀，保留 brain 侧的路径', () => {
    expect(stripPrefix('/api/pigeon-brain/ui/app.js')).toBe('/ui/app.js');
    expect(stripPrefix('/api/pigeon-brain/v1/memories')).toBe('/v1/memories');
    expect(stripPrefix('/api/pigeon-brain/health')).toBe('/health');
  });

  test('前缀本身就是根', () => {
    expect(stripPrefix('/api/pigeon-brain')).toBe('/');
    expect(stripPrefix('/api/pigeon-brain/')).toBe('/');
  });

  test('不像素的路径原样返回（不该发生，但别静默改掉）', () => {
    expect(stripPrefix('/somewhere/else')).toBe('/somewhere/else');
  });
});

describe('resolveBrainUrl', () => {
  test('没配就是 null —— 整条链路惰性关闭', () => {
    expect(resolveBrainUrl({})).toBeNull();
    expect(resolveBrainUrl({ PIGEON_BRAIN_URL: '' })).toBeNull();
    expect(resolveBrainUrl({ PIGEON_BRAIN_URL: '   ' })).toBeNull();
  });

  test('去掉结尾斜杠，避免拼出双斜杠 URL', () => {
    expect(resolveBrainUrl({ PIGEON_BRAIN_URL: 'http://brain:3210/' })).toBe('http://brain:3210');
    expect(resolveBrainUrl({ PIGEON_BRAIN_URL: 'http://brain:3210///' })).toBe('http://brain:3210');
  });

  test('原样保留正常地址', () => {
    expect(resolveBrainUrl({ PIGEON_BRAIN_URL: 'http://brain:3210' })).toBe('http://brain:3210');
  });
});

describe('未配置时', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await startProxy({ env: {}, logger: silentLogger });
  });
  afterAll(() => ctx.server.close());

  test('status 如实说没配', async () => {
    const res = await fetch(`${ctx.base}${PIGEON_BRAIN_PREFIX}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, upstream: null });
  });

  test('返回注册结果，调用方据此决定要不要提示用户', () => {
    expect(ctx.registration).toEqual({ enabled: false, upstream: null });
  });

  test('其它路径不被吞掉（没有挂代理）', async () => {
    const res = await fetch(`${ctx.base}${PIGEON_BRAIN_PREFIX}/ui/app.js`);
    expect(res.status).toBe(404);
  });
});

describe('配置了上游时', () => {
  let brain;
  let ctx;
  beforeAll(async () => {
    brain = await startFakeBrain();
    ctx = await startProxy({
      env: { PIGEON_BRAIN_URL: brain.url },
      logger: silentLogger,
    });
  });
  afterAll(() => {
    ctx.server.close();
    brain.server.close();
  });

  test('status 报出上游地址', async () => {
    const res = await fetch(`${ctx.base}${PIGEON_BRAIN_PREFIX}/status`);
    expect(await res.json()).toEqual({ enabled: true, upstream: brain.url });
  });

  test('★ 前缀被剥掉后才转发（这是最容易写错的一处）', async () => {
    brain.seen.length = 0;
    const res = await fetch(`${ctx.base}${PIGEON_BRAIN_PREFIX}/ui/app.js`);
    expect(await res.text()).toBe('upstream:/ui/app.js');
    expect(brain.seen[0].url).toBe('/ui/app.js');
  });

  test('★ 查询串原样带过去', async () => {
    brain.seen.length = 0;
    await fetch(`${ctx.base}${PIGEON_BRAIN_PREFIX}/v1/wiki/pages?q=%E5%AF%BC%E5%87%BA&limit=10`);
    expect(brain.seen[0].url).toBe('/v1/wiki/pages?q=%E5%AF%BC%E5%87%BA&limit=10');
  });

  test('UI 的三种资源路径都能过', async () => {
    for (const path of ['/ui/', '/app.js', '/style.css', '/ui/style.css', '/health']) {
      const res = await fetch(`${ctx.base}${PIGEON_BRAIN_PREFIX}${path}`);
      expect(res.status).toBe(200);
    }
  });

  test('★ 不把 OpenChamber 的会话 cookie 转给 brain', async () => {
    brain.seen.length = 0;
    await fetch(`${ctx.base}${PIGEON_BRAIN_PREFIX}/health`, {
      headers: { cookie: 'openchamber_session=secret' },
    });
    expect(brain.seen[0].cookie).toBeNull();
  });

  test('★ 但 authorization 要转发（brain 开鉴权时界面靠它）', async () => {
    brain.seen.length = 0;
    await fetch(`${ctx.base}${PIGEON_BRAIN_PREFIX}/health`, {
      headers: { authorization: 'Bearer brain-token' },
    });
    expect(brain.seen[0].authorization).toBe('Bearer brain-token');
  });

  test('POST 与请求体也能过', async () => {
    brain.seen.length = 0;
    await fetch(`${ctx.base}${PIGEON_BRAIN_PREFIX}/v1/memories/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '测试' }),
    });
    expect(brain.seen[0].method).toBe('POST');
    expect(brain.seen[0].url).toBe('/v1/memories/search');
  });
});

describe('上游连不上时', () => {
  let ctx;
  beforeAll(async () => {
    // 指向一个没人监听的端口
    ctx = await startProxy({
      env: { PIGEON_BRAIN_URL: 'http://127.0.0.1:1' },
      logger: silentLogger,
      timeoutMs: 1_000,
    });
  });
  afterAll(() => ctx.server.close());

  test('★ 回 502 且说明是人话，而不是挂死到超时', async () => {
    const res = await fetch(`${ctx.base}${PIGEON_BRAIN_PREFIX}/health`);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('pigeon_brain_unreachable');
    expect(body.message).toContain('pigeon-brain');
  });

  test('status 仍然可用 —— 界面靠它区分「没配」和「配了连不上」', async () => {
    const res = await fetch(`${ctx.base}${PIGEON_BRAIN_PREFIX}/status`);
    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toBe(true);
  });
});
