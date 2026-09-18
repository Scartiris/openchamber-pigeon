import { asFiniteNumber, asNonEmptyString } from '../devices/parse.js';

/**
 * One aggregate snapshot for the header chip and its panel: the workbench host
 * plus every registered device.
 *
 * Shape of the guarantees:
 *  - the host is read once per TTL and never invented (see host-metrics.js);
 *  - a device only gets metrics when its transport actually answered;
 *  - byte rates come from two cumulative samples, so the first poll reports null
 *    instead of a fake 0 B/s;
 *  - failures travel as `error` on the row, never as an empty success.
 */

export const FLEET_SNAPSHOT_TTL_MS = 10_000;
export const FLEET_DEVICE_STATUS_TTL_MS = 10_000;
export const FLEET_DEVICE_METRICS_TTL_MS = 30_000;
export const FLEET_DEVICE_METRICS_STALE_AFTER_MS = 120_000;

const MEMORY_WARN_PERCENT = 80;
const MEMORY_ERROR_PERCENT = 90;
const DISK_WARN_PERCENT = 80;
const DISK_ERROR_PERCENT = 90;

const maxOf = (values) => values.reduce((max, value) => (
  Number.isFinite(value) && (max === null || value > max) ? value : max
), null);

/** Aggregate health of the fleet. Pure, so the panel and the chip agree. */
export const summarizeFleet = ({ host, devices }) => {
  const rows = Array.isArray(devices) ? devices : [];
  const online = rows.filter((row) => row.online).length;
  const metricsErrors = rows.filter((row) => row.online && row.error).length;
  const hostDiskPercent = maxOf((host?.disks || []).map((disk) => disk.usedPercent));
  const deviceDiskPercent = maxOf(rows.flatMap((row) => (row.metrics?.disks || []).map((disk) => disk.usedPercent)));
  const worstDiskPercent = maxOf([hostDiskPercent, deviceDiskPercent]);
  const memPercent = asFiniteNumber(host?.memory?.usedPercent, null);
  const swapPercent = asFiniteNumber(host?.memory?.swapUsedPercent, null);

  let severity = 'ok';
  const bump = (level) => {
    const order = { ok: 0, warn: 1, error: 2 };
    if (order[level] > order[severity]) severity = level;
  };

  if (!host?.ok || host?.stale) bump('error');
  if (metricsErrors > 0) bump('warn');
  if (rows.length > online) bump('warn');
  if ((memPercent ?? 0) >= MEMORY_WARN_PERCENT || (worstDiskPercent ?? 0) >= DISK_WARN_PERCENT) bump('warn');
  if ((memPercent ?? 0) >= MEMORY_ERROR_PERCENT || (worstDiskPercent ?? 0) >= DISK_ERROR_PERCENT) bump('error');

  return {
    severity,
    hostOk: Boolean(host?.ok),
    hostStale: Boolean(host?.stale),
    hostMemPercent: memPercent,
    hostSwapPercent: swapPercent,
    hostDiskPercent: hostDiskPercent,
    hostSource: asNonEmptyString(host?.source) || null,
    devicesTotal: rows.length,
    devicesOnline: online,
    devicesWithMetrics: rows.filter((row) => row.metrics).length,
    devicesWithErrors: metricsErrors,
    worstDiskPercent,
  };
};

