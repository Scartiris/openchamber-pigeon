import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createArtifactStore, hashBytes } from './store.js';
import {
  collectArtifact,
  findArtifactBySourcePath,
  listArtifacts,
  uncollectArtifact,
} from './registry.js';
import { isDeliverablePath, listCandidateArtifacts } from './candidates.js';
import {
  labelVersion,
  listVersions,
  readVersionContent,
  restoreVersionToSource,
  snapshotArtifactVersion,
} from './versions.js';
import { createArtifactRuntime, registerArtifactRoutes } from './runtime.js';
import { computeHotUsage, selectDemotionCandidates } from './drive/tier.js';

const tempRoots = [];

const makeTempDir = async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oc-artifacts-'));
  tempRoots.push(dir);
  return dir;
};

afterAll(async () => {
  for (const dir of tempRoots) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('artifact hot store and versions', () => {
  test('collect creates an initial version and dedupes identical snapshots', async () => {
    const dataDir = await makeTempDir();
    const workDir = await makeTempDir();
    const sourcePath = path.join(workDir, 'report.md');
    await fs.promises.writeFile(sourcePath, '# v1\n');

    const store = createArtifactStore({ dataDir });
    await store.ensureLoaded();
    const snapshotVersion = ({ artifactId, source = 'auto', label = null }) =>
      snapshotArtifactVersion({ store, artifactId, source, label, fsPromises: fs.promises });

    const { artifact, created } = await collectArtifact({
      store,
      sourcePath,
      directory: workDir,
      fsPromises: fs.promises,
      snapshotVersion,
    });
    expect(created).toBe(true);
    expect(artifact.latestVersionId).toBeTruthy();

    const again = await snapshotVersion({ artifactId: artifact.id });
    expect(again.created).toBe(false);

    await fs.promises.writeFile(sourcePath, '# v2\n');
    const next = await snapshotVersion({ artifactId: artifact.id });
    expect(next.created).toBe(true);
    expect(next.version.contentHash).not.toBe(artifact.contentHash);

    const versions = await listVersions({ store, artifactId: artifact.id });
    expect(versions.length).toBe(2);
  });

  test('restore writes version bytes back and refuses dirty source without force', async () => {
    const dataDir = await makeTempDir();
    const workDir = await makeTempDir();
    const sourcePath = path.join(workDir, 'slides.pptx');
    await fs.promises.writeFile(sourcePath, 'bytes-v1');

    const store = createArtifactStore({ dataDir });
    await store.ensureLoaded();
    const snapshotVersion = ({ artifactId, source = 'auto', label = null }) =>
      snapshotArtifactVersion({ store, artifactId, source, label, fsPromises: fs.promises });

    const { artifact } = await collectArtifact({
      store,
      sourcePath,
      directory: workDir,
      fsPromises: fs.promises,
      snapshotVersion,
    });
    const v1Id = artifact.latestVersionId;

    await fs.promises.writeFile(sourcePath, 'bytes-v2');
    await snapshotVersion({ artifactId: artifact.id });

    // Dirty: un-snapshotted third write.
    await fs.promises.writeFile(sourcePath, 'bytes-dirty');
    await expect(
      restoreVersionToSource({
        store,
        artifactId: artifact.id,
        versionId: v1Id,
        fsPromises: fs.promises,
      }),
    ).rejects.toMatchObject({ code: 'source_dirty' });

    const restored = await restoreVersionToSource({
      store,
      artifactId: artifact.id,
      versionId: v1Id,
      force: true,
      fsPromises: fs.promises,
    });
    expect(restored.contentHash).toBe(hashBytes(Buffer.from('bytes-v1')));
    const live = await fs.promises.readFile(sourcePath, 'utf8');
    expect(live).toBe('bytes-v1');
  });

  test('malformed index is moved aside and starts empty without clobbering', async () => {
    const dataDir = await makeTempDir();
    const artifactsDir = path.join(dataDir, 'artifacts');
    await fs.promises.mkdir(artifactsDir, { recursive: true });
    const indexFile = path.join(artifactsDir, 'index.json');
    await fs.promises.writeFile(indexFile, '{ not json');

    const store = createArtifactStore({ dataDir });
    await store.ensureLoaded();
    const index = await store.getIndex();
    expect(Object.keys(index.artifacts).length).toBe(0);

    const leftovers = await fs.promises.readdir(artifactsDir);
    expect(leftovers.some((name) => name.startsWith('index.json.corrupt-'))).toBe(true);
  });

  test('uncollect with purge removes blobs that nothing else references', async () => {
    const dataDir = await makeTempDir();
    const workDir = await makeTempDir();
    const sourcePath = path.join(workDir, 'note.md');
    await fs.promises.writeFile(sourcePath, 'unique-bytes');

    const store = createArtifactStore({ dataDir });
    await store.ensureLoaded();
    const snapshotVersion = ({ artifactId, source = 'auto', label = null }) =>
      snapshotArtifactVersion({ store, artifactId, source, label, fsPromises: fs.promises });

    const { artifact } = await collectArtifact({
      store,
      sourcePath,
      directory: workDir,
      fsPromises: fs.promises,
      snapshotVersion,
    });
    const hash = (await listVersions({ store, artifactId: artifact.id }))[0].contentHash;
    expect(await store.hasBlob(hash)).toBe(true);

    await uncollectArtifact({ store, artifactId: artifact.id, purgeVersions: true });
    expect(await store.hasBlob(hash)).toBe(false);
    expect(await listArtifacts({ store })).toEqual([]);
  });

  test('label is preserved and content stream works for hot versions', async () => {
    const dataDir = await makeTempDir();
    const workDir = await makeTempDir();
    const sourcePath = path.join(workDir, 'brief.md');
    await fs.promises.writeFile(sourcePath, 'hello');

    const store = createArtifactStore({ dataDir });
    await store.ensureLoaded();
    const snapshotVersion = ({ artifactId, source = 'auto', label = null }) =>
      snapshotArtifactVersion({ store, artifactId, source, label, fsPromises: fs.promises });

    const { artifact } = await collectArtifact({
      store,
      sourcePath,
      directory: workDir,
      fsPromises: fs.promises,
      snapshotVersion,
    });
    const versions = await listVersions({ store, artifactId: artifact.id });
    const labeled = await labelVersion({
      store,
      artifactId: artifact.id,
      versionId: versions[0].id,
      label: '客户终稿',
    });
    expect(labeled.label).toBe('客户终稿');

    const bytes = await readVersionContent({
      store,
      artifactId: artifact.id,
      versionId: versions[0].id,
    });
    expect(bytes.toString('utf8')).toBe('hello');
  });
});

describe('tier policy', () => {
  test('protects latest and labeled versions from demotion candidates', async () => {
    const store = createArtifactStore({ dataDir: await makeTempDir() });
    await store.ensureLoaded();
    await store.commit((draft) => {
      draft.artifacts.a1 = {
        id: 'a1',
        title: 'a',
        sourcePath: '/tmp/a',
        directory: '/tmp',
        mimeType: 'text/plain',
        sizeBytes: 10,
        contentHash: 'h1',
        collectedAt: 1,
        updatedAt: 1,
        latestVersionId: 'v2',
        origin: 'user',
        status: 'active',
      };
      draft.versions.a1 = [
        { id: 'v1', artifactId: 'a1', createdAt: 1, contentHash: 'h1', sizeBytes: 10, label: null, source: 'auto', tier: 'hot' },
        { id: 'v2', artifactId: 'a1', createdAt: 2, contentHash: 'h2', sizeBytes: 10, label: 'keep', source: 'auto', tier: 'hot' },
        { id: 'v3', artifactId: 'a1', createdAt: 3, contentHash: 'h3', sizeBytes: 10, label: null, source: 'auto', tier: 'hot' },
      ];
    });
    const index = await store.getIndex();
    const candidates = selectDemotionCandidates(index).map((row) => row.version.id);
    // v2 is labeled; v3 is latest → only v1 is demotable.
    expect(candidates).toEqual(['v1']);
    expect(computeHotUsage(index)).toBe(30);
  });

  test('does not delete a hot blob still referenced by another version', async () => {
    const dataDir = await makeTempDir();
    const workDir = await makeTempDir();
    const sourcePath = path.join(workDir, 'shared.md');
    await fs.promises.writeFile(sourcePath, 'same-bytes');

    const store = createArtifactStore({ dataDir });
    await store.ensureLoaded();
    const snapshotVersion = ({ artifactId, source = 'auto', label = null }) =>
      snapshotArtifactVersion({ store, artifactId, source, label, fsPromises: fs.promises });

    const { artifact } = await collectArtifact({
      store,
      sourcePath,
      directory: workDir,
      fsPromises: fs.promises,
      snapshotVersion,
    });
    const autoVersion = (await listVersions({ store, artifactId: artifact.id }))[0];
    // Manual labeled save of identical bytes is a no-op by design, so fabricate
    // the shared-hash pair the way a restore + re-label path can: two version
    // rows pointing at one content hash.
    const labeled = {
      id: 'ver_shared_label',
      artifactId: artifact.id,
      createdAt: Date.now() + 1,
      contentHash: autoVersion.contentHash,
      sizeBytes: autoVersion.sizeBytes,
      label: 'named',
      source: 'manual',
      tier: 'hot',
    };
    await store.commit((draft) => {
      draft.versions[artifact.id] = [...(draft.versions[artifact.id] ?? []), labeled];
    });

    const removed = await store.deleteBlobIfUnreferenced(autoVersion.contentHash, {
      excludeVersionId: autoVersion.id,
    });
    expect(removed).toBe(false);
    expect(await store.hasBlob(autoVersion.contentHash)).toBe(true);
  });
});

describe('runtime HTTP surface', () => {
  test('list without any data returns empty success, not a failure', async () => {
    const runtime = createArtifactRuntime({
      openchamberDataDir: await makeTempDir(),
      env: {},
    });
    await runtime.start();
    expect(await runtime.listArtifacts()).toEqual([]);
    runtime.stop();
  });

  test('cold content returns 409 version_cold', async () => {
    const runtime = createArtifactRuntime({
      openchamberDataDir: await makeTempDir(),
      env: {},
    });
    await runtime.start();
    const workDir = await makeTempDir();
    const sourcePath = path.join(workDir, 'x.md');
    await fs.promises.writeFile(sourcePath, 'abc');
    const { artifact, version } = await runtime.collect({ path: sourcePath, directory: workDir });
    await runtime.store.commit((draft) => {
      const list = draft.versions[artifact.id];
      const target = list.find((entry) => entry.id === version.id);
      if (target) target.tier = 'cold';
    });
    await expect(runtime.readVersionContent(artifact.id, version.id)).rejects.toMatchObject({
      code: 'version_cold',
      status: 409,
    });
    runtime.stop();
  });

  test('registerArtifactRoutes exposes list and storage endpoints', async () => {
    const runtime = createArtifactRuntime({
      openchamberDataDir: await makeTempDir(),
      env: {},
    });
    await runtime.start();

    const handlers = new Map();
    const app = {
      get: (p, h) => handlers.set(`GET ${p}`, h),
      post: (p, h) => handlers.set(`POST ${p}`, h),
      patch: (p, h) => handlers.set(`PATCH ${p}`, h),
      delete: (p, h) => handlers.set(`DELETE ${p}`, h),
    };
    registerArtifactRoutes(app, {
      runtime,
      fsPromises: fs.promises,
      path,
      resolveReadPathFromContext: async () => ({ ok: false, error: 'no workspace' }),
    });

    expect(handlers.has('GET /api/artifacts')).toBe(true);
    expect(handlers.has('GET /api/artifacts/storage')).toBe(true);
    expect(handlers.has('GET /api/artifacts/drive/status')).toBe(true);

    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
      },
    };
    await handlers.get('GET /api/artifacts')({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.artifacts).toEqual([]);
    runtime.stop();
  });
});

describe('candidate inbox and path lookup', () => {
  test('deliverable allowlist and skip rules', () => {
    expect(isDeliverablePath('a/report.docx')).toBe(true);
    expect(isDeliverablePath('a/report.PDF')).toBe(true);
    expect(isDeliverablePath('a/report.ts')).toBe(false);
    expect(isDeliverablePath('a/report')).toBe(false);
  });

  test('candidates exclude collected paths and sort by mtime', async () => {
    const workDir = await makeTempDir();
    const older = path.join(workDir, 'older.md');
    const newer = path.join(workDir, 'newer.docx');
    const code = path.join(workDir, 'code.ts');
    const collected = path.join(workDir, 'already.pdf');
    const nestedSkip = path.join(workDir, 'node_modules', 'junk.md');
    const nestedOk = path.join(workDir, 'reports', 'q1.xlsx');

    await fs.promises.mkdir(path.dirname(nestedSkip), { recursive: true });
    await fs.promises.mkdir(path.dirname(nestedOk), { recursive: true });
    await fs.promises.writeFile(older, 'old');
    await fs.promises.writeFile(newer, 'new');
    await fs.promises.writeFile(code, 'code');
    await fs.promises.writeFile(collected, 'pdf');
    await fs.promises.writeFile(nestedSkip, 'junk');
    await fs.promises.writeFile(nestedOk, 'sheet');
    await fs.promises.utimes(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await fs.promises.utimes(newer, new Date(), new Date());

    const candidates = await listCandidateArtifacts({
      directory: workDir,
      collectedPaths: [collected],
      limit: 10,
      fsPromises: fs.promises,
    });

    const paths = candidates.map((entry) => entry.path);
    expect(paths).toContain(older);
    expect(paths).toContain(newer);
    expect(paths).toContain(nestedOk);
    expect(paths).not.toContain(code);
    expect(paths).not.toContain(collected);
    expect(paths).not.toContain(nestedSkip);
    expect(paths.indexOf(newer)).toBeLessThan(paths.indexOf(older));
  });

  test('candidates honor limit', async () => {
    const workDir = await makeTempDir();
    for (let index = 0; index < 5; index += 1) {
      await fs.promises.writeFile(path.join(workDir, `doc-${index}.md`), `# ${index}\n`);
    }
    const limited = await listCandidateArtifacts({
      directory: workDir,
      limit: 2,
      fsPromises: fs.promises,
    });
    expect(limited.length).toBe(2);
  });

  test('unreadable or missing directory is an error, not empty success', async () => {
    await expect(listCandidateArtifacts({
      directory: path.join(os.tmpdir(), `oc-missing-${Date.now()}`),
      fsPromises: fs.promises,
    })).rejects.toMatchObject({ code: 'directory_unreadable' });
  });

  test('runtime path lookup and candidates endpoints', async () => {
    const dataDir = await makeTempDir();
    const workDir = await makeTempDir();
    const sourcePath = path.join(workDir, 'brief.pdf');
    await fs.promises.writeFile(sourcePath, 'pdf-bytes');

    const runtime = createArtifactRuntime({ openchamberDataDir: dataDir, env: {} });
    await runtime.start();
    const { artifact } = await runtime.collect({ path: sourcePath, directory: workDir });

    const found = await runtime.findArtifactBySourcePath(sourcePath);
    expect(found?.id).toBe(artifact.id);
    expect(await findArtifactBySourcePath({ store: runtime.store, sourcePath: path.join(workDir, 'nope.pdf') })).toBeNull();

    const uncollected = path.join(workDir, 'draft.md');
    await fs.promises.writeFile(uncollected, '# draft');
    const candidates = await runtime.listCandidates({ directory: workDir });
    expect(candidates.map((entry) => entry.path)).toContain(uncollected);
    expect(candidates.map((entry) => entry.path)).not.toContain(sourcePath);

    const handlers = new Map();
    const app = {
      get: (p, h) => handlers.set(`GET ${p}`, h),
      post: (p, h) => handlers.set(`POST ${p}`, h),
      patch: (p, h) => handlers.set(`PATCH ${p}`, h),
      delete: (p, h) => handlers.set(`DELETE ${p}`, h),
    };
    const resolveReadPathFromContext = async ({ targetPath }) => {
      if (targetPath === workDir || targetPath === `${workDir}`) {
        return { ok: true, resolved: workDir, base: workDir };
      }
      return { ok: false, error: 'Directory is outside of active workspace' };
    };
    registerArtifactRoutes(app, {
      runtime,
      fsPromises: fs.promises,
      path,
      resolveReadPathFromContext,
    });
    expect(handlers.has('GET /api/artifacts/candidates')).toBe(true);

    const makeRes = () => ({
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
      },
    });

    const listRes = makeRes();
    await handlers.get('GET /api/artifacts')({ query: { path: sourcePath } }, listRes);
    expect(listRes.body.artifact?.id).toBe(artifact.id);

    const missingRes = makeRes();
    await handlers.get('GET /api/artifacts')({ query: { path: path.join(workDir, 'absent.pdf') } }, missingRes);
    expect(missingRes.body.artifact).toBeNull();

    const candRes = makeRes();
    await handlers.get('GET /api/artifacts/candidates')({ query: { directory: workDir } }, candRes);
    expect(Array.isArray(candRes.body.candidates)).toBe(true);
    expect(candRes.body.candidates.map((entry) => entry.path)).toContain(uncollected);

    const outsideRes = makeRes();
    await handlers.get('GET /api/artifacts/candidates')({ query: { directory: '/etc' } }, outsideRes);
    expect(outsideRes.statusCode).toBe(400);
    expect(outsideRes.body.code).toBe('directory_outside_workspace');

    const noDirRes = makeRes();
    await handlers.get('GET /api/artifacts/candidates')({ query: {} }, noDirRes);
    expect(noDirRes.statusCode).toBe(400);
    expect(noDirRes.body.code).toBe('directory_required');

    runtime.stop();
  });
});

