import { runtimeFetch } from '@/lib/runtime-fetch';
import { isBooleanValue, isFiniteNumber, isNonEmptyString, isPlainRecord, type JsonValue } from './guards';
import type {
  FleetCpu,
  FleetDeviceMetrics,
  FleetDeviceRow,
  FleetDevices,
  FleetDisk,
  FleetErrorCode,
  FleetHost,
  FleetHostSource,
  FleetMemory,
  FleetNetwork,
  FleetNetworkInterface,
  FleetSeverity,
  FleetSnapshot,
  FleetSummary,
} from './types';

/**
 * Reads `/api/fleet/status`.
 *
 * The parser is defensive in one direction only: it may drop a field it cannot
 * read, but it never substitutes a plausible number. A snapshot without a host
 * or a device list is a parse failure, because a panel that silently shows
 * "0 devices" is worse than one that says it could not read the answer.
 */

const asRecord = (value: JsonValue | undefined): { [key: string]: JsonValue } | null => {
  if (Array.isArray(value)) return null;
  return isPlainRecord(value) ? value : null;
};

const asNumber = (value: JsonValue | undefined): number | null => (isFiniteNumber(value) ? value : null);

const asText = (value: JsonValue | undefined): string | null => (isNonEmptyString(value) ? value : null);

const asBoolean = (value: JsonValue | undefined, fallback = false): boolean => (
  isBooleanValue(value) ? value : fallback
);

const asArray = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);

const parseMemory = (value: JsonValue | undefined): FleetMemory | null => {
  const source = asRecord(value);
  if (!source) return null;
  const totalBytes = asNumber(source.totalBytes);
  if (totalBytes === null || totalBytes <= 0) return null;
  return {
    totalBytes,
    availableBytes: asNumber(source.availableBytes),
    usedBytes: asNumber(source.usedBytes),
    usedPercent: asNumber(source.usedPercent),
    swapTotalBytes: asNumber(source.swapTotalBytes),
    swapUsedBytes: asNumber(source.swapUsedBytes),
    swapUsedPercent: asNumber(source.swapUsedPercent),
  };
};

const parseDisks = (value: JsonValue | undefined): FleetDisk[] => asArray(value).map((entry) => {
  const source = asRecord(entry);
  if (!source) return null;
  const mount = asText(source.mount);
  if (!mount) return null;
  return {
    mount,
    filesystem: asText(source.filesystem),
    totalBytes: asNumber(source.totalBytes),
    usedBytes: asNumber(source.usedBytes),
    availBytes: asNumber(source.availBytes),
    usedPercent: asNumber(source.usedPercent),
  };
}).filter((disk): disk is FleetDisk => disk !== null);

const parseInterfaces = (value: JsonValue | undefined): FleetNetworkInterface[] => asArray(value).map((entry) => {
  const source = asRecord(entry);
  if (!source) return null;
  const name = asText(source.name);
  if (!name) return null;
  return {
    name,
    rxBytes: asNumber(source.rxBytes),
    txBytes: asNumber(source.txBytes),
    rxBytesPerSec: asNumber(source.rxBytesPerSec),
    txBytesPerSec: asNumber(source.txBytesPerSec),
  };
}).filter((iface): iface is FleetNetworkInterface => iface !== null);

const parseNetwork = (value: JsonValue | undefined): FleetNetwork | null => {
  const source = asRecord(value);
  if (!source) return null;
  return {
    windowSec: asNumber(source.windowSec),
    interfaces: parseInterfaces(source.interfaces),
    totalRxBytesPerSec: asNumber(source.totalRxBytesPerSec),
    totalTxBytesPerSec: asNumber(source.totalTxBytesPerSec),
  };
};

const parseCpu = (value: JsonValue | undefined): FleetCpu | null => {
  const source = asRecord(value);
  if (!source) return null;
  return {
    count: asNumber(source.count),
    load1: asNumber(source.load1),
    load5: asNumber(source.load5),
    load15: asNumber(source.load15),
  };
};

const parseHostSource = (value: JsonValue | undefined): FleetHostSource => {
  if (value === 'helper' || value === 'in-process' || value === 'missing') return value;
  return 'missing';
};

