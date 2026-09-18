import { asFiniteNumber, asNonEmptyString } from './parse.js';

/**
 * Cross-platform resource metrics for registered devices.
 *
 * The remote side is a *fixed* command per platform — the caller never passes
 * user text into it. Both platforms answer in the same line-oriented format so
 * there is exactly one parser to trust:
 *
 *   key<TAB>field<TAB>field…
 *
 *   platform   windows | linux
 *   hostname   <name>
 *   uptime     <seconds>
 *   cpu        <count>[<TAB><load1><TAB><load5><TAB><load15>]   (load: POSIX only)
 *   mem        <totalKb><TAB><availableKb><TAB><swapTotalKb><TAB><swapFreeKb>
 *   disk       <mount><TAB><filesystem><TAB><totalBytes><TAB><usedBytes><TAB><availBytes>
 *   net        <name><TAB><rxBytes><TAB><txBytes>
 *   collected  <ISO timestamp>
 *
 * Why line-oriented instead of JSON: the command travels through `ssh` into a
 * second interpreter (PowerShell / sh), and JSON quoting through those two
 * layers is where silent corruption lives. The payloads are base64-encoded so
 * neither the local nor the remote shell ever parses the script text.
 *
 * Byte rates are deliberately NOT computed here: they need two samples, which
 * the fleet snapshot owns.
 */

const TAB = '\t';

const utf16leBase64 = (text) => Buffer.from(text, 'utf16le').toString('base64');
const utf8Base64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/** PowerShell: `-EncodedCommand` takes base64(UTF-16LE) and needs no quoting. */
const WINDOWS_SCRIPT = [
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  '$os = Get-CimInstance Win32_OperatingSystem',
  '$cs = Get-CimInstance Win32_ComputerSystem',
  `Write-Output "platform${TAB}windows"`,
  `Write-Output "hostname${TAB}$env:COMPUTERNAME"`,
  '$uptime = 0',
  'try { $uptime = [int64]((Get-Date) - $os.LastBootUpTime).TotalSeconds } catch { $uptime = 0 }',
  `Write-Output "uptime${TAB}$uptime"`,
  '$cpus = 1',
  'try { $cpus = [int]$cs.NumberOfLogicalProcessors } catch { $cpus = 1 }',
  `Write-Output "cpu${TAB}$cpus"`,
  '$memTotal = 0; $memFree = 0; $swapTotal = 0; $swapFree = 0',
  'try { $memTotal = [int64]$os.TotalVisibleMemorySize; $memFree = [int64]$os.FreePhysicalMemory } catch { }',
  // Page-file usage, NOT `TotalVirtualMemorySize - TotalVisibleMemorySize`: that
  // pair describes the commit limit, and the old math produced nonsense on a real
  // box ("used 49.6 GB / total 43.6 GB (100%)"). Win32_PageFileUsage counters are
  // MB while the mem row is KB, hence the *1024.
  'try {',
  '  foreach ($pf in @(Get-CimInstance Win32_PageFileUsage)) {',
  '    $allocatedMb = [int64]$pf.AllocatedBaseSize',
  '    $usedMb = [int64]$pf.CurrentUsage',
  '    if ($usedMb -gt $allocatedMb) { $usedMb = $allocatedMb }',
  '    $swapTotal += $allocatedMb',
  '    $swapFree += ($allocatedMb - $usedMb)',
  '  }',
  '} catch { }',
  '$swapTotal = $swapTotal * 1024',
  '$swapFree = $swapFree * 1024',
  `Write-Output "mem${TAB}$memTotal${TAB}$memFree${TAB}$swapTotal${TAB}$swapFree"`,
  // Free space is per fixed volume; CD/DVD and network drives are excluded on purpose.
  'try {',
  '  Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {',
  `    Write-Output "disk${TAB}$($_.DeviceID)${TAB}$($_.FileSystem)${TAB}$([int64]$_.Size)${TAB}$([int64]($_.Size - $_.FreeSpace))${TAB}$([int64]$_.FreeSpace)"`,
  '  }',
  '} catch { }',
  'try {',
  '  Get-NetAdapterStatistics | ForEach-Object {',
  `    Write-Output "net${TAB}$($_.Name)${TAB}$([int64]$_.ReceivedBytes)${TAB}$([int64]$_.SentBytes)"`,
  '  }',
  '} catch { }',
  `Write-Output "collected${TAB}$((Get-Date).ToUniversalTime().ToString('o'))"`,
].join('\n');

