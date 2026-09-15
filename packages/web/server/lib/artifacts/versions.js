/**
 * Version engine: content-hash snapshots, labels, restore-to-source.
 * Drive tiering is layered on top by drive/tier.js.
 */

import { createVersionId, getArtifact, markArtifactActive, markArtifactMissing } from './registry.js';
import { hashBytes } from './store.js';

const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;

export const listVersions = async ({ store, artifactId }) => {
  const index = await store.getIndex();
  if (!index.artifacts[artifactId]) {
    throw Object.assign(new Error('Artifact not found'), { status: 404 });
  }
  return [...(index.versions[artifactId] ?? [])].sort((a, b) => b.createdAt - a.createdAt);
};

export const getVersion = async ({ store, artifactId, versionId }) => {
  const list = await listVersions({ store, artifactId });
  return list.find((version) => version.id === versionId) ?? null;
};

export const labelVersion = async ({ store, artifactId, versionId, label }) => {
  const trimmed = typeof label === 'string' ? label.trim() : '';
  let updated = null;
  await store.commit((draft) => {
    const list = draft.versions[artifactId];
    if (!list) return;
    const version = list.find((entry) => entry.id === versionId);
    if (!version) return;
    version.label = trimmed || null;
    updated = version;
  });
  if (!updated) {
    throw Object.assign(new Error('Version not found'), { status: 404 });
  }
  return updated;
};

/**
 * Snapshot the current bytes of an artifact's source file.
 * Same content hash as the latest version is a no-op (returns that version).
 */
export const snapshotArtifactVersion = async ({
  store,
  artifactId,
  source = 'auto',
  label = null,
  fsPromises,
}) => {
  const artifact = await getArtifact({ store, artifactId });
  if (!artifact) {
    throw Object.assign(new Error('Artifact not found'), { status: 404 });
  }

  let stats;
  try {
    stats = await fsPromises.stat(artifact.sourcePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await markArtifactMissing({ store, artifactId });
      throw Object.assign(new Error('Source file is missing'), { status: 404, code: 'source-missing' });
    }
    throw error;
  }
  if (!stats.isFile()) {
    throw Object.assign(new Error('Source path is not a file'), { status: 400 });
  }
  if (stats.size > MAX_ARTIFACT_BYTES) {
    throw Object.assign(new Error('File is too large to snapshot'), { status: 413 });
  }

  const buffer = await fsPromises.readFile(artifact.sourcePath);
  const contentHash = hashBytes(buffer);

  const index = await store.getIndex();
  const list = index.versions[artifactId] ?? [];
  const latest = [...list].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (latest && latest.contentHash === contentHash && source === 'auto') {
    await markArtifactActive({ store, artifactId });
    return { version: latest, created: false };
  }
  // Manual save with no label and identical bytes is also a no-op.
  if (latest && latest.contentHash === contentHash && !label) {
    await markArtifactActive({ store, artifactId });
    return { version: latest, created: false };
  }

  await store.writeBlob(contentHash, buffer);

  const version = {
    id: createVersionId(),
    artifactId,
    createdAt: Date.now(),
    contentHash,
    sizeBytes: stats.size,
    label: label || null,
    source,
    tier: 'hot',
  };

  await store.commit((draft) => {
    draft.artifacts[artifactId] = {
      ...(draft.artifacts[artifactId] ?? artifact),
      contentHash,
      sizeBytes: stats.size,
      latestVersionId: version.id,
      updatedAt: Date.now(),
      status: 'active',
    };
    const next = draft.versions[artifactId] ?? [];
    next.push(version);
    draft.versions[artifactId] = next;
  });

  return { version, created: true };
};

export const readVersionContent = async ({ store, artifactId, versionId }) => {
  const version = await getVersion({ store, artifactId, versionId });
  if (!version) {
    throw Object.assign(new Error('Version not found'), { status: 404 });
  }
  if (version.tier === 'cold') {
    throw Object.assign(new Error('Version is cold; pull it back first'), {
      status: 409,
      code: 'version_cold',
    });
  }
  if (version.tier === 'restoring') {
    throw Object.assign(new Error('Version is being restored from cold storage'), {
      status: 409,
      code: 'version_restoring',
    });
  }
  const hasBlob = await store.hasBlob(version.contentHash);
  if (!hasBlob) {
    throw Object.assign(new Error('Version content is missing from hot storage'), { status: 410 });
  }
  return store.readBlob(version.contentHash);
};

/**
 * Write a version's bytes back to the artifact source path.
 * Refuses when the live file's hash differs from the latest hot version unless
 * `force` is set — that would silently discard un-snapshotted edits.
 */
export const restoreVersionToSource = async ({
  store,
  artifactId,
  versionId,
  force = false,
  fsPromises,
}) => {
  const artifact = await getArtifact({ store, artifactId });
  if (!artifact) {
    throw Object.assign(new Error('Artifact not found'), { status: 404 });
  }
  const version = await getVersion({ store, artifactId, versionId });
  if (!version) {
    throw Object.assign(new Error('Version not found'), { status: 404 });
  }
  if (version.tier !== 'hot') {
    throw Object.assign(new Error('Version is not in hot storage; pull it first'), {
      status: 409,
      code: 'version_cold',
    });
  }

  if (!force) {
    try {
      const live = await fsPromises.readFile(artifact.sourcePath);
      const liveHash = hashBytes(live);
      const index = await store.getIndex();
      const latest = [...(index.versions[artifactId] ?? [])].sort((a, b) => b.createdAt - a.createdAt)[0];
      if (latest && liveHash !== latest.contentHash) {
        throw Object.assign(new Error('Source file has unsnapshotted changes'), {
          status: 409,
          code: 'source_dirty',
        });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'source_dirty') throw error;
      if (error?.code === 'source_dirty') throw error;
    }
  }

  const buffer = await store.readBlob(version.contentHash);
  const tmpPath = `${artifact.sourcePath}.${process.pid}.restore.tmp`;
  await fsPromises.writeFile(tmpPath, buffer);
  await fsPromises.rename(tmpPath, artifact.sourcePath);

  // Restoring is itself a content change: record it as a restore-sourced
  // version only when the hash is not already the latest.
  const snapshot = await snapshotArtifactVersion({
    store,
    artifactId,
    source: 'restore',
    fsPromises,
  });
  if (snapshot.version.restoredFromVersionId !== version.id) {
    await store.commit((draft) => {
      const list = draft.versions[artifactId] ?? [];
      const created = list.find((entry) => entry.id === snapshot.version.id);
      if (created) created.restoredFromVersionId = version.id;
    });
  }
  return snapshot.version;
};
