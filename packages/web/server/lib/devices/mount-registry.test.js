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

  test('health stays not-ready when the mount root exists but nothing is mounted', async () => {
    // 真机实测（2026-10-02）：宿主机助手先 mkdir -p 出挂载点，设备离线或已卸载时
    // 那个空目录还在，旧的 stat().isDirectory() 判定会把它报成 ready —— 侧栏于是给
    // 一台掉线的设备亮绿灯。这里的目录与其父目录同一 filesystem，必须判成 mounting。
    const mountParent = path.join(tempDir, 'mounts');
    await fs.promises.mkdir(path.join(mountParent, 'dev_abc'), { recursive: true });
    const custom = createDeviceMountRegistry({
      fsPromises: fs.promises,
      path,
      storePath: path.join(tempDir, 'device-mounts.json'),
      mountParent,
    });
    await custom.upsertMount({ deviceId: 'dev_abc', remoteRoot: 'C:/Users/alice', ssh });
    const health = await custom.healthFor('dev_abc');
    expect(health.state).toBe('mounting');
    expect(String(health.mountRoot).replace(/\\/g, '/')).toBe(
      path.join(mountParent, 'dev_abc').replace(/\\/g, '/'),
    );
  });

  test('health is ready when the mount root really is a separate filesystem', async () => {
    // 单元测试造不出真挂载，所以只把 stat 换掉：mountRoot 报出与父目录不同的 dev，
    // 等价于 sshfs 挂上之后的形态。真挂载的正例在真机验收里（README-DEVICE-MOUNTS.md T7-2/3）。
    const mountParent = path.join(tempDir, 'mounts');
    const fsPromises = Object.create(fs.promises);
    const custom = createDeviceMountRegistry({
      fsPromises,
      path,
      storePath: path.join(tempDir, 'device-mounts.json'),
      mountParent,
    });
    await custom.upsertMount({ deviceId: 'dev_abc', remoteRoot: 'C:/Users/alice', ssh });
    // 注册表自己拼 mountRoot（正斜杠），测试必须用同一个字符串，否则 stub 命不中。
    const mountRoot = `${String(mountParent).replace(/\/+$/, '')}/dev_abc`;
    await fs.promises.mkdir(mountRoot, { recursive: true });
    const realStat = fs.promises.stat.bind(fs.promises);
    fsPromises.stat = async (target) => {
      const stat = await realStat(target);
      if (String(target) === mountRoot) return { isDirectory: () => true, dev: stat.dev + 1 };
      return stat;
    };
    const health = await custom.healthFor('dev_abc');
    expect(health.state).toBe('ready');
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
