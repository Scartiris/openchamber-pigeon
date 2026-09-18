import { asFiniteNumber, asNonEmptyString, asObject } from '../devices/parse.js';

/**
 * Host (the machine running this workbench) resource metrics.
 *
 * Two sources, in order:
 *  1. `host-metrics.json` written by the host-side `oc-host-metrics` helper —
 *     the only source that can report the **host's** network counters, because a
 *     container has its own network namespace and sees only its own interfaces.
 *  2. in-process collection from `/proc` + `os` — correct for memory, load,
 *     uptime and (via statfs/df) the host filesystem, but network is reported as
 *     unavailable rather than as the container's own traffic.
 *
 * Never fabricate a number: a missing source is `notes`, not a zero.
 */

export const HOST_METRICS_FILE_NAME = 'host-metrics.json';
export const HOST_METRICS_STALE_AFTER_MS = 60_000;

const KB = 1024;

const percentOf = (used, total) => {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  const clamped = Math.max(0, Math.min(used, total));
  return Math.round((clamped / total) * 1000) / 10;
};

const normalizeMemory = (raw) => {
  const source = asObject(raw);
  if (!source) return null;
  const totalBytes = asFiniteNumber(source.totalBytes, null);
  const availableBytes = asFiniteNumber(source.availableBytes, null);
  if (totalBytes === null || totalBytes <= 0) return null;
  const resolvedAvailable = availableBytes === null
    ? null
    : Math.max(0, Math.min(availableBytes, totalBytes));
  const usedBytes = asFiniteNumber(source.usedBytes, null)
    ?? (resolvedAvailable === null ? null : totalBytes - resolvedAvailable);
  const swapTotalBytes = asFiniteNumber(source.swapTotalBytes, 0) ?? 0;
  const swapUsedBytes = asFiniteNumber(source.swapUsedBytes, 0) ?? 0;
  return {
    totalBytes,
    availableBytes: resolvedAvailable,
    usedBytes,
    usedPercent: percentOf(usedBytes, totalBytes),
    swapTotalBytes: Math.max(0, swapTotalBytes),
    swapUsedBytes: Math.max(0, swapUsedBytes),
    swapUsedPercent: percentOf(swapUsedBytes, swapTotalBytes),
  };
};

const normalizeDisks = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const source = asObject(entry);
    if (!source) return null;
    const totalBytes = asFiniteNumber(source.totalBytes, null);
    if (totalBytes === null || totalBytes <= 0) return null;
    const usedBytes = asFiniteNumber(source.usedBytes, null);
    const availBytes = asFiniteNumber(source.availBytes, null);
    return {
      mount: asNonEmptyString(source.mount) || '?',
      filesystem: asNonEmptyString(source.filesystem) || null,
      totalBytes,
      usedBytes,
      availBytes,
      usedPercent: percentOf(usedBytes, totalBytes),
    };
  }).filter(Boolean);
};

const normalizeNetwork = (raw) => {
  const source = asObject(raw);
  if (!source) return null;
  const interfaces = Array.isArray(source.interfaces)
    ? source.interfaces.map((entry) => {
      const item = asObject(entry);
      if (!item) return null;
      const name = asNonEmptyString(item.name);
      if (!name) return null;
      return {
        name,
        rxBytes: asFiniteNumber(item.rxBytes, null),
        txBytes: asFiniteNumber(item.txBytes, null),
        rxBytesPerSec: asFiniteNumber(item.rxBytesPerSec, null),
        txBytesPerSec: asFiniteNumber(item.txBytesPerSec, null),
        rxErrors: asFiniteNumber(item.rxErrors, null),
        txErrors: asFiniteNumber(item.txErrors, null),
      };
    }).filter(Boolean)
    : [];
  return {
    windowSec: asFiniteNumber(source.windowSec, null),
    interfaces,
    totalRxBytesPerSec: asFiniteNumber(source.totalRxBytesPerSec, null),
    totalTxBytesPerSec: asFiniteNumber(source.totalTxBytesPerSec, null),
  };
};

const normalizeContainers = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const source = asObject(entry);
    if (!source) return null;
    const name = asNonEmptyString(source.name);
    if (!name) return null;
    return {
      name,
      image: asNonEmptyString(source.image) || null,
      state: asNonEmptyString(source.state) || null,
      health: asNonEmptyString(source.health) || null,
      status: asNonEmptyString(source.status) || null,
    };
  }).filter(Boolean);
};

const normalizeDeploy = (raw) => {
  const source = asObject(raw);
  if (!source) return null;
  const sha = asNonEmptyString(source.sha);
  const image = asNonEmptyString(source.image);
  if (!sha && !image) return null;
  return {
    sha,
    image,
    previousImage: asNonEmptyString(source.previousImage),
    at: asNonEmptyString(source.at),
  };
};

