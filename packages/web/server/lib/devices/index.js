import { createDeviceRegistry } from './registry.js';
import { createDeviceMcpTokenRuntime } from './tokens.js';
import { createDeviceEnrollTokenRuntime } from './enroll.js';
import { createDeviceTransportResolver } from './transport.js';
import { createDeviceSshClient } from './ssh.js';
import { createWindowsMcpClient } from './windows-mcp.js';
import { createDeviceAuditLog } from './audit.js';
import { createDeviceToolRuntime } from './tools.js';
import { createDeviceMcpHandler } from './mcp.js';
import { createDeviceStatusRuntime } from './status.js';
import { createDeviceMetricsRuntime } from './metrics.js';
import { registerDeviceRoutes } from './routes.js';

export function createDeviceRuntime({
  fsPromises,
  path,
  crypto,
  net,
  spawn,
  os,
  express,
  openchamberDataDir,
}) {
  const devicesDir = path.join(openchamberDataDir, 'devices');
  const registry = createDeviceRegistry({
    fsPromises,
    path,
    crypto,
    storePath: path.join(devicesDir, 'registry.json'),
    secretsPath: path.join(devicesDir, 'secrets.json'),
  });
  const tokens = createDeviceMcpTokenRuntime({
    fsPromises,
    path,
    crypto,
    storePath: path.join(devicesDir, 'mcp-tokens.json'),
  });
  const enrollTokens = createDeviceEnrollTokenRuntime({
    fsPromises,
    path,
    crypto,
    storePath: path.join(devicesDir, 'enroll-tokens.json'),
  });
  const transportResolver = createDeviceTransportResolver({ net });
  const sshClient = createDeviceSshClient({
    spawn,
    os,
    path,
    fsPromises,
    readPrivateKey: (deviceId) => registry.readDeviceSecret(deviceId, 'ssh'),
  });
  const windowsMcp = createWindowsMcpClient({});
  const audit = createDeviceAuditLog({
    fsPromises,
    path,
    storePath: path.join(devicesDir, 'audit.json'),
  });
  const metricsRuntime = createDeviceMetricsRuntime({ sshClient, registry });
  const toolRuntime = createDeviceToolRuntime({
    registry,
    transportResolver,
    sshClient,
    windowsMcp,
    audit,
    metricsRuntime,
  });
  const mcpHandler = createDeviceMcpHandler({
    toolRuntime,
    authenticateToken: (token) => tokens.authenticate(token),
  });
  const statusRuntime = createDeviceStatusRuntime({ net, registry });

  return {
    registry,
    tokens,
    enrollTokens,
    audit,
    toolRuntime,
    mcpHandler,
    statusRuntime,
    metricsRuntime,
    express,
    registerRoutes: (app) => registerDeviceRoutes(app, {
      registry,
      tokens,
      enrollTokens,
      audit,
      toolRuntime,
      mcpHandler,
      statusRuntime,
      express,
    }),
  };
}

export { registerDeviceRoutes };
