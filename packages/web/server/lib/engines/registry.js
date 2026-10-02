/**
 * 引擎注册表：把 `OC_ENGINES_DIR` 里的 `*.json` 读成一组描述符，并决定「当前用哪个」。
 *
 * 为什么是**目录**而不是配置文件里的一段数组：
 *   加引擎的完整动作应该是「放一份文件 + 起一个服务」，不该要求去改宿主的配置文件
 *   （那会立刻产生"我的改动和宿主的改动撞在一起"的问题）。一个目录、一份文件一个引擎，
 *   删掉文件就等于摘掉引擎，也不需要宿主重启（每次请求读一次目录，见 index.js 的缓存）。
 *
 * 内置的 opencode 描述符**永远在列表里**（除非被同名文件覆盖）：
 * 这样"升级到这一版"对老部署是零行为变化。
 */

import { z } from 'zod';
import { BUILTIN_OPENCODE_DESCRIPTOR, parseEngineDescriptor } from './descriptor.js';

export const DEFAULT_ENGINES_DIR = '/etc/oc-engines';

/** I/O 边界上的字符串规整 —— 环境变量、设置项、目录名都从这里过一道。 */
export const asNonEmptyString = (value) => {
  const parsed = z.string().trim().min(1).safeParse(value);
  return parsed.success ? parsed.data : '';
};

const isJsonFile = (name) => String(name).toLowerCase().endsWith('.json');

/**
 * 读取目录里的描述符。
 *
 * 容错原则：**任何一个文件坏掉都不该让整个注册表失败** —— 坏文件记 warning 跳过，
 * 其余的照常用。理由：一个手滑写错的 `codex.json` 不该把工作台整个搞瘫。
 *
 * @returns {Promise<{ descriptors: object[], warnings: string[], dir: string, dirReadable: boolean }>}
 */
export const loadEngineDescriptors = async ({ dir, readdir, readFile, logger = console } = {}) => {
  const warnings = [];
  const byId = new Map();

  // 内置先放进去，后面的文件可以覆盖它（显式配置胜过隐式默认）
  byId.set(BUILTIN_OPENCODE_DESCRIPTOR.id, BUILTIN_OPENCODE_DESCRIPTOR);

  const targetDir = z.string().trim().min(1).catch(DEFAULT_ENGINES_DIR).parse(dir);
  let names = [];
  let dirReadable = false;
  try {
    names = await readdir(targetDir);
    dirReadable = true;
  } catch (error) {
    // 目录不存在是**正常状态**（没配任何外部引擎），不是错误
    if (error?.code !== 'ENOENT') {
      const detail = `读不了引擎目录 ${targetDir}：${error?.code ?? error?.message ?? error}`;
      warnings.push(detail);
      logger.warn?.(`[engines] ${detail}`);
    }
    return { descriptors: [...byId.values()], warnings, dir: targetDir, dirReadable };
  }

  for (const name of [...names].filter(isJsonFile).sort()) {
    const file = `${targetDir}/${name}`;
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      warnings.push(`${name}：读不了（${error?.code ?? error?.message ?? error}）`);
      continue;
    }
    try {
      const { descriptor, warnings: fileWarnings } = parseEngineDescriptor(String(text), { source: file });
      for (const w of fileWarnings) warnings.push(`${name}：${w}`);
      const previous = byId.get(descriptor.id);
      if (previous && previous.builtin !== true) {
        // 两个文件抢同一个 id：**先出现的赢**（文件名已排序，所以是确定的），
        // 后一个跳过并报出来。不静默、也不按"谁后读谁赢"来定 —— 那种规则没人猜得到。
        warnings.push(`${name}：id=${descriptor.id} 已由 ${previous.source ?? '先前的文件'} 定义，本文件被跳过`);
        continue;
      }
      if (previous) {
        warnings.push(`${name}：覆盖了内置引擎 ${descriptor.id}（显式配置胜过隐式默认）`);
      }
      byId.set(descriptor.id, descriptor);
    } catch (error) {
      warnings.push(`${name}：${error?.message ?? error}`);
      logger.warn?.(`[engines] 跳过 ${file}：${error?.message ?? error}`);
    }
  }

  const descriptors = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { descriptors, warnings, dir: targetDir, dirReadable };
};

/**
 * 决定当前生效的引擎。
 *
 * 优先级：显式请求（设置项）→ 环境变量 `OC_ENGINE` → 描述符只有一个时就用它 → 内置 opencode。
 *
 * 为什么"只有一个就用它"：这才是"我放了一个引擎进去，它就该生效"的直觉行为；
 * 而**不**默认挑第一个文件（目录里两个引擎时，谁生效不该由文件名的字母序决定）。
 */
export const resolveActiveEngine = ({ descriptors, requestedId, env } = {}) => {
  const list = descriptors ?? [];
  const wanted = [requestedId, env?.OC_ENGINE].map(asNonEmptyString).filter(Boolean);

  for (const id of wanted) {
    const hit = list.find((d) => d.id === id);
    if (hit) return { engine: hit, reason: 'requested' };
  }

  const nonBuiltin = list.filter((d) => d.builtin !== true);
  if (list.length === 1) return { engine: list[0], reason: 'only-one' };
  if (nonBuiltin.length === 1 && list.length === 2) {
    // 内置 opencode + 恰好一个外部引擎：仍然用内置（不猜），但理由说得出来
    return { engine: BUILTIN_OPENCODE_DESCRIPTOR, reason: 'builtin-default-with-alternatives' };
  }
  return { engine: BUILTIN_OPENCODE_DESCRIPTOR, reason: 'builtin-default' };
};
