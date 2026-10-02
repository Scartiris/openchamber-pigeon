/**
 * 引擎的 HTTP 面（**纯增量**，不改任何既有路由）。
 *
 *   GET /api/engines          → 目录里有哪些引擎 + 当前生效的是谁 + 解析警告
 *   GET /api/engines/active   → 当前引擎的描述符 + **一次真实探测**（ok/版本/耗时）
 *
 * 挂在 `/api/*` 下，因此自动继承既有的 UI 鉴权（未登录 401）——
 * 不要为了实现方便把它挪到免鉴权的命名空间里。
 */

export const registerEngineRoutes = (app, { getSnapshot, probeActive } = {}) => {
  app.get('/api/engines', async (req, res) => {
    try {
      const force = req?.query?.refresh === '1';
      const snapshot = await getSnapshot({ force });
      res.json(snapshot);
    } catch (error) {
      res.status(500).json({ error: error?.message ?? 'Failed to load engine registry' });
    }
  });

  app.get('/api/engines/active', async (req, res) => {
    try {
      const force = req?.query?.refresh === '1';
      const result = await probeActive({ force });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error?.message ?? 'Failed to probe the active engine' });
    }
  });
};
