/**
 * Client-side deliverable heuristic for artifact hub chrome.
 * Keep aligned with packages/web/server/lib/artifacts/candidates.js.
 * Source code stays out of candidate/chat delivery UI; users can still
 * collect any file explicitly from the file tree context menu.
 */

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

export const isDeliverableArtifactPath = (filePath: string): boolean => {
  const match = /\.([A-Za-z0-9]+)$/.exec(filePath.replace(/\\/g, '/'));
  if (!match) return false;
  return DELIVERABLE_EXTENSIONS.has(match[1].toLowerCase());
};
