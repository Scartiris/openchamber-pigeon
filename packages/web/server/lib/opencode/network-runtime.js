export const createOpenCodeNetworkRuntime = (deps) => {
  const {
    state,
    getOpenCodeAuthHeaders,
    configuredOpenCodeHostname = '127.0.0.1',
    // 「当前生效的引擎自己声明了地址吗」——多引擎路由的**唯一接缝**。
    // 默认 () => null：不注入时行为与加这个参数之前完全一致。
    resolveActiveEngineUrl = () => null,
  } = deps;

  const resolveConnectHostname = () => {
    const raw = typeof configuredOpenCodeHostname === 'string' ? configuredOpenCodeHostname.trim() : '';
    const hostname = raw || '127.0.0.1';
    if (hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]') {
      return '127.0.0.1';
    }
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      return hostname;
    }
    return hostname.includes(':') ? `[${hostname}]` : hostname;
  };

  const normalizeApiPrefix = (prefix) => {
    if (!prefix) {
      return '';
    }

    if (prefix.includes('://')) {
      try {
        const parsed = new URL(prefix);
        return normalizeApiPrefix(parsed.pathname);
      } catch {
        return '';
      }
    }

    const trimmed = prefix.trim();
    if (!trimmed || trimmed === '/') {
      return '';
    }
    const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
  };

  const waitForReady = async (url, timeoutMs = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let timeout = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(`${url.replace(/\/+$/, '')}/global/health`, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...getOpenCodeAuthHeaders(),
          },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        timeout = null;

        if (response.ok) {
          const body = await response.json().catch(() => null);
          if (body?.healthy === true) {
            return true;
          }
        }
      } catch {
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };

  const setDetectedOpenCodeApiPrefix = () => {
    state.openCodeApiPrefix = '';
    state.openCodeApiPrefixDetected = true;
    if (state.openCodeApiDetectionTimer) {
      clearTimeout(state.openCodeApiDetectionTimer);
      state.openCodeApiDetectionTimer = null;
    }
  };

  /**
   * 「引擎在哪」——**全仓约 30 个模块**（事件流、通知、权限、会话、定时任务…）都问这一个函数，
   * 所以多引擎路由就落在这里：改这一处，等于所有跟引擎说话的地方一起跟着走。
   *
   * 优先级：
   *   ① 当前生效的引擎**自己声明**的地址（描述符 `endpoint.url`，例如 codex 适配器）——
   *      自定义引擎按自己的根路径提供服务（`/global/health`、`/session`），所以**不套** opencode 的 API 前缀；
   *   ② 原来的逻辑：本地端口 / `OPENCODE_HOST` + API 前缀。
   *
   * ⚠️ 顺序上有个刻意的细节：引擎自己声明了地址时**不检查 `openCodePort`**。
   * 原来的实现端口未知就抛错；而切到外部引擎时，opencode 的端口跟这次请求根本无关 ——
   * 还抛错就等于"引擎好好的却报 OpenCode port is not available"。
   * 没声明地址时抛错行为**一字未改**。
   */
  const buildOpenCodeUrl = (path, prefixOverride) => {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;

    let engineOwnUrl = null;
    try {
      const candidate = resolveActiveEngineUrl();
      if (typeof candidate === 'string' && candidate.trim()) {
        engineOwnUrl = candidate.trim().replace(/\/+$/, '');
      }
    } catch {
      // 引擎注册表读不出来 → 当作"没声明"，走宿主原路
    }
    if (engineOwnUrl) {
      return `${engineOwnUrl}${normalizedPath}`;
    }

    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }
    const prefix = normalizeApiPrefix(prefixOverride !== undefined ? prefixOverride : '');
    const fullPath = `${prefix}${normalizedPath}`;
    const base = state.openCodeBaseUrl ?? `http://${resolveConnectHostname()}:${state.openCodePort}`;
    return `${base}${fullPath}`;
  };

  const detectOpenCodeApiPrefix = () => {
    state.openCodeApiPrefixDetected = true;
    state.openCodeApiPrefix = '';
    return true;
  };

  const ensureOpenCodeApiPrefix = () => detectOpenCodeApiPrefix();

  const scheduleOpenCodeApiDetection = () => {
    return;
  };

  return {
    waitForReady,
    normalizeApiPrefix,
    setDetectedOpenCodeApiPrefix,
    buildOpenCodeUrl,
    ensureOpenCodeApiPrefix,
    scheduleOpenCodeApiDetection,
  };
};
