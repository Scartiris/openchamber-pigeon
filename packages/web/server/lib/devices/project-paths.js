/**
 * Device-project path model.
 *
 * Windows remote paths on a registered node map onto one POSIX mount root
 * (`/mnt/oc-devices/<slug>/`). Project paths in OpenChamber are always the
 * mounted POSIX path so the existing FS/git/terminal stack treats them as
 * ordinary local directories.
 */

const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

/** Stable directory name for a device under the shared mount parent. */
export const deviceMountSlug = (deviceId) => {
  const id = String(deviceId || '').trim();
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw Object.assign(new Error('Invalid device id for mount slug'), {
      code: 'invalid_input',
      statusCode: 400,
    });
  }
  return id;
};

/** Normalize a Windows path to `C:/Users/foo` form (forward slashes, no trailing slash). */
export const normalizeWindowsPath = (value) => {
  let raw = String(value || '').trim();
  if (!raw) return '';
  raw = raw.replace(/\\/g, '/');
  while (raw.length > 1 && raw.endsWith('/')) raw = raw.slice(0, -1);
  // `C:` alone is fine; `C:/` becomes `C:`.
  if (/^[A-Za-z]:\/$/.test(raw)) raw = raw.slice(0, 2);
  return raw;
};

/**
 * SFTP path for Windows OpenSSH, which exposes volumes as `/C:/...`.
 * Accepts `C:\Users\x`, `C:/Users/x`, or already-prefixed `/C:/Users/x`.
 */
export const windowsPathToSftp = (value) => {
  const normalized = normalizeWindowsPath(value);
  if (!normalized) return '';
  if (normalized.startsWith('/')) return normalized;
  if (WINDOWS_DRIVE_RE.test(normalized)) return `/${normalized}`;
  return `/${normalized}`;
};

/**
 * POSIX relative segment of `remotePath` under `remoteRoot`.
 * Returns `''` when they are the same directory.
 * Throws `invalid_input` on `..` / absolute escape / non-child paths.
 */
export const remoteRelativeSegment = (remoteRoot, remotePath) => {
  const root = normalizeWindowsPath(remoteRoot);
  const target = normalizeWindowsPath(remotePath);
  if (!root || !target) {
    throw Object.assign(new Error('remoteRoot and remotePath are required'), {
      code: 'invalid_input',
      statusCode: 400,
    });
  }
  if (root.toLowerCase() === target.toLowerCase()) return '';

  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  if (!target.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
    throw Object.assign(new Error('remotePath is outside the device mount root'), {
      code: 'path_escape',
      statusCode: 400,
    });
  }

  const rest = target.slice(rootPrefix.length);
  const segments = rest.split('/').filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw Object.assign(new Error('remotePath must not contain "." or ".." segments'), {
        code: 'path_escape',
        statusCode: 400,
      });
    }
    if (segment.includes('\0')) {
      throw Object.assign(new Error('remotePath contains a null byte'), {
        code: 'path_escape',
        statusCode: 400,
      });
    }
  }
  return segments.join('/');
};

/**
 * Host/container project path under the device mount root.
 * `mountRoot` is e.g. `/mnt/oc-devices/dev_abc`.
 */
export const projectPathFromRemote = ({ deviceId, remoteRoot, remotePath, mountParent = '/mnt/oc-devices' }) => {
  const slug = deviceMountSlug(deviceId);
  const mountRoot = `${String(mountParent || '/mnt/oc-devices').replace(/\/+$/, '')}/${slug}`;
  const rel = remoteRelativeSegment(remoteRoot, remotePath);
  return rel ? `${mountRoot}/${rel}` : mountRoot;
};

/** Inverse: remote Windows path for a mounted project path. */
export const remotePathFromProjectPath = ({ deviceId, remoteRoot, projectPath, mountParent = '/mnt/oc-devices' }) => {
  const slug = deviceMountSlug(deviceId);
  const parent = String(mountParent || '/mnt/oc-devices').replace(/\/+$/, '');
  const mountRoot = `${parent}/${slug}`;
  const normalizedProject = String(projectPath || '').replace(/\/+$/, '');
  if (normalizedProject !== mountRoot && !normalizedProject.startsWith(`${mountRoot}/`)) {
    throw Object.assign(new Error('projectPath is outside the device mount root'), {
      code: 'path_escape',
      statusCode: 400,
    });
  }
  const rel = normalizedProject === mountRoot ? '' : normalizedProject.slice(mountRoot.length + 1);
  const root = normalizeWindowsPath(remoteRoot);
  if (!rel) return root;
  return `${root}/${rel.split('/').join('/')}`;
};
