import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * OpenViking 的浏览器侧客户端。
 *
 * ## 为什么所有请求都走 `/api/openviking`
 *
 * OpenViking 只绑在服务器的 `127.0.0.1:1933` 与 docker 网络里，浏览器够不到它。
 * 工作台服务器做同源反代（`packages/web/server/lib/openviking/routes.js`），
 * 并在服务器侧注入 `x-api-key` —— 所以这里**不碰任何凭据**，
 * 浏览器既不持有也不发送 OpenViking 的 key。
 */

export const OPENVIKING_PREFIX = '/api/openviking';

/** 未配置时反代会回 404 且 body 带这个 error 码，界面据此给"未配置"提示 */
const NOT_CONFIGURED_ERROR = 'openviking_not_configured';

export class OpenVikingError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly notConfigured: boolean;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'OpenVikingError';
    this.status = status;
    this.code = code;
    this.notConfigured = code === NOT_CONFIGURED_ERROR;
  }
}

export interface OpenVikingStatus {
  enabled: boolean;
  upstream: string | null;
  hasApiKey: boolean;
}

/** OpenViking 的响应信封：`{ status, result, error, telemetry, profile }` */
interface Envelope<T> {
  status?: string;
  result?: T;
  error?: { code?: string; message?: string } | null;
}

const readEnvelope = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON（网关错误页之类）—— 原样当消息用，别假装能解析
    if (!response.ok) {
      throw new OpenVikingError(text.slice(0, 200) || `HTTP ${response.status}`, response.status, null);
    }
    throw new OpenVikingError('OpenViking 返回了无法解析的响应', response.status, null);
  }

  const envelope = (payload ?? {}) as Envelope<T> & { error?: unknown; message?: unknown };

  if (!response.ok) {
    const errorObject = (envelope.error ?? null) as { code?: string; message?: string } | null;
    const code = typeof errorObject?.code === 'string' ? errorObject.code : null;
    const message =
      (typeof errorObject?.message === 'string' && errorObject.message)
      || (typeof envelope.message === 'string' && envelope.message)
      || `HTTP ${response.status}`;
    throw new OpenVikingError(message, response.status, code);
  }

  // 信封里 status === 'error' 但 HTTP 200 的情况也要当失败处理
  if (envelope.status === 'error') {
    const errorObject = (envelope.error ?? null) as { code?: string; message?: string } | null;
    throw new OpenVikingError(
      errorObject?.message || 'OpenViking 返回了错误',
      response.status,
      typeof errorObject?.code === 'string' ? errorObject.code : null,
    );
  }

  return envelope.result as T;
};

/**
 * 请求超时。
 *
 * OpenViking 的读接口在**服务器侧**实测是 5~15ms（uvicorn 访问日志 `duration_ms=4~8`），
 * 但**浏览器侧**要经过工作台的同源反代 + 用户所在链路：实测经一条慢隧道时，
 * 同一个 154B 的响应可以在 0.7s 到 36s 之间浮动。所以超时必须按"端到端最坏情况"给，
 * 而不是按服务器处理时间给 —— 给 20s 会把**只是慢**的读判成失败
 * （实机截图抓到过：identity.md 被 20s 超时打断，界面显示"读取这个条目失败"）。
 *
 * 这里取 90s：足够覆盖慢链路，又能在真的挂死时给出明确的错误
 * （没有超时会永久停在"加载中…"，那才是最初那个更糟的表现）。
 */
