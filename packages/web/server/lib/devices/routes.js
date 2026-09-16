import { asBoolean, asFiniteNumber, asNonEmptyString, asObject } from './parse.js';

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
    audit,
    toolRuntime,
    mcpHandler,
    express,
  } = runtime;

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
