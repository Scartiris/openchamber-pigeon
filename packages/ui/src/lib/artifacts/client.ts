import { runtimeFetch } from '@/lib/runtime-fetch';

export const ARTIFACTS_PREFIX = '/api/artifacts';

export type ArtifactOrigin = 'user' | 'agent';
export type ArtifactStatus = 'active' | 'missing';
export type VersionTier = 'hot' | 'cold' | 'restoring';
export type VersionSource = 'auto' | 'manual' | 'restore';

export interface ArtifactRecord {
  id: string;
  title: string;
  sourcePath: string;
  directory: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  collectedAt: number;
  updatedAt: number;
  latestVersionId: string | null;
  origin: ArtifactOrigin;
  status: ArtifactStatus;
  driveFolderId?: string;
}

export interface ArtifactVersion {
  id: string;
  artifactId: string;
  createdAt: number;
  contentHash: string;
  sizeBytes: number;
  label: string | null;
  source: VersionSource;
  tier: VersionTier;
  driveFileId?: string;
  restoredFromVersionId?: string;
}

export interface ArtifactStorageSnapshot {
  hotUsageBytes: number;
  hotBudgetBytes: number;
  artifactCount: number;
  versionCount: number;
  coldCount: number;
  revision: number;
}

export interface DriveStatus {
  configured: boolean;
  connected: boolean;
  expiresAt: number | null;
}

export class ArtifactApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ArtifactApiError';
    this.status = status;
    this.code = code;
  }
}

const readError = async (response: Response): Promise<ArtifactApiError> => {
  let message = `HTTP ${response.status}`;
  let code: string | null = null;
  try {
    const payload = (await response.json()) as { error?: unknown; code?: unknown };
    if (typeof payload?.error === 'string' && payload.error) message = payload.error;
    if (typeof payload?.code === 'string' && payload.code) code = payload.code;
  } catch {
    // non-JSON error body
  }
  return new ArtifactApiError(message, response.status, code);
};

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await runtimeFetch(`${ARTIFACTS_PREFIX}${path}`, init);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
}

export const listArtifacts = (directory?: string) =>
  requestJson<{ artifacts: ArtifactRecord[] }>(
    directory ? `?directory=${encodeURIComponent(directory)}` : '',
  ).then((payload) => payload.artifacts);

export const collectArtifact = (input: {
  path: string;
  directory?: string;
  title?: string;
  origin?: ArtifactOrigin;
}) =>
  requestJson<{ artifact: ArtifactRecord; version: ArtifactVersion | null; created: boolean }>('', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

export const getArtifact = (id: string) =>
  requestJson<{ artifact: ArtifactRecord }>(`/${encodeURIComponent(id)}`).then((payload) => payload.artifact);

export const patchArtifact = (id: string, title: string) =>
  requestJson<{ artifact: ArtifactRecord }>(`/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  }).then((payload) => payload.artifact);

export const uncollectArtifact = (id: string, purge = false) =>
  requestJson<{ id: string }>(
    `/${encodeURIComponent(id)}${purge ? '?purge=1' : ''}`,
    { method: 'DELETE' },
  );

export const snapshotArtifact = (id: string, label?: string) =>
  requestJson<{ version: ArtifactVersion; created: boolean }>(`/${encodeURIComponent(id)}/snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(label ? { label } : {}),
  });

export const listVersions = (artifactId: string) =>
  requestJson<{ versions: ArtifactVersion[] }>(`/${encodeURIComponent(artifactId)}/versions`).then(
    (payload) => payload.versions,
  );

export const labelVersion = (artifactId: string, versionId: string, label: string) =>
  requestJson<{ version: ArtifactVersion }>(
    `/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    },
  ).then((payload) => payload.version);

export const restoreVersion = (artifactId: string, versionId: string, force = false) =>
  requestJson<{ version: ArtifactVersion }>(
    `/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/restore`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    },
  ).then((payload) => payload.version);

export const pullVersion = (artifactId: string, versionId: string) =>
  requestJson<{ promoted: boolean; alreadyHot?: boolean }>(
    `/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/pull`,
    { method: 'POST' },
  );

export const fetchVersionContent = async (artifactId: string, versionId: string) => {
  const response = await runtimeFetch(
    `${ARTIFACTS_PREFIX}/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/content`,
  );
  if (!response.ok) throw await readError(response);
  return response.blob();
};

export const getStorage = () => requestJson<ArtifactStorageSnapshot>('/storage');

export const getDriveStatus = () => requestJson<DriveStatus>('/drive/status');

export const startDriveAuth = () =>
  requestJson<{ authorizeUrl: string }>('/drive/auth', { method: 'POST' });

export const disconnectDrive = () => requestJson<DriveStatus>('/drive/auth', { method: 'DELETE' });
