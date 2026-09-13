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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await runtimeFetch(`${OPENVIKING_PREFIX}${path}`, init);
  return readEnvelope<T>(response);
}

const withQuery = (path: string, params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
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

// ---------------------------------------------------------------------------
// 端点
// ---------------------------------------------------------------------------

export const openVikingApi = {
  status: () => request<OpenVikingStatus>(`/status`.replace(/^\//, '/'), undefined).catch(() => null),

  /**
   * 反代状态。反代自身**永远**回 200（未配置时 body 里 enabled=false），
   * 所以这里不需要容错到 `null`。
   */
  proxyStatus: () => request<OpenVikingStatus>('/status'),

  health: () => request<OpenVikingStatusResponse>('/health'),
  ready: () => request<OpenVikingReadyResponse>('/ready'),

  ls: (uri: string) => request<OpenVikingEntry[]>(withQuery('/api/v1/fs/ls', { uri })),
  tree: (uri: string) => request<OpenVikingEntry[]>(withQuery('/api/v1/fs/tree', { uri })),

  read: (uri: string) => request<string>(withQuery('/api/v1/content/read', { uri })),
  abstract: (uri: string) => request<string>(withQuery('/api/v1/content/abstract', { uri })),
  overview: (uri: string) => request<string>(withQuery('/api/v1/content/overview', { uri })),

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