/** POSIX sh. `/proc` + `df` only: no interpreter dependency beyond coreutils. */
const LINUX_SCRIPT = [
  `printf 'platform${TAB}linux\\n'`,
  `printf 'hostname${TAB}%s\\n' "$(hostname 2>/dev/null || echo unknown)"`,
  `printf 'uptime${TAB}%s\\n' "$(cut -d' ' -f1 /proc/uptime 2>/dev/null || echo 0)"`,
  `printf 'cpu${TAB}%s${TAB}%s\\n' "$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 1)" "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null | tr ' ' '${TAB}')"`,
  'awk \'BEGIN{t=0;a=0;st=0;sf=0} /^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} /^SwapTotal:/{st=$2} /^SwapFree:/{sf=$2} END{printf "mem\\t%d\\t%d\\t%d\\t%d\\n", t, a, st, sf}\' /proc/meminfo',
  // Virtual and bridge interfaces are container plumbing, not the host's link.
  'awk \'NR>2 && $1!="lo:" { name=$1; sub(/:$/,"",name); if (name ~ /^(veth|br-|docker|virbr|tun|tap)/) next; printf "net\\t%s\\t%s\\t%s\\n", name, $2, $10 }\' /proc/net/dev',
  `df -P -k / 2>/dev/null | awk 'NR==2{printf "disk\\t%s\\t%s\\t%d\\t%d\\t%d\\n", $6, $1, $2*1024, $3*1024, $4*1024}'`,
  `printf 'collected${TAB}%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
].join('\n');

export const DEVICE_METRICS_PLATFORMS = ['windows', 'linux'];

/**
 * Build the fixed remote command for a device platform.
 * Throws `unsupported_platform` rather than guessing — a Windows device that
 * silently ran the POSIX script would report "no metrics" forever.
 */
export const buildMetricsCommand = (platform) => {
  if (platform === 'windows') {
    return `powershell -NoProfile -EncodedCommand ${utf16leBase64(WINDOWS_SCRIPT)}`;
  }
  if (platform === 'linux') {
    return `sh -c 'echo ${utf8Base64(LINUX_SCRIPT)} | base64 -d | sh'`;
  }
  throw Object.assign(new Error(`Unsupported device platform: ${platform || 'unknown'}`), {
    code: 'unsupported_platform',
    statusCode: 400,
  });
};

const percentOf = (used, total) => {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  const clamped = Math.max(0, Math.min(used, total));
  return Math.round((clamped / total) * 1000) / 10;
};

const splitFields = (line) => line.split(TAB).map((field) => field.trim());

/**
 * Parse the fixed format into a normalized snapshot.
 * Returns null when a mandatory line is missing: an empty success would be
 * indistinguishable from a host with zero memory.
 */
export const parseMetricsOutput = ({ platform, stdout }) => {
  const text = asNonEmptyString(stdout);
  if (!text) return null;

  const lines = text.split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line) continue;
    const fields = splitFields(line);
    const key = fields.shift();
    if (!key) continue;
    rows.push({ key, fields });
  }

  const first = (key) => rows.find((row) => row.key === key) || null;
  const all = (key) => rows.filter((row) => row.key === key);

  const platformRow = first('platform');
  const resolvedPlatform = asNonEmptyString(platformRow?.fields?.[0]) || platform;

  const memRow = first('mem');
  const uptimeRow = first('uptime');
  if (!memRow || !uptimeRow) return null;

  const totalKb = asFiniteNumber(memRow.fields[0], null);
  const availableKb = asFiniteNumber(memRow.fields[1], null);
  if (totalKb === null || totalKb <= 0 || availableKb === null) return null;
  const swapTotalKb = asFiniteNumber(memRow.fields[2], 0) ?? 0;
  const swapFreeKb = asFiniteNumber(memRow.fields[3], 0) ?? 0;

  const totalBytes = totalKb * 1024;
  const availableBytes = Math.max(0, Math.min(availableKb, totalKb)) * 1024;
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const swapTotalBytes = Math.max(0, swapTotalKb) * 1024;
  const swapUsedBytes = Math.max(0, swapTotalKb - swapFreeKb) * 1024;

  const cpuRow = first('cpu');
  const cpuCount = asFiniteNumber(cpuRow?.fields?.[0], null);
  const load1 = asFiniteNumber(cpuRow?.fields?.[1], null);
  const load5 = asFiniteNumber(cpuRow?.fields?.[2], null);
  const load15 = asFiniteNumber(cpuRow?.fields?.[3], null);

  // Emitted order is mount, filesystem, total, used, avail on both platforms.
  const disks = all('disk').map((row) => {
    const total = asFiniteNumber(row.fields[2], null);
    const used = asFiniteNumber(row.fields[3], null);
    const avail = asFiniteNumber(row.fields[4], null);
    return {
      mount: asNonEmptyString(row.fields[0]) || '?',
      filesystem: asNonEmptyString(row.fields[1]) || null,
      totalBytes: total,
      usedBytes: used,
      availBytes: avail,
      usedPercent: percentOf(used, total),
    };
  }).filter((disk) => disk.totalBytes !== null);

  const interfaces = all('net').map((row) => ({
    name: asNonEmptyString(row.fields[0]) || '?',
    rxBytes: asFiniteNumber(row.fields[1], null),
    txBytes: asFiniteNumber(row.fields[2], null),
  }));

  return {
    platform: resolvedPlatform,
    hostname: asNonEmptyString(first('hostname')?.fields?.[0]) || null,
    uptimeSec: asFiniteNumber(uptimeRow.fields[0], null),
    cpu: {
      count: cpuCount !== null && cpuCount > 0 ? Math.round(cpuCount) : null,
      load1,
      load5,
      load15,
    },
    memory: {
      totalBytes,
      availableBytes,
      usedBytes,
      usedPercent: percentOf(usedBytes, totalBytes),
      swapTotalBytes,
      swapUsedBytes,
      swapUsedPercent: percentOf(swapUsedBytes, swapTotalBytes),
    },
    disks,
    network: { interfaces },
    collectedAt: asNonEmptyString(first('collected')?.fields?.[0]) || null,
  };
};

export const DEFAULT_METRICS_TIMEOUT_MS = 15_000;

/**
 * Collect one device's metrics over the device SSH channel.
 * Rates stay null on a first sample; the caller (fleet snapshot) keeps the
 * previous cumulative counters and fills them in.
 */
export const createDeviceMetricsRuntime = ({ sshClient, registry }) => {
  const collect = async ({ device, transport, timeoutMs = DEFAULT_METRICS_TIMEOUT_MS }) => {
    if (!transport?.ssh) {
      return { ok: false, code: 'transport_unavailable', message: 'Device SSH transport is unavailable' };
    }

    const result = await sshClient.exec({
      device,
      transport,
      command: buildMetricsCommand(device.platform),
      timeoutMs,
    });

    if (!result?.ok) {
      return {
        ok: false,
        code: asNonEmptyString(result?.error) || 'ssh_failed',
        message: asNonEmptyString(result?.stderr) || 'Device metrics command failed',
        exitCode: result?.exitCode ?? null,
        stderr: asNonEmptyString(result?.stderr),
      };
    }

    const metrics = parseMetricsOutput({ platform: device.platform, stdout: result.stdout });
    if (!metrics) {
      return {
        ok: false,
        code: 'metrics_parse_failed',
        message: 'Device metrics output was not in the expected format',
        stdout: asNonEmptyString(result.stdout)?.slice(0, 300) || null,
      };
    }

    if (registry) {
      try {
        await registry.touchDevice(device.id, 'online');
      } catch {
        // Metrics are the product; a registry write failure must not erase them.
      }
    }

    return { ok: true, metrics };
  };

  return { collect };
};
