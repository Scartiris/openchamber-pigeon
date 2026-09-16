import { asNonEmptyString, asObject } from './parse.js';

const MAX_ENTRIES = 500;

const nowIso = () => new Date().toISOString();

export const createDeviceAuditLog = ({ fsPromises, path, storePath }) => {
  let queue = Promise.resolve();

  const append = (entry) => {
    queue = queue.then(async () => {
      try {
        await fsPromises.mkdir(path.dirname(storePath), { recursive: true });
        let entries = [];
        try {
          const raw = await fsPromises.readFile(storePath, 'utf8');
          const parsed = asObject(JSON.parse(raw));
          entries = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
        } catch {
          entries = [];
        }
        entries.push(entry);
        if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
        await fsPromises.writeFile(storePath, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8');
      } catch (error) {
        console.warn('[devices] failed to write audit log:', error?.message || error);
      }
    }).catch(() => {});
    return queue;
  };

  const record = async ({
    deviceId,
    tool,
    actor,
    decision,
    durationMs,
    error,
    summary,
  }) => {
    const errorText = asNonEmptyString(error);
    const summaryText = asNonEmptyString(summary);
    return append({
      ts: nowIso(),
      deviceId: asNonEmptyString(deviceId),
      tool: asNonEmptyString(tool),
      actor: asNonEmptyString(actor),
      decision: asNonEmptyString(decision) || 'unknown',
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      error: errorText ? errorText.slice(0, 300) : null,
      summary: summaryText ? summaryText.slice(0, 200) : null,
    });
  };

  const listRecent = async (limit = 50) => {
    try {
      const raw = await fsPromises.readFile(storePath, 'utf8');
      const parsed = asObject(JSON.parse(raw));
      const entries = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
      const capped = Math.max(1, Math.min(Number(limit) || 50, MAX_ENTRIES));
      return entries.slice(-capped).reverse();
    } catch {
      return [];
    }
  };

  return { record, listRecent };
};
