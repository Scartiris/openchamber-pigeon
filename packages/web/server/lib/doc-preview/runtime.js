/**
 * Runtime configuration + document-server reachability for the preview surface.
 *
 * The feature is **off unless configured**: without a document-server URL and a
 * JWT secret every preview route answers `not-configured`, so upstream builds,
 * the desktop app and plain `bun dev` behave exactly as before.
 *
 * Environment:
 *   OPENCHAMBER_DOC_PREVIEW_URL            internal base for the document server
 *                                          (server -> sidecar), e.g. http://documentserver
 *   OPENCHAMBER_DOC_PREVIEW_PUBLIC_URL     browser-facing document server origin,
 *                                          e.g. https://office.example.com (defaults to URL)
 *   OPENCHAMBER_DOC_PREVIEW_DOCUMENT_BASE_URL
 *                                          base URL the document server uses to fetch
 *                                          documents back from OpenChamber
 *                                          (default: the request origin)
 *   OPENCHAMBER_DOC_PREVIEW_JWT_SECRET     shared secret for the editor JWT (required)
 *   OPENCHAMBER_DOC_PREVIEW_RAW_SECRET     overrides the generated capability-token secret
 *   OPENCHAMBER_DOC_PREVIEW_DISABLED       "true" force-disables the feature
 */

const HEALTH_CACHE_TTL_MS = 30 * 1000;
const HEALTH_CACHE_FAILURE_TTL_MS = 5 * 1000;
const HEALTH_TIMEOUT_MS = 2500;
const SECRET_BYTES = 32;

const asString = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeUrl = (value) => {
  const trimmed = asString(value);
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/\/+$/, '');
};

const isTruthy = (value) => asString(value).toLowerCase() === 'true';

export const createDocPreviewRuntime = ({
  crypto,
  fsPromises,
  path,
  openchamberDataDir,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) => {
  const disabled = isTruthy(env.OPENCHAMBER_DOC_PREVIEW_DISABLED);
  const internalUrl = normalizeUrl(env.OPENCHAMBER_DOC_PREVIEW_URL);
  const publicUrl = normalizeUrl(env.OPENCHAMBER_DOC_PREVIEW_PUBLIC_URL) || internalUrl;
  const documentBaseUrl = normalizeUrl(env.OPENCHAMBER_DOC_PREVIEW_DOCUMENT_BASE_URL);
  const jwtSecret = asString(env.OPENCHAMBER_DOC_PREVIEW_JWT_SECRET);
  const envRawSecret = asString(env.OPENCHAMBER_DOC_PREVIEW_RAW_SECRET);
  const secretFilePath = path.join(openchamberDataDir, 'doc-preview-secret');

  let rawSecretPromise = null;
  let healthCache = { at: 0, value: null };

  const isConfigured = () => Boolean(!disabled && internalUrl && jwtSecret);

  const readRawSecret = async () => {
    if (envRawSecret) {
      return envRawSecret;
    }
    if (!rawSecretPromise) {
      rawSecretPromise = (async () => {
        try {
          const existing = asString(await fsPromises.readFile(secretFilePath, 'utf8'));
          if (existing) {
            return existing;
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            console.warn('Failed to read the document preview secret:', error);
          }
        }

        const generated = crypto.randomBytes(SECRET_BYTES).toString('hex');
        try {
          await fsPromises.mkdir(path.dirname(secretFilePath), { recursive: true });
          await fsPromises.writeFile(secretFilePath, `${generated}\n`, { mode: 0o600 });
        } catch (error) {
          // An unwritable data dir must not break previews — the token then
          // simply does not survive a server restart.
          console.warn('Failed to persist the document preview secret:', error);
        }
        return generated;
      })();
    }
    return rawSecretPromise;
  };

  /**
   * Probe `/healthcheck` on the sidecar. Results are cached so that a page with
   * several preview tabs does not hammer the sidecar; failures are cached for a
   * much shorter window so recovery is quick.
   */
  const probeDocumentServer = async ({ force = false } = {}) => {
    if (!isConfigured()) {
      return { available: false, reason: disabled ? 'disabled' : 'not-configured' };
    }

    const now = Date.now();
    if (!force && healthCache.value && now - healthCache.at < healthCache.value.ttlMs) {
      return healthCache.value.result;
    }

    const remember = (result) => {
      healthCache = {
        at: Date.now(),
        value: {
          ttlMs: result.available ? HEALTH_CACHE_TTL_MS : HEALTH_CACHE_FAILURE_TTL_MS,
          result,
        },
      };
      return result;
    };

    if (typeof fetchImpl !== 'function') {
      return remember({ available: false, reason: 'document-server-unavailable' });
    }

    try {
      const response = await fetchImpl(`${internalUrl}/healthcheck`, {
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(HEALTH_TIMEOUT_MS) : undefined,
        headers: { accept: 'text/plain' },
      });
      const text = await response.text().catch(() => '');
      const healthy = response.ok && text.trim().toLowerCase().startsWith('true');
      return remember(healthy
        ? { available: true, reason: null }
        : { available: false, reason: 'document-server-unavailable' });
    } catch (error) {
      console.warn('Document server health probe failed:', error?.message || error);
      return remember({ available: false, reason: 'document-server-unavailable' });
    }
  };

  return {
    isConfigured,
    isDisabled: () => disabled,
    getInternalUrl: () => internalUrl,
    getPublicUrl: () => publicUrl,
    getJwtSecret: () => jwtSecret,
    getDocumentBaseUrl: () => documentBaseUrl,
    readRawSecret,
    probeDocumentServer,
    /** Test seam: drop the cached health result. */
    resetHealthCache: () => {
      healthCache = { at: 0, value: null };
    },
    describe: () => ({
      configured: isConfigured(),
      disabled,
      internalUrl: internalUrl || null,
      publicUrl: publicUrl || null,
    }),
  };
};
