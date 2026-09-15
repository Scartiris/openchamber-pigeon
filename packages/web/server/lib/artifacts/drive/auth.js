/**
 * Google OAuth for Drive cold tier.
 * Tokens never leave the server; the browser only receives an authorize URL.
 *
 * Client id/secret resolution:
 *   OPENCHAMBER_GOOGLE_DRIVE_CLIENT_ID / OPENCHAMBER_GOOGLE_DRIVE_CLIENT_SECRET
 *   (settings override can be layered later without changing this module).
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const asNonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

export const resolveDriveOAuthClient = ({ env = process.env } = {}) => {
  const clientId = asNonEmptyString(env.OPENCHAMBER_GOOGLE_DRIVE_CLIENT_ID);
  const clientSecret = asNonEmptyString(env.OPENCHAMBER_GOOGLE_DRIVE_CLIENT_SECRET);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
};

export const isDriveOAuthConfigured = (deps) => Boolean(resolveDriveOAuthClient(deps));

/** Build the user-facing authorize URL. `state` binds the callback to this server. */
export const buildDriveAuthorizeUrl = ({ clientId, redirectUri, state, codeChallenge }) => {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
};

export const createPkcePair = (crypto) => {
  const verifierBytes = crypto.randomBytes(32);
  const verifier = verifierBytes.toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

export const exchangeDriveCode = async ({
  client,
  code,
  codeVerifier,
  redirectUri,
  fetchImpl = fetch,
}) => {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(payload.error_description || payload.error || 'Drive OAuth exchange failed'), {
      status: 502,
    });
  }
  return normalizeTokenPayload(payload);
};

export const refreshDriveToken = async ({ client, refreshToken, fetchImpl = fetch }) => {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(payload.error_description || payload.error || 'Drive token refresh failed'), {
      status: 502,
    });
  }
  return normalizeTokenPayload(payload, refreshToken);
};

const normalizeTokenPayload = (payload, existingRefresh) => {
  const accessToken = asNonEmptyString(payload.access_token);
  if (!accessToken) {
    throw Object.assign(new Error('Drive OAuth response had no access token'), { status: 502 });
  }
  const expiresIn = Number.isFinite(payload.expires_in) ? Number(payload.expires_in) : 3600;
  const refreshToken = asNonEmptyString(payload.refresh_token) || asNonEmptyString(existingRefresh) || '';
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: asNonEmptyString(payload.token_type) || 'Bearer',
    scope: asNonEmptyString(payload.scope) || DRIVE_SCOPE,
  };
};

/**
 * Ensure a usable access token. Refreshes when expired.
 * Returns null when auth is missing/unusable — callers treat that as not-connected.
 */
export const ensureDriveAccessToken = async ({ store, client, fetchImpl = fetch }) => {
  const auth = await store.readDriveAuth();
  if (!auth || !asNonEmptyString(auth.accessToken)) return null;
  const expiresAt = Number(auth.expiresAt) || 0;
  if (expiresAt - Date.now() > 60_000) {
    return asNonEmptyString(auth.accessToken);
  }
  const refreshToken = asNonEmptyString(auth.refreshToken);
  if (!refreshToken) return null;
  const refreshed = await refreshDriveToken({ client, refreshToken, fetchImpl });
  await store.writeDriveAuth({
    ...auth,
    ...refreshed,
    connectedAt: auth.connectedAt || Date.now(),
  });
  return refreshed.accessToken;
};
