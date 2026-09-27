import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  isBooleanValue,
  isNonEmptyString,
  isPlainRecord,
  type JsonValue,
} from '@/lib/fleet/guards';

export type DeviceMountHealthState = 'absent' | 'disabled' | 'mounting' | 'ready';

export type DeviceMountHealth = {
  state: DeviceMountHealthState;
  mountRoot: string | null;
  remoteRoot: string | null;
  enabled: boolean;
};

export type DeviceMountEntry = {
  deviceId: string;
  slug: string;
  remoteRoot: string;
  mountRoot: string;
  sftpPath: string;
  enabled: boolean;
};

export type DeviceMountPayload = {
  deviceId: string;
  mount: DeviceMountEntry | null;
  health: DeviceMountHealth;
  projectPath: string | null;
};

export type DeviceListEntry = {
  id: string;
  name: string;
  status: string;
  capabilities: { shell: boolean; files: boolean; screen: boolean };
};

export type DeviceBrowseEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

const asText = (value: JsonValue | undefined): string => (isNonEmptyString(value) ? value : '');

const asRecord = (value: JsonValue | undefined): { [key: string]: JsonValue } | null => (
  isPlainRecord(value) ? value : null
);

const parseHealthState = (value: JsonValue | undefined): DeviceMountHealthState => {
  const text = asText(value);
  if (text === 'ready' || text === 'disabled' || text === 'mounting' || text === 'absent') {
    return text;
  }
  // Older payloads used `unavailable` for the not-ready case.
  return 'mounting';
};

const parseMountEntry = (value: JsonValue | undefined): DeviceMountEntry | null => {
  const source = asRecord(value);
  if (!source) return null;
  const deviceId = asText(source.deviceId);
  const remoteRoot = asText(source.remoteRoot);
  const mountRoot = asText(source.mountRoot);
  if (!deviceId || !remoteRoot || !mountRoot) return null;
  return {
    deviceId,
    slug: asText(source.slug) || deviceId,
    remoteRoot,
    mountRoot,
    sftpPath: asText(source.sftpPath),
    enabled: source.enabled === undefined ? true : isBooleanValue(source.enabled) ? source.enabled : true,
  };
};

const parseHealth = (value: JsonValue | undefined): DeviceMountHealth => {
  const source = asRecord(value) || {};
  return {
    state: parseHealthState(source.state),
    mountRoot: isNonEmptyString(source.mountRoot) ? source.mountRoot : null,
    remoteRoot: isNonEmptyString(source.remoteRoot) ? source.remoteRoot : null,
    enabled: isBooleanValue(source.enabled) ? source.enabled : false,
  };
};

const parseMountPayload = (payload: JsonValue): DeviceMountPayload | null => {
  const source = asRecord(payload);
  if (!source) return null;
  return {
    deviceId: asText(source.deviceId),
    mount: parseMountEntry(source.mount),
    health: parseHealth(source.health),
    projectPath: isNonEmptyString(source.projectPath) ? source.projectPath : null,
  };
};

/** Parse PowerShell `Get-ChildItem | ConvertTo-Json` output (object or array). */
export const parseDeviceDirectoryListing = (
  stdout: string,
  parentPath: string,
): DeviceBrowseEntry[] => {
  const raw = stdout.trim();
  if (!raw) return [];
  let parsed: JsonValue;
  try {
    // SAFETY: JSON.parse is the I/O boundary; every row is re-checked below.
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    return [];
  }
  const rows: JsonValue[] = Array.isArray(parsed) ? parsed : [parsed];
  const normalizedParent = parentPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const entries: DeviceBrowseEntry[] = [];
  for (const row of rows) {
    const source = asRecord(row);
    if (!source) continue;
    const name = asText(source.Name) || asText(source.name);
    if (!name) continue;
    const mode = asText(source.Mode) || asText(source.mode);
    // Windows Mode string starts with 'd' for directories.
    const isDirectory = mode.toLowerCase().startsWith('d') || source.PSIsContainer === true;
    const joined = normalizedParent ? `${normalizedParent}/${name}` : name;
    entries.push({
      name,
      path: joined.replace(/\\/g, '/'),
      isDirectory,
    });
  }
  return entries;
};

