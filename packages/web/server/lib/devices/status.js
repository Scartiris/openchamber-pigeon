import { asFiniteNumber } from './parse.js';

const DEFAULT_TIMEOUT_MS = 1200;

const nowIso = () => new Date().toISOString();

/**
 * Measure TCP connect latency to host:port.
 * Fail closed: unreachable / timeout → { ok: false, latencyMs: null }.
 */
const probeLatency = ({ host, port, timeoutMs = DEFAULT_TIMEOUT_MS, net }) => new Promise((resolve) => {
  if (!host || !Number.isFinite(port) || port <= 0) {
    resolve({ ok: false, latencyMs: null, target: null });
    return;
  }
  const target = `${host}:${port}`;
  const startedAt = performance.now();
  const socket = net.connect({ host, port });
  let settled = false;
  const finish = (ok) => {
    if (settled) return;
    settled = true;
    try {
      socket.destroy();
    } catch {
      // ignore
    }
    const latencyMs = ok ? Math.round(performance.now() - startedAt) : null;
    resolve({ ok, latencyMs, target });
  };
  socket.setTimeout(timeoutMs, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});

/**
 * Live health snapshot for registered devices.
 * Prefers Tailscale, falls back to loopback tunnel ports (same as transport).
 */
export const createDeviceStatusRuntime = ({ net, registry }) => {
  const probeDevice = async (device) => {
    const connection = device?.connection || {};
    const timeoutMs = DEFAULT_TIMEOUT_MS;
    const attempted = [];

    let ssh = { ok: false, latencyMs: null, target: null, kind: null };
    let mcp = { ok: false, latencyMs: null, target: null, kind: null };

    if (connection.tailscale?.host) {
      const host = connection.tailscale.host;
      const sshPort = asFiniteNumber(connection.tailscale.sshPort, 22);
      const mcpPort = asFiniteNumber(connection.tailscale.mcpPort, null);

      const sshProbe = await probeLatency({ host, port: sshPort, timeoutMs, net });
      attempted.push({ kind: 'tailscale-ssh', ...sshProbe });
      if (sshProbe.ok) {
        ssh = { ...sshProbe, kind: 'tailscale' };
      }

      if (mcpPort && mcpPort > 0) {
        const mcpProbe = await probeLatency({ host, port: mcpPort, timeoutMs, net });
        attempted.push({ kind: 'tailscale-mcp', ...mcpProbe });
        if (mcpProbe.ok) {
          mcp = { ...mcpProbe, kind: 'tailscale' };
        }
      }
    }

    if ((!ssh.ok || !mcp.ok) && connection.tunnel) {
      const host = '127.0.0.1';
      const sshPort = asFiniteNumber(connection.tunnel.sshPort, null);
      const mcpPort = asFiniteNumber(connection.tunnel.mcpPort, null);

      if (!ssh.ok && sshPort && sshPort > 0) {
        const sshProbe = await probeLatency({ host, port: sshPort, timeoutMs, net });
        attempted.push({ kind: 'tunnel-ssh', ...sshProbe });
        if (sshProbe.ok) {
          ssh = { ...sshProbe, kind: 'tunnel' };
        }
      }
      if (!mcp.ok && mcpPort && mcpPort > 0) {
        const mcpProbe = await probeLatency({ host, port: mcpPort, timeoutMs, net });
        attempted.push({ kind: 'tunnel-mcp', ...mcpProbe });
        if (mcpProbe.ok) {
          mcp = { ...mcpProbe, kind: 'tunnel' };
        }
      }
    }

    const online = ssh.ok || mcp.ok;
    // Prefer SSH latency as the headline RTT; fall back to MCP.
    const latencyMs = ssh.ok ? ssh.latencyMs : (mcp.ok ? mcp.latencyMs : null);
    const transport = ssh.kind || mcp.kind || null;

    return {
      id: device.id,
      name: device.name,
      online,
      latencyMs,
      transport,
      ssh,
      mcp,
      checkedAt: nowIso(),
      attempted,
    };
  };

  const listStatus = async () => {
    const devices = await registry.listDevices();
    const results = await Promise.all(devices.map((device) => probeDevice(device)));
    const onlineCount = results.filter((entry) => entry.online).length;

    // Persist online/offline so the registry stays truthful between refreshes.
    await Promise.all(results.map(async (entry) => {
      try {
        await registry.touchDevice(entry.id, entry.online ? 'online' : 'offline');
      } catch {
        // Status is advisory; never fail the snapshot because of a store write.
      }
    }));

    return {
      checkedAt: nowIso(),
      onlineCount,
      total: results.length,
      devices: results,
    };
  };

  return { listStatus, probeDevice };
};
