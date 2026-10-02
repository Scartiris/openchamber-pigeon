/**
 * 引擎能力词表（**闭集**，带版本）。
 *
 * 为什么要有词表：用户拍板的接入方式是「引擎自己声明能力，UI 按能力降级」。
 * 那就必须有一个**双方都认的固定词表** —— 否则每个引擎各自发明几个字符串，
 * UI 既没法判"能不能进主聊天流"，也没法在缺能力时给出准确的降级理由。
 *
 * 版本化：词表本身有 `apiVersion`。以后加能力是**加法**（旧 UI 忽略不认识的能力），
 * 改语义才升 apiVersion。与 guests 的 `openchamber.apiVersion` 同一个思路。
 *
 * 实现上刻意只做"集合运算"而**不做类型判断** —— 输入的类型检查归描述符的 schema
 * （descriptor.js 用 zod 在 I/O 边界一次解析），这里拿到的已经是字符串数组。
 */

import { z } from 'zod';

export const ENGINE_CAPABILITIES_API_VERSION = 1;

/**
 * 词表全集。判据是「这个能力会不会改变 UI 的渲染/交互分支」——
 * 纯后端内部的概念（比如引擎自己的存储格式）不该进来。
 */
export const ENGINE_CAPABILITY_IDS = Object.freeze([
  'sessions',    // 会话 CRUD（列表/新建/删除/归档）
  'streaming',   // 逐 token 的流式输出（含事件流）
  'parts',       // 消息分段（文本/推理/工具调用是结构化 part，不是一整块字符串）
  'tools',       // 工具调用可见（能渲染"正在跑什么命令/读哪个文件"）
  'permissions', // 权限询问与答复（agent 停下来问"能不能执行"）
  'questions',   // 向用户提问（与 permissions 分开：一个是授权，一个是内容澄清）
  'todos',       // 任务清单
  'providers',   // 模型供应商/凭据管理
  'agents',      // 智能体定义（例如本仓的 工作.md / 公文.md）
  'mcp',         // MCP 服务器配置与状态
  'skills',      // 技能目录
  'commands',    // 自定义命令 / 快捷指令
  'diffs',       // 文件改动与快照（diff 面板、回滚）
  'attachments', // 附件/文件上传进会话
  'projects',    // 项目与目录上下文
]);

const CAPABILITY_SET = new Set(ENGINE_CAPABILITY_IDS);

/** 声明列表的 schema —— 描述符里那一项必须是字符串数组。 */
export const engineCapabilitiesSchema = z.array(z.string());

/**
 * 进「主聊天流」的最低要求。
 *
 * 只要这两个：能建会话 + 能流式。其余全部缺失都只是**降级**（隐藏对应的面），
 * 不是"不能用"。这条线一旦定得过高，第二个引擎就永远进不来；
 * 定得过低，UI 会在聊天流里渲染出空白。所以只留这两个真正的地基。
 */
export const REQUIRED_FOR_CHAT = Object.freeze(['sessions', 'streaming']);

export const isKnownEngineCapability = (id) => CAPABILITY_SET.has(id);

/**
 * 把声明列表拆成「认识的」与「不认识的」。
 *
 * **不认识的丢掉、但要报出来**（而不是静默、也不是报错）：
 *   · 报错 → 新版引擎的描述符在旧宿主上直接装不上，这是最差的兼容行为；
 *   · 静默 → 一个拼错的 `streamingg` 会变成"引擎莫名其妙不能进聊天流"，查半天。
 * 所以返回值里带上 `unknown`，由调用方决定是记日志还是回给界面。
 */
export const splitEngineCapabilities = (list = []) => {
  const known = [];
  const unknown = [];
  const seen = new Set();
  for (const id of list) {
    // 空值直接跳过（不参与"不认识"的统计）：schema 已经保证这里是字符串数组，
    // 但一个空的 id 不该被报成"拼错的能力"。
    if (!id) continue;
    if (!CAPABILITY_SET.has(id)) {
      if (!unknown.includes(id)) unknown.push(id);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    known.push(id);
  }
  return { known, unknown };
};

/** 能不能进主聊天流。 */
export const canServeChat = (capabilities = []) => (
  REQUIRED_FOR_CHAT.every((id) => capabilities.includes(id))
);

/** 缺哪些能力才能进聊天流（给界面一句能读懂的理由）。 */
export const missingForChat = (capabilities = []) => (
  REQUIRED_FOR_CHAT.filter((id) => !capabilities.includes(id))
);
