import { describe, expect, test } from 'bun:test';
import {
  deviceMountSlug,
  normalizeWindowsPath,
  projectPathFromRemote,
  remotePathFromProjectPath,
  remoteRelativeSegment,
  windowsPathToSftp,
} from './project-paths.js';

describe('deviceMountSlug', () => {
  test('accepts stable device ids', () => {
    expect(deviceMountSlug('dev_7299d5997226fcbf')).toBe('dev_7299d5997226fcbf');
    expect(deviceMountSlug('dev.1-a_b')).toBe('dev.1-a_b');
  });

  test('rejects path-hostile ids', () => {
    for (const bad of ['', '../x', 'a/b', 'a b', 'a\0b', '-lead']) {
      expect(() => deviceMountSlug(bad)).toThrow(/Invalid device id/);
    }
  });
});

describe('normalizeWindowsPath', () => {
  test('forces forward slashes and drops trailing separators', () => {
    expect(normalizeWindowsPath('C:\\Users\\alice\\')).toBe('C:/Users/alice');
    expect(normalizeWindowsPath('C:/Users/alice//')).toBe('C:/Users/alice');
    expect(normalizeWindowsPath('C:/')).toBe('C:');
  });
});

describe('windowsPathToSftp', () => {
  test('prefixes drive letters for OpenSSH SFTP', () => {
    expect(windowsPathToSftp('C:/Users/alice')).toBe('/C:/Users/alice');
    expect(windowsPathToSftp('C:\\Users\\alice')).toBe('/C:/Users/alice');
  });

  test('keeps already-prefixed paths', () => {
    expect(windowsPathToSftp('/C:/Users/alice')).toBe('/C:/Users/alice');
  });
});

describe('remoteRelativeSegment', () => {
  test('maps child paths and identity', () => {
    expect(remoteRelativeSegment('C:/Users/alice', 'C:/Users/alice')).toBe('');
    expect(remoteRelativeSegment('C:/Users/alice', 'C:/Users/alice/proj/foo')).toBe('proj/foo');
    expect(remoteRelativeSegment('C:/Users/alice', 'C:\\Users\\alice\\proj')).toBe('proj');
  });

  test('is case-insensitive on drive and prefix (Windows)', () => {
    expect(remoteRelativeSegment('c:/Users/alice', 'C:/users/alice/proj')).toBe('proj');
  });

  test('rejects paths outside the mount root', () => {
    expect(() => remoteRelativeSegment('C:/Users/alice', 'C:/Users/bob/x')).toThrow(/outside/);
    expect(() => remoteRelativeSegment('C:/Users/alice', 'D:/x')).toThrow(/outside/);
  });

  test('rejects dot segments even under the root', () => {
    expect(() => remoteRelativeSegment('C:/Users/alice', 'C:/Users/alice/../bob')).toThrow(/dot|outside|\.\./i);
    expect(() => remoteRelativeSegment('C:/Users/alice', 'C:/Users/alice/proj/../x')).toThrow();
    expect(() => remoteRelativeSegment('C:/Users/alice', 'C:/Users/alice/./x')).toThrow();
  });
});

describe('projectPathFromRemote / remotePathFromProjectPath', () => {
  const args = {
    deviceId: 'dev_abc',
    remoteRoot: 'C:/Users/alice',
    mountParent: '/mnt/oc-devices',
  };

  test('root maps to the mount root', () => {
    expect(projectPathFromRemote({ ...args, remotePath: 'C:/Users/alice' })).toBe(
      '/mnt/oc-devices/dev_abc',
    );
  });

  test('child maps under the mount root', () => {
    expect(projectPathFromRemote({ ...args, remotePath: 'C:/Users/alice/proj/foo' })).toBe(
      '/mnt/oc-devices/dev_abc/proj/foo',
    );
    expect(remotePathFromProjectPath({ ...args, projectPath: '/mnt/oc-devices/dev_abc/proj/foo' })).toBe(
      'C:/Users/alice/proj/foo',
    );
    expect(remotePathFromProjectPath({ ...args, projectPath: '/mnt/oc-devices/dev_abc' })).toBe(
      'C:/Users/alice',
    );
  });

  test('rejects project paths outside the mount root', () => {
    expect(() =>
      remotePathFromProjectPath({ ...args, projectPath: '/mnt/oc-devices/other/proj' }),
    ).toThrow(/outside/);
    expect(() =>
      projectPathFromRemote({ ...args, remotePath: 'C:/Users/alice/../../etc' }),
    ).toThrow();
  });

  test('round-trips', () => {
    const remote = 'C:/Users/alice/work/repo';
    const projectPath = projectPathFromRemote({ ...args, remotePath: remote });
    expect(remotePathFromProjectPath({ ...args, projectPath })).toBe(remote);
  });
});