/**
 * Turn a raw helper payload into the host view, or null when it cannot carry
 * the two things every consumer needs (an identity and a memory reading).
 */
export const normalizeHostMetrics = (payload) => {
  const source = asObject(payload);
  if (!source) return null;

  const host = asObject(source.host) || {};
  const memory = normalizeMemory(source.memory);
  if (!memory) return null;

  const collectedAt = asNonEmptyString(source.collectedAt);
  const collectedAtMs = asFiniteNumber(source.collectedAtMs, null)
    ?? (collectedAt ? Date.parse(collectedAt) : null);
  if (!Number.isFinite(collectedAtMs)) return null;

  const cpu = asObject(source.cpu) || {};
  const containers = normalizeContainers(source.containers);
  const summary = asObject(source.containersSummary) || {};

  return {
    collectedAt,
    collectedAtMs,
    intervalSec: asFiniteNumber(source.intervalSec, null),
    hostname: asNonEmptyString(host.hostname) || asNonEmptyString(source.hostname),
    platform: asNonEmptyString(host.platform) || 'linux',
    kernel: asNonEmptyString(host.kernel),
    arch: asNonEmptyString(host.arch),
    uptimeSec: asFiniteNumber(source.uptimeSec, null),
    cpu: {
      count: asFiniteNumber(cpu.count, null),
      load1: asFiniteNumber(cpu.load1, null),
      load5: asFiniteNumber(cpu.load5, null),
      load15: asFiniteNumber(cpu.load15, null),
    },
    memory,
    disks: normalizeDisks(source.disks),
    network: normalizeNetwork(source.network),
    containers: containers.length > 0 ? containers : null,
    containersSummary: containers.length > 0
      ? {
        total: asFiniteNumber(summary.total, containers.length),
        running: asFiniteNumber(summary.running, null),
        healthy: asFiniteNumber(summary.healthy, null),
        unhealthy: asFiniteNumber(summary.unhealthy, null),
      }
      : null,
    deploy: normalizeDeploy(source.deploy),
    errors: Array.isArray(source.errors)
      ? source.errors.map((entry) => asNonEmptyString(entry)).filter(Boolean)
      : [],
  };
};