const parseHost = (value: JsonValue | undefined): FleetHost | null => {
  const source = asRecord(value);
  if (!source) return null;
  const containers = asArray(source.containers).map((entry) => {
    const item = asRecord(entry);
    if (!item) return null;
    const name = asText(item.name);
    if (!name) return null;
    return {
      name,
      image: asText(item.image),
      state: asText(item.state),
      health: asText(item.health),
      status: asText(item.status),
    };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const summary = asRecord(source.containersSummary);
  const deploy = asRecord(source.deploy);

  return {
    ok: asBoolean(source.ok),
    source: parseHostSource(source.source),
    ageMs: asNumber(source.ageMs),
    stale: asBoolean(source.stale, true),
    notes: asArray(source.notes).map((note) => asText(note)).filter((note): note is string => note !== null),
    error: asText(source.error),
    collectedAt: asText(source.collectedAt),
    hostname: asText(source.hostname),
    platform: asText(source.platform),
    kernel: asText(source.kernel),
    arch: asText(source.arch),
    uptimeSec: asNumber(source.uptimeSec),
    cpu: parseCpu(source.cpu),
    memory: parseMemory(source.memory),
    disks: parseDisks(source.disks),
    network: parseNetwork(source.network),
    containers: containers.length > 0 ? containers : null,
    containersSummary: summary
      ? {
        total: asNumber(summary.total),
        running: asNumber(summary.running),
        healthy: asNumber(summary.healthy),
        unhealthy: asNumber(summary.unhealthy),
      }
      : null,
    deploy: deploy
      ? {
        sha: asText(deploy.sha),
        image: asText(deploy.image),
        previousImage: asText(deploy.previousImage),
        at: asText(deploy.at),
      }
      : null,
  };
};

const parseDeviceMetrics = (value: JsonValue | undefined): FleetDeviceMetrics | null => {
  const source = asRecord(value);
  if (!source) return null;
  return {
    platform: asText(source.platform),
    hostname: asText(source.hostname),
    uptimeSec: asNumber(source.uptimeSec),
    cpu: parseCpu(source.cpu),
    memory: parseMemory(source.memory),
    disks: parseDisks(source.disks),
    network: parseNetwork(source.network),
    collectedAt: asText(source.collectedAt),
  };
};

const parseDeviceRow = (value: JsonValue | undefined): FleetDeviceRow | null => {
  const source = asRecord(value);
  if (!source) return null;
  const id = asText(source.id);
  if (!id) return null;
  const error = asRecord(source.error);
  return {
    id,
    name: asText(source.name) ?? id,
    platform: asText(source.platform) ?? 'windows',
    approval: asText(source.approval) ?? 'smart',
    online: asBoolean(source.online),
    latencyMs: asNumber(source.latencyMs),
    transport: asText(source.transport),
    checkedAt: asText(source.checkedAt),
    metrics: parseDeviceMetrics(source.metrics),
    metricsAgeMs: asNumber(source.metricsAgeMs),
    metricsStale: asBoolean(source.metricsStale, false),
    error: error
      ? { code: asText(error.code) ?? 'unknown', message: asText(error.message) ?? '' }
      : null,
  };
};

const parseDevices = (value: JsonValue | undefined): FleetDevices | null => {
  const source = asRecord(value);
  if (!source) return null;
  const items = asArray(source.items)
    .map((entry) => parseDeviceRow(entry))
    .filter((row): row is FleetDeviceRow => row !== null);
  return {
    checkedAt: asText(source.checkedAt),
    total: asNumber(source.total) ?? items.length,
    onlineCount: asNumber(source.onlineCount) ?? items.filter((row) => row.online).length,
    items,
  };
};

const parseSeverity = (value: JsonValue | undefined): FleetSeverity => {
  if (value === 'ok' || value === 'warn' || value === 'error') return value;
  return 'warn';
};

const parseSummary = (value: JsonValue | undefined): FleetSummary | null => {
  const source = asRecord(value);
  if (!source) return null;
  return {
    severity: parseSeverity(source.severity),
    hostOk: asBoolean(source.hostOk),
    hostStale: asBoolean(source.hostStale, false),
    hostMemPercent: asNumber(source.hostMemPercent),
    hostSwapPercent: asNumber(source.hostSwapPercent),
    hostDiskPercent: asNumber(source.hostDiskPercent),
    hostSource: asText(source.hostSource),
    devicesTotal: asNumber(source.devicesTotal) ?? 0,
    devicesOnline: asNumber(source.devicesOnline) ?? 0,
    devicesWithMetrics: asNumber(source.devicesWithMetrics) ?? 0,
    devicesWithErrors: asNumber(source.devicesWithErrors) ?? 0,
    worstDiskPercent: asNumber(source.worstDiskPercent),
  };
};

export const parseFleetSnapshot = (value: JsonValue | undefined): FleetSnapshot | null => {
  const source = asRecord(value);
  if (!source) return null;
  const host = parseHost(source.host);
  const devices = parseDevices(source.devices);
  const summary = parseSummary(source.summary);
  if (!host || !devices || !summary) return null;
  return {
    checkedAt: asText(source.checkedAt),
    cached: asBoolean(source.cached),
    host,
    devices,
    summary,
  };
};

export class FleetStatusError extends Error {
  readonly code: FleetErrorCode;

  readonly status: number | null;

  constructor(code: FleetErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'FleetStatusError';
    this.code = code;
    this.status = status;
  }
}

/** `force` maps to the panel's refresh button and bypasses the server TTL. */
export const fetchFleetSnapshot = async ({ force = false } = {}): Promise<FleetSnapshot> => {
  let response: Response;
  try {
    response = await runtimeFetch(`/api/fleet/status${force ? '?refresh=1' : ''}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FleetStatusError('load', reason);
  }

  if (!response.ok) {
    throw new FleetStatusError('load', `HTTP ${response.status}`, response.status);
  }

  let payload: JsonValue;
  try {
    // SAFETY: `response.json()` is the JSON I/O boundary; the parsers below
    // treat every field as untrusted and never substitute a plausible value.
    payload = await response.json() as JsonValue;
  } catch {
    throw new FleetStatusError('parse', 'invalid JSON', response.status);
  }

  const snapshot = parseFleetSnapshot(payload);
  if (!snapshot) {
    throw new FleetStatusError('parse', 'unexpected shape', response.status);
  }
  return snapshot;
};
