/**
 * 引擎描述符（`engine.json`）的解析与校验。
 *
 * 这是「以后随时加一个 agent 引擎」这件事的**唯一契约**：
 * 加引擎 = 往 `OC_ENGINES_DIR` 放一份 `engine.json` + 把适配器服务跑起来，
 * **不需要改应用代码**。
 *
 * 校验用 **zod 在 I/O 边界一次解析**（与 `lib/guests/*`、`lib/opencode/theme-catalog.js`
 * 同一个套路）：好处是错误信息自带字段路径，且下游拿到的是已经成形的领域对象，
 * 不必到处写类型判断（本仓的 anti-slop 规则也不允许那种写法）。
 *
 * 三个刻意的取舍：
 *   · 未知的**能力**：丢掉 + 记 warning（向前兼容，见 capabilities.js）；
 *   · 未知的**协议**：直接拒绝 —— 宿主不知道怎么驱动它，放进去只会变成一个
 *     "看得见点不动"的引擎；
 *   · 未知的**字段**：忽略（`.passthrough()`，与 guests 的 "extra keys drop, not forward" 一致）。
 */

import { z } from 'zod';
import {
  ENGINE_CAPABILITIES_API_VERSION,
  ENGINE_CAPABILITY_IDS,
  canServeChat,
  engineCapabilitiesSchema,
  missingForChat,
  splitEngineCapabilities,
} from './capabilities.js';

export const ENGINE_DESCRIPTOR_API_VERSION = 1;

/** 宿主**会驱动**的协议。加新协议要同时加驱动代码，不是加一行字符串的事。 */
export const ENGINE_PROTOCOLS = Object.freeze(['opencode-v1', 'guest-panel']);

/** 呈现方式：chat = 进主聊天流；panel = 只在面板里出现。 */
export const ENGINE_SURFACES = Object.freeze(['chat', 'panel']);

