import { createProxyMiddleware } from 'http-proxy-middleware';
import { serverMessage } from '../server-html/page-copy.js';

/**
 * pigeon-brain 的同源反代。
 *
 * ## 为什么必须反代，而不能让浏览器直连
 *
 * brain 只绑在服务器的 `127.0.0.1` 与 docker 网络里（这是刻意的，见它自己的
 * ADR-0002：Docker 发布端口会绕过 ufw，发布 `0.0.0.0` 等于直接暴露到公网）。
 * 而 OpenChamber 的浏览器面板跑在**用户自己的浏览器**里 —— 源码原话：
 * "The browser lives in a renderer, not in the server process"。
 * 所以浏览器够不到 `brain:3210`。
 *
 * 唯一的办法是**由 OpenChamber 服务器去取、同源发给浏览器**。好处：
 * 不新增端口、不新增公网暴露面、没有 CORS、也不需要把 brain 暴露出去。
 *
 * ## 挂载点
 *
 *   /api/pigeon-brain/ui/**    → brain /ui/**
 *   /api/pigeon-brain/v1/**    → brain /v1/**
 *   /api/pigeon-brain/health   → brain /health
 *   /api/pigeon-brain/status   → 本模块自己实现（不转发）
 *
 * brain 的界面用**相对路径**引用资源、并从自己的 script 地址推导 API 基数，
 * 所以同一份产物在 `http://brain:3210/` 与 `/api/pigeon-brain/` 下都能用。
 *
 * ## 惰性
 *
 * `PIGEON_BRAIN_URL` 没配就**整条链路不挂** —— 上游/桌面端行为完全不变。
 * 设置侧栏不再挂「记忆库」；配置后由 pigeon-brain guest 面板从 rail 进入。
 * 这与 doc-preview 的做法一致。
 */

/** 反代挂载前缀。改这里要同步改 UI 里 iframe 的 src。 */
export const PIGEON_BRAIN_PREFIX = '/api/pigeon-brain';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 不转发到上游的请求头。
 *
 * `cookie` 是 OpenChamber 自己的会话凭据，没有理由交给另一个服务 ——
 * brain 也不认它。`authorization` **要转发**：brain 开了鉴权时，
 * 界面会把 token 放在这里。
 */
const STRIPPED_REQUEST_HEADERS = Object.freeze(['cookie']);

const isUnderPrefix = (path) =>
  path === PIGEON_BRAIN_PREFIX || path.startsWith(`${PIGEON_BRAIN_PREFIX}/`);

/**
 * 把挂载前缀剥掉，得到 brain 侧的路径。
 *
 * 显式重写而不是依赖 Express 的挂载行为：`app.use(prefix, mw)` 会改 `req.url`，
 * 而 `app.use(mw)` + `pathFilter` 不会 —— 两种写法只差一个参数，
 * 却决定转发出去的路径对不对。显式写出来就不用记这个区别了。
 */
export const stripPrefix = (path) => {
  if (path === PIGEON_BRAIN_PREFIX) return '/';
  if (path.startsWith(`${PIGEON_BRAIN_PREFIX}/`)) {
    return path.slice(PIGEON_BRAIN_PREFIX.length) || '/';
  }
  return path;
};

export const resolveBrainUrl = (env = process.env) => {
  const raw = typeof env?.PIGEON_BRAIN_URL === 'string' ? env.PIGEON_BRAIN_URL.trim() : '';
  if (!raw) return null;
  // 去掉结尾斜杠，避免拼出 `http://brain:3210//v1/...` 这种双斜杠目标
  return raw.replace(/\/+$/, '');
};

export function registerPigeonBrainRoutes(app, options = {}) {
  const {
    env = process.env,
    logger = console,
    prefix = PIGEON_BRAIN_PREFIX,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const brainUrl = options.brainUrl ?? resolveBrainUrl(env);

  // 状态查询**永远可用**：界面靠它区分"没配"和"配了但连不上"，
  // 这两种情况给用户的提示完全不同。
  app.get(`${prefix}/status`, (_req, res) => {
    res.json({ enabled: Boolean(brainUrl), upstream: brainUrl });
  });

  if (!brainUrl) {
    // 未配置时**显式堵住整个前缀**，而不是让它落到 SPA 兜底。
    //
    // 实测过：不堵的话 `/api/pigeon-brain/ui/` 会命中静态资源的兜底路由、
    // 返回工作台自己的 index.html（HTTP 200）—— 于是 iframe 会**把工作台嵌进它自己**，
    // 表现为一个诡异的递归空白框。前端虽然会先查 status 不渲染 iframe，
    // 但这层不该指望调用方自觉。
    app.use(prefix, (req, res) => {
      res.status(404).json({
        error: 'pigeon_brain_not_configured',
        message: serverMessage(req, 'server.pigeonBrain.notConfigured'),
      });
    });
    return { enabled: false, upstream: null };
  }

  const proxy = createProxyMiddleware({
    target: brainUrl,
    changeOrigin: true,
    ws: false,
    // 用 pathFilter + 显式 pathRewrite，而不是 app.use(prefix, proxy)：
    // 后者依赖 Express 剥不剥 req.url 这个容易记错的细节。
    pathFilter: isUnderPrefix,
    pathRewrite: stripPrefix,
    proxyTimeout: timeoutMs,
    timeout: timeoutMs,
    on: {
      proxyReq: (proxyReq) => {
        for (const header of STRIPPED_REQUEST_HEADERS) {
          proxyReq.removeHeader(header);
        }
      },
      error: (error, req, res) => {
        logger.error(
          `[pigeon-brain] 反代失败 ${req?.method ?? '?'} ${req?.url ?? '?'} → ${brainUrl}: ${error?.message ?? error}`,
        );
        if (res && !res.headersSent && typeof res.writeHead === 'function') {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              error: 'pigeon_brain_unreachable',
              message: serverMessage(req, 'server.pigeonBrain.unreachable', { url: brainUrl }),
            }),
          );
        }
      },
    },
  });

  app.use(proxy);
  logger.log?.(`[pigeon-brain] 反代已挂载：${prefix}/** → ${brainUrl}`);
  return { enabled: true, upstream: brainUrl, prefix };
}
