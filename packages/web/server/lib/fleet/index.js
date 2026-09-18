import {
  HOST_METRICS_FILE_NAME,
  HOST_METRICS_STALE_AFTER_MS,
  createHostMetricsReader,
} from './host-metrics.js';
import {
  FLEET_DEVICE_METRICS_TTL_MS,
  FLEET_SNAPSHOT_TTL_MS,
  createFleetSnapshotRuntime,
  summarizeFleet,
} from './snapshot.js';
import { registerFleetRoutes } from './routes.js';

/**
 * Composition root for the fleet panel: host metrics (helper file, with an
 * in-process fallback) plus every registered device, read through the existing
 * device transport/approval/audit machinery.
 */
export const createFleetRuntime = ({
  fsPromises,
  path,
  os,
  spawn,
  openchamberDataDir,
  deviceRuntime,
  env,
  now,
}) => {
  const hostReader = createHostMetricsReader({
    fsPromises,
    path,
    os,
    spawn,
    openchamberDataDir,
    env,
  });

  const snapshotRuntime = createFleetSnapshotRuntime({
    hostReader,
    registry: deviceRuntime.registry,
    statusRuntime: deviceRuntime.statusRuntime,
    toolRuntime: deviceRuntime.toolRuntime,
    now,
  });

  return {
    hostReader,
    snapshotRuntime,
    registerRoutes: (app) => registerFleetRoutes(app, { snapshotRuntime }),
  };
};

export {
  FLEET_DEVICE_METRICS_TTL_MS,
  FLEET_SNAPSHOT_TTL_MS,
  HOST_METRICS_FILE_NAME,
  HOST_METRICS_STALE_AFTER_MS,
  registerFleetRoutes,
  summarizeFleet,
};
