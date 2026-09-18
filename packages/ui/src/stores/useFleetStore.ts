import { create } from 'zustand';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { FleetStatusError, fetchFleetSnapshot } from '@/lib/fleet/client';
import type { FleetError, FleetSnapshot } from '@/lib/fleet/types';
import { toAgeSeconds } from '@/lib/fleet/format';

/**
 * Fleet snapshot for the header chip and its panel.
 *
 * Same contract as the token-usage store: one in-flight request, a TTL so the
 * chip does not hammer the server, and a failed refresh keeps the previous
 * snapshot on screen next to the error rather than blanking the panel.
 */

const REFRESH_INTERVAL_MS = 30 * 1000;

let generation = 0;
let inFlight: Promise<FleetSnapshot | null> | null = null;

type FleetStatus = 'idle' | 'loading' | 'ready' | 'error';

type FleetState = {
  snapshot: FleetSnapshot | null;
  loadedRuntimeKey: string | null;
  status: FleetStatus;
  error: FleetError | null;
  lastUpdated: number | null;
  ensureLoaded: (options?: { force?: boolean }) => Promise<FleetSnapshot | null>;
  resetForRuntimeSwitch: () => void;
};

const toFleetError = (error: Error): FleetError => {
  if (error instanceof FleetStatusError) {
    return { code: error.code, status: error.status, message: error.message };
  }
  return { code: 'load', status: null, message: error.message };
};

export const useFleetStore = create<FleetState>((set, get) => ({
  snapshot: null,
  loadedRuntimeKey: null,
  status: 'idle',
  error: null,
  lastUpdated: null,

  ensureLoaded: async (options) => {
    const force = options?.force === true;
    const runtimeKey = getRuntimeKey();
    const state = get();
    const now = Date.now();

    if (
      !force
      && state.loadedRuntimeKey === runtimeKey
      && state.status === 'ready'
      && state.lastUpdated !== null
      && now - state.lastUpdated < REFRESH_INTERVAL_MS
      && state.snapshot
    ) {
      return state.snapshot;
    }

    // A forced read (the panel's refresh button) still joins an in-flight read:
    // the server would otherwise start a second round of device probes.
    if (inFlight) {
      return inFlight;
    }

    const thisGeneration = ++generation;
    set({ status: state.snapshot ? 'ready' : 'loading' });

    let task: Promise<FleetSnapshot | null> | null = null;
    task = (async (): Promise<FleetSnapshot | null> => {
      try {
        const snapshot = await fetchFleetSnapshot({ force });
        if (thisGeneration !== generation || getRuntimeKey() !== runtimeKey) {
          return null;
        }
        set({
          snapshot,
          loadedRuntimeKey: runtimeKey,
          status: 'ready',
          error: null,
          lastUpdated: Date.now(),
        });
        return snapshot;
      } catch (caught) {
        if (thisGeneration !== generation || getRuntimeKey() !== runtimeKey) {
          return null;
        }
        const failure = caught instanceof Error ? caught : new Error(String(caught));
        set((current) => ({
          // Keep whatever we last read: stale numbers plus an explicit error is
          // more useful than an empty panel.
          status: current.snapshot ? 'ready' : 'error',
          error: toFleetError(failure),
          loadedRuntimeKey: current.loadedRuntimeKey ?? runtimeKey,
        }));
        return get().snapshot;
      } finally {
        if (inFlight === task) {
          inFlight = null;
        }
      }
    })();

    inFlight = task;
    return task;
  },

  resetForRuntimeSwitch: () => {
    generation += 1;
    inFlight = null;
    set({
      snapshot: null,
      loadedRuntimeKey: null,
      status: 'idle',
      error: null,
      lastUpdated: null,
    });
  },
}));

/** Seconds since the snapshot was read, for the "{seconds}s ago" label. */
export const fleetAgeSeconds = (lastUpdated: number | null, nowMs = Date.now()): number | null => (
  lastUpdated === null ? null : toAgeSeconds(nowMs - lastUpdated)
);
