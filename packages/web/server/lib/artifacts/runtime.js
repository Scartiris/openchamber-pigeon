/**
 * Artifact Center runtime + HTTP routes.
 *
 * Server is authoritative. Hot versioning works without Drive. Drive OAuth and
 * cold tiering attach when the client is configured and the user connects.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createArtifactStore, hashBytes } from './store.js';
import {
  collectArtifact,
  getArtifact,
  listArtifacts,
  patchArtifact,
  uncollectArtifact,
} from './registry.js';
import {
  getVersion,
  labelVersion,
  listVersions,
  readVersionContent,
  restoreVersionToSource,
  snapshotArtifactVersion,
} from './versions.js';
import { createArtifactWatcher } from './watcher.js';
import {
  buildDriveAuthorizeUrl,
  createPkcePair,
  ensureDriveAccessToken,
  exchangeDriveCode,
  isDriveOAuthConfigured,
  resolveDriveOAuthClient,
} from './drive/auth.js';
import { createDriveClient } from './drive/client.js';
import { computeHotUsage, createDriveTier, resolveHotBudgetBytes } from './drive/tier.js';

const asNonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

const sendError = (res, error, fallbackStatus = 500) => {
  const status = error?.status || fallbackStatus;
  const body = { error: error?.message || 'Artifact request failed' };
  if (error?.code) body.code = error.code;
  res.status(status).json(body);
};

export const createArtifactRuntime = ({
  openchamberDataDir,
  fsPromises = fs.promises,
  env = process.env,
  logger = console,
  fetchImpl = fetch,
}) => {
  if (!asNonEmptyString(openchamberDataDir)) {
    throw new Error('openchamberDataDir is required for the Artifact Center');
  }

  const store = createArtifactStore({ dataDir: openchamberDataDir, fsPromises });
  const snapshotVersion = ({ artifactId, source = 'auto', label = null }) =>
    snapshotArtifactVersion({ store, artifactId, source, label, fsPromises });

  const listArtifactIdsForPath = async (sourcePath) => {
    const index = await store.getIndex();
    return Object.values(index.artifacts)
      .filter((artifact) => artifact.sourcePath === sourcePath && artifact.status !== 'missing')
      .map((artifact) => artifact.id);
  };

  const watcher = createArtifactWatcher({
    store,
    snapshotVersion,
    listArtifactIdsForPath,
    logger,
  });

  const driveClientConfigured = isDriveOAuthConfigured({ env });
  const oauthClient = resolveDriveOAuthClient({ env });
  const hotBudgetBytes = resolveHotBudgetBytes(env);

  let driveClient = null;
  const getDriveClient = () => {
    if (!driveClient) {
      driveClient = createDriveClient({
        getAccessToken: () => ensureDriveAccessToken({ store, client: oauthClient, fetchImpl }),
        fetchImpl,
      });
    }
    return driveClient;
  };

  const tier = createDriveTier({
    store,
    driveClient: {
      ensureRootFolder: (...args) => getDriveClient().ensureRootFolder(...args),
      ensureArtifactFolder: (...args) => getDriveClient().ensureArtifactFolder(...args),
      uploadBlob: (...args) => getDriveClient().uploadBlob(...args),
      downloadBlob: (...args) => getDriveClient().downloadBlob(...args),
      deleteFile: (...args) => getDriveClient().deleteFile(...args),
    },
    hotBudgetBytes,
    logger,
  });

  /** Pending OAuth PKCE (single-flight; enough for one user workbench). */
  let pendingOAuth = null;

  const afterMutation = async () => {
    await watcher.syncFromIndex();
    if (driveClientConfigured) {
      const auth = await store.readDriveAuth();
      if (auth?.accessToken || auth?.refreshToken) {
        void tier.enforceBudget().catch((error) => {
          logger.warn?.('[artifacts] budget enforcement failed:', error?.message ?? error);
        });
      }
    }
  };

  const storageSnapshot = async () => {
    const index = await store.getIndex();
    const hotUsage = computeHotUsage(index);
    const versions = Object.values(index.versions).flat();
    return {
      hotUsageBytes: hotUsage,
      hotBudgetBytes,
      artifactCount: Object.keys(index.artifacts).length,
      versionCount: versions.length,
      coldCount: versions.filter((version) => version.tier === 'cold').length,
      revision: index.revision,
    };
  };

  const driveStatus = async () => {
    const configured = driveClientConfigured;
    const auth = await store.readDriveAuth();
    const connected = Boolean(auth?.accessToken || auth?.refreshToken);
    return {
      configured,
      connected,
      expiresAt: auth?.expiresAt ?? null,
    };
  };

  return {
    store,
    watcher,
    tier,
    hotBudgetBytes,
    async start() {
      await store.ensureLoaded();
      await watcher.syncFromIndex();
    },
    stop() {
      watcher.stop();
    },
    listArtifacts: (directory) => listArtifacts({ store, directory: asNonEmptyString(directory) || undefined }),
    getArtifact: (artifactId) => getArtifact({ store, artifactId }),
    collect: async ({ path: sourcePath, directory, title, origin }) => {
      const resolved = path.resolve(asNonEmptyString(sourcePath));
      if (!asNonEmptyString(sourcePath)) {
        throw Object.assign(new Error('Path is required'), { status: 400 });
      }
      const result = await collectArtifact({
        store,
        sourcePath: resolved,
        directory: asNonEmptyString(directory) || '',
        title: asNonEmptyString(title) || undefined,
        origin: origin === 'agent' ? 'agent' : 'user',
        fsPromises,
        snapshotVersion,
      });
      await afterMutation();
      return result;
    },
    patch: async (artifactId, { title }) => {
      const updated = await patchArtifact({ store, artifactId, title });
      await afterMutation();
      return updated;
    },
    uncollect: async (artifactId, { purge }) => {
      const result = await uncollectArtifact({ store, artifactId, purgeVersions: Boolean(purge) });
      await afterMutation();
      return result;
    },
    snapshot: async (artifactId, { label } = {}) => {
      const result = await snapshotVersion({ artifactId, source: 'manual', label: asNonEmptyString(label) || null });
      await afterMutation();
      return result;
    },
    listVersions: (artifactId) => listVersions({ store, artifactId }),
    getVersion: (artifactId, versionId) => getVersion({ store, artifactId, versionId }),
    labelVersion: async (artifactId, versionId, label) => {
      const updated = await labelVersion({ store, artifactId, versionId, label });
      await afterMutation();
      return updated;
    },
    readVersionContent: (artifactId, versionId) => readVersionContent({ store, artifactId, versionId }),
    restoreVersion: async (artifactId, versionId, { force } = {}) => {
      const version = await restoreVersionToSource({
        store,
        artifactId,
        versionId,
        force: Boolean(force),
        fsPromises,
      });
      await afterMutation();
      return version;
    },
    pullVersion: async (artifactId, versionId) => {
      const result = await tier.promoteVersion({ artifactId, versionId });
      await afterMutation();
      return result;
    },
    storageSnapshot,
    driveStatus,
    startDriveAuth: async ({ baseUrl }) => {
      if (!oauthClient) {
        throw Object.assign(new Error('Google Drive OAuth is not configured'), {
          status: 501,
          code: 'drive_not_configured',
        });
      }
      const state = crypto.randomBytes(16).toString('base64url');
      const { verifier, challenge } = createPkcePair(crypto);
      const redirectUri = `${baseUrl.replace(/\/$/, '')}/api/artifacts/drive/callback`;
      pendingOAuth = { state, codeVerifier: verifier, createdAt: Date.now() };
      const authorizeUrl = buildDriveAuthorizeUrl({
        clientId: oauthClient.clientId,
        redirectUri,
        state,
        codeChallenge: challenge,
      });
      return { authorizeUrl, state };
    },
    completeDriveAuth: async ({ code, state }) => {
      if (!oauthClient) {
        throw Object.assign(new Error('Google Drive OAuth is not configured'), {
          status: 501,
          code: 'drive_not_configured',
        });
      }
      if (!pendingOAuth || pendingOAuth.state !== asNonEmptyString(state)) {
        throw Object.assign(new Error('Drive OAuth state mismatch'), { status: 400 });
      }
      if (Date.now() - pendingOAuth.createdAt > 10 * 60 * 1000) {
        pendingOAuth = null;
        throw Object.assign(new Error('Drive OAuth attempt expired'), { status: 400 });
      }
      const redirectUri = pendingOAuth.redirectUri;
      if (!asNonEmptyString(redirectUri)) {
        throw Object.assign(new Error('Drive OAuth redirect URI missing'), { status: 400 });
      }
      const tokens = await exchangeDriveCode({
        client: oauthClient,
        code: asNonEmptyString(code),
        codeVerifier: pendingOAuth.codeVerifier,
        redirectUri,
        fetchImpl,
      });
      pendingOAuth = null;
      await store.writeDriveAuth({
        ...tokens,
        connectedAt: Date.now(),
      });
      return driveStatus();
    },
    /** Record the redirect URI used for the in-flight OAuth attempt. */
    rememberDriveRedirectUri: (redirectUri) => {
      if (pendingOAuth) pendingOAuth.redirectUri = redirectUri;
    },
    disconnectDrive: async () => {
      await store.clearDriveAuth();
      return driveStatus();
    },
  };
};

