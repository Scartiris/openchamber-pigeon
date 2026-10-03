/**
 * 引擎注册表（UI 侧）。
 *
 * 数据源是后端的两个只读端点（M4 加的，**接缝是纯增量的**）：
 *   GET /api/engines          → 注册表里所有引擎（含能力、地址、来源）
 *   GET /api/engines/active   → 当前生效的那个（含探活结果）
 *
 * 为什么不塞进 useConfigStore：引擎注册表是**只读的运行时事实**（目录里有什么、探活通不通），
 * 而 config store 管的是"用户选了什么"。两者的刷新时机完全不同 —— 注册表跟着目录变，
 * 探活还有自己的短缓存（服务端 5s、注册表 10s，见 server/lib/engines/index.js）。
 *
 * ⚠️ **在 I/O 边界用 zod 解析**（本仓的既有约定，见 lib/guests、lib/gitApiHttp）：
 * 不做零散的 `typeof` 判断 —— 那样既过不了 anti-slop 规则，也会把"形状不对"漏到界面里。
 * 解析不了就当成"读不到引擎"，界面显示错误而不是崩。
 */

import { create } from 'zustand';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { knownCapabilities, type EngineCapability } from '@/lib/engines/capabilities';

// ---------- 边界 schema（服务端形状 → 域类型） ----------
export const engineDescriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  protocol: z.string().optional(),
  /** 描述符里写的地址；没写就是 null（= 回落宿主地址，探测分不清是谁） */
  endpointUrl: z.string().nullable().optional(),
  endpoint: z.object({
    url: z.string().nullable().optional(),
    healthPath: z.string().nullable().optional(),
  }).partial().optional(),
  capabilities: z.array(z.string()).optional(),
  canServeChat: z.boolean().optional(),
}).passthrough();

export const engineProbeSchema = z.object({
  ok: z.boolean().optional(),
  status: z.number().nullable().optional(),
  version: z.string().nullable().optional(),
  latencyMs: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
  /** 探的是哪个地址 + 地址从哪来（descriptor = 引擎自己的；host = 回落宿主的） */
  baseUrl: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
}).passthrough();

/**
 * ⚠️ 这个 schema 已经**不用了**：真实响应里没有嵌套的 `registry` 对象，目录字段在顶层。
 * 保留导出只是为了不破坏可能引用它的旧测试；新代码请用 `enginesResponseSchema`。
 * @deprecated 用 `enginesResponseSchema` + `toEngineRegistryView`。
 */
export const engineRegistrySchema = z.object({
  dir: z.string().nullable().optional(),
  readable: z.boolean().optional(),
  count: z.number().optional(),
  warnings: z.array(z.string()).optional(),
}).passthrough();

/**
 * `/api/engines` 的**真实形状**（2026-10-03 用 `ops/split/dump-engines-shape.sh` 从服务器取的原文）：
 *
 *   { dir, dirReadable, warnings, requestedId, activeReason,
 *     active: <描述符>, engines: [<描述符>, …] }
 *
 * 🔴 **我第一版是照"以为的形状"写的**：把 `active` 当成 `{engine, probe, reason}`、
 * 把目录信息当成 `registry: {dir, readable, count, warnings}` —— 而真实响应里
 * `active` **就是描述符本身**、目录字段**在顶层**、**根本没有 `registry` 这个键**。
 * 因为字段全 `.optional()` + `.passthrough()`，解析"成功"了，于是 `activeId` 恒为 null
 * —— 界面显示「当前引擎：未知」（用户就是这么发现的）。**又是"照推的写"这一类错**。
 *
 * 而且 **`probe` 不在这个端点**：它只出现在 `/api/engines/active`（`{engine, probe, cached}`）。
 * 所以 `load()` 要**两个端点都取**再合并。
 */
export const enginesResponseSchema = z.object({
  engines: z.array(engineDescriptorSchema).optional(),
  /** 当前生效的引擎 —— 直接就是描述符，不是包装对象 */
  active: engineDescriptorSchema.nullable().optional(),
  activeReason: z.string().nullable().optional(),
  requestedId: z.string().nullable().optional(),
  dir: z.string().nullable().optional(),
  dirReadable: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
}).passthrough();

/** `/api/engines/active`：`{ engine, probe, cached }` */
export const activeEngineResponseSchema = z.object({
  engine: engineDescriptorSchema.nullable().optional(),
  probe: engineProbeSchema.nullable().optional(),
}).passthrough();

// ---------- 域类型 ----------
export type EngineDescriptorView = {
  id: string;
  name: string;
  protocol: string;
  endpointUrl: string | null;
  capabilities: EngineCapability[];
  canServeChat: boolean;
};

export type EngineProbeView = {
  ok: boolean;
  status: number | null;
  version: string | null;
  latencyMs: number | null;
  error: string | null;
  baseUrl: string | null;
  source: string | null;
};

export type EngineRegistryView = {
  dir: string | null;
  readable: boolean;
  count: number | null;
  warnings: string[];
};

type EnginesState = {
  engines: EngineDescriptorView[];
  activeId: string | null;
  activeReason: string | null;
  probe: EngineProbeView | null;
  registry: EngineRegistryView | null;
  loading: boolean;
  error: string | null;
  switching: boolean;
  loadedAt: number | null;
  load: (options?: { force?: boolean }) => Promise<void>;
  setActiveEngine: (engineId: string) => Promise<{ ok: boolean; error?: string }>;
};

