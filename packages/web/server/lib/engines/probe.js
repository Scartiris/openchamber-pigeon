/**
 * 引擎探测：按**描述符**去问一次"你还活着吗、你是什么版本"。
 *
 * 与 lib/opencode/network-runtime.js 的 waitForReady 的关系：
 *   那个是**生命周期**的一部分（spawn 之后等它起来），针对写死的 opencode 语义；
 *   这里是**只读的一次探测**，路径/字段/认证方式全部来自描述符，给注册表与界面用。
 * 两者暂时并存（M4 的硬要求是行为保持），等第二个引擎真接进来再谈合并。
 *
 * 所有外部输入（描述符字段、地址、认证头、响应体）都在这里**一次解析成形**，
 * 之后的代码只处理领域值，不做类型判断。
 */

import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 5000;

/** 健康响应必须是个 JSON 对象；字段本身不约束（各引擎自便，版本字段单独取）。 */
const healthBodySchema = z.record(z.string(), z.unknown());

const nonEmptyString = () => z.string().trim().min(1);

const asNonEmptyStringOrNull = (value) => {
  const parsed = nonEmptyString().safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** 版本字段的兜底顺序：描述符指定的优先，其次几个常见名字。 */
const pickVersion = (body, field) => {
  const candidates = [field, 'version', 'openCodeVersion', 'openchamberVersion'].filter(Boolean);
  for (const key of candidates) {
    const parsed = nonEmptyString().safeParse(body[key]);
    if (parsed.success) return parsed.data;
  }
  return null;
};

/**
 * @returns {Promise<{
 *   ok: boolean, status: number|null, version: string|null,
 *   latencyMs: number, healthPath: string|null, error: string|null, body: object|null
 * }>}
 */
export const probeEngine = async ({
  descriptor,
  baseUrl,
  authHeaders,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) => {
  const startedAt = now();
  const healthPath = asNonEmptyStringOrNull(descriptor?.endpoint?.healthPath);
  const base = z.string().catch('').parse(baseUrl).replace(/\/+$/, '');
  const versionField = asNonEmptyStringOrNull(descriptor?.versionProbe?.field);
  const headers = z.record(z.string(), z.string()).catch({}).parse(authHeaders);

  const fail = (error, status = null) => ({
    ok: false,
    status,
    version: null,
    latencyMs: Math.max(0, now() - startedAt),
    healthPath,
    error: error instanceof Error ? error.message : String(error),
    body: null,
  });

  if (!base) return fail('还没有可用的引擎地址（引擎未就绪或未配置）');
  if (!healthPath) return fail('描述符里没有 endpoint.healthPath，无法探测');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}${healthPath}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, now() - startedAt);
    let raw = null;
    try {
      raw = await response.json();
    } catch {
      raw = null;
    }
    const parsedBody = healthBodySchema.safeParse(raw);
    const body = parsedBody.success ? parsedBody.data : null;
    if (!response.ok) {
      return { ok: false, status: response.status, version: null, latencyMs, healthPath, error: `HTTP ${response.status}`, body };
    }
    return {
      ok: true,
      status: response.status,
      version: body ? pickVersion(body, versionField) : null,
      latencyMs,
      healthPath,
      error: null,
      body,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return fail(aborted ? `探测超时（${timeoutMs}ms）` : error);
  } finally {
    clearTimeout(timer);
  }
};
