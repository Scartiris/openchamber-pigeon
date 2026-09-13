/**
 * Runtime configuration for the preview surface.
 *
 * The feature is **off unless configured**: without a conversion-service URL the
 * office routes answer `not-configured`, so upstream builds, the desktop app and
 * a plain `bun dev` behave exactly as before. Real PDFs keep previewing either
 * way, because the browser renders those itself.
 *
 * Environment:
 *   OPENCHAMBER_DOC_PREVIEW_URL           base URL of the conversion service as
 *                                         reachable from this server, e.g.
 *                                         http://office-convert:8000
 *   OPENCHAMBER_DOC_PREVIEW_TIMEOUT_MS    per-conversion budget (default 120000)
 *   OPENCHAMBER_DOC_PREVIEW_DISABLED      "true" force-disables the feature
 */

import { createDocumentConverter } from './converter.js';

const DEFAULT_CONVERSION_TIMEOUT_MS = 120 * 1000;
const MIN_CONVERSION_TIMEOUT_MS = 5 * 1000;
const MAX_CONVERSION_TIMEOUT_MS = 10 * 60 * 1000;

const asString = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeUrl = (value) => {
  const trimmed = asString(value);
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/\/+$/, '');
};

const isTruthy = (value) => asString(value).toLowerCase() === 'true';

const readTimeout = (value) => {
  const parsed = Number.parseInt(asString(value), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CONVERSION_TIMEOUT_MS;
  }
  // A conversion is allowed to be slow, but never unbounded: the request that
  // waits for it is a user-facing one, and a wedged LibreOffice would otherwise
  // hold it open forever.
  return Math.min(Math.max(parsed, MIN_CONVERSION_TIMEOUT_MS), MAX_CONVERSION_TIMEOUT_MS);
};

export const createDocPreviewRuntime = ({ env = process.env, fetchImpl = globalThis.fetch } = {}) => {
  const disabled = isTruthy(env.OPENCHAMBER_DOC_PREVIEW_DISABLED);
  const converterUrl = normalizeUrl(env.OPENCHAMBER_DOC_PREVIEW_URL);
  const conversionTimeoutMs = readTimeout(env.OPENCHAMBER_DOC_PREVIEW_TIMEOUT_MS);

  const isConfigured = () => Boolean(!disabled && converterUrl);

  const converter = createDocumentConverter({
    fetchImpl,
    baseUrl: converterUrl,
    timeoutMs: conversionTimeoutMs,
  });

  const probeConverter = async (options) => {
    if (!isConfigured()) {
      return { available: false, reason: disabled ? 'disabled' : 'not-configured' };
    }
    return converter.probe(options);
  };

  return {
    isConfigured,
    isDisabled: () => disabled,
    getConverterUrl: () => converterUrl,
    getConversionTimeoutMs: () => conversionTimeoutMs,
    probeConverter,
    readConverted: (key) => converter.readConverted(key),
    convert: (args) => converter.convert(args),
    /** Test seam: drop the cached health result. */
    resetHealthCache: () => converter.resetHealthCache(),
    describe: () => ({
      configured: isConfigured(),
      disabled,
      converterUrl: converterUrl || null,
      conversionTimeoutMs,
    }),
  };
};
