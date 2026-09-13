/**
 * Client for the document conversion service.
 *
 * Office formats are turned into PDF by a LibreOffice sidecar (see
 * `deploy/office-convert/`); this module owns that HTTP contract and nothing
 * else. The sidecar keeps the converted PDFs in its own cache, so the same file
 * version is only converted once — the service is asked for the cached copy
 * first and only sees document bytes when it has to actually run a conversion.
 *
 * Contract:
 *   GET  /health          -> 200 when LibreOffice is usable
 *   GET  /cache/<key>     -> 200 PDF | 404 not converted yet
 *   POST /convert/<key>?name=<file>
 *                         -> 200 PDF | 413 too large | 422 conversion failed
 *
 * The `<key>` is opaque to the service: it is only a cache file name, so the
 * service never has to know anything about the workspace it is serving.
 */

const PROBE_TIMEOUT_MS = 2500;
const HEALTH_CACHE_TTL_MS = 30 * 1000;
const HEALTH_CACHE_FAILURE_TTL_MS = 5 * 1000;

/**
 * The cache identity of one file version. Anything that changes the bytes —
 * a different path, a save, a truncation — produces a different key, so a
 * converted PDF can never be served for content it was not made from.
 */
export const buildConversionKey = ({ crypto, canonicalPath, mtimeMs, size }) => crypto
  .createHash('sha1')
  .update(`${canonicalPath}|${Math.trunc(mtimeMs)}|${Math.trunc(size)}`)
  .digest('hex');

export const createDocumentConverter = ({ fetchImpl, baseUrl, timeoutMs }) => {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const url = (pathname) => `${root}${pathname}`;
  const offline = () => typeof fetchImpl !== 'function';

  // A conversion is a real LibreOffice run: it gets its own, much longer budget
  // than a health probe, and a timeout is reported as such so the UI can tell
  // "this document is too heavy" apart from "the service is down".
  const conversionSignal = () => (
    typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
  );

  let healthCache = { at: 0, value: null };

  const rememberHealth = (result) => {
    healthCache = {
      at: Date.now(),
      value: {
        ttlMs: result.available ? HEALTH_CACHE_TTL_MS : HEALTH_CACHE_FAILURE_TTL_MS,
        result,
      },
    };
    return result;
  };

  const probe = async ({ force = false } = {}) => {
    const now = Date.now();
    if (!force && healthCache.value && now - healthCache.at < healthCache.value.ttlMs) {
      return healthCache.value.result;
    }
    if (offline()) {
      return rememberHealth({ available: false, reason: 'converter-unavailable' });
    }

    try {
      const response = await fetchImpl(url('/health'), {
        signal: typeof AbortSignal?.timeout === 'function'
          ? AbortSignal.timeout(PROBE_TIMEOUT_MS)
          : undefined,
        headers: { accept: 'application/json' },
      });
      return rememberHealth(response.ok
        ? { available: true, reason: null }
        : { available: false, reason: 'converter-unavailable' });
    } catch (error) {
      console.warn('Document conversion service probe failed:', error?.message || error);
      return rememberHealth({ available: false, reason: 'converter-unavailable' });
    }
  };

  /**
   * The cache is an optimisation, so nothing here can fail a preview: a probe
   * that cannot be made or answered is reported as a miss, and the conversion
   * attempt that follows produces the real reason. An empty body counts as a
   * miss too, because a zero-byte entry can only be the remains of a conversion
   * that died halfway.
   */
  const readConverted = async (key) => {
    if (offline()) {
      return { hit: false };
    }
    try {
      const response = await fetchImpl(url(`/cache/${encodeURIComponent(key)}`), {
        signal: conversionSignal(),
      });
      if (!response.ok) {
        return { hit: false };
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes.length ? { hit: true, bytes } : { hit: false };
    } catch (error) {
      console.warn('Failed to read a converted document:', error?.message || error);
      return { hit: false };
    }
  };

  const convert = async ({ key, fileName, bytes }) => {
    if (offline()) {
      return { ok: false, reason: 'converter-unavailable' };
    }
    try {
      const response = await fetchImpl(
        url(`/convert/${encodeURIComponent(key)}?name=${encodeURIComponent(fileName)}`),
        {
          method: 'POST',
          body: bytes,
          signal: conversionSignal(),
          headers: { 'content-type': 'application/octet-stream' },
        },
      );

      if (response.status === 413) {
        return { ok: false, reason: 'too-large' };
      }
      if (!response.ok) {
        return { ok: false, reason: 'conversion-failed' };
      }

      const converted = Buffer.from(await response.arrayBuffer());
      return converted.length
        ? { ok: true, bytes: converted }
        : { ok: false, reason: 'conversion-failed' };
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      if (timedOut) {
        return { ok: false, reason: 'conversion-timeout' };
      }
      console.warn('Document conversion failed:', error?.message || error);
      return { ok: false, reason: 'conversion-failed' };
    }
  };

  return {
    probe,
    readConverted,
    convert,
    /** Test seam: drop the cached health result. */
    resetHealthCache: () => {
      healthCache = { at: 0, value: null };
    },
  };
};
