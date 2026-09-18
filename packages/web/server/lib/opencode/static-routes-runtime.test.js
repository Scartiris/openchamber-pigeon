import { describe, expect, it } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createStaticRoutesRuntime } from './static-routes-runtime.js';

const createRuntime = () => createStaticRoutesRuntime({
  fs: { existsSync: () => false },
  path: { join: (...parts) => parts.join('/'), resolve: (value) => value, sep: '/' },
  process: { env: {} },
  __dirname: '/server',
  express,
  resolveProjectDirectory: () => '',
  buildOpenCodeUrl: () => '',
  getOpenCodeAuthHeaders: () => ({}),
  readSettingsFromDiskMigrated: async () => ({}),
  normalizePwaAppName: (value) => value,
  normalizePwaOrientation: (value) => value,
});

describe('static routes runtime', () => {
  it('returns API-only HTML fallback for browser UI routes', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const response = await request(app).get('/sessions/abc').set('Accept', 'text/html');

    expect(response.status).toBe(200);
    expect(response.text).toContain('OpenChamber 正在以 headless 模式运行');
    expect(response.text).toContain('服务器已就绪。请从 OpenChamber 桌面端或移动端打开后使用。');
    expect(response.text).toContain('openchamber connect-url --help');
    expect(response.text).toContain('复制命令');
  });

  it('returns English API-only HTML when the browser asks for English', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const response = await request(app)
      .get('/sessions/abc')
      .set('Accept', 'text/html')
      .set('Accept-Language', 'en-US,en;q=0.9');

    expect(response.text).toContain('OpenChamber is running in headless mode');
    expect(response.text).toContain('Copy command');
  });

  it('returns API-only info JSON for JSON clients', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const response = await request(app).get('/sessions/abc').set('Accept', 'application/json');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      mode: 'api-only',
      message: 'OpenChamber 正在以 API-only 模式运行',
    });
  });

  it('does not intercept API, auth, or health routes in API-only mode', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const api = await request(app).get('/api/version');
    const auth = await request(app).get('/auth/session');
    const health = await request(app).get('/health');

    expect(api.body).not.toEqual({ ok: true, mode: 'api-only', message: 'OpenChamber 正在以 API-only 模式运行' });
    expect(auth.body).not.toEqual({ ok: true, mode: 'api-only', message: 'OpenChamber 正在以 API-only 模式运行' });
    expect(health.body).not.toEqual({ ok: true, mode: 'api-only', message: 'OpenChamber 正在以 API-only 模式运行' });
  });
});
