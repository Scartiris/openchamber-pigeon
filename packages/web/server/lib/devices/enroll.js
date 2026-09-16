import { asNonEmptyString, asObject } from './parse.js';

const TOKEN_PREFIX = 'oc_enroll_';
const TOKEN_BYTES = 24;
const STORE_VERSION = 1;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

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

/**
 * Short-lived enrollment tokens for one-click device join.
 * The join script presents the token; it can create one device and is then spent.
 */
export const createDeviceEnrollTokenRuntime = ({ fsPromises, path, crypto, storePath }) => {
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

  const createToken = async ({ label, ttlMs } = {}) => {
    const store = await readStore();
    const token = `${TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Number(ttlMs) : DEFAULT_TTL_MS;
    const record = {
      id: crypto.randomBytes(8).toString('hex'),
      label: asNonEmptyString(label)?.slice(0, 80) || 'device-enroll',
      tokenHash: hashToken(token),
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + ttl).toISOString(),
      usedAt: null,
      revokedAt: null,
    };
    store.tokens.push(record);
    await writeStore(store);
    return {
      id: record.id,
      label: record.label,
      token,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  };

  const listTokens = async () => {
    const store = await readStore();
    const now = Date.now();
    return store.tokens
      .filter((token) => !token.revokedAt && !token.usedAt && Date.parse(token.expiresAt) > now)
      .map((token) => ({
        id: token.id,
        label: token.label,
        createdAt: token.createdAt,
        expiresAt: token.expiresAt,
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

  /** Validate without consuming. */
  const peekToken = async (presented) => {
    const tokenText = asNonEmptyString(presented);
    if (!tokenText || !tokenText.startsWith(TOKEN_PREFIX)) {
      return { ok: false, reason: 'invalid_token' };
    }
    const store = await readStore();
    const presentedHash = hashToken(tokenText);
    const record = store.tokens.find((token) => !token.revokedAt
      && !token.usedAt
      && constantTimeEqualHex(token.tokenHash, presentedHash, crypto));
    if (!record) return { ok: false, reason: 'invalid_token' };
    if (Date.parse(record.expiresAt) <= Date.now()) {
      return { ok: false, reason: 'token_expired' };
    }
    return { ok: true, record };
  };

  /** Validate and mark used (one device per token). */
  const consumeToken = async (presented) => {
    const peeked = await peekToken(presented);
    if (!peeked.ok) return peeked;
    const store = await readStore();
    const record = store.tokens.find((token) => token.id === peeked.record.id);
    if (!record) return { ok: false, reason: 'invalid_token' };
    if (record.usedAt || record.revokedAt) return { ok: false, reason: 'invalid_token' };
    record.usedAt = nowIso();
    await writeStore(store);
    return { ok: true, record };
  };

  return { createToken, listTokens, revokeToken, peekToken, consumeToken };
};

export { TOKEN_PREFIX as DEVICE_ENROLL_TOKEN_PREFIX, DEFAULT_TTL_MS as ENROLL_TOKEN_TTL_MS };
