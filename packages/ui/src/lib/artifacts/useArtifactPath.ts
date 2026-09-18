import React from 'react';
import {
  collectArtifact,
  findArtifactByPath,
  getStorage,
  listArtifacts,
  listVersions,
  type ArtifactRecord,
} from '@/lib/artifacts/client';
import { useArtifactsHubStore } from '@/stores/useArtifactsHubStore';

export type ArtifactPathStatus = {
  artifact: ArtifactRecord | null;
  loading: boolean;
  versionCount: number | null;
  collect: () => Promise<{ created: boolean; artifact: ArtifactRecord }>;
  refresh: () => Promise<void>;
};

const pathKey = (filePath: string) => filePath.replace(/\\/g, '/');

export const refreshArtifactsHub = async (): Promise<void> => {
  const hub = useArtifactsHubStore.getState();
  try {
    const [storage, artifacts] = await Promise.all([getStorage(), listArtifacts()]);
    hub.primePathMap(artifacts);
    hub.setArtifactCount(storage.artifactCount);
  } catch {
    // Keep the previous cache; a failed refresh is not an empty registry.
  }
};

export const collectPathAsArtifact = async (input: {
  path: string;
  directory?: string;
  title?: string;
  origin?: 'user' | 'agent';
}): Promise<{ created: boolean; artifact: ArtifactRecord }> => {
  const result = await collectArtifact({
    path: input.path,
    directory: input.directory,
    title: input.title,
    origin: input.origin ?? 'user',
  });
  useArtifactsHubStore.getState().noteCollected(result.artifact);
  return { created: result.created, artifact: result.artifact };
};

/**
 * Resolve collect status for one workspace path. The hub store is a cache;
 * misses trigger a single path lookup so toolbars do not download the full list.
 */
export function useArtifactPathStatus(
  filePath: string | null | undefined,
  options?: { directory?: string | null; skip?: boolean },
): ArtifactPathStatus {
  const skip = Boolean(options?.skip) || !filePath;
  const cacheKey = filePath ? pathKey(filePath) : '';
  const cached = useArtifactsHubStore((state) => (cacheKey ? state.byPath[cacheKey] : undefined));
  const [fetched, setFetched] = React.useState<ArtifactRecord | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [versionCount, setVersionCount] = React.useState<number | null>(null);
  const directory = options?.directory ?? undefined;

  React.useEffect(() => {
    if (skip || !filePath) {
      setFetched(null);
      setVersionCount(null);
      setLoading(false);
      return;
    }
    if (cached) {
      setFetched(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void findArtifactByPath(filePath)
      .then((found) => {
        if (cancelled) return;
        setFetched(found);
        if (found) useArtifactsHubStore.getState().noteCollected(found);
      })
      .catch(() => {
        if (!cancelled) setFetched(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cached, filePath, skip]);

  const artifact = cached ?? fetched;

  React.useEffect(() => {
    if (!artifact?.id) {
      setVersionCount(null);
      return;
    }
    let cancelled = false;
    void listVersions(artifact.id)
      .then((versions) => {
        if (!cancelled) setVersionCount(versions.length);
      })
      .catch(() => {
        if (!cancelled) setVersionCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact?.id]);

  const refresh = React.useCallback(async () => {
    if (!filePath) return;
    setLoading(true);
    try {
      const found = await findArtifactByPath(filePath);
      setFetched(found);
      if (found) {
        useArtifactsHubStore.getState().noteCollected(found);
        const versions = await listVersions(found.id);
        setVersionCount(versions.length);
      } else {
        useArtifactsHubStore.getState().noteUncollected(pathKey(filePath));
        setVersionCount(null);
      }
    } catch {
      // leave previous state
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  const collect = React.useCallback(async () => {
    if (!filePath) throw new Error('Path is required');
    const result = await collectPathAsArtifact({
      path: filePath,
      directory,
      origin: 'user',
    });
    setFetched(result.artifact);
    try {
      const versions = await listVersions(result.artifact.id);
      setVersionCount(versions.length);
    } catch {
      setVersionCount(null);
    }
    return result;
  }, [directory, filePath]);

  return {
    artifact: artifact ?? null,
    loading,
    versionCount,
    collect,
    refresh,
  };
}
