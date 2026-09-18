const tcpProbe = ({ host, port, timeoutMs = 1200, net }) => new Promise((resolve) => {
  if (!host || !Number.isFinite(port) || port <= 0) {
    resolve(false);
    return;
  }
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
    resolve(ok);
  };
  socket.setTimeout(timeoutMs, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});

const DEFAULT_TUNNEL_HOST = '127.0.0.1';

/**
 * Where a device's reverse tunnel actually lands.
 *
 * The historical default is loopback, which only holds when the workbench runs
 * on the same host as the tunnel listener. Inside a container `127.0.0.1` is the
 * container itself, so deployments record the bridge gateway (or any other
 * address the tunnel is bound to) on the device connection.
 */
export const resolveTunnelHost = (connection) => {
  const host = connection?.tunnel?.host;
  if (typeof host !== 'string') return DEFAULT_TUNNEL_HOST;
  const trimmed = host.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_TUNNEL_HOST;
};

/**
 * Resolve a usable transport for a device.
 * Preference: Tailscale direct, then loopback tunnel ports.
 * Never invents connectivity — probes fail closed.
 */
export const createDeviceTransportResolver = ({ net, probe = tcpProbe }) => {
  const resolve = async (device) => {
    const attempted = [];
    const connection = device?.connection || {};

    if (connection.tailscale?.host) {
      const sshPort = connection.tailscale.sshPort || 22;
      const sshHost = connection.tailscale.host;
      const sshOk = await probe({ host: sshHost, port: sshPort, net });
      attempted.push({ kind: 'tailscale', target: `${sshHost}:${sshPort}`, ok: sshOk });

      let mcpBase = null;
      if (Number.isFinite(connection.tailscale.mcpPort) && connection.tailscale.mcpPort > 0) {
        const mcpOk = await probe({
          host: sshHost,
          port: connection.tailscale.mcpPort,
          net,
        });
        attempted.push({
          kind: 'tailscale-mcp',
          target: `${sshHost}:${connection.tailscale.mcpPort}`,
          ok: mcpOk,
        });
        if (mcpOk) mcpBase = `http://${sshHost}:${connection.tailscale.mcpPort}`;
      }

      if (sshOk || mcpBase) {
        return {
          kind: 'tailscale',
          ssh: sshOk ? { host: sshHost, port: sshPort } : null,
          mcpBase,
          attempted,
        };
      }
    }

    if (connection.tunnel) {
      const sshPort = connection.tunnel.sshPort;
      const mcpPort = connection.tunnel.mcpPort;
      const tunnelHost = resolveTunnelHost(connection);
      const sshOk = Number.isFinite(sshPort)
        ? await probe({ host: tunnelHost, port: sshPort, net })
        : false;
      if (Number.isFinite(sshPort)) {
        attempted.push({ kind: 'tunnel-ssh', target: `${tunnelHost}:${sshPort}`, ok: sshOk });
      }

      let mcpBase = null;
      if (Number.isFinite(mcpPort) && mcpPort > 0) {
        const mcpOk = await probe({ host: tunnelHost, port: mcpPort, net });
        attempted.push({ kind: 'tunnel-mcp', target: `${tunnelHost}:${mcpPort}`, ok: mcpOk });
        if (mcpOk) mcpBase = `http://${tunnelHost}:${mcpPort}`;
      }

      if (sshOk || mcpBase) {
        return {
          kind: 'tunnel',
          ssh: sshOk ? { host: tunnelHost, port: sshPort } : null,
          mcpBase,
          attempted,
        };
      }
    }

    return {
      kind: null,
      ssh: null,
      mcpBase: null,
      attempted,
      error: 'transport_unavailable',
    };
  };

  return { resolve };
};
