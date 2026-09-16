import { evaluateDeviceApproval } from './approval.js';
import { asBoolean, asFiniteNumber, asNonEmptyString, asObject } from './parse.js';

const toolError = (code, message, extra = {}) => {
  const payload = { code, message };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) payload[key] = value;
  }
  return { ok: false, error: payload };
};

const toolOk = (data) => ({ ok: true, data });

/** Promote a channel result that already carries ok/error into a tool envelope. */
const fromChannelResult = (result) => {
  if (result && result.ok === false) {
    const code = asNonEmptyString(result.error) || 'upstream_error';
    const message = asNonEmptyString(result.stderr)
      || asNonEmptyString(result.message)
      || 'Device channel operation failed';
    return toolError(code, message, {
      exitCode: result.exitCode ?? null,
      stdout: result.stdout ?? null,
      stderr: result.stderr ?? null,
    });
  }
  return toolOk(result);
};

export const DEVICE_TOOL_DEFINITIONS = [
  {
    name: 'devices.list',
    description: 'List registered devices with status, capabilities, and approval mode.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'devices.shell.exec',
    description: 'Run a shell command on a registered device over SSH.',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: { type: 'string' },
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
      required: ['device_id', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'devices.fs.list',
    description: 'List a directory on a registered device.',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['device_id', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'devices.fs.read',
    description: 'Read a text file from a registered device.',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: { type: 'string' },
        path: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'] },
      },
      required: ['device_id', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'devices.fs.write',
    description: 'Write a text file on a registered device.',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      required: ['device_id', 'path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'devices.screen.capture',
    description: 'Capture a screenshot from a registered Windows device.',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: { type: 'string' },
      },
      required: ['device_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'devices.ui.click',
    description: 'Click at screen coordinates on a registered Windows device.',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
      },
      required: ['device_id', 'x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'devices.ui.type',
    description: 'Type text on a registered Windows device (optional x/y target).',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: { type: 'string' },
        text: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['device_id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'devices.ui.elements',
    description: 'Read UI elements from a registered Windows device when supported.',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['device_id'],
      additionalProperties: false,
    },
  },
];

export const createDeviceToolRuntime = ({
  registry,
  transportResolver,
  sshClient,
  windowsMcp,
  audit,
}) => {
  const requireDevice = async (deviceId) => {
    const id = asNonEmptyString(deviceId);
    if (!id) return { error: toolError('invalid_input', 'device_id is required') };
    const device = await registry.getDevice(id);
    if (!device) return { error: toolError('device_not_found', `Unknown device ${id}`) };
    return { device };
  };

  const resolveTransport = async (device) => {
    const transport = await transportResolver.resolve(device);
    if (!transport.ssh && !transport.mcpBase) {
      return {
        error: toolError('transport_unavailable', 'No reachable transport for this device', {
          attempted: transport.attempted,
        }),
        transport,
      };
    }
    return { transport };
  };

  const guard = async ({ tool, args, actor }) => {
    const started = Date.now();
    const finish = async (result, deviceId, summary) => {
      await audit.record({
        deviceId: deviceId || null,
        tool,
        actor,
        decision: result.ok ? 'allow' : (result.error?.code || 'deny'),
        durationMs: Date.now() - started,
        error: result.ok ? null : result.error?.message,
        summary,
      });
      return result;
    };

    if (tool === 'devices.list') return { started, finish };

    const { device, error } = await requireDevice(args?.device_id);
    if (error) return { error, finish, deviceId: asNonEmptyString(args?.device_id) };

    const approval = evaluateDeviceApproval({ approval: device.approval, tool });
    if (!approval.allowed) {
      return {
        error: toolError(approval.reason, approval.detail || 'Operation not allowed', {
          deviceId: device.id,
          approval: device.approval,
        }),
        finish,
        deviceId: device.id,
        device,
      };
    }

    return { device, started, finish };
  };

  const callTool = async ({ tool, args = {}, actor = 'mcp' }) => {
    const toolName = asNonEmptyString(tool);
    const input = asObject(args) || {};

    if (toolName === 'devices.list') {
      const devices = await registry.listDevices();
      return { ok: true, data: { devices } };
    }

    const guardResult = await guard({ tool: toolName, args: input, actor });
    if (guardResult.error) {
      return guardResult.finish(guardResult.error, guardResult.deviceId, toolName);
    }
    const { device, finish } = guardResult;

    const { transport, error: transportError } = await resolveTransport(device);
    if (transportError) {
      return finish(transportError, device.id, toolName);
    }

    try {
      if (toolName === 'devices.shell.exec') {
        if (!device.capabilities.shell) {
          return finish(toolError('capability_missing', 'Device does not advertise shell'), device.id, toolName);
        }
        const result = await sshClient.exec({
          device,
          transport,
          command: asNonEmptyString(input.command),
          cwd: asNonEmptyString(input.cwd),
          timeoutMs: asFiniteNumber(input.timeout_ms, undefined),
        });
        await registry.touchDevice(device.id, 'online');
        return finish(fromChannelResult(result), device.id, `exec exit=${result.exitCode}`);
      }

      if (toolName === 'devices.fs.list') {
        if (!device.capabilities.files) {
          return finish(toolError('capability_missing', 'Device does not advertise files'), device.id, toolName);
        }
        const result = await sshClient.list({
          device,
          transport,
          remotePath: asNonEmptyString(input.path),
        });
        await registry.touchDevice(device.id, 'online');
        return finish(fromChannelResult(result), device.id, `list ${asNonEmptyString(input.path)}`);
      }

      if (toolName === 'devices.fs.read') {
        if (!device.capabilities.files) {
          return finish(toolError('capability_missing', 'Device does not advertise files'), device.id, toolName);
        }
        const encoding = asNonEmptyString(input.encoding) === 'base64' ? 'base64' : 'utf8';
        const result = await sshClient.read({
          device,
          transport,
          remotePath: asNonEmptyString(input.path),
          encoding,
        });
        await registry.touchDevice(device.id, 'online');
        return finish(fromChannelResult(result), device.id, `read ${asNonEmptyString(input.path)}`);
      }

      if (toolName === 'devices.fs.write') {
        if (!device.capabilities.files) {
          return finish(toolError('capability_missing', 'Device does not advertise files'), device.id, toolName);
        }
        const result = await sshClient.write({
          device,
          transport,
          remotePath: asNonEmptyString(input.path),
          content: input.content === undefined || input.content === null ? '' : String(input.content),
          overwrite: input.overwrite === undefined ? true : asBoolean(input.overwrite, true),
        });
        await registry.touchDevice(device.id, 'online');
        return finish(fromChannelResult(result), device.id, `write ${asNonEmptyString(input.path)}`);
      }

      if (toolName === 'devices.screen.capture'
        || toolName === 'devices.ui.click'
        || toolName === 'devices.ui.type'
        || toolName === 'devices.ui.elements') {
        if (!device.capabilities.screen) {
          return finish(toolError('capability_missing', 'Device does not advertise screen'), device.id, toolName);
        }
        const bearer = device.auth.mcpBearerRef
          ? await registry.readDeviceSecret(device.id, 'mcp')
          : null;
        const callArgs = { mcpBase: transport.mcpBase, bearer };

        let result;
        if (toolName === 'devices.screen.capture') {
          result = await windowsMcp.capture(callArgs);
        } else if (toolName === 'devices.ui.click') {
          result = await windowsMcp.click({
            ...callArgs,
            x: asFiniteNumber(input.x, 0),
            y: asFiniteNumber(input.y, 0),
            button: asNonEmptyString(input.button) || 'left',
          });
        } else if (toolName === 'devices.ui.type') {
          result = await windowsMcp.type({
            ...callArgs,
            text: String(input.text ?? ''),
            x: asFiniteNumber(input.x, 100),
            y: asFiniteNumber(input.y, 100),
          });
        } else {
          result = await windowsMcp.elements({ ...callArgs, query: asNonEmptyString(input.query) });
        }
        await registry.touchDevice(device.id, 'online');
        return finish(toolOk(result), device.id, toolName);
      }

      return finish(toolError('unknown_tool', `Unknown tool ${toolName}`), device.id, toolName);
    } catch (error) {
      const code = asNonEmptyString(error?.code) || 'upstream_error';
      const statusCode = asFiniteNumber(error?.statusCode, 502);
      return finish(toolError(code, error?.message || 'Device tool failed', { statusCode }), device.id, toolName);
    }
  };

  return { callTool, toolDefinitions: DEVICE_TOOL_DEFINITIONS };
};
