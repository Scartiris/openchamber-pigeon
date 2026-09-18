/**
 * Artifact registry: collect / uncollect / list / patch.
 * Version snapshotting lives in versions.js; this file owns identity only.
 */

import path from 'path';
import crypto from 'crypto';

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const asNonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

const newId = (prefix) => {
  const random = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${random}`;
};

export const createArtifactId = () => newId('art');
export const createVersionId = () => newId('ver');

const guessMimeType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.json': 'application/json',
  };
  return map[ext] || 'application/octet-stream';
};

export const listArtifacts = async ({ store, directory }) => {
  const index = await store.getIndex();
  const artifacts = Object.values(index.artifacts);
  if (!directory) {
    return artifacts.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return artifacts
    .filter((artifact) => artifact.directory === directory)
    .sort((a, b) => b.updatedAt - a.updatedAt);
};

export const findArtifactBySourcePath = async ({ store, sourcePath }) => {
  const index = await store.getIndex();
  return Object.values(index.artifacts).find((artifact) => artifact.sourcePath === sourcePath) ?? null;
};

export const listCollectedSourcePaths = async ({ store }) => {
  const index = await store.getIndex();
  return Object.values(index.artifacts).map((artifact) => artifact.sourcePath);
};

export const getArtifact = async ({ store, artifactId }) => {
  const index = await store.getIndex();
  return index.artifacts[artifactId] ?? null;
};

export const collectArtifact = async ({
  store,
  sourcePath,
  directory,
  title,
  origin = 'user',
  fsPromises,
  snapshotVersion,
}) => {
  const index = await store.getIndex();
  const existing = Object.values(index.artifacts).find((artifact) => artifact.sourcePath === sourcePath);
  if (existing) {
    return { artifact: existing, created: false };
  }

  const stats = await fsPromises.stat(sourcePath);
  if (!stats.isFile()) {
    throw Object.assign(new Error('Specified path is not a file'), { status: 400 });
  }

  const id = createArtifactId();
  const now = Date.now();
  const artifact = {
    id,
    title: asNonEmptyString(title) || path.basename(sourcePath),
    sourcePath,
    directory: asNonEmptyString(directory) || '',
    mimeType: guessMimeType(sourcePath),
    sizeBytes: stats.size,
    contentHash: '',
    collectedAt: now,
    updatedAt: now,
    latestVersionId: null,
    origin: origin === 'agent' ? 'agent' : 'user',
    status: 'active',
  };

  await store.commit((draft) => {
    draft.artifacts[id] = artifact;
    draft.versions[id] = [];
  });

  const snapshot = await snapshotVersion({ artifactId: id, source: 'auto' });
  const refreshed = (await store.getIndex()).artifacts[id] ?? artifact;
  return { artifact: refreshed, version: snapshot?.version ?? null, created: true };
};

export const patchArtifact = async ({ store, artifactId, title }) => {
  const nextTitle = asNonEmptyString(title);
  if (!nextTitle) {
    throw Object.assign(new Error('Title is required'), { status: 400 });
  }
  let updated = null;
  await store.commit((draft) => {
    const artifact = draft.artifacts[artifactId];
    if (!artifact) return;
    artifact.title = nextTitle;
    artifact.updatedAt = Date.now();
    updated = artifact;
  });
  if (!updated) {
    throw Object.assign(new Error('Artifact not found'), { status: 404 });
  }
  return updated;
};

export const uncollectArtifact = async ({ store, artifactId, purgeVersions = false }) => {
  const index = await store.getIndex();
  const artifact = index.artifacts[artifactId];
  if (!artifact) {
    throw Object.assign(new Error('Artifact not found'), { status: 404 });
  }
  const versionList = index.versions[artifactId] ?? [];
  const removedVersionIds = new Set(versionList.map((version) => version.id));
  const removedHashes = versionList.map((version) => version.contentHash);

  await store.commit((draft) => {
    delete draft.artifacts[artifactId];
    delete draft.versions[artifactId];
  });

  // Always drop blobs that only this artifact's removed versions referenced.
  // `purge` is retained as an explicit confirmation of the same outcome.
  const remaining = await store.getIndex();
  const stillUsed = new Set();
  for (const list of Object.values(remaining.versions ?? {})) {
    for (const version of list) stillUsed.add(version.contentHash);
  }
  for (const hash of removedHashes) {
    if (!stillUsed.has(hash)) await store.deleteBlob(hash);
  }
  void purgeVersions;
  void removedVersionIds;

  return { id: artifactId };
};

export const markArtifactMissing = async ({ store, artifactId }) => {
  await store.commit((draft) => {
    const artifact = draft.artifacts[artifactId];
    if (!artifact) return;
    artifact.status = 'missing';
    artifact.updatedAt = Date.now();
  });
};

export const markArtifactActive = async ({ store, artifactId }) => {
  await store.commit((draft) => {
    const artifact = draft.artifacts[artifactId];
    if (!artifact) return;
    artifact.status = 'active';
    artifact.updatedAt = Date.now();
  });
};

export { asRecord, asNonEmptyString };
