import { create } from 'zustand';
import type { ArtifactRecord } from '@/lib/artifacts/client';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

type ArtifactsHubState = {
  artifactCount: number | null;
  byPath: Record<string, ArtifactRecord>;
  setArtifactCount: (count: number | null) => void;
  noteCollected: (artifact: ArtifactRecord) => void;
  noteUncollected: (sourcePath: string) => void;
  primePathMap: (artifacts: ArtifactRecord[]) => void;
  reset: () => void;
};

const pathKey = (sourcePath: string) => sourcePath.replace(/\\/g, '/');

export const useArtifactsHubStore = create<ArtifactsHubState>((set) => ({
  artifactCount: null,
  byPath: {},
  setArtifactCount: (count) => set({ artifactCount: count }),
  noteCollected: (artifact) =>
    set((state) => {
      const key = pathKey(artifact.sourcePath);
      const existed = Boolean(state.byPath[key]);
      return {
        byPath: { ...state.byPath, [key]: artifact },
        artifactCount:
          state.artifactCount === null
            ? state.artifactCount
            : state.artifactCount + (existed ? 0 : 1),
      };
    }),
  noteUncollected: (sourcePath) =>
    set((state) => {
      const key = pathKey(sourcePath);
      if (!state.byPath[key]) return state;
      const byPath = { ...state.byPath };
      delete byPath[key];
      return {
        byPath,
        artifactCount:
          state.artifactCount === null ? state.artifactCount : Math.max(0, state.artifactCount - 1),
      };
    }),
  primePathMap: (artifacts) =>
    set(() => {
      const byPath: Record<string, ArtifactRecord> = {};
      for (const artifact of artifacts) {
        byPath[pathKey(artifact.sourcePath)] = artifact;
      }
      return { byPath, artifactCount: artifacts.length };
    }),
  reset: () => set({ artifactCount: null, byPath: {} }),
}));

subscribeRuntimeEndpointChanged(() => {
  useArtifactsHubStore.getState().reset();
});
