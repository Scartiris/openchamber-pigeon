import { asNonEmptyString, asObject } from './parse.js';
import { DEVICE_TOOL_DEFINITIONS } from './tools.js';

const PROTOCOL_VERSION = '2025-06-18';

const asJsonRpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const asJsonRpcError = (id, code, message, data) => {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
};

const parseBody = (body) => {
  if (body === null || body === undefined) return null;
  if (Array.isArray(body)) return body;
  if (Object.prototype.toString.call(body) === '[object Object]') return body;

  const text = String(body).trim();
  if (!text) return null;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine.slice(5).trim());
  } catch {
    return null;
  }
};

const toolResultPayload = (result) => {
  if (!result?.ok) {
    const error = result?.error || { code: 'upstream_error', message: 'Device tool failed' };
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error }, null, 2),
      }],
      isError: true,
      structuredContent: { error },
    };
  }

  const data = result.data;
  // Windows-MCP (and workers) already return MCP-shaped content parts.
  // Pass them through so agents receive real image parts, not a JSON blob.
  if (data && Array.isArray(data.content)) {
    const payload = {
      content: data.content,
      structuredContent: data.structuredContent !== undefined ? data.structuredContent : data,
    };
    if (data.isError === true) payload.isError = true;
    return payload;
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(data, null, 2),
    }],
    structuredContent: data,
  };
};

/**
 * Minimal MCP Streamable HTTP handler for device tools.
 * Supports initialize / tools/list / tools/call with a fixed tool catalog.
 */
export const createDeviceMcpHandler = ({ toolRuntime, authenticateToken }) => {
  const handle = async ({ authorization, body, actorFallback = 'mcp' }) => {
    const header = asNonEmptyString(authorization);
    const token = header && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : null;
    const actor = token ? await authenticateToken(token) : null;
    if (!actor) {
      return {
        status: 401,
        json: { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' } },
      };
    }

    const message = parseBody(body);
    if (message === null) {
      return {
        status: 400,
        json: { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } },
      };
    }
    if (Array.isArray(message)) {
      return {
        status: 400,
        json: { jsonrpc: '2.0', error: { code: -32600, message: 'Batch requests are not supported' } },
      };
    }

    const id = message.id ?? null;
    const method = asNonEmptyString(message.method);
    const actorName = asNonEmptyString(actor.label) || actorFallback;
    const params = asObject(message.params) || {};

    if (method === 'initialize') {
      return {
        status: 200,
        json: asJsonRpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'openchamber-devices', version: '0.1.0' },
        }),
      };
    }

    if (method === 'notifications/initialized' || method === 'initialized') {
      return { status: 202, json: null };
    }

    if (method === 'ping') {
      return { status: 200, json: asJsonRpcResult(id, {}) };
    }

    if (method === 'tools/list') {
      return {
        status: 200,
        json: asJsonRpcResult(id, {
          tools: DEVICE_TOOL_DEFINITIONS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }),
      };
    }

    if (method === 'tools/call') {
      const tool = asNonEmptyString(params.name);
      const args = asObject(params.arguments) || {};
      const result = await toolRuntime.callTool({ tool, args, actor: actorName });
      return {
        status: 200,
        json: asJsonRpcResult(id, toolResultPayload(result)),
      };
    }

    return {
      status: 200,
      json: asJsonRpcError(id, -32601, `Method not found: ${method}`),
    };
  };

  return { handle };
};
