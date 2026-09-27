import { asBoolean, asFiniteNumber, asNonEmptyString, asObject } from './parse.js';
import { buildJoinScript } from './join-script.js';
import { resolveTunnelHost } from './transport.js';
import { projectPathFromRemote, remoteRelativeSegment } from './project-paths.js';

const readJsonBody = (req) => new Promise((resolve, reject) => {
  if (req.body !== undefined && req.body !== null) {
    if (Array.isArray(req.body) || Object.prototype.toString.call(req.body) === '[object Object]') {
      resolve(req.body);
      return;
    }
  }
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 2 * 1024 * 1024) {
      reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
      req.destroy();
    }
  });
  req.on('end', () => {
    if (!raw) {
      resolve({});
      return;
    }
    try {
      resolve(JSON.parse(raw));
    } catch {
      reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
    }
  });
  req.on('error', reject);
});

const sendError = (res, error, fallback = 'Device request failed') => {
  const statusCode = asFiniteNumber(error?.statusCode, 500);
  const payload = { error: error?.message || fallback };
  const code = asNonEmptyString(error?.code);
  if (code) payload.code = code;
  if (statusCode >= 500) console.error('[devices]', fallback, error);
  res.status(statusCode).json(payload);
};

export function registerDeviceRoutes(app, runtime) {
  const {
    registry,
    tokens,
    enrollTokens,
    audit,
    toolRuntime,
    mcpHandler,
    statusRuntime,
    mountRegistry,
    express,
  } = runtime;

  const requestOrigin = (req) => {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (!host) return '';
    return `${proto}://${host}`;
  };

  const jsonParser = express?.json
    ? express.json({ limit: '2mb' })
    : async (req, res, next) => {
      try {
        req.body = await readJsonBody(req);
        next();
      } catch (error) {
        sendError(res, error);
      }
    };

  app.get('/api/devices', async (_req, res) => {
    try {
      res.json({ devices: await registry.listDevices() });
    } catch (error) {
      sendError(res, error, 'Failed to list devices');
    }
  });

  // Live health snapshot: online + TCP latency for SSH/MCP endpoints.
  app.get('/api/devices/status', async (_req, res) => {
    try {
      if (!statusRuntime) {
        return res.status(503).json({ error: 'Status runtime unavailable', code: 'status_unavailable' });
      }
      res.json(await statusRuntime.listStatus());
    } catch (error) {
      sendError(res, error, 'Failed to probe device status');
    }
  });

  app.post('/api/devices', jsonParser, async (req, res) => {
    try {
      const device = await registry.createDevice(req.body || {});
      res.status(201).json({ device });
    } catch (error) {
      sendError(res, error, 'Failed to create device');
    }
  });

  app.get('/api/devices/audit', async (req, res) => {
    try {
      const limit = asFiniteNumber(req.query.limit, 50);
      res.json({ entries: await audit.listRecent(limit) });
    } catch (error) {
      sendError(res, error, 'Failed to read device audit log');
    }
  });

  app.get('/api/devices/mcp/tokens', async (_req, res) => {
    try {
      res.json({ tokens: await tokens.listTokens() });
    } catch (error) {
      sendError(res, error, 'Failed to list device MCP tokens');
    }
  });

  app.post('/api/devices/mcp/tokens', jsonParser, async (req, res) => {
    try {
      const body = asObject(req.body) || {};
      const created = await tokens.createToken({ label: asNonEmptyString(body.label) });
      res.status(201).json({ token: created });
    } catch (error) {
      sendError(res, error, 'Failed to create device MCP token');
    }
  });

  app.delete('/api/devices/mcp/tokens/:id', async (req, res) => {
    try {
      const revoked = await tokens.revokeToken(req.params.id);
      if (!revoked) return res.status(404).json({ error: 'Token not found', code: 'token_not_found' });
      res.json({ revoked: true });
    } catch (error) {
      sendError(res, error, 'Failed to revoke device MCP token');
    }
  });

  // --- one-click enrollment (management, UI session) ---
  app.get('/api/devices/enroll/tokens', async (_req, res) => {
    try {
      res.json({ tokens: await enrollTokens.listTokens() });
    } catch (error) {
      sendError(res, error, 'Failed to list enroll tokens');
    }
  });

  app.post('/api/devices/enroll/tokens', jsonParser, async (req, res) => {
    try {
      const body = asObject(req.body) || {};
      const created = await enrollTokens.createToken({
        label: asNonEmptyString(body.label),
        ttlMs: asFiniteNumber(body.ttlMs, undefined),
      });
      res.status(201).json({ token: created });
    } catch (error) {
      sendError(res, error, 'Failed to create enroll token');
    }
  });

  app.delete('/api/devices/enroll/tokens/:id', async (req, res) => {
    try {
      const revoked = await enrollTokens.revokeToken(req.params.id);
      if (!revoked) return res.status(404).json({ error: 'Token not found', code: 'token_not_found' });
      res.json({ revoked: true });
    } catch (error) {
      sendError(res, error, 'Failed to revoke enroll token');
    }
  });

  // Public join script: requires a valid (unspent) enroll token in the query.
  // Consuming happens only on successful enroll, so the script can be fetched
  // before execution.
  app.get('/api/devices/join.ps1', async (req, res) => {
    try {
      const presented = asNonEmptyString(req.query.t) || asNonEmptyString(req.query.token);
      const peeked = await enrollTokens.peekToken(presented);
      if (!peeked.ok) {
        return res.status(401).json({
          error: peeked.reason === 'token_expired' ? 'Enrollment token expired' : 'Invalid enrollment token',
          code: peeked.reason,
        });
      }
      const script = buildJoinScript({
        serverOrigin: requestOrigin(req) || 'http://127.0.0.1:3000',
        enrollToken: presented,
        approval: 'smart',
        enableWindowsMcp: true,
      });
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.send(script);
    } catch (error) {
      sendError(res, error, 'Failed to build join script');
    }
  });

  // Public enroll: one device per enrollment token.
  app.post('/api/devices/enroll', jsonParser, async (req, res) => {
    try {
      const header = asNonEmptyString(req.headers.authorization) || '';
      const presented = header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : asNonEmptyString(asObject(req.body)?.enrollToken);
      const consumed = await enrollTokens.consumeToken(presented);
      if (!consumed.ok) {
        return res.status(401).json({
          error: consumed.reason === 'token_expired' ? 'Enrollment token expired' : 'Invalid enrollment token',
          code: consumed.reason,
        });
      }
      const device = await registry.createDevice(req.body || {});
      res.status(201).json({ device });
    } catch (error) {
      sendError(res, error, 'Failed to enroll device');
    }
  });

  // MCP endpoint intentionally bypasses UI session auth: agents present a
  // dedicated Bearer token. Management routes above stay session-authenticated
  // by the surrounding /api middleware.
  app.post('/api/devices/mcp', async (req, res) => {
    try {
      let body = req.body;
      if (body === undefined || body === null
        || (!Array.isArray(body) && Object.prototype.toString.call(body) !== '[object Object]')) {
        body = await readJsonBody(req);
      }
      const outcome = await mcpHandler.handle({
        authorization: req.headers.authorization,
        body,
      });
      if (outcome.json == null) {
        return res.status(outcome.status).end();
      }
      return res.status(outcome.status).json(outcome.json);
    } catch (error) {
      sendError(res, error, 'Device MCP request failed');
    }
  });

  const resolveMountSsh = (device) => {
    const connection = device?.connection || {};
    if (connection.tailscale?.host) {
      return {
        host: connection.tailscale.host,
        port: asFiniteNumber(connection.tailscale.sshPort, 22),
        user: device.auth?.sshUser || 'agent',
      };
    }
    if (connection.tunnel?.sshPort) {
      return {
        host: resolveTunnelHost(connection),
        port: asFiniteNumber(connection.tunnel.sshPort, 22),
        user: device.auth?.sshUser || 'agent',
      };
    }
    return null;
  };

  const mountPayloadFor = async (deviceId, { remotePath = null } = {}) => {
    const device = await registry.getDevice(deviceId);
    if (!device) {
      throw Object.assign(new Error('Device not found'), { code: 'device_not_found', statusCode: 404 });
    }
    const health = mountRegistry
      ? await mountRegistry.healthFor(deviceId)
      : { state: 'absent', mountRoot: null, remoteRoot: null, enabled: false };
    let projectPath = null;
    if (remotePath && health.mountRoot && health.remoteRoot) {
      projectPath = projectPathFromRemote({
        deviceId,
        remoteRoot: health.remoteRoot,
        remotePath,
      });
      // Validate escape even when health is not ready.
      remoteRelativeSegment(health.remoteRoot, remotePath);
    }
    return {
      deviceId,
      mount: mountRegistry ? await mountRegistry.getMount(deviceId) : null,
      health,
      projectPath,
    };
  };

  app.get('/api/devices/:id/mount', async (req, res) => {
    try {
      if (!mountRegistry) {
        return res.status(503).json({ error: 'Mount registry unavailable', code: 'mount_unavailable' });
      }
      res.json(await mountPayloadFor(req.params.id));
    } catch (error) {
      sendError(res, error, 'Failed to read device mount');
    }
  });

  app.put('/api/devices/:id/mount', jsonParser, async (req, res) => {
    try {
      if (!mountRegistry) {
        return res.status(503).json({ error: 'Mount registry unavailable', code: 'mount_unavailable' });
      }
      const device = await registry.getDevice(req.params.id);
      if (!device) return res.status(404).json({ error: 'Device not found', code: 'device_not_found' });
      const body = asObject(req.body) || {};
      const remoteRoot = asNonEmptyString(body.remoteRoot);
      if (!remoteRoot) {
        return res.status(400).json({ error: 'remoteRoot is required', code: 'invalid_input' });
      }
      const ssh = resolveMountSsh(device);
      if (!ssh) {
        return res.status(400).json({
          error: 'Device has no reachable SSH transport for mounting',
          code: 'transport_unavailable',
        });
      }
      const enabled = body.enabled === undefined ? true : asBoolean(body.enabled, true);
      const entry = await mountRegistry.upsertMount({
        deviceId: device.id,
        remoteRoot,
        ssh,
        enabled,
      });
      const health = await mountRegistry.healthFor(device.id);
      res.json({ mount: entry, health, mountParent: mountRegistry.mountParent });
    } catch (error) {
      sendError(res, error, 'Failed to upsert device mount');
    }
  });

  app.post('/api/devices/:id/mount/ensure', jsonParser, async (req, res) => {
    try {
      if (!mountRegistry) {
        return res.status(503).json({ error: 'Mount registry unavailable', code: 'mount_unavailable' });
      }
      const device = await registry.getDevice(req.params.id);
      if (!device) return res.status(404).json({ error: 'Device not found', code: 'device_not_found' });
      const body = asObject(req.body) || {};
      const remoteRoot = asNonEmptyString(body.remoteRoot);
      const remotePath = asNonEmptyString(body.remotePath) || remoteRoot;
      let entry = await mountRegistry.getMount(device.id);
      if (remoteRoot) {
        const ssh = resolveMountSsh(device);
        if (!ssh) {
          return res.status(400).json({
            error: 'Device has no reachable SSH transport for mounting',
            code: 'transport_unavailable',
          });
        }
        entry = await mountRegistry.upsertMount({
          deviceId: device.id,
          remoteRoot,
          ssh,
          enabled: true,
        });
      } else if (!entry) {
        return res.status(400).json({
          error: 'remoteRoot is required when no mount is configured',
          code: 'invalid_input',
        });
      } else if (!entry.enabled) {
        const ssh = resolveMountSsh(device);
        entry = await mountRegistry.upsertMount({
          deviceId: device.id,
          remoteRoot: entry.remoteRoot,
          ssh,
          enabled: true,
        });
      }
      // Full payload including projectPath for the selected remote path.
      const payload = await mountPayloadFor(device.id, { remotePath: remotePath || entry.remoteRoot });
      res.json(payload);
    } catch (error) {
      sendError(res, error, 'Failed to ensure device mount');
    }
  });

  app.delete('/api/devices/:id/mount', async (req, res) => {
    try {
      if (!mountRegistry) {
        return res.status(503).json({ error: 'Mount registry unavailable', code: 'mount_unavailable' });
      }
      const entry = await mountRegistry.disableMount(req.params.id);
      if (!entry) return res.status(404).json({ error: 'Mount not found', code: 'mount_not_found' });
      res.json({ mount: entry, health: await mountRegistry.healthFor(req.params.id) });
    } catch (error) {
      sendError(res, error, 'Failed to disable device mount');
    }
  });

  app.get('/api/devices/:id', async (req, res) => {
    try {
      const device = await registry.getDevice(req.params.id);
      if (!device) return res.status(404).json({ error: 'Device not found', code: 'device_not_found' });
      res.json({ device: registry.publicDeviceView(device) });
    } catch (error) {
      sendError(res, error, 'Failed to read device');
    }
  });

  app.patch('/api/devices/:id', jsonParser, async (req, res) => {
    try {
      const device = await registry.updateDevice(req.params.id, req.body || {});
      if (!device) return res.status(404).json({ error: 'Device not found', code: 'device_not_found' });
      res.json({ device });
    } catch (error) {
      sendError(res, error, 'Failed to update device');
    }
  });

  app.delete('/api/devices/:id', async (req, res) => {
    try {
      const removed = await registry.deleteDevice(req.params.id);
      if (!removed) return res.status(404).json({ error: 'Device not found', code: 'device_not_found' });
      res.json({ deleted: true });
    } catch (error) {
      sendError(res, error, 'Failed to delete device');
    }
  });

  app.post('/api/devices/:id/test', jsonParser, async (req, res) => {
    try {
      const device = await registry.getDevice(req.params.id);
      if (!device) return res.status(404).json({ error: 'Device not found', code: 'device_not_found' });
      const body = asObject(req.body) || {};
      const tool = asNonEmptyString(body.tool) || 'devices.list';
      const argsSource = asObject(body.args) || {};
      const args = { ...argsSource, device_id: device.id };
      if (tool === 'devices.list') {
        return res.json({ result: { ok: true, data: { devices: await registry.listDevices() } } });
      }
      const result = await toolRuntime.callTool({
        tool,
        args,
        actor: 'ui',
      });
      res.json({ result });
    } catch (error) {
      sendError(res, error, 'Device test failed');
    }
  });
}
