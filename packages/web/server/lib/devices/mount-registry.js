import { asBoolean, asNonEmptyString, asObject } from './parse.js';
import {
  deviceMountSlug,
  normalizeWindowsPath,
  projectPathFromRemote,
  windowsPathToSftp,
} from './project-paths.js';

export const MOUNT_REGISTRY_VERSION = 1;
export const DEFAULT_MOUNT_PARENT = '/mnt/oc-devices';

const nowIso = () => new Date().toISOString();

const safeJsonParse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const fail = (message, code, statusCode = 400) =>
  Object.assign(new Error(message), { code, statusCode });

/**
 * Declarative mount registry shared with the host-side `oc-device-mounts`
 * helper. OpenChamber only writes intent and reports health; the host performs
 * sshfs/unmount. Lives in the OpenChamber data dir so the helper can read it
 * through the existing bind mount.
 */
export const createDeviceMountRegistry = ({ fsPromises, path, storePath, mountParent = DEFAULT_MOUNT_PARENT }) => {
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

  const normalizeEntry = (input) => {
    const source = asObject(input) || {};
    const deviceId = asNonEmptyString(source.deviceId);
    if (!deviceId) return null;
    const remoteRoot = normalizeWindowsPath(source.remoteRoot);
    if (!remoteRoot) return null;
    const slug = deviceMountSlug(deviceId);
    const mountRoot = `${String(mountParent).replace(/\/+$/, '')}/${slug}`;
    const sshSource = asObject(source.ssh) || {};
    const sshHost = asNonEmptyString(sshSource.host);
    const sshPort = Number.isFinite(Number(sshSource.port)) ? Number(sshSource.port) : 22;
    const sshUser = asNonEmptyString(sshSource.user) || 'agent';
    return {
      deviceId,
      slug,
      remoteRoot,
      mountRoot,
      sftpPath: windowsPathToSftp(remoteRoot),
      ssh: {
        host: sshHost || '',
        port: sshPort,
        user: sshUser,
      },
      keyRef: asNonEmptyString(source.keyRef) || `${deviceId}:ssh`,
      enabled: source.enabled === undefined ? true : asBoolean(source.enabled, true),
      updatedAt: asNonEmptyString(source.updatedAt) || nowIso(),
    };
  };

  const readStore = async () => {
    try {
      const raw = await fsPromises.readFile(storePath, 'utf8');
      const parsed = asObject(safeJsonParse(raw));
      const mountsRaw = parsed && Array.isArray(parsed.mounts) ? parsed.mounts : [];
      const mounts = mountsRaw.map(normalizeEntry).filter(Boolean);
      return { version: MOUNT_REGISTRY_VERSION, mounts };
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: MOUNT_REGISTRY_VERSION, mounts: [] };
      throw error;
    }
  };

  const writeStore = async (store) => {
    await fsPromises.mkdir(path.dirname(storePath), { recursive: true });
    const tempPath = `${storePath}.tmp`;
    await fsPromises.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await fsPromises.rename(tempPath, storePath);
  };

  const listMounts = async () => (await readStore()).mounts;

  const getMount = async (deviceId) => {
    const mounts = await listMounts();
    return mounts.find((entry) => entry.deviceId === deviceId) || null;
  };

  const upsertMount = async ({ deviceId, remoteRoot, ssh, enabled = true, keyRef }) => {
    return withMutation(async () => {
      const entry = normalizeEntry({
        deviceId,
        remoteRoot,
        ssh,
        enabled,
        keyRef,
        updatedAt: nowIso(),
      });
      if (!entry) {
        throw fail('deviceId and remoteRoot are required', 'invalid_input', 400);
      }
      if (!entry.ssh.host) {
        throw fail('Device SSH host is not configured', 'transport_unavailable', 400);
      }
      const store = await readStore();
      const index = store.mounts.findIndex((item) => item.deviceId === deviceId);
      if (index >= 0) store.mounts[index] = entry;
      else store.mounts.push(entry);
      await writeStore(store);
      return entry;
    });
  };

  const disableMount = async (deviceId) => {
    return withMutation(async () => {
      const store = await readStore();
      const index = store.mounts.findIndex((item) => item.deviceId === deviceId);
      if (index < 0) return null;
      store.mounts[index] = { ...store.mounts[index], enabled: false, updatedAt: nowIso() };
      await writeStore(store);
      return store.mounts[index];
    });
  };

  /**
   * Health for a mount root as the container sees it.
   * - `ready`: mountRoot is a readable directory
   * - `mounting`: registered and enabled but not a directory yet (host timer pending or stale)
   * - `disabled`: registry entry exists but enabled=false
   * - `absent`: no registry entry
   */
  const healthFor = async (deviceId) => {
    const entry = await getMount(deviceId);
    if (!entry) return { state: 'absent', mountRoot: null, remoteRoot: null, enabled: false };
    if (!entry.enabled) {
      return {
        state: 'disabled',
        mountRoot: entry.mountRoot,
        remoteRoot: entry.remoteRoot,
        enabled: false,
      };
    }
    try {
      const stat = await fsPromises.stat(entry.mountRoot);
      const ready = stat.isDirectory();
      return {
        state: ready ? 'ready' : 'mounting',
        mountRoot: entry.mountRoot,
        remoteRoot: entry.remoteRoot,
        enabled: true,
      };
    } catch {
      return {
        state: 'mounting',
        mountRoot: entry.mountRoot,
        remoteRoot: entry.remoteRoot,
        enabled: true,
      };
    }
  };

  return {
    storePath,
    mountParent,
    listMounts,
    getMount,
    upsertMount,
    disableMount,
    healthFor,
  };
};
