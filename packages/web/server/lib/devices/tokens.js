import { asNonEmptyString, asObject } from './parse.js';

const TOKEN_PREFIX = 'oc_device_mcp_';
const TOKEN_BYTES = 32;
const STORE_VERSION = 1;

const nowIso = () => new Date().toISOString();

const safeJsonParse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const constantTimeEqualHex = (left, right, crypto) => {
  const leftText = asNonEmptyString(left);
  const rightText = asNonEmptyString(right);
  if (!leftText || !rightText) return false;
  const leftBuffer = Buffer.from(leftText, 'hex');
  const rightBuffer = Buffer.from(rightText, 'hex');
  if (leftBuffer.length === 0 || leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

export const createDeviceMcpTokenRuntime = ({ fsPromises, path, crypto, storePath }) => {
  const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

  const readStore = async () => {
    try {
      const raw = await fsPromises.readFile(storePath, 'utf8');
      const parsed = asObject(safeJsonParse(raw));
      const tokensRaw = parsed && Array.isArray(parsed.tokens) ? parsed.tokens : [];
      return {
        version: STORE_VERSION,
        tokens: tokensRaw
          .map((token) => asObject(token))
          .filter((token) => token && asNonEmptyString(token.tokenHash)),
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: STORE_VERSION, tokens: [] };
      throw error;
    }
  };

  const writeStore = async (store) => {
    await fsPromises.mkdir(path.dirname(storePath), { recursive: true });
    const tempPath = `${storePath}.tmp`;
    await fsPromises.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await fsPromises.rename(tempPath, storePath);
  };

  const createToken = async ({ label } = {}) => {
    const store = await readStore();
    const token = `${TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;
    const labelText = asNonEmptyString(label);
    const record = {
      id: crypto.randomBytes(8).toString('hex'),
      label: labelText ? labelText.slice(0, 80) : 'Device MCP agent',
      tokenHash: hashToken(token),
      createdAt: nowIso(),
      lastUsedAt: null,
      revokedAt: null,
    };
    store.tokens.push(record);
    await writeStore(store);
    return { id: record.id, label: record.label, token, createdAt: record.createdAt };
  };

  const listTokens = async () => {
    const store = await readStore();
    return store.tokens
      .filter((token) => !token.revokedAt)
      .map((token) => ({
        id: token.id,
        label: token.label,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
      }));
  };

  const revokeToken = async (id) => {
    const store = await readStore();
    const record = store.tokens.find((token) => token.id === id);
    if (!record || record.revokedAt) return false;
    record.revokedAt = nowIso();
    await writeStore(store);
    return true;
  };

  const authenticate = async (presented) => {
    const tokenText = asNonEmptyString(presented);
    if (!tokenText || !tokenText.startsWith(TOKEN_PREFIX)) return null;
    const store = await readStore();
    const presentedHash = hashToken(tokenText);
    const record = store.tokens.find((token) => !token.revokedAt
      && constantTimeEqualHex(token.tokenHash, presentedHash, crypto));
    if (!record) return null;
    record.lastUsedAt = nowIso();
    try {
      await writeStore(store);
    } catch {
      // Authentication already succeeded; last-used is best effort.
    }
    return { id: record.id, label: record.label };
  };

  return { createToken, listTokens, revokeToken, authenticate };
};

export { TOKEN_PREFIX as DEVICE_MCP_TOKEN_PREFIX };
