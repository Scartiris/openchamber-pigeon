/**
 * Hot-store persistence for the Artifact Center.
 *
 * Layout under `<openchamberDataDir>/artifacts/`:
 *   index.json          registry + version metadata (atomic)
 *   blobs/<sha256>      content-addressed version bytes
 *   drive-auth.json     Google OAuth tokens (mode 0o600)
 *
 * Persistence discipline matches message-queue: temp file + rename, and a
 * malformed index is moved aside rather than overwritten.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const INDEX_FILE_NAME = 'index.json';
export const INDEX_FILE_VERSION = 1;
export const BLOBS_DIR_NAME = 'blobs';
export const DRIVE_AUTH_FILE_NAME = 'drive-auth.json';

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const asNonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
const asCount = (value) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);

export const hashBytes = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

export const createArtifactStore = ({ dataDir, fsPromises = fs.promises, now = () => Date.now() }) => {
  const rootDir = path.join(dataDir, 'artifacts');
  const indexFile = path.join(rootDir, INDEX_FILE_NAME);
  const blobsDir = path.join(rootDir, BLOBS_DIR_NAME);
  const driveAuthFile = path.join(rootDir, DRIVE_AUTH_FILE_NAME);

  /** @type {{ version: number, revision: number, artifacts: Record<string, any>, versions: Record<string, any[]> } | null} */
  let loaded = null;
  let loadPromise = null;
  let writePromise = Promise.resolve();
  let writesDisabled = false;

  const emptyIndex = () => ({
    version: INDEX_FILE_VERSION,
    revision: 0,
    artifacts: {},
    versions: {},
  });

  const normalizeVersionRecord = (raw) => {
    const record = asRecord(raw);
    if (!record) return null;
    const id = asNonEmptyString(record.id);
    const artifactId = asNonEmptyString(record.artifactId);
    const contentHash = asNonEmptyString(record.contentHash);
    if (!id || !artifactId || !contentHash) return null;
    const tier = record.tier === 'cold' || record.tier === 'restoring' ? record.tier : 'hot';
    const source = record.source === 'manual' || record.source === 'restore' ? record.source : 'auto';
    const version = {
      id,
      artifactId,
      createdAt: asCount(record.createdAt) ?? now(),
      contentHash,
      sizeBytes: asCount(record.sizeBytes) ?? 0,
      label: asNonEmptyString(record.label) || null,
      source,
      tier,
    };
    const driveFileId = asNonEmptyString(record.driveFileId);
    if (driveFileId) version.driveFileId = driveFileId;
    const restoredFromVersionId = asNonEmptyString(record.restoredFromVersionId);
    if (restoredFromVersionId) version.restoredFromVersionId = restoredFromVersionId;
    return version;
  };

  const normalizeArtifactRecord = (raw) => {
    const record = asRecord(raw);
    if (!record) return null;
    const id = asNonEmptyString(record.id);
    const sourcePath = asNonEmptyString(record.sourcePath);
    if (!id || !sourcePath) return null;
    const artifact = {
      id,
      title: asNonEmptyString(record.title) || path.basename(sourcePath),
      sourcePath,
      directory: asNonEmptyString(record.directory) || '',
      mimeType: asNonEmptyString(record.mimeType) || 'application/octet-stream',
      sizeBytes: asCount(record.sizeBytes) ?? 0,
      contentHash: asNonEmptyString(record.contentHash) || '',
      collectedAt: asCount(record.collectedAt) ?? now(),
      updatedAt: asCount(record.updatedAt) ?? now(),
      latestVersionId: asNonEmptyString(record.latestVersionId) || null,
      origin: record.origin === 'agent' ? 'agent' : 'user',
      status: record.status === 'missing' ? 'missing' : 'active',
    };
    const driveFolderId = asNonEmptyString(record.driveFolderId);
    if (driveFolderId) artifact.driveFolderId = driveFolderId;
    return artifact;
  };

  const readIndexFile = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(indexFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyIndex();
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const backup = `${indexFile}.corrupt-${now()}`;
      await fsPromises.rename(indexFile, backup).catch(() => undefined);
      console.warn(`[artifacts] index was unreadable and moved to ${backup}: ${error?.message ?? error}`);
      return emptyIndex();
    }
    const stored = asRecord(parsed) ?? {};
    const artifacts = {};
    for (const [id, value] of Object.entries(asRecord(stored.artifacts) ?? {})) {
      const artifact = normalizeArtifactRecord(value);
      if (artifact && artifact.id === id) artifacts[id] = artifact;
    }
    const versions = {};
    for (const [artifactId, list] of Object.entries(asRecord(stored.versions) ?? {})) {
      if (!Array.isArray(list)) continue;
      const normalized = list.map(normalizeVersionRecord).filter(Boolean);
      if (normalized.length) versions[artifactId] = normalized;
    }
    return {
      version: asCount(stored.version) ?? INDEX_FILE_VERSION,
      revision: asCount(stored.revision) ?? 0,
      artifacts,
      versions,
    };
  };

  const ensureLoaded = () => {
    if (!loadPromise) {
      loadPromise = readIndexFile()
        .then((index) => {
          loaded = index;
        })
        .catch((error) => {
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  const persist = () => {
    if (writesDisabled || !loaded) return Promise.resolve();
    const payload = JSON.stringify(loaded);
    writePromise = writePromise
      .then(async () => {
        await fsPromises.mkdir(rootDir, { recursive: true });
        const tmpPath = `${indexFile}.${process.pid}.tmp`;
        await fsPromises.writeFile(tmpPath, payload, 'utf8');
        await fsPromises.rename(tmpPath, indexFile);
      })
      .catch((error) => {
        console.warn('[artifacts] failed to persist index:', error?.message ?? error);
      });
    return writePromise;
  };

  const getIndex = async () => {
    await ensureLoaded();
    return loaded;
  };

  const commit = async (mutator) => {
    await ensureLoaded();
    if (!loaded) throw new Error('Artifact index is not loaded');
    loaded.revision += 1;
    mutator(loaded);
    await persist();
    return loaded;
  };

  const blobPath = (contentHash) => path.join(blobsDir, contentHash);

  const writeBlob = async (contentHash, buffer) => {
    await fsPromises.mkdir(blobsDir, { recursive: true });
    const target = blobPath(contentHash);
    try {
      await fsPromises.access(target);
      return target;
    } catch {
      // miss — write below
    }
    const tmpPath = `${target}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmpPath, buffer);
    await fsPromises.rename(tmpPath, target);
    return target;
  };

  const readBlob = async (contentHash) => {
    return fsPromises.readFile(blobPath(contentHash));
  };

  const hasBlob = async (contentHash) => {
    try {
      await fsPromises.access(blobPath(contentHash));
      return true;
    } catch {
      return false;
    }
  };

  const deleteBlob = async (contentHash) => {
    await fsPromises.unlink(blobPath(contentHash)).catch(() => undefined);
  };

  /**
   * Delete a blob only when no remaining version still references its hash.
   * Manual labeled snapshots can share a content hash with an auto version;
   * demotion of one must not 410 the other.
   */
  const deleteBlobIfUnreferenced = async (contentHash, { excludeVersionId } = {}) => {
    const index = await getIndex();
    for (const list of Object.values(index.versions ?? {})) {
      for (const version of list) {
        if (excludeVersionId && version.id === excludeVersionId) continue;
        if (version.contentHash === contentHash && version.tier !== 'cold') return false;
      }
    }
    await deleteBlob(contentHash);
    return true;
  };

  const readDriveAuth = async () => {
    try {
      const raw = await fsPromises.readFile(driveAuthFile, 'utf8');
      const parsed = asRecord(JSON.parse(raw));
      return parsed;
    } catch {
      return null;
    }
  };

  const writeDriveAuth = async (auth) => {
    await fsPromises.mkdir(rootDir, { recursive: true });
    const tmpPath = `${driveAuthFile}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmpPath, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fsPromises.rename(tmpPath, driveAuthFile);
    await fsPromises.chmod(driveAuthFile, 0o600).catch(() => undefined);
  };

  const clearDriveAuth = async () => {
    await fsPromises.unlink(driveAuthFile).catch(() => undefined);
  };

  return {
    rootDir,
    indexFile,
    blobsDir,
    ensureLoaded,
    getIndex,
    commit,
    persist,
    writeBlob,
    readBlob,
    hasBlob,
    deleteBlob,
    deleteBlobIfUnreferenced,
    blobPath,
    readDriveAuth,
    writeDriveAuth,
    clearDriveAuth,
  };
};
