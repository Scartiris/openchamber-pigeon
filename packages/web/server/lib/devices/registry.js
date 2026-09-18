import { asBoolean, asFiniteNumber, asNonEmptyString, asObject } from './parse.js';

const REGISTRY_VERSION = 1;
const APPROVAL_MODES = new Set(['deny', 'smart', 'auto']);
// Windows is still the default because the join script and the file tools are
// Windows-only; Linux devices exist so the same monitoring channel can cover
// POSIX hosts without inventing a second device concept.
const DEVICE_PLATFORMS = new Set(['windows', 'linux']);

const nowIso = () => new Date().toISOString();

const safeJsonParse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const normalizePlatform = (value, fallback = 'windows') => {
  const platform = asNonEmptyString(value);
  return platform && DEVICE_PLATFORMS.has(platform) ? platform : fallback;
};

const normalizeConnection = (connection) => {
  const source = asObject(connection) || {};
  const tailscaleRaw = asObject(source.tailscale);
  const tunnelRaw = asObject(source.tunnel);

  const tailscaleHost = tailscaleRaw ? asNonEmptyString(tailscaleRaw.host) : null;
  const tailscale = tailscaleHost
    ? {
      host: tailscaleHost,
      sshPort: asFiniteNumber(tailscaleRaw.sshPort, 22),
      mcpPort: asFiniteNumber(tailscaleRaw.mcpPort, null),
    }
    : null;

  const tunnelSshPort = tunnelRaw ? asFiniteNumber(tunnelRaw.sshPort, null) : null;
  const tunnelMcpPort = tunnelRaw ? asFiniteNumber(tunnelRaw.mcpPort, null) : null;
  // `host` exists because a containerised workbench cannot reach a tunnel that
  // listens on the *host's* loopback: 127.0.0.1 inside the container is the
  // container itself. Deployments record the docker bridge gateway instead.
  const tunnelHost = tunnelRaw ? asNonEmptyString(tunnelRaw.host) : null;
  let tunnel = null;
  if (tunnelSshPort || tunnelMcpPort) {
    tunnel = { sshPort: tunnelSshPort, mcpPort: tunnelMcpPort };
    if (tunnelHost) tunnel.host = tunnelHost;
  }

  return { tailscale, tunnel };
};

const normalizeCapabilities = (capabilities) => {
  const source = asObject(capabilities) || {};
  return {
    shell: source.shell === undefined ? true : asBoolean(source.shell, true),
    files: source.files === undefined ? true : asBoolean(source.files, true),
    screen: asBoolean(source.screen, false),
  };
};

const normalizeAuth = (auth) => {
  const source = asObject(auth) || {};
  return {
    sshUser: asNonEmptyString(source.sshUser) || 'agent',
    sshKeyRef: asNonEmptyString(source.sshKeyRef),
    mcpBearerRef: asNonEmptyString(source.mcpBearerRef),
  };
};

const normalizeApproval = (value) => {
  const mode = asNonEmptyString(value);
  return mode && APPROVAL_MODES.has(mode) ? mode : 'smart';
};

const publicDeviceView = (device) => ({
  id: device.id,
  name: device.name,
  platform: device.platform,
  status: device.status,
  capabilities: device.capabilities,
  connection: device.connection,
  approval: device.approval,
  lastSeenAt: device.lastSeenAt,
  enrolledAt: device.enrolledAt,
  auth: {
    sshUser: device.auth.sshUser,
    hasSshKey: Boolean(device.auth.sshKeyRef),
    hasMcpBearer: Boolean(device.auth.mcpBearerRef),
  },
});

