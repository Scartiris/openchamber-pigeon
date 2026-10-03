/**
 * 引擎运行时：把「注册表 + 探测」组装成宿主能用的三个动作 —— 快照、活动引擎、探测。
 *
 * 两条性能/稳定性上的取舍（都是刻意的）：
 *   1) `/health` 是热路径（docker 每 30s 探一次、界面也在轮询），所以快照**只读描述符、
 *      不做网络探测** —— 描述符里已经有 UI 需要的全部声明；
 *   2) 目录读取与网络探测各自带一个短缓存（默认 10s / 5s），免得每次请求都去碰磁盘或引擎。
 *      两个缓存的时长分开：描述符几乎不变，探测结果变得快。
 */

import { z } from 'zod';
import { DEFAULT_ENGINES_DIR, asNonEmptyString, loadEngineDescriptors, resolveActiveEngine } from './registry.js';
import { BUILTIN_OPENCODE_DESCRIPTOR, describeEngineForApi } from './descriptor.js';
import { probeEngine } from './probe.js';
import { registerEngineRoutes } from './routes.js';

const DEFAULT_REGISTRY_CACHE_MS = 10_000;
const DEFAULT_PROBE_CACHE_MS = 5_000;

export const createEnginesRuntime = ({
  env = process.env,
  fsPromises,
  readSettingsFromDiskMigrated = async () => ({}),
  getEngineBaseUrl = () => '',
  getEngineAuthHeaders = () => ({}),
  logger = console,
  fetchImpl,
  registryCacheMs = DEFAULT_REGISTRY_CACHE_MS,
  probeCacheMs = DEFAULT_PROBE_CACHE_MS,
  now = () => Date.now(),
} = {}) => {
  let registryCache = null; // { at, value }
  let probeCache = null; // { at, key, value }
  // `/health` 是同步处理器，而读目录/读设置都是异步的 —— 所以额外维护一份**同步可读**的
  // 最近快照：异步那边刷新它，`/health` 直接读。读不到时给 null（而不是编一个假的默认值）。
  let cachedSnapshot = null;
  let cachedSnapshotAt = 0;
  let snapshotRefreshing = false;

  const readRequestedEngineId = async () => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      return asNonEmptyString(settings?.engine) || null;
    } catch (error) {
      logger.warn?.(`[engines] 读设置失败，按"未指定引擎"处理：${error?.message ?? error}`);
      return null;
    }
  };

  const getRegistry = async ({ force = false } = {}) => {
    const at = now();
    if (!force && registryCache && at - registryCache.at < registryCacheMs) return registryCache.value;
    const loaded = await loadEngineDescriptors({
      dir: asNonEmptyString(env?.OC_ENGINES_DIR) || DEFAULT_ENGINES_DIR,
      readdir: (...args) => fsPromises.readdir(...args),
      readFile: (...args) => fsPromises.readFile(...args),
      logger,
    });
    const requestedId = await readRequestedEngineId();
    const { engine, reason } = resolveActiveEngine({ descriptors: loaded.descriptors, requestedId, env });
    const value = {
      ...loaded,
      requestedId,
      activeEngineId: engine.id,
      activeReason: reason,
      builtinId: BUILTIN_OPENCODE_DESCRIPTOR.id,
    };
    registryCache = { at, value };
    return value;
  };

  const resolveBaseUrl = () => {
    try {
      return z.string().catch('').parse(getEngineBaseUrl()).replace(/\/+$/, '');
    } catch {
      // 引擎还没起来时 buildOpenCodeUrl 会抛 —— 快照不该因此失败
      return '';
    }
  };

  /**
   * 这个引擎该探测哪个地址。
   *
   * 描述符写了 `endpoint.url` 就用它（多引擎并存时**必须**写）；没写就回落到宿主那一个引擎
   * —— 内置 opencode 就是这么工作的，所以这条是**向后兼容**的。
   * 加这个之前，探测永远打宿主那一个地址，于是 `probe.ok` 分不清是谁在应答
   * （2026-10-03 的 M4 验收里就明确记着这个坑）。
   */
  const resolveBaseUrlFor = (descriptor) => {
    const own = asNonEmptyString(descriptor?.endpoint?.url);
    return own ? own.replace(/\/+$/, '') : resolveBaseUrl();
  };

  const resolveAuthHeaders = () => {
    try {
      return z.record(z.string(), z.string()).catch({}).parse(getEngineAuthHeaders());
    } catch {
      return {};
    }
  };

  /** 只读描述符的快照 —— 给 `/health` 与 `/api/engines` 用。 */
  const getSnapshot = async ({ force = false } = {}) => {
    const registry = await getRegistry({ force });
    const active = registry.descriptors.find((d) => d.id === registry.activeEngineId) ?? BUILTIN_OPENCODE_DESCRIPTOR;
    const snapshot = {
      dir: registry.dir,
      dirReadable: registry.dirReadable,
      warnings: registry.warnings,
      requestedId: registry.requestedId,
      activeReason: registry.activeReason,
      active: describeEngineForApi(active),
      engines: registry.descriptors.map(describeEngineForApi),
    };
    cachedSnapshot = snapshot;
    cachedSnapshotAt = now();
    return snapshot;
  };

  /**
   * 同步读最近一次快照（可能还没热起来 → null）。
   *
   * **过期就顺手在后台重算一次**（stale-while-revalidate）：不做这件事的话，快照只在
   * "有人调 /api/engines" 或启动预热时更新 —— 于是改了 `engine` 设置之后，
   * `/health` 会一直报旧引擎直到有人碰一下那个接口。
   * 2026-10-03 的验收就是被这一条卡住的（设置生效了，/health 却不动）。
   * 这里保持同步语义：先返回手上这份，刷新在后台跑；并发只放一个。
   */
  const getCachedSnapshot = () => {
    const stale = !cachedSnapshot || now() - cachedSnapshotAt >= registryCacheMs;
    if (stale && !snapshotRefreshing) {
      snapshotRefreshing = true;
      void getSnapshot()
        .catch((error) => logger.warn?.(`[engines] 刷新引擎注册表失败：${error?.message ?? error}`))
        .finally(() => { snapshotRefreshing = false; });
    }
    return cachedSnapshot;
  };

  /** 真去问一次引擎 —— 给 `/api/engines/active` 用；带短缓存。 */
  const probeActive = async ({ force = false } = {}) => {
    const registry = await getRegistry({ force });
    const active = registry.descriptors.find((d) => d.id === registry.activeEngineId) ?? BUILTIN_OPENCODE_DESCRIPTOR;
    const baseUrl = resolveBaseUrlFor(active);
    const key = `${active.id}|${baseUrl}`;
    const at = now();
    if (!force && probeCache && probeCache.key === key && at - probeCache.at < probeCacheMs) {
      return { engine: describeEngineForApi(active), probe: probeCache.value, cached: true };
    }
    const probe = await probeEngine({
      descriptor: active,
      baseUrl,
      authHeaders: resolveAuthHeaders(),
      fetchImpl,
      now,
    });
    // 把"探的是哪个地址"一起回出去 —— 多引擎并存时这是判读 probe.ok 的前提
    const value = { ...probe, baseUrl: baseUrl || null, source: asNonEmptyString(active?.endpoint?.url) ? 'descriptor' : 'host' };
    probeCache = { at, key, value };
    return { engine: describeEngineForApi(active), probe: value, cached: false };
  };

  /**
   * 同步问一句：当前生效的引擎**自己**声明了地址吗？（没声明 → null）
   *
   * 给**代理层**用 —— 每个请求都要问一次，所以这里**只读缓存、绝不 I/O、绝不探测**：
   *   · 探测一次要发 HTTP，放在请求路径上等于给每个请求加一次往返；
   *   · 顺手调 `getCachedSnapshot()`，过期就在**后台**重算（stale-while-revalidate），
   *     于是改了 `engine` 设置之后，代理目标最迟一个缓存周期就跟上，不用重启。
   *
   * 返回 null 的语义是"**按宿主原来的路走**"（内置 opencode 就是这种），
   * 所以默认行为与加这个函数之前**完全一致**。
   */
  const getActiveEngineOwnUrl = () => {
    getCachedSnapshot();
    const own = asNonEmptyString(cachedSnapshot?.active?.endpointUrl);
    return own ? own.replace(/\/+$/, '') : null;
  };

  const registerRoutes = (app) => {
    // 先把快照热起来（fire-and-forget）：`/health` 是同步的，启动后第一次被探时
    // 不该还报 null。失败只记日志 —— 引擎注册表读不出来不该阻止服务启动。
    void getSnapshot().catch((error) => {
      logger.warn?.(`[engines] 预热引擎注册表失败：${error?.message ?? error}`);
    });
    return registerEngineRoutes(app, { getSnapshot, probeActive });
  };

  return { getSnapshot, getCachedSnapshot, probeActive, getActiveEngineOwnUrl, registerRoutes };
};