const readJson = async (response: Response): Promise<JsonValue> => {
  // SAFETY: `response.json()` is the JSON I/O boundary; parsers treat every
  // field as untrusted and never invent a plausible value.
  return await response.json() as JsonValue;
};

export const listDeviceDirectories = async (
  deviceId: string,
  remotePath: string,
): Promise<DeviceBrowseEntry[]> => {
  const response = await runtimeFetch(`/api/devices/${encodeURIComponent(deviceId)}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ tool: 'devices.fs.list', args: { path: remotePath } }),
  });
  if (!response.ok) {
    throw new Error(`Failed to list device directory (${response.status})`);
  }
  const payload = await readJson(response);
  const root = asRecord(payload);
  const result = root ? asRecord(root.result) : null;
  if (!result || result.ok !== true) {
    const error = result ? asRecord(result.error) : null;
    throw new Error(error ? asText(error.message) || 'Device directory listing failed' : 'Device directory listing failed');
  }
  const data = asRecord(result.data);
  return parseDeviceDirectoryListing(data ? asText(data.stdout) : '', remotePath);
};

export const readDeviceMount = async (deviceId: string): Promise<DeviceMountPayload> => {
  const response = await runtimeFetch(`/api/devices/${encodeURIComponent(deviceId)}/mount`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Failed to read device mount (${response.status})`);
  }
  const parsed = parseMountPayload(await readJson(response));
  if (!parsed) throw new Error('Unexpected device mount payload');
  return parsed;
};

export const ensureDeviceMount = async (
  deviceId: string,
  input: { remoteRoot: string; remotePath: string },
): Promise<DeviceMountPayload> => {
  const response = await runtimeFetch(`/api/devices/${encodeURIComponent(deviceId)}/mount/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ remoteRoot: input.remoteRoot, remotePath: input.remotePath }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const source = asRecord(payload);
    throw new Error(source ? asText(source.error) || `Failed to ensure device mount (${response.status})` : `Failed to ensure device mount (${response.status})`);
  }
  const parsed = parseMountPayload(payload);
  if (!parsed) throw new Error('Unexpected device mount payload');
  return parsed;
};

/**
 * Poll until the host mount is `ready`. The host helper mounts on a timer, so
 * the first ensure only records intent — callers must not register a project
 * against a path that is still empty.
 */
export const waitForDeviceMountReady = async (
  deviceId: string,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<DeviceMountPayload> => {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const intervalMs = options?.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let last: DeviceMountPayload | null = null;
  for (;;) {
    last = await readDeviceMount(deviceId);
    if (last.health.state === 'ready') return last;
    if (Date.now() >= deadline) {
      throw new Error(`Device mount is not ready (${last.health.state})`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

export const listMountedDevices = async (): Promise<DeviceListEntry[]> => {
  const response = await runtimeFetch('/api/devices', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Failed to list devices (${response.status})`);
  }
  const payload = await readJson(response);
  const source = asRecord(payload);
  const devicesRaw = source && Array.isArray(source.devices) ? source.devices : [];
  const devices: DeviceListEntry[] = [];
  for (const row of devicesRaw) {
    const entry = asRecord(row);
    if (!entry) continue;
    const id = asText(entry.id);
    if (!id) continue;
    const caps = asRecord(entry.capabilities) || {};
    const capabilities = {
      shell: caps.shell !== false,
      files: caps.files !== false,
      screen: caps.screen === true,
    };
    if (!capabilities.files) continue;
    devices.push({
      id,
      name: asText(entry.name) || id,
      status: asText(entry.status) || 'unknown',
      capabilities,
    });
  }
  return devices;
};
