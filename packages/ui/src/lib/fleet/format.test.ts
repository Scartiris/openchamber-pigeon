import { describe, expect, test } from 'bun:test';
import {
  EMPTY_VALUE,
  deviceErrorTextKey,
  formatBytes,
  formatCores,
  formatPercent,
  formatRate,
  formatUptime,
  severityDotClass,
  severityOfPercent,
  severityTextClass,
  shortSha,
  toAgeSeconds,
} from './format';

describe('fleet formatting', () => {
  test('bytes use binary units and never turn missing data into zero', () => {
    expect(formatBytes(null)).toBe(EMPTY_VALUE);
    expect(formatBytes(undefined)).toBe(EMPTY_VALUE);
    expect(formatBytes(-1)).toBe(EMPTY_VALUE);
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.0 TB');
    // Three-digit values drop the decimal so the column stays aligned.
    expect(formatBytes(150 * 1024 ** 3)).toBe('150 GB');
  });

  test('rates append /s and refuse to invent a zero', () => {
    expect(formatRate(null)).toBe(EMPTY_VALUE);
    expect(formatRate(1500)).toBe('1.5 KB/s');
    expect(formatRate(0)).toBe('0 B/s');
  });

  test('percent keeps one decimal unless it is a whole number', () => {
    expect(formatPercent(null)).toBe(EMPTY_VALUE);
    expect(formatPercent(58.53)).toBe('58.5%');
    expect(formatPercent(59)).toBe('59%');
    expect(formatPercent(100)).toBe('100%');
  });

  test('uptime degrades from days to seconds', () => {
    expect(formatUptime(null)).toBe(EMPTY_VALUE);
    expect(formatUptime(45)).toBe('45s');
    expect(formatUptime(600)).toBe('10m');
    expect(formatUptime(3660)).toBe('1h 1m');
    expect(formatUptime(501873)).toBe('5d 19h');
  });

  test('cores and short shas read like the rest of the header', () => {
    expect(formatCores(4)).toBe('4');
    expect(formatCores(0)).toBe(EMPTY_VALUE);
    expect(formatCores(null)).toBe(EMPTY_VALUE);
    expect(shortSha('e98e5b8c5c1f2a3b')).toBe('e98e5b8c5');
    expect(shortSha('abc')).toBe('abc');
    expect(shortSha(null)).toBeNull();
  });

  test('age conversion clamps negatives and rounds to seconds', () => {
    expect(toAgeSeconds(null)).toBeNull();
    expect(toAgeSeconds(-5)).toBeNull();
    expect(toAgeSeconds(0)).toBe(0);
    expect(toAgeSeconds(4200)).toBe(4);
    expect(toAgeSeconds(4600)).toBe(5);
  });

  test('severity thresholds match the server summary', () => {
    expect(severityOfPercent(null)).toBe('ok');
    expect(severityOfPercent(10)).toBe('ok');
    expect(severityOfPercent(80)).toBe('warn');
    expect(severityOfPercent(89.9)).toBe('warn');
    expect(severityOfPercent(90)).toBe('error');
    expect(severityTextClass('warn')).toBe('text-status-warning');
    expect(severityDotClass('error')).toBe('bg-status-error');
  });

  test('device failures explain themselves without leaking raw codes', () => {
    expect(deviceErrorTextKey('device_offline')).toBe('fleet.devices.offline');
    expect(deviceErrorTextKey('transport_unavailable')).toBe('fleet.devices.offline');
    expect(deviceErrorTextKey('approval_required')).toBe('fleet.devices.metricsUnavailable');
    expect(deviceErrorTextKey('metrics_parse_failed')).toBe('fleet.devices.metricsUnavailable');
    expect(deviceErrorTextKey(null)).toBe('fleet.devices.metricsUnavailable');
  });
});
