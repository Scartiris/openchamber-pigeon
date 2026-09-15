/**
 * Debounced filesystem watch over collected artifact source paths.
 * Same bytes never create a second version (versions.js hash-dedupes).
 */

import fs from 'fs';

const DEFAULT_DEBOUNCE_MS = 800;

export const createArtifactWatcher = ({
  store,
  snapshotVersion,
  listArtifactIdsForPath,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  fsModule = fs,
  logger = console,
}) => {
  /** @type {Map<string, { watcher: fs.FSWatcher, timer: NodeJS.Timeout | null, pending: boolean }>} */
  const byPath = new Map();
  let stopped = false;

  const scheduleSnapshot = (sourcePath) => {
    const entry = byPath.get(sourcePath);
    if (!entry || stopped) return;
    entry.pending = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      entry.timer = null;
      if (!entry.pending || stopped) return;
      entry.pending = false;
      const artifactIds = await listArtifactIdsForPath(sourcePath);
      for (const artifactId of artifactIds) {
        try {
          await snapshotVersion({ artifactId, source: 'auto' });
        } catch (error) {
          if (error?.code === 'source-missing' || error?.status === 404) continue;
          logger.warn?.(`[artifacts] snapshot failed for ${artifactId}:`, error?.message ?? error);
        }
      }
    }, debounceMs);
  };

  const watchPath = (sourcePath) => {
    if (stopped || byPath.has(sourcePath)) return;
    try {
      const watcher = fsModule.watch(sourcePath, { persistent: false }, (eventType) => {
        if (eventType === 'rename' || eventType === 'change') {
          scheduleSnapshot(sourcePath);
        }
      });
      watcher.on('error', (error) => {
        logger.warn?.(`[artifacts] watch error for ${sourcePath}:`, error?.message ?? error);
        unwatchPath(sourcePath);
      });
      byPath.set(sourcePath, { watcher, timer: null, pending: false });
    } catch (error) {
      logger.warn?.(`[artifacts] could not watch ${sourcePath}:`, error?.message ?? error);
    }
  };

  const unwatchPath = (sourcePath) => {
    const entry = byPath.get(sourcePath);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    try {
      entry.watcher.close();
    } catch {
      // already closed
    }
    byPath.delete(sourcePath);
  };

  const syncFromIndex = async () => {
    if (stopped) return;
    const index = await store.getIndex();
    const activePaths = new Set();
    for (const artifact of Object.values(index.artifacts)) {
      if (artifact.status === 'missing') continue;
      activePaths.add(artifact.sourcePath);
      watchPath(artifact.sourcePath);
    }
    for (const sourcePath of [...byPath.keys()]) {
      if (!activePaths.has(sourcePath)) unwatchPath(sourcePath);
    }
  };

  const stop = () => {
    stopped = true;
    for (const sourcePath of [...byPath.keys()]) unwatchPath(sourcePath);
  };

  return {
    watchPath,
    unwatchPath,
    syncFromIndex,
    stop,
    get watchedCount() {
      return byPath.size;
    },
  };
};
