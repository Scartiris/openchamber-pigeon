/**
 * Signing helpers for the document preview surface.
 *
 * Two independent tokens exist:
 *
 *  - the **raw token** authorises one server-side document fetch by the
 *    OnlyOffice Document Server. It is deliberately not a UI session: the
 *    document server fetches `/doc-preview/raw` from another container without
 *    cookies or an `Authorization` header, so the capability has to live in the
 *    URL itself. The payload pins the canonical path, the file version and an
 *    expiry, and is signed with a local secret.
 *  - the **editor JWT** is the OnlyOffice document-server token that protects
 *    the editor configuration (`JWT_ENABLED=true` on the sidecar). It is an
 *    HS256 JWT over the whole editor config.
 *
 * Both are implemented with `node:crypto` primitives only — the sidecar is
 * optional, so the feature must not drag in a JWT dependency.
 */

const TOKEN_VERSION = 'v1';

const toBase64Url = (value) => Buffer.from(value, 'utf8').toString('base64url');

const fromBase64Url = (value) => Buffer.from(value, 'base64url').toString('utf8');

const safeEqual = (crypto, left, right) => {
  const leftBuffer = Buffer.from(String(left), 'utf8');
  const rightBuffer = Buffer.from(String(right), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const hmac = (crypto, secret, value) => crypto
  .createHmac('sha256', String(secret))
  .update(value)
  .digest('base64url');

/**
 * Sign a capability token for one document version.
 * `payload` is `{ p: canonicalPath, m: mtimeMs, s: size, e: expiresAtMs }`.
 */
export const signRawToken = ({ crypto, secret, payload }) => {
  const body = toBase64Url(JSON.stringify({ v: TOKEN_VERSION, ...payload }));
  return `${body}.${hmac(crypto, secret, body)}`;
};

/**
 * Verify a capability token. Returns `{ ok: true, payload }` or
 * `{ ok: false, reason: 'malformed' | 'signature' | 'expired' }`.
 */
export const verifyRawToken = ({ crypto, secret, token, now = Date.now() }) => {
  const raw = typeof token === 'string' ? token.trim() : '';
  const separator = raw.lastIndexOf('.');
  if (!raw || separator <= 0 || separator === raw.length - 1) {
    return { ok: false, reason: 'malformed' };
  }

  const body = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (!safeEqual(crypto, signature, hmac(crypto, secret, body))) {
    return { ok: false, reason: 'signature' };
  }

  let payload = null;
  try {
    payload = JSON.parse(fromBase64Url(body));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!payload || typeof payload !== 'object' || payload.v !== TOKEN_VERSION) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload.p !== 'string' || !payload.p) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload.e !== 'number' || !Number.isFinite(payload.e) || payload.e <= now) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload };
};

/**
 * HS256 JWT for the OnlyOffice editor configuration. The document server
 * validates the `token` field against the same shared secret.
 */
export const signJwt = ({ crypto, secret, payload }) => {
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = toBase64Url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  return `${data}.${hmac(crypto, secret, data)}`;
};

/**
 * Verify an HS256 JWT signature against the shared editor secret. Returns
 * `{ ok: true, payload }` or `{ ok: false }`. The callback route uses this as
 * a secondary check; the edit capability token remains the write authority.
 */
export const verifyJwt = ({ crypto, secret, token }) => {
  const raw = typeof token === 'string' ? token.trim() : '';
  const parts = raw.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false };
  }

  const expected = hmac(crypto, secret, `${parts[0]}.${parts[1]}`);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(parts[2], 'utf8');
  if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    return { ok: false };
  }

  try {
    const payload = JSON.parse(fromBase64Url(parts[1]));
    if (!payload || typeof payload !== 'object') {
      return { ok: false };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false };
  }
};

/** Short, stable, OnlyOffice-safe document key (<=128 chars, `[0-9a-f]`). */
export const buildDocumentKey = ({ crypto, canonicalPath, mtimeMs, size }) => crypto
  .createHash('sha1')
  .update(`${canonicalPath}|${Math.trunc(mtimeMs)}|${Math.trunc(size)}`)
  .digest('hex');