const parseMeminfo = (text) => {
  const read = (key) => {
    const match = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const total = read('MemTotal');
  if (!Number.isFinite(total) || total <= 0) return null;
  const available = read('MemAvailable') ?? read('MemFree');
  const swapTotal = read('SwapTotal') ?? 0;
  const swapFree = read('SwapFree') ?? 0;
  return {
    totalBytes: total * KB,
    availableBytes: (available ?? 0) * KB,
    usedBytes: total * KB - (available ?? 0) * KB,
    swapTotalBytes: swapTotal * KB,
    swapUsedBytes: Math.max(0, swapTotal - swapFree) * KB,
  };
};

const parseDf = (text) => {
  const line = text.split('\n').map((entry) => entry.trim()).filter(Boolean)[1];
  if (!line) return null;
  const fields = line.split(/\s+/);
  if (fields.length < 6) return null;
  const total = Number(fields[1]) * KB;
  const used = Number(fields[2]) * KB;
  const avail = Number(fields[3]) * KB;
  if (!Number.isFinite(total) || total <= 0) return null;
  return { mount: fields[5], filesystem: fields[0], totalBytes: total, usedBytes: used, availBytes: avail };
};

/**
 * @param deps.fsPromises  readFile/statfs access
 * @param deps.os          hostname/uptime/loadavg/cpus
 * @param deps.spawn       `df` fallback when statfs is unavailable
 */
export const createHostMetricsReader = ({
  fsPromises,
  path,
  os,
  spawn,
  openchamberDataDir,
  filePath,
  env = process.env,
  staleAfterMs = HOST_METRICS_STALE_AFTER_MS,
}) => {
  const resolvedPath = asNonEmptyString(filePath)
    || asNonEmptyString(env.OPENCHAMBER_HOST_METRICS_FILE)
    || path.join(openchamberDataDir, HOST_METRICS_FILE_NAME);

  const readHelperFile = async () => {
    try {
      const raw = await fsPromises.readFile(resolvedPath, 'utf8');
      const parsed = JSON.parse(raw);
      return normalizeHostMetrics(parsed);
    } catch (error) {
      if (error?.code === 'ENOENT') return { missing: true };
      return { unreadable: true, reason: asNonEmptyString(error?.message) };
    }
  };

  const readProcText = async (procPath) => {
    try {
      return await fsPromises.readFile(procPath, 'utf8');
    } catch {
      return null;
    }
  };

  const diskFromStatfs = async (mount = '/') => {
    // A runtime without `statfs` throws on the call, which the catch below
    // already handles — no capability probe needed.
    try {
      const stats = await fsPromises.statfs(mount);
      const blockSize = asFiniteNumber(stats.bsize, null);
      const blocks = asFiniteNumber(stats.blocks, null);
      if (blockSize === null || blocks === null) return null;
      const totalBytes = blockSize * blocks;
      if (totalBytes <= 0) return null;
      const freeBytes = blockSize * (asFiniteNumber(stats.bavail, asFiniteNumber(stats.bfree, 0)) ?? 0);
      return {
        mount,
        filesystem: null,
        totalBytes,
        usedBytes: Math.max(0, totalBytes - freeBytes),
        availBytes: freeBytes,
      };
    } catch {
      return null;
    }
  };

  const diskFromDf = async (mount = '/') => new Promise((resolve) => {
    if (!spawn) {
      resolve(null);
      return;
    }
    let child;
    try {
      child = spawn('df', ['-P', '-k', mount], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve(null);
    }, 5000);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve(parseDf(stdout)); });
  });

  /**
   * What the workbench can see about its own host with no helper installed.
   * Network and containers are deliberately absent — see the module comment.
   */
  const collectInProcess = async () => {
    const notes = ['host-helper-missing', 'network-unavailable', 'containers-unavailable'];
    const meminfo = await readProcText('/proc/meminfo');
    const memory = meminfo ? parseMeminfo(meminfo) : null;
    if (!memory) return null;

    const loadavg = (await readProcText('/proc/loadavg')) || '';
    const loads = loadavg.trim().split(/\s+/).map((value) => asFiniteNumber(value, null));
    const uptimeText = (await readProcText('/proc/uptime')) || '';
    const uptimeSec = asFiniteNumber(uptimeText.trim().split(/\s+/)[0], null);

    const disk = (await diskFromStatfs('/')) ?? (await diskFromDf('/'));
    const disks = disk ? [{ ...disk, usedPercent: percentOf(disk.usedBytes, disk.totalBytes) }] : [];

    const cpuCount = Array.isArray(os?.cpus?.()) ? os.cpus().length : null;
    let fallbackUptime = null;
    try {
      fallbackUptime = asFiniteNumber(os?.uptime?.(), null);
    } catch {
      fallbackUptime = null;
    }

    return {
      collectedAt: new Date().toISOString(),
      collectedAtMs: Date.now(),
      intervalSec: null,
      hostname: asNonEmptyString(os?.hostname?.()) || null,
      platform: process.platform === 'win32' ? 'windows' : 'linux',
      kernel: asNonEmptyString(os?.release?.()) || null,
      arch: asNonEmptyString(os?.arch?.()) || null,
      uptimeSec: uptimeSec ?? (fallbackUptime === null ? null : Math.round(fallbackUptime)),
      cpu: {
        count: cpuCount,
        load1: loads[0] ?? null,
        load5: loads[1] ?? null,
        load15: loads[2] ?? null,
      },
      memory: {
        ...memory,
        usedPercent: percentOf(memory.usedBytes, memory.totalBytes),
        swapUsedPercent: percentOf(memory.swapUsedBytes, memory.swapTotalBytes),
      },
      disks,
      network: null,
      containers: null,
      containersSummary: null,
      deploy: null,
      errors: [],
      notes,
    };
  };

  const read = async ({ nowMs = Date.now() } = {}) => {
    const helper = await readHelperFile();
    if (helper && !helper.missing && !helper.unreadable) {
      const ageMs = Math.max(0, nowMs - helper.collectedAtMs);
      const stale = ageMs > staleAfterMs;
      return {
        ok: true,
        source: 'helper',
        path: resolvedPath,
        ageMs,
        stale,
        notes: stale ? ['host-helper-stale'] : [],
        ...helper,
      };
    }

    const fallback = await collectInProcess();
    if (!fallback) {
      return {
        ok: false,
        source: 'missing',
        path: resolvedPath,
        ageMs: null,
        stale: true,
        notes: helper?.missing ? ['host-helper-missing'] : ['host-helper-unreadable', 'proc-unavailable'],
        error: helper?.reason || 'Host metrics are unavailable',
      };
    }

    return {
      // Spread first: `fallback` carries its own `notes`, and letting it land
      // after the computed ones silently turned "helper unreadable" into
      // "helper missing" — the same wrong-cause bug this file exists to avoid.
      ...fallback,
      ok: true,
      source: 'in-process',
      path: resolvedPath,
      ageMs: 0,
      stale: false,
      notes: helper?.missing
        ? fallback.notes
        : ['host-helper-unreadable', ...fallback.notes.filter((note) => note !== 'host-helper-missing')],
    };
  };

  return { read, collectInProcess, filePath: resolvedPath, staleAfterMs };
};
