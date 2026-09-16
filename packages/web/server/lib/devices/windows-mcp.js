const DEFAULT_TIMEOUT_MS = 60_000;

const fail = (message, code, statusCode = 502) =>
  Object.assign(new Error(message), { code, statusCode });

const parseJsonOrSse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    const dataLine = String(text || '')
      .split('\n')
      .find((line) => line.startsWith('data:'));
    if (!dataLine) return null;
    try {
      return JSON.parse(dataLine.slice(5).trim());
    } catch {
      return null;
    }
  }
};

/**
 * Proxy device GUI operations to a Windows-MCP (CursorTouch) worker.
 *
 * Speaks Streamable HTTP MCP:
 *   1) POST /mcp initialize → capture Mcp-Session-Id
 *   2) notifications/initialized
 *   3) tools/call with the session header
 *
 * Tool names match upstream: Screenshot / Snapshot / Click / Type.
 */
export const createWindowsMcpClient = ({ fetchImpl = fetch }) => {
  const endpointOf = (mcpBase) => {
    const base = String(mcpBase).replace(/\/$/, '');
    return base.endsWith('/mcp') ? base : `${base}/mcp`;
  };

  const postMcp = async ({ endpoint, bearer, body, sessionId, signal }) => {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    const nextSession = response.headers.get('mcp-session-id') || sessionId || null;
    return { response, text, nextSession };
  };

  /** Run one tools/call against Windows-MCP with a short-lived session. */
  const callTool = async ({ mcpBase, bearer, toolName, arguments: toolArgs, timeoutMs }) => {
    if (!mcpBase) throw fail('Windows-MCP transport is unavailable', 'transport_unavailable');
    if (!bearer) throw fail('Windows-MCP bearer is not configured for this device', 'missing_mcp_bearer', 400);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
    const endpoint = endpointOf(mcpBase);
    try {
      // 1) initialize
      const init = await postMcp({
        endpoint,
        bearer,
        signal: controller.signal,
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'openchamber-devices', version: '0.1.0' },
          },
        },
      });
      if (init.response.status === 401 || init.response.status === 403) {
        throw fail('Windows-MCP unauthorized', 'mcp_unauthorized', 502);
      }
      if (!init.response.ok) {
        throw fail(`Windows-MCP initialize HTTP ${init.response.status}`, 'upstream_error', 502);
      }
      const sessionId = init.nextSession;

      // 2) initialized notification (best effort)
      await postMcp({
        endpoint,
        bearer,
        sessionId,
        signal: controller.signal,
        body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      }).catch(() => {});

      // 3) tools/call
      const call = await postMcp({
        endpoint,
        bearer,
        sessionId,
        signal: controller.signal,
        body: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: toolArgs || {},
          },
        },
      });
      if (!call.response.ok) {
        throw fail(
          `Windows-MCP returned HTTP ${call.response.status}`,
          call.response.status === 401 || call.response.status === 403 ? 'mcp_unauthorized' : 'upstream_error',
          502,
        );
      }

      const payload = parseJsonOrSse(call.text);
      if (!payload) throw fail('Windows-MCP returned an unreadable response', 'upstream_error');
      if (payload.error) {
        throw fail(payload.error.message || 'Windows-MCP tool call failed', 'upstream_error', 502);
      }
      return payload.result ?? { content: [] };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw fail('Windows-MCP call timed out', 'timeout', 504);
      }
      if (error?.code) throw error;
      throw fail(error?.message || 'Windows-MCP call failed', 'upstream_error');
    } finally {
      clearTimeout(timer);
    }
  };

  /** Fast visual capture — Windows-MCP `Screenshot`. */
  const capture = async ({ mcpBase, bearer, timeoutMs }) => callTool({
    mcpBase,
    bearer,
    toolName: 'Screenshot',
    arguments: { use_annotation: false },
    timeoutMs,
  });

  /** Click at screen coordinates — Windows-MCP `Click` uses loc=[x,y]. */
  const click = async ({ mcpBase, bearer, x, y, button = 'left', timeoutMs }) => callTool({
    mcpBase,
    bearer,
    toolName: 'Click',
    arguments: {
      loc: [Number(x), Number(y)],
      button: button || 'left',
      clicks: 1,
    },
    timeoutMs,
  });

  /**
   * Type text — Windows-MCP `Type` requires loc or label.
   * Optional x/y default to (100,100) when only text is provided.
   */
  const type = async ({ mcpBase, bearer, text, x = 100, y = 100, timeoutMs }) => callTool({
    mcpBase,
    bearer,
    toolName: 'Type',
    arguments: {
      text: String(text ?? ''),
      loc: [Number(x), Number(y)],
      clear: false,
      press_enter: false,
    },
    timeoutMs,
  });

  /** UI tree snapshot — Windows-MCP `Snapshot`. */
  const elements = async ({ mcpBase, bearer, query, timeoutMs }) => {
    void query;
    return callTool({
      mcpBase,
      bearer,
      toolName: 'Snapshot',
      arguments: {
        use_vision: false,
        use_ui_tree: true,
        use_annotation: false,
      },
      timeoutMs,
    });
  };

  return { callTool, capture, click, type, elements };
};
