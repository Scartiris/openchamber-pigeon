import { isFiniteNumber, isNonEmptyString } from './guards';
import type { FleetSeverity } from './types';

/**
 * Presentation helpers for the fleet panel. Pure on purpose: the numbers a
 * monitoring surface shows are the ones people make decisions from, so they are
 * unit-tested rather than eyeballed.
 *
 * Missing readings render as `—`, never as 0: "no data" and "empty disk" must
 * not look the same.
 */

export const EMPTY_VALUE = '—';

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export const formatBytes = (bytes: number | null | undefined, fractionDigits = 1): string => {
  if (!isFiniteNumber(bytes) || bytes < 0) return EMPTY_VALUE;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : fractionDigits;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unitIndex]}`;
};

export const formatRate = (bytesPerSecond: number | null | undefined): string => {
  if (!isFiniteNumber(bytesPerSecond)) return EMPTY_VALUE;
  return `${formatBytes(bytesPerSecond)}/s`;
};

export const formatPercent = (percent: number | null | undefined, fractionDigits = 1): string => {
  if (!isFiniteNumber(percent)) return EMPTY_VALUE;
  const rounded = Number(percent.toFixed(fractionDigits));
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(fractionDigits)}%`;
};

export const formatCores = (count: number | null | undefined): string => {
  if (!isFiniteNumber(count) || count <= 0) return EMPTY_VALUE;
  return String(Math.round(count));
};

export const formatUptime = (seconds: number | null | undefined): string => {
  if (!isFiniteNumber(seconds) || seconds < 0) return EMPTY_VALUE;
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
};

/** Milliseconds → whole seconds, for the "{seconds}s ago" strings. */
export const toAgeSeconds = (ageMs: number | null | undefined): number | null => {
  if (!isFiniteNumber(ageMs) || ageMs < 0) return null;
  return Math.max(0, Math.round(ageMs / 1000));
};

export const severityOfPercent = (percent: number | null | undefined): FleetSeverity => {
  if (!isFiniteNumber(percent)) return 'ok';
  if (percent >= 90) return 'error';
  if (percent >= 80) return 'warn';
  return 'ok';
};

export const severityTextClass = (severity: FleetSeverity): string => {
  if (severity === 'error') return 'text-status-error';
  if (severity === 'warn') return 'text-status-warning';
  return 'text-status-success';
};

export const severityDotClass = (severity: FleetSeverity): string => {
  if (severity === 'error') return 'bg-status-error';
  if (severity === 'warn') return 'bg-status-warning';
  return 'bg-status-success';
};

/**
 * Which translation key explains a device row that has no metrics.
 * Unknown codes fall back to the generic wording instead of leaking a raw code
 * into the interface.
 */
export const deviceErrorTextKey = (
  code: string | null | undefined,
): 'fleet.devices.offline' | 'fleet.devices.metricsUnavailable' => {
  switch (code) {
    case 'device_offline':
    case 'transport_unavailable':
      return 'fleet.devices.offline';
    case 'approval_required':
    case 'permission_denied':
      return 'fleet.devices.metricsUnavailable';
    default:
      return 'fleet.devices.metricsUnavailable';
  }
};

export const shortSha = (sha: string | null | undefined): string | null => {
  if (!isNonEmptyString(sha)) return null;
  const trimmed = sha.trim();
  return trimmed.length > 9 ? trimmed.slice(0, 9) : trimmed;
};