export const registerArtifactRoutes = (app, { runtime, resolveReadPathFromContext, fsPromises, path: pathModule }) => {
  app.get('/api/artifacts', async (req, res) => {
    try {
      const artifacts = await runtime.listArtifacts(req.query?.directory);
      res.json({ artifacts });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/artifacts', async (req, res) => {
    try {
      const sourcePath = asNonEmptyString(req.body?.path);
      if (!sourcePath) {
        res.status(400).json({ error: 'Path is required' });
        return;
      }
      const resolved = await resolveReadPathFromContext({ req, targetPath: sourcePath, scope: 'raw' });
      if (!resolved?.ok) {
        res.status(400).json({ error: resolved?.error || 'Path is outside of active workspace' });
        return;
      }
      const canonicalPath = await fsPromises.realpath(resolved.resolved);
      const result = await runtime.collect({
        path: canonicalPath,
        directory: resolved.base || req.body?.directory || '',
        title: req.body?.title,
        origin: req.body?.origin,
      });
      res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/artifacts/storage', async (req, res) => {
    try {
      res.json(await runtime.storageSnapshot());
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/artifacts/drive/status', async (req, res) => {
    try {
      res.json(await runtime.driveStatus());
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/artifacts/drive/auth', async (req, res) => {
    try {
      const host = req.get('host') || '';
      const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
      const baseUrl = `${proto}://${host}`;
      const result = await runtime.startDriveAuth({ baseUrl });
      res.json(result);
    } catch (error) {
      sendError(res, error, 501);
    }
  });

  app.get('/api/artifacts/drive/callback', async (req, res) => {
    try {
      const host = req.get('host') || '';
      const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
      const redirectUri = `${proto}://${host}/api/artifacts/drive/callback`;
      runtime.rememberDriveRedirectUri(redirectUri);
      const code = asNonEmptyString(req.query?.code);
      const state = asNonEmptyString(req.query?.state);
      if (!code) {
        res.status(400).send('Missing OAuth code');
        return;
      }
      await runtime.completeDriveAuth({ code, state });
      res.send('<html><body><p>Google Drive connected. You can close this window.</p></body></html>');
    } catch (error) {
      res.status(error?.status || 500).send(error?.message || 'Drive OAuth failed');
    }
  });

  app.delete('/api/artifacts/drive/auth', async (req, res) => {
    try {
      res.json(await runtime.disconnectDrive());
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/artifacts/:id', async (req, res) => {
    try {
      const artifact = await runtime.getArtifact(req.params.id);
      if (!artifact) {
        res.status(404).json({ error: 'Artifact not found' });
        return;
      }
      res.json({ artifact });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.patch('/api/artifacts/:id', async (req, res) => {
    try {
      const artifact = await runtime.patch(req.params.id, { title: req.body?.title });
      res.json({ artifact });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete('/api/artifacts/:id', async (req, res) => {
    try {
      const purge = req.query?.purge === '1' || req.query?.purge === 'true' || req.body?.purge === true;
      res.json(await runtime.uncollect(req.params.id, { purge }));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/artifacts/:id/snapshot', async (req, res) => {
    try {
      const result = await runtime.snapshot(req.params.id, { label: req.body?.label });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/artifacts/:id/versions', async (req, res) => {
    try {
      const versions = await runtime.listVersions(req.params.id);
      res.json({ versions });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.patch('/api/artifacts/:id/versions/:versionId', async (req, res) => {
    try {
      const version = await runtime.labelVersion(req.params.id, req.params.versionId, req.body?.label ?? '');
      res.json({ version });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/artifacts/:id/versions/:versionId/content', async (req, res) => {
    try {
      const artifact = await runtime.getArtifact(req.params.id);
      const buffer = await runtime.readVersionContent(req.params.id, req.params.versionId);
      res.setHeader('Content-Type', artifact?.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', String(buffer.length));
      res.send(buffer);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/artifacts/:id/versions/:versionId/pull', async (req, res) => {
    try {
      res.json(await runtime.pullVersion(req.params.id, req.params.versionId));
    } catch (error) {
      sendError(res, error, error?.code === 'drive_not_connected' ? 501 : 500);
    }
  });

  app.post('/api/artifacts/:id/versions/:versionId/restore', async (req, res) => {
    try {
      const version = await runtime.restoreVersion(req.params.id, req.params.versionId, {
        force: req.body?.force === true,
      });
      res.json({ version });
    } catch (error) {
      sendError(res, error);
    }
  });
};

export { hashBytes };
