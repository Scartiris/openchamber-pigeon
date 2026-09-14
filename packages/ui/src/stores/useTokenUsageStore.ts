import { create } from 'zustand';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { collectTokenUsage, resetTokenUsageCollectCache } from '@/lib/tokenUsage/collect';
import { emptyTokenUsageSnapshot, type TokenUsageSnapshot } from '@/lib/tokenUsage/aggregate';

/** Header badge stays live; dialog still forces a full refresh on open. */
const REFRESH_INTERVAL_MS = 45 * 1000;

let generation = 0;
let inFlight: Promise<TokenUsageSnapshot | null> | null = null;

type TokenUsageStatus = 'idle' | 'loading' | 'ready' | 'error';

type TokenUsageState = {
  snapshot: TokenUsageSnapshot | null;
  loadedRuntimeKey: string | null;
  status: TokenUsageStatus;
  /** Last transport failure. Stale data stays visible next to this. */
  error: string | null;
  lastUpdated: number | null;
  ensureLoaded: (options?: { force?: boolean }) => Promise<TokenUsageSnapshot | null>;
  resetForRuntimeSwitch: () => void;
};

const formatError = (error: Error): string =>
  error.message.length > 0 ? error.message : 'Token usage refresh failed';

export const useTokenUsageStore = create<TokenUsageState>((set, get) => ({
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

    if (inFlight && !force) {
      return inFlight;
    }

    const thisGeneration = ++generation;
    set({
      status: state.snapshot ? 'ready' : 'loading',
      error: state.error,
    });

    let taskPromise: Promise<TokenUsageSnapshot | null> | null = null;
    taskPromise = (async (): Promise<TokenUsageSnapshot | null> => {
      try {
        const store = useGlobalSessionsStore.getState();
        if (!store.hasLoaded) {
          await store.loadSessions();
        }
        // Re-read after the await: the load may have replaced the snapshot.
        const loaded = useGlobalSessionsStore.getState();
        const sessions = [...loaded.activeSessions, ...loaded.archivedSessions];
        const snapshot = await collectTokenUsage({ sessions, nowMs: Date.now() });

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
      } catch (error) {
        if (thisGeneration !== generation || getRuntimeKey() !== runtimeKey) {
          return null;
        }
        const failure = error instanceof Error ? error : new Error('Token usage refresh failed');
        set((current) => ({
          status: current.snapshot ? 'ready' : 'error',
          error: formatError(failure),
          // Keep any previous snapshot; a failed refresh is not an empty success.
          loadedRuntimeKey: current.loadedRuntimeKey ?? runtimeKey,
        }));
        return get().snapshot;
      } finally {
        if (inFlight === taskPromise) {
          inFlight = null;
        }
      }
    })();

    inFlight = taskPromise;
    return taskPromise;
  },

  resetForRuntimeSwitch: () => {
    generation += 1;
    inFlight = null;
    resetTokenUsageCollectCache();
    set({
      snapshot: null,
      loadedRuntimeKey: null,
      status: 'idle',
      error: null,
      lastUpdated: null,
    });
  },
}));
