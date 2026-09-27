import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeviceMountRegistry } from './mount-registry.js';

let tempDir;
let registry;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mount-reg-'));
  registry = createDeviceMountRegistry({
    fsPromises: fs.promises,
    path,
    storePath: path.join(tempDir, 'device-mounts.json'),
    mountParent: '/mnt/oc-devices',
  });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const ssh = { host: '100.1.2.3', port: 22, user: 'alice' };

describe('mount registry', () => {
  test('upsert writes a host-readable entry', async () => {
    const entry = await registry.upsertMount({
      deviceId: 'dev_abc',
      remoteRoot: 'C:\\Users\\alice\\proj',
      ssh,
    });
    expect(entry.slug).toBe('dev_abc');
    expect(entry.remoteRoot).toBe('C:/Users/alice/proj');
    expect(entry.mountRoot).toBe('/mnt/oc-devices/dev_abc');
    expect(entry.sftpPath).toBe('/C:/Users/alice/proj');
    expect(entry.enabled).toBe(true);

    const onDisk = JSON.parse(await fs.promises.readFile(path.join(tempDir, 'device-mounts.json'), 'utf8'));
    expect(onDisk.mounts).toHaveLength(1);
    expect(onDisk.mounts[0].deviceId).toBe('dev_abc');
    expect(onDisk.mounts[0].ssh.user).toBe('alice');
  });

  test('rejects upsert without SSH host', async () => {
    await expect(
      registry.upsertMount({
        deviceId: 'dev_abc',
        remoteRoot: 'C:/Users/alice',
        ssh: { host: '', port: 22, user: 'alice' },
      }),
    ).rejects.toThrow(/SSH host/);
  });

  test('health is unavailable when the mount root is missing', async () => {
    await registry.upsertMount({ deviceId: 'dev_abc', remoteRoot: 'C:/Users/alice', ssh });
    const health = await registry.healthFor('dev_abc');
    expect(health.state).toBe('mounting');
    expect(health.enabled).toBe(true);
  });

  test('health is ready when mountRoot is a directory', async () => {
    const mountRoot = path.join(tempDir, 'mnt');
    await fs.promises.mkdir(mountRoot, { recursive: true });
    const custom = createDeviceMountRegistry({
      fsPromises: fs.promises,
      path,
      storePath: path.join(tempDir, 'device-mounts.json'),
      mountParent: tempDir,
    });
    await custom.upsertMount({
      deviceId: 'dev_abc',
      remoteRoot: 'C:/Users/alice',
      ssh,
    });
    // Force mountRoot to the real directory we created (slug still under parent).
    // healthFor stats mountRoot = <parent>/<slug>.
    await fs.promises.mkdir(path.join(tempDir, 'dev_abc'), { recursive: true });
    const health = await custom.healthFor('dev_abc');
    expect(health.state).toBe('ready');
    expect(String(health.mountRoot).replace(/\\/g, '/')).toBe(
      path.join(tempDir, 'dev_abc').replace(/\\/g, '/'),
    );
  });

  test('disable marks enabled=false and health disabled', async () => {
    await registry.upsertMount({ deviceId: 'dev_abc', remoteRoot: 'C:/Users/alice', ssh });
    const disabled = await registry.disableMount('dev_abc');
    expect(disabled.enabled).toBe(false);
    const health = await registry.healthFor('dev_abc');
    expect(health.state).toBe('disabled');
  });

  test('health is absent with no entry', async () => {
    const health = await registry.healthFor('dev_missing');
    expect(health.state).toBe('absent');
  });

  test('upsert replaces by deviceId', async () => {
    await registry.upsertMount({ deviceId: 'dev_abc', remoteRoot: 'C:/Users/alice', ssh });
    await registry.upsertMount({
      deviceId: 'dev_abc',
      remoteRoot: 'C:/Users/alice/other',
      ssh,
    });
    const mounts = await registry.listMounts();
    expect(mounts).toHaveLength(1);
    expect(mounts[0].remoteRoot).toBe('C:/Users/alice/other');
  });
});
