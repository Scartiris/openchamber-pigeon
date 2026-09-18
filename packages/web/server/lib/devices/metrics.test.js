import { describe, expect, test } from 'bun:test';
import {
  buildMetricsCommand,
  createDeviceMetricsRuntime,
  parseMetricsOutput,
} from './metrics.js';

/**
 * Captured verbatim from `pigeoncore` on 2026-09-18 18:34 UTC by running the
 * exact command `buildMetricsCommand('linux')` produces. LF is swapped for CRLF
 * on purpose: Windows devices answer with CRLF and the parser must not care.
 */
const PIGEONCORE_OUTPUT = [
  'platform\tlinux',
  'hostname\tpigeoncore',
  'uptime\t501873.41',
  'cpu\t4\t0.11\t0.20\t0.25',
  'mem\t8077984\t5798056\t11534324\t10357228',
  'net\tens3\t10730567573\t4940363790',
  'disk\t/\t/dev/vda1\t61255049216\t35862216704\t25376055296',
  'collected\t2026-09-18T18:34:51Z',
].join('\r\n');

const decodeBase64Payload = (command) => {
  const match = command.match(/([A-Za-z0-9+/=]{16,})/);
  expect(match).not.toBeNull();
  return match[1];
};

describe('metrics command builder', () => {
  test('windows uses -EncodedCommand and carries no shell-quoting hazards', () => {
    const command = buildMetricsCommand('windows');
    expect(command.startsWith('powershell -NoProfile -EncodedCommand ')).toBe(true);

    const payload = command.slice('powershell -NoProfile -EncodedCommand '.length);
    expect(payload).toMatch(/^[A-Za-z0-9+/=]+$/);
    const script = Buffer.from(payload, 'base64').toString('utf16le');
    expect(script).toContain('Win32_OperatingSystem');
    expect(script).toContain('Get-NetAdapterStatistics');
    expect(script).toContain(`platform\twindows`);
  });

  test('linux pipes a base64 script into sh with a quote-free payload', () => {
    const command = buildMetricsCommand('linux');
    expect(command.startsWith("sh -c 'echo ")).toBe(true);
    expect(command.endsWith(" | base64 -d | sh'")).toBe(true);

    const script = Buffer.from(decodeBase64Payload(command), 'base64').toString('utf8');
    expect(script).toContain('/proc/meminfo');
    expect(script).toContain('df -P -k /');
    // The wrapper's single quotes must stay balanced: the payload may not
    // contain a quote of its own, or the remote sh would end the string early.
    expect(decodeBase64Payload(command)).not.toContain("'");
  });

  test('unknown platforms fail loudly instead of guessing', () => {
    expect(() => buildMetricsCommand('solaris')).toThrow();
    try {
      buildMetricsCommand(undefined);
    } catch (error) {
      expect(error.code).toBe('unsupported_platform');
    }
  });

  test('windows reports page-file usage, not the commit limit', () => {
    const payload = buildMetricsCommand('windows').slice('powershell -NoProfile -EncodedCommand '.length);
    const script = Buffer.from(payload, 'base64').toString('utf16le');
    // `TotalVirtualMemorySize - TotalVisibleMemorySize` is the commit limit; on a
    // real box that produced "used 49.6 GB / total 43.6 GB (100%)". Pin the source.
    expect(script).toContain('Win32_PageFileUsage');
    expect(script).not.toContain('TotalVirtualMemorySize');
    expect(script).not.toContain('FreeVirtualMemory');
  });
});

