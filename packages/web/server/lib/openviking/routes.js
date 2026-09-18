import { createProxyMiddleware } from 'http-proxy-middleware';
import { serverMessage } from '../server-html/page-copy.js';

/**
 * OpenViking 的同源反代。
 *
 * ## 为什么必须反代，而不能让浏览器直连
 *
 * openviking 只绑在服务器的 `127.0.0.1:1933` 与 docker 网络里（刻意的：
 * 记忆/知识库里是用户的私有内容，不该有公网端口）。而 OpenChamber 的浏览器面板
 * 跑在**用户自己的浏览器**里 —— 浏览器够不到 `openviking:1933`。
 *
 * 唯一的办法是**由 OpenChamber 服务器去取、同源发给浏览器**。好处：
 * 不新增端口、不新增公网暴露面、没有 CORS、不需要把 OpenViking 暴露出去，
 * 而且这条链路的信任边界就是工作台自己的登录 —— 挂在 `/api` 下，
 * 与其它路由受同一道 UI 鉴权。
 *
 * ## 挂载点
 *
 *   /api/openviking/api/v1/**   → openviking /api/v1/**
 *   /api/openviking/health      → openviking /health
 *   /api/openviking/ready       → openviking /ready
 *   /api/openviking/status      → 本模块自己实现（不转发）
 *
 * ## 鉴权：服务器侧注入，浏览器永远拿不到 key
 *
 * OpenViking 的 ROOT key **不能**访问数据 API（实测会 403：
 * `ROOT API keys cannot access tenant-scoped data APIs in api_key mode`），
 * 必须用**账户下的 user key**。这个 key 只存在于服务器环境变量
 * `OPENVIKING_API_KEY` 里，由本模块在转发时注入 `x-api-key` ——
 * 浏览器既不发送也不接收它。
 *
 * 顺带把浏览器可能带来的鉴权头**剥掉**，避免调用方塞一个别的 key 进来
 * 覆盖服务器注入的那个。
 *
 * ## 惰性
 *
 * `OPENVIKING_URL` 没配就**整条链路不挂** —— 上游/桌面端行为完全不变，
 * 设置页那一栏显示"未配置"而不是报错。与 pigeon-brain / doc-preview 一致。
 */

/** 反代挂载前缀。改这里要同步改 UI 里的请求基数。 */
export const OPENVIKING_PREFIX = '/api/openviking';

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 不转发到上游的请求头。
 *
 * - `cookie`：OpenChamber 自己的会话凭据，没有理由交给另一个服务。
 * - `x-api-key` / `authorization`：**浏览器不许自带凭据**。OpenViking 的 key
 *   由服务器注入（见上），放行调用方提供的值等于让前端能冒用任意身份。
 */
const STRIPPED_REQUEST_HEADERS = Object.freeze(['cookie', 'x-api-key', 'authorization']);

const isUnderPrefix = (path) =>
  path === OPENVIKING_PREFIX || path.startsWith(`${OPENVIKING_PREFIX}/`);

/**
 * 把挂载前缀剥掉，得到 OpenViking 侧的路径。
 *
 * 显式重写而不是依赖 Express 的挂载行为：`app.use(prefix, mw)` 会改 `req.url`，
 * 而 `app.use(mw)` + `pathFilter` 不会 —— 两种写法只差一个参数，
 * 却决定转发出去的路径对不对。
 */
export const stripPrefix = (path) => {
  if (path === OPENVIKING_PREFIX) return '/';
  if (path.startsWith(`${OPENVIKING_PREFIX}/`)) {
    return path.slice(OPENVIKING_PREFIX.length) || '/';
  }
  return path;
};

export const resolveOpenVikingUrl = (env = process.env) => {
  const raw = typeof env?.OPENVIKING_URL === 'string' ? env.OPENVIKING_URL.trim() : '';
  if (!raw) return null;
  // 去掉结尾斜杠，避免拼出 `http://openviking:1933//api/v1/...` 这种双斜杠目标
  return raw.replace(/\/+$/, '');
};

export const resolveOpenVikingApiKey = (env = process.env) => {
  const raw = typeof env?.OPENVIKING_API_KEY === 'string' ? env.OPENVIKING_API_KEY.trim() : '';
  return raw || null;
};

/**
 * 配了地址但没配 key 时，请求必然 401。与其让它以 OpenViking 的原始报错浮上来，
 * 不如在挂载时就判定为"没配好"，整条链路惰性关闭 —— 界面提示也更准确。
 */
const isConfigured = (upstream, apiKey) => Boolean(upstream) && Boolean(apiKey);

export function registerOpenVikingRoutes(app, options = {}) {
  const {
    env = process.env,
    logger = console,
    prefix = OPENVIKING_PREFIX,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const upstream = options.upstream ?? resolveOpenVikingUrl(env);
  const apiKey = options.apiKey ?? resolveOpenVikingApiKey(env);
  const enabled = isConfigured(upstream, apiKey);

  // 状态查询**永远可用**：界面靠它区分"没配"和"配了但连不上"，
  // 这两种情况给用户的提示完全不同。
  app.get(`${prefix}/status`, (_req, res) => {
    res.json({
      enabled,
      upstream,
      // 只说有没有 key，绝不回显 key 本身
      hasApiKey: Boolean(apiKey),
    });
  });

  if (!enabled) {
    // 未配置时**显式堵住整个前缀**，而不是让它落到 SPA 兜底。
    //
    // 与 pigeon-brain 同一个坑：不堵的话 `/api/openviking/` 会命中静态资源的
    // 兜底路由、返回工作台自己的 index.html（HTTP 200）。
    app.use(prefix, (req, res) => {
      res.status(404).json({
        error: 'openviking_not_configured',
        message: serverMessage(req, 'server.openviking.notConfigured'),
      });
    });
    return { enabled: false, upstream: null };
  }

  const proxy = createProxyMiddleware({
    target: upstream,
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
        proxyReq.setHeader('x-api-key', apiKey);
      },
      error: (error, req, res) => {
        logger.error(
          `[openviking] 反代失败 ${req?.method ?? '?'} ${req?.url ?? '?'} → ${upstream}: ${error?.message ?? error}`,
        );
        if (res && !res.headersSent && typeof res.writeHead === 'function') {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              error: 'openviking_unreachable',
              message: serverMessage(req, 'server.openviking.unreachable', { upstream }),
            }),
          );
        }
      },
    },
  });

  app.use(proxy);
  logger.log?.(`[openviking] 反代已挂载：${prefix}/** → ${upstream}`);
  return { enabled: true, upstream, prefix };
}