const REQUEST_TIMEOUT_MS = 90_000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await runtimeFetch(`${OPENVIKING_PREFIX}${path}`, {
      ...init,
      signal: controller.signal,
    });
    return await readEnvelope<T>(response);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new OpenVikingError('OpenViking 请求超时', 0, 'TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 与 `request` 相同，但走 `readBareObject`（裸对象端点用） */
async function requestBare<T extends object>(
  path: string,
  requireKeys: readonly string[],
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await runtimeFetch(`${OPENVIKING_PREFIX}${path}`, {
      signal: controller.signal,
    });
    return await readBareObject<T>(response, requireKeys, label);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new OpenVikingError(`${label}超时`, 0, 'TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 反代状态。**注意这个端点没有 OpenViking 的信封**。
 *
 * `/api/openviking/status` 是**我们自己的反代模块**实现的（不转发到 OpenViking），
 * 它直接返回 `{ enabled, upstream, hasApiKey }` —— 没有 `{ status, result, error }` 外壳。
 * 早期版本这里走了统一的 `readEnvelope()`，于是永远取到 `envelope.result === undefined`，
 * 表现是**两个设置页永远停在「加载中…」**（真机截图抓到：`/status` 回了 200 两次，
 * 但页面一直不进入已就绪分支，`/health` 与 `/ready` 压根没发）。
 *
 * 所以这里必须显式判形状，而不是套信封。
 *
 * 导出是为了能直接对它写回归测试（这个 bug 靠"测 store 逻辑"是抓不到的）。
 */
export const readProxyStatus = async (response: Response): Promise<OpenVikingStatus> => {
  const raw = await readBareObject<{
    enabled: unknown;
    upstream?: unknown;
    hasApiKey?: unknown;
  }>(response, ['enabled'], '反代状态');
  if (typeof raw.enabled !== 'boolean') {
    throw new OpenVikingError('反代状态响应的 enabled 不是布尔值', response.status, null);
  }
  return {
    enabled: raw.enabled,
    upstream: typeof raw.upstream === 'string' ? raw.upstream : null,
    hasApiKey: raw.hasApiKey === true,
  };
};

const withQuery = (path: string, params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
};

/**
 * 解析**裸对象**响应（顶层就是数据，没有 `{status, result, error}` 外壳）。
 *
 * 实测（2026-09-13）只有三个端点是这样，其余全是信封：
 *   - OpenViking `GET /health` → `{status, healthy, version, auth_mode, account_id, user_id, role}`
 *   - OpenViking `GET /ready`  → `{status, checks}`
 *   - 我们反代 `GET /status`   → `{enabled, upstream, hasApiKey}`
 *
 * **踩过的坑**：一开始假设"OpenViking 的端点都有信封"，这三个都走了 `readEnvelope()`
 * 去取 `envelope.result` → 永远是 `undefined`。分两步暴露：
 *   ① 两个设置页**永远「加载中…」**（`/status` 取不到 enabled）
 *   ② 修掉①之后立刻炸 `TypeError: Cannot read properties of undefined (reading 'version')`（`/health`）
 *
 * 所以裸对象必须显式解析，并用 `requireKeys` 校验关键字段：缺字段就**报错**，
 * 而不是返回一个 undefined —— 否则又会退化成"静默的假状态"。
 */
export const readBareObject = async <T extends object>(
  response: Response,
  requireKeys: readonly string[],
  label: string,
): Promise<T> => {
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new OpenVikingError(`${label}响应无法解析`, response.status, null);
  }

  if (!response.ok) {
    const record = (payload ?? {}) as { error?: unknown; message?: unknown };
    const code = typeof record.error === 'string' ? record.error : null;
    const message = typeof record.message === 'string' && record.message
      ? record.message
      : `HTTP ${response.status}`;
    throw new OpenVikingError(message, response.status, code);
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new OpenVikingError(`${label}响应不是对象`, response.status, null);
  }

  const record = payload as Record<string, unknown>;
  const missing = requireKeys.filter((key) => record[key] === undefined);
  if (missing.length > 0) {
    throw new OpenVikingError(
      `${label}响应缺少字段：${missing.join(', ')}`,
      response.status,
      null,
    );
  }

  return record as unknown as T;
};

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface OpenVikingStatusResponse {
  status: string;
  healthy: boolean;
  version: string;
  auth_mode: string;
  account_id?: string;
  user_id?: string;
  role?: string;
}

export interface OpenVikingReadyResponse {
  status: string;
  checks?: Record<string, { status?: string } | string>;
}

export interface OpenVikingEntry {
  uri: string;
  size: number;
  isDir: boolean;
  modTime?: string;
  rel_path?: string;
  abstract?: string;
}

export interface OpenVikingWatch {
  task_id?: string;
  id?: string;
  uri?: string;
  watch_interval?: number;
  is_active?: boolean;
  reason?: string;
  instruction?: string;
}

export interface OpenVikingSearchHit {
  context_type?: string;
  uri: string;
  level?: number;
  score?: number;
  abstract?: string;
  tags?: string[];
}

export interface OpenVikingSearchResult {
  memories?: OpenVikingSearchHit[];
  resources?: OpenVikingSearchHit[];
  skills?: OpenVikingSearchHit[];
}

export interface OpenVikingSession {
  session_id: string;
  uri: string;
  is_dir?: boolean;
  mod_time?: string;
}

export interface OpenVikingGrepMatch {
  line: number;
  uri: string;
  content: string;
}

/** `POST /content/write` 的 result：写入字节数与索引刷新状态（字段以实际返回为准，均可选） */
export interface OpenVikingWriteResult {
  written_bytes?: number;
  uri?: string;
}

/** `DELETE /fs` 的 result */
export interface OpenVikingRemoveResult {
  uri: string;
  estimated_deleted_count?: number;
}

// ---------------------------------------------------------------------------
// 端点
// ---------------------------------------------------------------------------

export const openVikingApi = {
  /**
   * 反代状态。反代自身**永远**回 200（未配置时 body 里 enabled=false），
   * 但它**不走 OpenViking 的信封**，所以单独解析 —— 见 `readProxyStatus`。
   */
  proxyStatus: async (): Promise<OpenVikingStatus> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await runtimeFetch(`${OPENVIKING_PREFIX}/status`, { signal: controller.signal });
      return await readProxyStatus(response);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new OpenVikingError('OpenViking 状态请求超时', 0, 'TIMEOUT');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },

  // `/health` 与 `/ready` 是**裸对象**（顶层就是数据），不是信封 —— 见 readBareObject。
  health: () => requestBare<OpenVikingStatusResponse>('/health', ['status', 'healthy', 'version'], '健康检查'),
  ready: () => requestBare<OpenVikingReadyResponse>('/ready', ['status'], '就绪检查'),

  ls: (uri: string) => request<OpenVikingEntry[]>(withQuery('/api/v1/fs/ls', { uri })),
  tree: (uri: string) => request<OpenVikingEntry[]>(withQuery('/api/v1/fs/tree', { uri })),

  read: (uri: string) => request<string>(withQuery('/api/v1/content/read', { uri })),
  abstract: (uri: string) => request<string>(withQuery('/api/v1/content/abstract', { uri })),
  overview: (uri: string) => request<string>(withQuery('/api/v1/content/overview', { uri })),

  /**
   * 写/覆盖/新建正文。OpenViking 的写端点是 `content/write`，不是 `fs/write`。
   * `replace` 会创建或覆盖；`create` 已存在则失败。父目录由上游自动创建。
   */
  write: (
    uri: string,
    content: string,
    mode: 'replace' | 'create' = 'replace',
  ): Promise<OpenVikingWriteResult> =>
    request<OpenVikingWriteResult>(
      '/api/v1/content/write',
      jsonInit('POST', { uri, content, mode }),
    ),

  /** 删除文件或目录。本轮 UI 只对文件用；目录递归删除留给调用方显式决定。 */
  remove: (uri: string, options?: { recursive?: boolean; wait?: boolean }): Promise<OpenVikingRemoveResult> =>
    request<OpenVikingRemoveResult>(
      withQuery('/api/v1/fs', {
        uri,
        recursive: options?.recursive ? 'true' : undefined,
        wait: options?.wait ? 'true' : undefined,
      }),
      { method: 'DELETE' },
    ),

  find: (query: string, limit = 10) =>
    request<OpenVikingSearchResult>('/api/v1/search/find', jsonInit('POST', { query, limit })),
  grep: (pattern: string, uri: string, limit = 50) =>
    request<{ matches?: OpenVikingGrepMatch[]; count?: number }>(
      '/api/v1/search/grep',
      jsonInit('POST', { pattern, uri, limit }),
    ),
  glob: (pattern: string, uri: string) =>
    request<{ matches?: string[]; count?: number }>(
      '/api/v1/search/glob',
      jsonInit('POST', { pattern, uri }),
    ),

  listWatches: () =>
    request<{ tasks?: OpenVikingWatch[]; total?: number }>('/api/v1/watches'),
  updateWatch: (taskId: string, patch: Partial<Pick<OpenVikingWatch, 'is_active' | 'watch_interval'>>) =>
    request<unknown>(`/api/v1/watches/${encodeURIComponent(taskId)}`, jsonInit('PATCH', patch)),
  deleteWatch: (taskId: string) =>
    request<unknown>(`/api/v1/watches/${encodeURIComponent(taskId)}`, { method: 'DELETE' }),

  sessions: () => request<OpenVikingSession[]>('/api/v1/sessions'),
};