// ---------- 域类型映射（已解析过的输入，这里只做形状搬运） ----------
export const toEngineDescriptorView = (input: z.infer<typeof engineDescriptorSchema>): EngineDescriptorView => ({
  id: input.id,
  name: input.name && input.name.length > 0 ? input.name : input.id,
  protocol: input.protocol && input.protocol.length > 0 ? input.protocol : 'unknown',
  endpointUrl: input.endpointUrl ?? input.endpoint?.url ?? null,
  capabilities: knownCapabilities(input.capabilities ?? []),
  canServeChat: input.canServeChat === true,
});

export const toEngineProbeView = (input: z.infer<typeof engineProbeSchema>): EngineProbeView => ({
  ok: input.ok === true,
  status: input.status ?? null,
  version: input.version ?? null,
  latencyMs: input.latencyMs ?? null,
  error: input.error ?? null,
  baseUrl: input.baseUrl ?? null,
  source: input.source ?? null,
});

/**
 * 目录信息来自 `/api/engines` 的**顶层**字段（`dir` / `dirReadable` / `warnings`），
 * 不是嵌套的 `registry` 对象 —— 第一版推错了，见上面那段说明。
 * `count` 用列表长度即可（服务端没有单独的 count）。
 */
export const toEngineRegistryView = (
  input: z.infer<typeof enginesResponseSchema>,
): EngineRegistryView => ({
  dir: input.dir ?? null,
  readable: input.dirReadable === true,
  count: input.engines?.length ?? null,
  warnings: input.warnings ?? [],
});

const CACHE_MS = 10_000; // 与服务端的注册表缓存同量级；太短会打爆后端，太长看不到新引擎

export const useEnginesStore = create<EnginesState>((set, get) => ({
  engines: [],
  activeId: null,
  activeReason: null,
  probe: null,
  registry: null,
  loading: false,
  error: null,
  switching: false,
  loadedAt: null,

  load: async (options) => {
    const state = get();
    if (state.loading) return;
    if (!options?.force && state.loadedAt && Date.now() - state.loadedAt < CACHE_MS) return;
    set({ loading: true, error: null });
    try {
      // 两个端点都要取：注册表与"当前是哪个"在 /api/engines，**探活只在 /api/engines/active**
      const [listResponse, activeResponse] = await Promise.all([
        runtimeFetch('/api/engines'),
        runtimeFetch('/api/engines/active'),
      ]);
      if (!listResponse.ok) throw new Error(`/api/engines 回了 ${listResponse.status}`);
      const parsed = enginesResponseSchema.safeParse(await listResponse.json());
      if (!parsed.success) throw new Error(`/api/engines 的形状不认识：${parsed.error.issues[0]?.message ?? '未知'}`);

      // 探活失败不算致命：注册表本身还能显示（少一段"引擎探活"而已）
      let probeView: EngineProbeView | null = null;
      if (activeResponse.ok) {
        const parsedActive = activeEngineResponseSchema.safeParse(await activeResponse.json());
        if (parsedActive.success && parsedActive.data.probe) {
          probeView = toEngineProbeView(parsedActive.data.probe);
        }
      }

      const data = parsed.data;
      set({
        engines: (data.engines ?? []).map(toEngineDescriptorView),
        // active 就是描述符本身（第一版误当成 {engine:…}，于是这里恒为 null）
        activeId: data.active?.id ?? null,
        activeReason: data.activeReason ?? null,
        probe: probeView,
        registry: toEngineRegistryView(data),
        loading: false,
        loadedAt: Date.now(),
      });
    } catch (error) {
      // 引擎端点挂了不该让设置页崩 —— 记下错误，界面显示"读不到"，其余照常
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  /**
   * 切引擎：写 `engine` 设置 → 刷新注册表。
   *
   * 三条刻意的行为：
   *   · **同一个引擎不重复写**（省一次没意义的落盘）；
   *   · 写完**强制刷新**（`load({force:true})`）—— 后端在 PUT 里已经同步刷过引擎快照，
   *     所以这里刷完，界面显示的引擎与代理真正在用的引擎是**同一个**，不会出现"界面说切了、请求还发给旧的"；
   *   · **失败要能说出来**：返回 `{ok:false,error}`，由界面显示，而不是静默当成功
   *     （选了个连不上的引擎会明确失败，这是有意的语义 —— 见 ops/split/verify-engines.sh 里的说明）。
   */
  setActiveEngine: async (engineId) => {
    const state = get();
    if (!engineId) return { ok: false, error: 'engine id is required' };
    if (engineId === state.activeId) return { ok: true };
    if (!state.engines.some((engine) => engine.id === engineId)) {
      return { ok: false, error: `unknown engine: ${engineId}` };
    }

    set({ switching: true, error: null });
    try {
      const response = await runtimeFetch('/api/config/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: engineId }),
      });
      if (!response.ok) throw new Error(`写设置回了 ${response.status}`);

      await get().load({ force: true });
      set({ switching: false });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ switching: false, error: message });
      return { ok: false, error: message };
    }
  },
}));