export class EngineDescriptorError extends Error {
  constructor(message, { code = 'INVALID_ENGINE_DESCRIPTOR', source = null } = {}) {
    super(message);
    this.name = 'EngineDescriptorError';
    this.code = code;
    this.source = source;
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

const nonEmpty = () => z.string().trim().min(1);

const descriptorSchema = z.object({
  apiVersion: z.literal(ENGINE_DESCRIPTOR_API_VERSION),
  id: z.string().trim().regex(ID_PATTERN, 'id 必须是 kebab-case（小写字母/数字/连字符）'),
  name: nonEmpty().optional(),
  protocol: z.enum(ENGINE_PROTOCOLS),
  surface: z.enum(ENGINE_SURFACES).optional(),
  endpoint: z.object({
    healthPath: z.string().trim().startsWith('/', 'healthPath 必须以 / 开头').optional(),
    // 这个引擎**自己的**地址。不写 = 用宿主那一个引擎的地址（向后兼容：内置 opencode 就是这么工作的）。
    // 多个引擎并存时**必须**写它，否则探测分不清谁是谁。
    url: z.string().trim().url('endpoint.url 必须是一个完整 URL（例：http://codex-engine:4096）')
      .refine((value) => /^https?:\/\//i.test(value), 'endpoint.url 只支持 http / https')
      .optional(),
  }).passthrough().optional(),
  auth: z.object({
    type: z.enum(['none', 'basic']).optional(),
    username: nonEmpty().optional(),
    passwordEnv: nonEmpty().optional(),
  }).passthrough().optional(),
  versionProbe: z.object({
    path: z.string().trim().optional(),
    field: z.string().trim().optional(),
  }).passthrough().optional(),
  capabilities: engineCapabilitiesSchema.optional(),
}).passthrough();

/**
 * 内置的 opencode 描述符。
 *
 * 「目录里什么都没有」时的兜底，也是**唯一**一个不靠文件就能工作的引擎 ——
 * 保证升级到这一版之后老部署的行为**一个字节都不变**（这是 M4 的硬要求：
 * 接缝收敛必须是行为保持的）。
 */
export const BUILTIN_OPENCODE_DESCRIPTOR = Object.freeze({
  apiVersion: ENGINE_DESCRIPTOR_API_VERSION,
  id: 'opencode',
  name: 'OpenCode',
  protocol: 'opencode-v1',
  surface: 'chat',
  builtin: true,
  endpoint: Object.freeze({ healthPath: '/global/health' }),
  auth: Object.freeze({ type: 'basic', username: 'opencode', passwordEnv: 'OPENCODE_SERVER_PASSWORD' }),
  versionProbe: Object.freeze({ path: '/global/health', field: 'version' }),
  capabilities: Object.freeze([
    'sessions', 'streaming', 'parts', 'tools', 'permissions', 'questions', 'todos',
    'providers', 'agents', 'mcp', 'skills', 'commands', 'diffs', 'attachments', 'projects',
  ]),
});

/** zod 的报错 → 一句人话（带字段路径，否则"哪里错了"要靠猜）。 */
const formatIssues = (issues) => issues
  .map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}：${issue.message}` : issue.message;
  })
  .join('；');

/**
 * 校验并归一化一份描述符。
 *
 * @returns {{ descriptor: object, warnings: string[] }}
 * @throws {EngineDescriptorError}
 */
export const normalizeEngineDescriptor = (raw, { source = null } = {}) => {
  const parsed = descriptorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EngineDescriptorError(formatIssues(parsed.error.issues), { source });
  }
  const value = parsed.data;

  if (value.protocol === 'opencode-v1' && !value.endpoint?.healthPath) {
    throw new EngineDescriptorError(
      'opencode-v1 需要 endpoint.healthPath（宿主靠它探活）',
      { code: 'MISSING_HEALTH_PATH', source },
    );
  }

  const warnings = [];
  const { known: capabilities, unknown: unknownCapabilities } = splitEngineCapabilities(value.capabilities ?? []);
  if (unknownCapabilities.length > 0) {
    warnings.push(
      `不认识的能力被忽略：${unknownCapabilities.join(', ')}（本宿主的词表见 capabilities.js，`
      + `已知：${ENGINE_CAPABILITY_IDS.join(', ')}）`,
    );
  }
  if (!value.capabilities) {
    warnings.push('没有声明 capabilities —— 按"什么都不能"处理，它进不了主聊天流');
  }

  // 没写 surface 时的默认：能进聊天流就进；不能就退到面板 —— 与 capabilities 声明一致，
  // 免得出现"声明了会话+流式却被塞进面板"这种自相矛盾的配置。
  const surface = value.surface ?? (canServeChat(capabilities) ? 'chat' : 'panel');
  if (surface === 'chat' && !canServeChat(capabilities)) {
    warnings.push(
      `声明 surface=chat 但缺少 ${missingForChat(capabilities).join(', ')} —— `
      + '界面上它仍然只能按面板呈现（判据走 capabilities，不走 surface）',
    );
  }

  const auth = value.auth?.type === 'basic'
    ? { type: 'basic', username: value.auth.username ?? 'opencode', passwordEnv: value.auth.passwordEnv ?? 'OPENCODE_SERVER_PASSWORD' }
    : { type: 'none' };

  const versionProbe = {};
  if (value.versionProbe?.path) versionProbe.path = value.versionProbe.path;
  if (value.versionProbe?.field) versionProbe.field = value.versionProbe.field;

  const descriptor = {
    apiVersion: ENGINE_DESCRIPTOR_API_VERSION,
    id: value.id,
    name: value.name ?? value.id,
    protocol: value.protocol,
    surface,
    builtin: false,
    source,
    auth,
    capabilities,
    capabilitiesApiVersion: ENGINE_CAPABILITIES_API_VERSION,
  };
  // 「有才加」的属性用显式赋值，不用条件展开 —— 后者会把"没有这个字段"藏进一个空对象里
  if (value.endpoint?.healthPath || value.endpoint?.url) {
    descriptor.endpoint = {};
    if (value.endpoint.healthPath) descriptor.endpoint.healthPath = value.endpoint.healthPath;
    if (value.endpoint.url) descriptor.endpoint.url = value.endpoint.url.replace(/\/+$/, '');
  }
  if (Object.keys(versionProbe).length > 0) descriptor.versionProbe = versionProbe;

  return { descriptor: Object.freeze(descriptor), warnings };
};

/** 从磁盘上的文本解析（把 JSON 语法错误也包成 EngineDescriptorError，好报出文件名）。 */
export const parseEngineDescriptor = (text, { source = null } = {}) => {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new EngineDescriptorError(`不是合法 JSON：${error?.message ?? error}`, { code: 'INVALID_JSON', source });
  }
  return normalizeEngineDescriptor(raw, { source });
};

/** 给 API/UI 用的公开形状。 */
export const describeEngineForApi = (descriptor) => {
  const capabilities = descriptor.capabilities ?? [];
  const api = {
    id: descriptor.id,
    name: descriptor.name,
    protocol: descriptor.protocol,
    surface: descriptor.surface,
    builtin: descriptor.builtin === true,
    source: descriptor.source ?? null,
    capabilities: [...capabilities],
    capabilitiesApiVersion: descriptor.capabilitiesApiVersion ?? ENGINE_CAPABILITIES_API_VERSION,
    canServeChat: canServeChat(capabilities),
    missingForChat: missingForChat(capabilities),
    healthPath: descriptor.endpoint?.healthPath ?? null,
    endpointUrl: descriptor.endpoint?.url ?? null,
    authType: descriptor.auth?.type ?? 'none',
  };
  if (descriptor.versionProbe) api.versionProbe = { ...descriptor.versionProbe };
  return api;
};