export const createDeviceRegistry = ({ fsPromises, path, crypto, storePath, secretsPath }) => {
  let mutationQueue = Promise.resolve();

  const withMutation = async (fn) => {
    const previous = mutationQueue;
    let release;
    mutationQueue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const generateId = () => `dev_${crypto.randomBytes(8).toString('hex')}`;

  const normalizeDevice = (payload) => {
    const source = asObject(payload);
    if (!source) return null;
    const id = asNonEmptyString(source.id) || generateId();
    const statusRaw = asNonEmptyString(source.status);
    const status = statusRaw === 'online' || statusRaw === 'offline' || statusRaw === 'unknown'
      ? statusRaw
      : 'unknown';
    return {
      id,
      name: asNonEmptyString(source.name) || id,
      platform: normalizePlatform(source.platform),
      status,
      capabilities: normalizeCapabilities(source.capabilities),
      connection: normalizeConnection(source.connection),
      auth: normalizeAuth(source.auth),
      approval: normalizeApproval(source.approval),
      lastSeenAt: asNonEmptyString(source.lastSeenAt),
      enrolledAt: asNonEmptyString(source.enrolledAt) || nowIso(),
    };
  };

  const readStore = async () => {
    try {
      const raw = await fsPromises.readFile(storePath, 'utf8');
      const parsed = asObject(safeJsonParse(raw));
      const devicesRaw = parsed && Array.isArray(parsed.devices) ? parsed.devices : [];
      const devices = devicesRaw.map(normalizeDevice).filter(Boolean);
      return { version: REGISTRY_VERSION, devices };
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: REGISTRY_VERSION, devices: [] };
      throw error;
    }
  };

  const readSecrets = async () => {
    try {
      const raw = await fsPromises.readFile(secretsPath, 'utf8');
      return asObject(safeJsonParse(raw)) || {};
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
  };

  const writeStore = async (store) => {
    await fsPromises.mkdir(path.dirname(storePath), { recursive: true });
    const tempPath = `${storePath}.tmp`;
    await fsPromises.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await fsPromises.rename(tempPath, storePath);
  };

  const writeSecrets = async (secrets) => {
    await fsPromises.mkdir(path.dirname(secretsPath), { recursive: true });
    const tempPath = `${secretsPath}.tmp`;
    await fsPromises.writeFile(tempPath, `${JSON.stringify(secrets, null, 2)}\n`, 'utf8');
    await fsPromises.rename(tempPath, secretsPath);
  };

  const listDevices = async () => {
    const store = await readStore();
    return store.devices.map(publicDeviceView);
  };

  const getDevice = async (id) => {
    const store = await readStore();
    return store.devices.find((device) => device.id === id) || null;
  };

  const createDevice = async (input) => {
    return withMutation(async () => {
      const store = await readStore();
      const secrets = await readSecrets();
      const source = asObject(input) || {};
      const device = normalizeDevice({
        ...source,
        id: generateId(),
        enrolledAt: nowIso(),
        status: source.status || 'unknown',
      });
      if (!device) throw Object.assign(new Error('Invalid device payload'), { statusCode: 400 });

      const secretId = device.id;
      const sshPrivateKey = asNonEmptyString(source.sshPrivateKey);
      if (sshPrivateKey) {
        device.auth.sshKeyRef = secretId;
        secrets[`${secretId}:ssh`] = sshPrivateKey;
      }
      const mcpBearer = asNonEmptyString(source.mcpBearer);
      if (mcpBearer) {
        device.auth.mcpBearerRef = secretId;
        secrets[`${secretId}:mcp`] = mcpBearer;
      }

      store.devices.push(device);
      await writeStore(store);
      await writeSecrets(secrets);
      return publicDeviceView(device);
    });
  };

  const updateDevice = async (id, patch) => {
    return withMutation(async () => {
      const store = await readStore();
      const secrets = await readSecrets();
      const index = store.devices.findIndex((device) => device.id === id);
      if (index < 0) return null;
      const existing = store.devices[index];
      const source = asObject(patch) || {};
      const authPatch = asObject(source.auth) || {};

      const next = normalizeDevice({
        ...existing,
        ...source,
        id: existing.id,
        enrolledAt: existing.enrolledAt,
        platform: normalizePlatform(source.platform, existing.platform),
        auth: {
          sshUser: asNonEmptyString(authPatch.sshUser) || existing.auth.sshUser,
          sshKeyRef: existing.auth.sshKeyRef,
          mcpBearerRef: existing.auth.mcpBearerRef,
        },
        connection: source.connection ? normalizeConnection(source.connection) : existing.connection,
        capabilities: source.capabilities ? normalizeCapabilities(source.capabilities) : existing.capabilities,
        approval: source.approval !== undefined ? normalizeApproval(source.approval) : existing.approval,
      });

      const sshPrivateKey = asNonEmptyString(source.sshPrivateKey);
      if (sshPrivateKey) {
        next.auth.sshKeyRef = existing.id;
        secrets[`${existing.id}:ssh`] = sshPrivateKey;
      }
      const mcpBearer = asNonEmptyString(source.mcpBearer);
      if (mcpBearer) {
        next.auth.mcpBearerRef = existing.id;
        secrets[`${existing.id}:mcp`] = mcpBearer;
      }
      store.devices[index] = next;
      await writeStore(store);
      await writeSecrets(secrets);
      return publicDeviceView(next);
    });
  };

  const deleteDevice = async (id) => {
    return withMutation(async () => {
      const store = await readStore();
      const secrets = await readSecrets();
      const nextDevices = store.devices.filter((device) => device.id !== id);
      if (nextDevices.length === store.devices.length) return false;
      delete secrets[`${id}:ssh`];
      delete secrets[`${id}:mcp`];
      await writeStore({ version: REGISTRY_VERSION, devices: nextDevices });
      await writeSecrets(secrets);
      return true;
    });
  };

  const readDeviceSecret = async (id, kind) => {
    if (kind !== 'ssh' && kind !== 'mcp') return null;
    const secrets = await readSecrets();
    return asNonEmptyString(secrets[`${id}:${kind}`]);
  };

  const touchDevice = async (id, status = 'online') => {
    return withMutation(async () => {
      const store = await readStore();
      const device = store.devices.find((entry) => entry.id === id);
      if (!device) return null;
      device.status = status === 'online' || status === 'offline' || status === 'unknown' ? status : 'online';
      device.lastSeenAt = nowIso();
      await writeStore(store);
      return publicDeviceView(device);
    });
  };

  return {
    listDevices,
    getDevice,
    createDevice,
    updateDevice,
    deleteDevice,
    readDeviceSecret,
    touchDevice,
    publicDeviceView,
  };
};

export const DEVICE_APPROVAL_MODES = [...APPROVAL_MODES];
export const DEVICE_PLATFORM_IDS = [...DEVICE_PLATFORMS];
export { publicDeviceView };
