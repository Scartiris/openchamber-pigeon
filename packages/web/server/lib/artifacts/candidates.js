/**
 * Deliverable-looking workspace files that are not yet collected.
 * User-driven inbox data only — never auto-collects.
 */

import path from 'path';

const DELIVERABLE_EXTENSIONS = new Set([
  'pdf',
  'doc', 'docx', 'docm', 'odt', 'rtf',
  'xls', 'xlsx', 'xlsm', 'ods', 'csv',
  'ppt', 'pptx', 'pptm', 'odp',
  'md', 'markdown', 'txt',
  'html', 'htm',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'key', 'pages', 'numbers',
]);

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '.cache',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.worktrees',
]);

const MAX_DEPTH = 4;
const MAX_VISITED_FILES = 2000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export const isDeliverablePath = (filePath) => {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  return DELIVERABLE_EXTENSIONS.has(ext);
};

const shouldSkipDirName = (name) => {
  if (!name) return true;
  if (SKIP_DIR_NAMES.has(name)) return true;
  return name.startsWith('.');
};

/**
 * @param {{
 *   directory: string,
 *   collectedPaths?: Set<string> | Iterable<string>,
 *   limit?: number,
 *   fsPromises: typeof import('fs').promises,
 *   maxDepth?: number,
 *   maxVisitedFiles?: number,
 * }} input
 */
export const listCandidateArtifacts = async ({
  directory,
  collectedPaths,
  limit = DEFAULT_LIMIT,
  fsPromises,
  maxDepth = MAX_DEPTH,
  maxVisitedFiles = MAX_VISITED_FILES,
}) => {
  const root = path.resolve(directory);
  const collected = collectedPaths instanceof Set
    ? collectedPaths
    : new Set(collectedPaths ?? []);
  const safeLimit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_LIMIT),
  );

  let rootStat;
  try {
    rootStat = await fsPromises.stat(root);
  } catch (error) {
    throw Object.assign(new Error(`Directory is not readable: ${error?.message ?? error}`), {
      status: 400,
      code: 'directory_unreadable',
    });
  }
  if (!rootStat.isDirectory()) {
    throw Object.assign(new Error('Candidates require a directory path'), {
      status: 400,
      code: 'directory_required',
    });
  }

  /** @type {Array<{ path: string, title: string, sizeBytes: number, mtimeMs: number, mimeType: string }>} */
  const found = [];
  let visited = 0;

  /** @type {Array<{ dir: string, depth: number }>} */
  const queue = [{ dir: root, depth: 0 }];

  while (queue.length > 0 && visited < maxVisitedFiles) {
    const current = queue.shift();
    if (!current) break;

    let entries;
    try {
      entries = await fsPromises.readdir(current.dir, { withFileTypes: true });
    } catch {
      // A single unreadable subdirectory must not fail the whole inbox.
      continue;
    }

    for (const entry of entries) {
      if (visited >= maxVisitedFiles) break;
      const fullPath = path.join(current.dir, entry.name);

      if (entry.isDirectory()) {
        if (current.depth >= maxDepth) continue;
        if (shouldSkipDirName(entry.name)) continue;
        queue.push({ dir: fullPath, depth: current.depth + 1 });
        continue;
      }

      if (!entry.isFile()) continue;
      visited += 1;
      if (collected.has(fullPath)) continue;
      if (!isDeliverablePath(fullPath)) continue;

      try {
        const stats = await fsPromises.stat(fullPath);
        if (!stats.isFile()) continue;
        found.push({
          path: fullPath,
          title: entry.name,
          sizeBytes: stats.size,
          mtimeMs: stats.mtimeMs,
          mimeType: guessMimeType(fullPath),
        });
      } catch {
        // File vanished between readdir and stat — skip it.
      }
    }
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, safeLimit);
};

const guessMimeType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] || 'application/octet-stream';
};
