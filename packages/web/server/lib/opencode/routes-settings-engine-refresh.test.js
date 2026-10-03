import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';

/**
 * `PUT /api/config/settings` 写完之后要**同步刷一次「当前引擎」快照**。
 *
 * 为什么值得钉住：代理目标读的是**缓存**里的引擎快照（stale-while-revalidate，10s）。
 * 不刷的话，改了 `engine` 之后**头几个请求还会发给上一个引擎** —— 2026-10-03 的
 * 路由验收就是被这一条卡住的：PUT 返回 200、`/health` 已经报新引擎，
 * 但 `/api/session` 还返回旧引擎的会话。
 * 刷过之后语义变成"**PUT 返回时切换已经生效**"。
 */

const createApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  const dependencies = {
    readSettingsFromDisk: vi.fn(async () => ({})),
    sanitizeProjects: (projects) => projects,
    persistSettings: vi.fn(async (settings) => settings),
    refreshEnginesAfterSettingsWrite: vi.fn(async () => {}),
    ...overrides,
  };
  registerOpenCodeRoutes(app, dependencies);
  return { app, dependencies };
};

describe('PUT /api/config/settings → 刷新引擎快照', () => {
  it('写成功后调用刷新（这样"切引擎"在 PUT 返回时就生效）', async () => {
    const { app, dependencies } = createApp();
    const response = await request(app).put('/api/config/settings').send({ engine: 'codex' });

    expect(response.status).toBe(200);
    expect(dependencies.refreshEnginesAfterSettingsWrite).toHaveBeenCalledTimes(1);
  });

  it('没注入刷新钩子也能正常保存（默认 noop，不破坏既有调用方）', async () => {
    const { app } = createApp({ refreshEnginesAfterSettingsWrite: undefined });
    const response = await request(app).put('/api/config/settings').send({ engine: 'codex' });
    expect(response.status).toBe(200);
  });

  it('刷新失败**不影响保存结果**（设置已经落盘了，不该因此回 500）', async () => {
    const { app, dependencies } = createApp({
      refreshEnginesAfterSettingsWrite: vi.fn(async () => { throw new Error('注册表读挂了'); }),
    });
    const response = await request(app).put('/api/config/settings').send({ engine: 'codex' });

    expect(response.status).toBe(200);
    expect(dependencies.persistSettings).toHaveBeenCalledTimes(1);
  });

  it('保存失败时不刷新（没改成，就别动快照）', async () => {
    const { app, dependencies } = createApp({
      persistSettings: vi.fn(async () => { throw new Error('落盘失败'); }),
    });
    const response = await request(app).put('/api/config/settings').send({ engine: 'codex' });

    expect(response.status).toBe(500);
    expect(dependencies.refreshEnginesAfterSettingsWrite).not.toHaveBeenCalled();
  });
});
