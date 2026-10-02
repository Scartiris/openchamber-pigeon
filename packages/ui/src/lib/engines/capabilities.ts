/**
 * 引擎能力（**UI 侧**的镜像）。
 *
 * 真相在服务端：`packages/web/server/lib/engines/capabilities.js`。
 * UI 不能 import 服务端代码，所以这里镜像一份 —— **改词表要两边一起改**，
 * 测试里有一条断言盯着"两份词表是否一致"（见 capabilities.test.ts 里的注释）。
 *
 * 为什么 UI 需要它：用户拍板的接入方式是「引擎自己声明能力，**UI 按能力降级**」。
 * 也就是说，一个只有 sessions+streaming 的引擎也要能用 —— 缺什么就把对应的面收起来，
 * 而不是渲染出一堆点了没反应的东西。
 */

/** 词表全集（顺序与服务端一致，便于人眼对照）。 */
export const ENGINE_CAPABILITY_IDS = [
  'sessions',
  'streaming',
  'parts',
  'tools',
  'permissions',
  'questions',
  'todos',
  'providers',
  'agents',
  'mcp',
  'skills',
  'commands',
  'diffs',
  'attachments',
  'projects',
] as const;

export type EngineCapability = (typeof ENGINE_CAPABILITY_IDS)[number];

/** 进主聊天流的最低要求（与服务端 REQUIRED_FOR_CHAT 一致）。 */
export const REQUIRED_FOR_CHAT: readonly EngineCapability[] = ['sessions', 'streaming'];

const KNOWN: ReadonlySet<string> = new Set(ENGINE_CAPABILITY_IDS);

/**
 * 是不是词表里的能力。
 *
 * 写成**类型谓词**而不是"比较字符串再断言"：这样调用方拿到的是收窄过的类型，
 * 不需要 `as` 断言（本仓的 anti-slop 规则不允许没有 SAFETY 说明的断言）。
 */
export const isEngineCapability = (id: string): id is EngineCapability => KNOWN.has(id);

/** 把任意字符串数组收成"认识的能力"（不认识的丢掉 —— 服务端已经报过 warning 了）。 */
export const knownCapabilities = (list: readonly string[] | undefined | null): EngineCapability[] => {
  if (!Array.isArray(list)) return [];
  const out: EngineCapability[] = [];
  for (const id of list) {
    if (!isEngineCapability(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
  }
  return out;
};

/** 能不能进主聊天流。 */
export const canServeChat = (capabilities: readonly string[] | undefined | null): boolean => {
  const known = knownCapabilities(capabilities);
  return REQUIRED_FOR_CHAT.every((id) => known.includes(id));
};

/** 缺哪些能力才进不了聊天流（给界面一句能读懂的理由，而不是只给个灰按钮）。 */
export const missingForChat = (capabilities: readonly string[] | undefined | null): EngineCapability[] => {
  const known = knownCapabilities(capabilities);
  return REQUIRED_FOR_CHAT.filter((id) => !known.includes(id));
};

/**
 * 某个面该不该渲染。
 *
 * 语义是**"能不能显示"**而不是"能不能用"：缺能力时把面收起来，比留一个点了没反应的按钮好。
 * 注意：这是**降级**不是**禁用** —— 缺 `diffs` 的引擎照样能聊天，只是没有 diff 面板。
 */
export const shouldRenderSurface = (
  capabilities: readonly string[] | undefined | null,
  surface: EngineCapability,
): boolean => knownCapabilities(capabilities).includes(surface);

/** 缺哪些面（用来在界面上一次性说明"这个引擎少了什么"）。 */
export const missingSurfaces = (capabilities: readonly string[] | undefined | null): EngineCapability[] => {
  const known = new Set(knownCapabilities(capabilities));
  return ENGINE_CAPABILITY_IDS.filter((id) => !known.has(id));
};
