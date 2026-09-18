/** Mirrors `packages/web/server/lib/fleet` — the snapshot the header chip reads. */

export type FleetSeverity = 'ok' | 'warn' | 'error';

export type FleetHostSource = 'helper' | 'in-process' | 'missing';

export interface FleetMemory {
  totalBytes: number | null;
  availableBytes: number | null;
  usedBytes: number | null;
  usedPercent: number | null;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
  swapUsedPercent: number | null;
}

export interface FleetDisk {
  mount: string;
  filesystem: string | null;
  totalBytes: number | null;
  usedBytes: number | null;
  availBytes: number | null;
  usedPercent: number | null;
}

export interface FleetNetworkInterface {
  name: string;
  rxBytes: number | null;
  txBytes: number | null;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
}

export interface FleetNetwork {
  windowSec: number | null;
  interfaces: FleetNetworkInterface[];
  totalRxBytesPerSec: number | null;
  totalTxBytesPerSec: number | null;
}

export interface FleetContainer {
  name: string;
  image: string | null;
  state: string | null;
  health: string | null;
  status: string | null;
}

export interface FleetContainersSummary {
  total: number | null;
  running: number | null;
  healthy: number | null;
  unhealthy: number | null;
}

export interface FleetCpu {
  count: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
}

export interface FleetHost {
  ok: boolean;
  source: FleetHostSource;
  ageMs: number | null;
  stale: boolean;
  notes: string[];
  error: string | null;
  collectedAt: string | null;
  hostname: string | null;
  platform: string | null;
  kernel: string | null;
  arch: string | null;
  uptimeSec: number | null;
  cpu: FleetCpu | null;
  memory: FleetMemory | null;
  disks: FleetDisk[];
  network: FleetNetwork | null;
  containers: FleetContainer[] | null;
  containersSummary: FleetContainersSummary | null;
  deploy: { sha: string | null; image: string | null; previousImage: string | null; at: string | null } | null;
}

export interface FleetDeviceMetrics {
  platform: string | null;
  hostname: string | null;
  uptimeSec: number | null;
  cpu: FleetCpu | null;
  memory: FleetMemory | null;
  disks: FleetDisk[];
  network: FleetNetwork | null;
  collectedAt: string | null;
}

export interface FleetDeviceError {
  code: string;
  message: string;
}

export interface FleetDeviceRow {
  id: string;
  name: string;
  platform: string;
  approval: string;
  online: boolean;
  latencyMs: number | null;
  transport: string | null;
  checkedAt: string | null;
  metrics: FleetDeviceMetrics | null;
  metricsAgeMs: number | null;
  metricsStale: boolean;
  error: FleetDeviceError | null;
}

export interface FleetDevices {
  checkedAt: string | null;
  total: number;
  onlineCount: number;
  items: FleetDeviceRow[];
}

export interface FleetSummary {
  severity: FleetSeverity;
  hostOk: boolean;
  hostStale: boolean;
  hostMemPercent: number | null;
  hostSwapPercent: number | null;
  hostDiskPercent: number | null;
  hostSource: string | null;
  devicesTotal: number;
  devicesOnline: number;
  devicesWithMetrics: number;
  devicesWithErrors: number;
  worstDiskPercent: number | null;
}

export interface FleetSnapshot {
  checkedAt: string | null;
  cached: boolean;
  host: FleetHost;
  devices: FleetDevices;
  summary: FleetSummary;
}

export type FleetErrorCode = 'load' | 'parse';

export interface FleetError {
  code: FleetErrorCode;
  status: number | null;
  message: string;
}