export const createFleetSnapshotRuntime = ({
  hostReader,
  registry,
  statusRuntime,
  toolRuntime,
  now = () => Date.now(),
  hostTtlMs = FLEET_SNAPSHOT_TTL_MS,
  deviceStatusTtlMs = FLEET_DEVICE_STATUS_TTL_MS,
  deviceMetricsTtlMs = FLEET_DEVICE_METRICS_TTL_MS,
  deviceMetricsStaleAfterMs = FLEET_DEVICE_METRICS_STALE_AFTER_MS,
}) => {
  /** Cumulative counters per device, for the next rate computation. */
  const rateSamples = new Map();
  const metricsCache = new Map();
  let deviceStatusCache = null;
  let snapshotCache = null;
  let snapshotAt = 0;
  let inFlight = null;

  const applyRates = (deviceId, metrics, atMs) => {
    const interfaces = Array.isArray(metrics?.network?.interfaces) ? metrics.network.interfaces : [];
    const previous = rateSamples.get(deviceId) || null;
    const elapsedSec = previous ? (atMs - previous.at) / 1000 : 0;
    const nextSamples = new Map();

    const enriched = interfaces.map((iface) => {
      const rx = asFiniteNumber(iface.rxBytes, null);
      const tx = asFiniteNumber(iface.txBytes, null);
      const prior = previous?.interfaces?.get(iface.name) || null;
      let rxBytesPerSec = null;
      let txBytesPerSec = null;
      if (prior && elapsedSec >= 0.5 && rx !== null && tx !== null) {
        // A reboot resets the counters; a negative delta is "no reading yet",
        // not a negative rate.
        rxBytesPerSec = rx >= prior.rx ? Math.round((rx - prior.rx) / elapsedSec) : null;
        txBytesPerSec = tx >= prior.tx ? Math.round((tx - prior.tx) / elapsedSec) : null;
      }
      if (rx !== null && tx !== null) nextSamples.set(iface.name, { rx, tx });
      return { ...iface, rxBytesPerSec, txBytesPerSec };
    });

    rateSamples.set(deviceId, { at: atMs, interfaces: nextSamples });

    const totalRx = enriched.reduce((sum, iface) => sum + (iface.rxBytesPerSec ?? 0), 0);
    const totalTx = enriched.reduce((sum, iface) => sum + (iface.txBytesPerSec ?? 0), 0);

    return {
      ...metrics,
      network: {
        ...metrics.network,
        interfaces: enriched,
        windowSec: previous ? Math.round(elapsedSec) : null,
        totalRxBytesPerSec: previous ? totalRx : null,
        totalTxBytesPerSec: previous ? totalTx : null,
      },
    };
  };

  const readDeviceState = async (atMs) => {
    if (deviceStatusCache && atMs - deviceStatusCache.at < deviceStatusTtlMs) {
      return deviceStatusCache.value;
    }
    const [status, devices] = await Promise.all([
      statusRuntime.listStatus(),
      registry.listDevices(),
    ]);
    const records = new Map(devices.map((device) => [device.id, device]));
    const rows = (status.devices || []).map((entry) => {
      const record = records.get(entry.id) || null;
      return {
        ...entry,
        platform: record?.platform || 'windows',
        approval: record?.approval || 'smart',
        capabilities: record?.capabilities || null,
      };
    });
    const value = { checkedAt: status.checkedAt, onlineCount: status.onlineCount, total: status.total, rows };
    deviceStatusCache = { at: atMs, value };
    return value;
  };

  const collectMetrics = async ({ row, atMs }) => {
    const cached = metricsCache.get(row.id);
    if (cached && atMs - cached.at < deviceMetricsTtlMs) {
      // Serve the cached *enriched* view, rates included. Recomputing rates for a
      // cached sample would use the same observation time twice, collapsing the
      // window to 0 and reporting null rates on every refresh inside the TTL.
      return cached.value;
    }
    if (!row?.ssh?.ok) {
      return { ok: false, error: { code: 'transport_unavailable', message: 'Device SSH transport is unreachable' } };
    }
    try {
      const result = await toolRuntime.callTool({
        tool: 'devices.metrics',
        args: { device_id: row.id },
        actor: 'ui-fleet',
        // Timer-driven reads must not flush the 500-entry audit ring.
        audit: false,
      });
      const value = result?.ok
        ? { ok: true, metrics: applyRates(row.id, result.data, atMs), observedAtMs: atMs }
        : {
          ok: false,
          error: {
            code: asNonEmptyString(result?.error?.code) || 'upstream_error',
            message: asNonEmptyString(result?.error?.message) || 'Device metrics failed',
          },
        };
      metricsCache.set(row.id, { at: atMs, value });
      return value;
    } catch (error) {
      const value = {
        ok: false,
        error: { code: asNonEmptyString(error?.code) || 'upstream_error', message: String(error?.message || error) },
      };
      metricsCache.set(row.id, { at: atMs, value });
      return value;
    }
  };

  const buildDeviceRow = async ({ row, atMs }) => {
    const collected = row.online ? await collectMetrics({ row, atMs }) : {
      ok: false,
      error: { code: 'device_offline', message: 'Device is offline' },
    };

    if (!collected.ok) {
      return {
        id: row.id,
        name: row.name,
        platform: row.platform,
        approval: row.approval,
        online: row.online,
        latencyMs: row.latencyMs ?? null,
        transport: row.transport ?? null,
        checkedAt: row.checkedAt ?? null,
        metrics: null,
        metricsAgeMs: null,
        metricsStale: true,
        error: collected.error,
      };
    }

    // Age is measured on the workbench clock: a device whose own clock is wrong
    // would otherwise produce a bogus "stale". Rates were computed when the
    // sample was taken (see collectMetrics) and are carried through unchanged.
    const observedAtMs = asFiniteNumber(collected.observedAtMs, atMs) ?? atMs;
    const metricsAgeMs = Math.max(0, atMs - observedAtMs);

    return {
      id: row.id,
      name: row.name,
      platform: row.platform,
      approval: row.approval,
      online: row.online,
      latencyMs: row.latencyMs ?? null,
      transport: row.transport ?? null,
      checkedAt: row.checkedAt ?? null,
      metrics: collected.metrics,
      metricsAgeMs,
      metricsStale: metricsAgeMs > deviceMetricsStaleAfterMs,
      error: null,
    };
  };

  const build = async ({ atMs }) => {
    const host = await hostReader.read({ nowMs: atMs });
    const state = await readDeviceState(atMs);
    const devices = await Promise.all(state.rows.map((row) => buildDeviceRow({ row, atMs })));
    const summary = summarizeFleet({ host, devices });
    return {
      checkedAt: new Date(atMs).toISOString(),
      cached: false,
      host,
      devices: {
        checkedAt: state.checkedAt,
        total: state.total ?? devices.length,
        onlineCount: state.onlineCount ?? devices.filter((row) => row.online).length,
        items: devices,
      },
      summary,
    };
  };

  const read = async ({ force = false } = {}) => {
    const atMs = now();
    if (!force && snapshotCache && atMs - snapshotAt < hostTtlMs) {
      return { ...snapshotCache, cached: true };
    }
    // A forced read during an in-flight read joins it: two concurrent polls of a
    // 20s device probe must not spawn two SSH fleets.
    if (inFlight) return inFlight;

    const task = build({ atMs });
    inFlight = task;
    try {
      const snapshot = await task;
      snapshotCache = snapshot;
      snapshotAt = atMs;
      return snapshot;
    } finally {
      if (inFlight === task) inFlight = null;
    }
  };

  const invalidate = () => {
    snapshotCache = null;
    snapshotAt = 0;
    deviceStatusCache = null;
  };

  return { read, invalidate, summarizeFleet };
};
