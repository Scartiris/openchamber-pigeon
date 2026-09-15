/**
 * Hot/cold tier policy.
 *
 * Protect: every artifact's latest version, and any version with a user label.
 * Demote oldest unprotected hot versions until hot usage fits the budget.
 * Promote: download, verify sha256, write hot blob, mark hot.
 */

import { hashBytes } from '../store.js';

export const DEFAULT_HOT_BUDGET_BYTES = 1024 * 1024 * 1024; // 1 GiB

export const resolveHotBudgetBytes = (env = process.env) => {
  const raw = env.OPENCHAMBER_ARTIFACTS_HOT_BUDGET_BYTES;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return DEFAULT_HOT_BUDGET_BYTES;
};

const listAllVersions = (index) => {
  const rows = [];
  for (const [artifactId, list] of Object.entries(index.versions ?? {})) {
    for (const version of list) rows.push({ artifactId, version });
  }
  return rows;
};

export const computeHotUsage = (index) => {
  let bytes = 0;
  for (const { version } of listAllVersions(index)) {
    if (version.tier === 'hot') bytes += version.sizeBytes || 0;
  }
  return bytes;
};

const protectedVersionIds = (index) => {
  const protectedIds = new Set();
  for (const list of Object.values(index.versions ?? {})) {
    const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt);
    if (sorted[0]) protectedIds.add(sorted[0].id);
    for (const version of list) {
      if (version.label) protectedIds.add(version.id);
    }
  }
  return protectedIds;
};

/** Pick hot versions eligible for demotion, oldest first. */
export const selectDemotionCandidates = (index) => {
  const protectedIds = protectedVersionIds(index);
  return listAllVersions(index)
    .filter(({ version }) => version.tier === 'hot' && !protectedIds.has(version.id))
    .sort((a, b) => a.version.createdAt - b.version.createdAt);
};

export const createDriveTier = ({ store, driveClient, hotBudgetBytes, logger = console }) => {
  const ensureArtifactFolder = async (artifactId) => {
    const index = await store.getIndex();
    const artifact = index.artifacts[artifactId];
    if (!artifact) return null;
    if (artifact.driveFolderId) return artifact.driveFolderId;
    const rootId = await driveClient.ensureRootFolder();
    const folderId = await driveClient.ensureArtifactFolder({
      parentId: rootId,
      title: `${artifact.id}-${artifact.title}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120),
    });
    await store.commit((draft) => {
      if (draft.artifacts[artifactId]) draft.artifacts[artifactId].driveFolderId = folderId;
    });
    return folderId;
  };

  const demoteVersion = async ({ artifactId, versionId }) => {
    const index = await store.getIndex();
    const list = index.versions[artifactId] ?? [];
    const version = list.find((entry) => entry.id === versionId);
    if (!version || version.tier !== 'hot') return { skipped: true };
    const bytes = await store.readBlob(version.contentHash);
    const folderId = await ensureArtifactFolder(artifactId);
    const uploaded = await driveClient.uploadBlob({
      parentId: folderId,
      name: `${version.contentHash}`,
      bytes,
      mimeType: index.artifacts[artifactId]?.mimeType,
    });
    await store.commit((draft) => {
      const draftVersion = (draft.versions[artifactId] ?? []).find((entry) => entry.id === versionId);
      if (!draftVersion) return;
      draftVersion.tier = 'cold';
      draftVersion.driveFileId = uploaded.id;
    });
    // Shared-hash safety: only drop the hot blob when nothing else still needs it.
    await store.deleteBlobIfUnreferenced(version.contentHash, { excludeVersionId: versionId });
    return { demoted: true, driveFileId: uploaded.id };
  };

  const promoteVersion = async ({ artifactId, versionId }) => {
    const index = await store.getIndex();
    const list = index.versions[artifactId] ?? [];
    const version = list.find((entry) => entry.id === versionId);
    if (!version) {
      throw Object.assign(new Error('Version not found'), { status: 404 });
    }
    if (version.tier === 'hot') return { promoted: false, alreadyHot: true };
    if (version.tier !== 'cold' || !version.driveFileId) {
      throw Object.assign(new Error('Version has no cold copy to pull'), { status: 409, code: 'version_not_cold' });
    }

    await store.commit((draft) => {
      const draftVersion = (draft.versions[artifactId] ?? []).find((entry) => entry.id === versionId);
      if (draftVersion) draftVersion.tier = 'restoring';
    });

    try {
      const bytes = await driveClient.downloadBlob({ fileId: version.driveFileId });
      const actualHash = hashBytes(bytes);
      if (actualHash !== version.contentHash) {
        throw Object.assign(new Error('Downloaded cold version failed integrity check'), { status: 502 });
      }
      await store.writeBlob(version.contentHash, bytes);
      await store.commit((draft) => {
        const draftVersion = (draft.versions[artifactId] ?? []).find((entry) => entry.id === versionId);
        if (!draftVersion) return;
        draftVersion.tier = 'hot';
        delete draftVersion.driveFileId;
      });
      return { promoted: true };
    } catch (error) {
      await store.commit((draft) => {
        const draftVersion = (draft.versions[artifactId] ?? []).find((entry) => entry.id === versionId);
        if (draftVersion && draftVersion.tier === 'restoring') draftVersion.tier = 'cold';
      });
      throw error;
    }
  };

  /** After a mutation: demote until under budget. Failures leave versions hot. */
  const enforceBudget = async () => {
    const budget = hotBudgetBytes;
    let usage = computeHotUsage(await store.getIndex());
    if (usage <= budget) return { demoted: 0, usage, budget };
    let demoted = 0;
    const candidates = selectDemotionCandidates(await store.getIndex());
    for (const { artifactId, version } of candidates) {
      if (usage <= budget) break;
      try {
        const result = await demoteVersion({ artifactId, versionId: version.id });
        if (result.demoted) {
          demoted += 1;
          usage -= version.sizeBytes || 0;
        }
      } catch (error) {
        logger.warn?.(`[artifacts] demote ${version.id} failed:`, error?.message ?? error);
      }
    }
    return { demoted, usage, budget };
  };

  return {
    demoteVersion,
    promoteVersion,
    enforceBudget,
    resolveBudget: () => hotBudgetBytes,
  };
};