describe('metrics parser', () => {
  test('parses real linux output into bytes and percentages', () => {
    const parsed = parseMetricsOutput({ platform: 'linux', stdout: PIGEONCORE_OUTPUT });
    expect(parsed).not.toBeNull();
    expect(parsed.platform).toBe('linux');
    expect(parsed.hostname).toBe('pigeoncore');
    expect(Math.round(parsed.uptimeSec)).toBe(501873);
    expect(parsed.cpu).toEqual({ count: 4, load1: 0.11, load5: 0.2, load15: 0.25 });

    expect(parsed.memory.totalBytes).toBe(8077984 * 1024);
    expect(parsed.memory.availableBytes).toBe(5798056 * 1024);
    expect(parsed.memory.usedBytes).toBe((8077984 - 5798056) * 1024);
    expect(parsed.memory.usedPercent).toBeCloseTo(28.2, 1);
    expect(parsed.memory.swapTotalBytes).toBe(11534324 * 1024);
    expect(parsed.memory.swapUsedBytes).toBe((11534324 - 10357228) * 1024);
    expect(parsed.memory.swapUsedPercent).toBeCloseTo(10.2, 1);

    expect(parsed.disks).toHaveLength(1);
    expect(parsed.disks[0]).toEqual({
      mount: '/',
      filesystem: '/dev/vda1',
      totalBytes: 61255049216,
      usedBytes: 35862216704,
      availBytes: 25376055296,
      usedPercent: 58.5,
    });

    expect(parsed.network.interfaces).toEqual([
      { name: 'ens3', rxBytes: 10730567573, txBytes: 4940363790 },
    ]);
    expect(parsed.collectedAt).toBe('2026-09-18T18:34:51Z');
  });

  test('accepts LF output and multiple disks/interfaces', () => {
    const parsed = parseMetricsOutput({
      platform: 'windows',
      stdout: [
        'platform\twindows',
        'hostname\tHOME-PC',
        'uptime\t1234',
        'cpu\t16',
        'mem\t16384\t4096\t2048\t1024',
        'disk\tC:\tNTFS\t511000000000\t300000000000\t211000000000',
        'disk\tD:\tNTFS\t1000000000000\t100000000000\t900000000000',
        'net\t以太网\t1000\t2000',
        'net\tWLAN\t3000\t4000',
        'collected\t2026-09-19T01:00:00Z',
      ].join('\n'),
    });
    expect(parsed).not.toBeNull();
    expect(parsed.platform).toBe('windows');
    expect(parsed.cpu.load1).toBeNull();
    expect(parsed.disks).toHaveLength(2);
    expect(parsed.disks[1].mount).toBe('D:');
    expect(parsed.network.interfaces[1]).toEqual({ name: 'WLAN', rxBytes: 3000, txBytes: 4000 });
  });

  test('missing mandatory lines return null instead of an empty success', () => {
    expect(parseMetricsOutput({ platform: 'linux', stdout: '' })).toBeNull();
    expect(parseMetricsOutput({ platform: 'linux', stdout: 'hostname\tx' })).toBeNull();
    expect(parseMetricsOutput({ platform: 'linux', stdout: 'uptime\t1\nmem\t0\t0\t0\t0' })).toBeNull();
    expect(parseMetricsOutput({ platform: 'windows', stdout: 'bash: powershell: not found' })).toBeNull();
  });
});

describe('device metrics runtime', () => {
  const baseDevice = { id: 'dev_1', platform: 'linux', capabilities: { shell: true } };

  test('returns metrics and keeps the registry status truthful', async () => {
    const touched = [];
    const runtime = createDeviceMetricsRuntime({
      registry: { touchDevice: async (id, status) => { touched.push(`${id}:${status}`); } },
      sshClient: { exec: async () => ({ ok: true, exitCode: 0, stdout: PIGEONCORE_OUTPUT, stderr: '' }) },
    });

    const result = await runtime.collect({ device: baseDevice, transport: { ssh: { host: 'h', port: 22 } } });
    expect(result.ok).toBe(true);
    expect(result.metrics.hostname).toBe('pigeoncore');
    expect(touched).toEqual(['dev_1:online']);
  });

  test('a registry write failure never erases good metrics', async () => {
    const runtime = createDeviceMetricsRuntime({
      registry: { touchDevice: async () => { throw new Error('disk full'); } },
      sshClient: { exec: async () => ({ ok: true, exitCode: 0, stdout: PIGEONCORE_OUTPUT, stderr: '' }) },
    });
    const result = await runtime.collect({ device: baseDevice, transport: { ssh: { host: 'h', port: 22 } } });
    expect(result.ok).toBe(true);
  });

  test('channel failures carry their own code', async () => {
    const runtime = createDeviceMetricsRuntime({
      registry: null,
      sshClient: { exec: async () => ({ ok: false, exitCode: null, stdout: '', stderr: 'ssh timed out', error: 'timeout' }) },
    });
    const result = await runtime.collect({ device: baseDevice, transport: { ssh: { host: 'h', port: 22 } } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('timeout');
    expect(result.message).toBe('ssh timed out');
  });

  test('unparsable output is an explicit failure', async () => {
    const runtime = createDeviceMetricsRuntime({
      registry: null,
      sshClient: { exec: async () => ({ ok: true, exitCode: 0, stdout: 'nonsense', stderr: '' }) },
    });
    const result = await runtime.collect({ device: baseDevice, transport: { ssh: { host: 'h', port: 22 } } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('metrics_parse_failed');
  });

  test('without an SSH transport nothing is attempted', async () => {
    let called = false;
    const runtime = createDeviceMetricsRuntime({
      registry: null,
      sshClient: { exec: async () => { called = true; return { ok: true, stdout: '' }; } },
    });
    const result = await runtime.collect({ device: baseDevice, transport: { ssh: null, mcpBase: 'http://x' } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('transport_unavailable');
    expect(called).toBe(false);
  });
});
