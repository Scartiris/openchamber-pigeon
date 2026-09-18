const READ_TOOLS = new Set([
  'devices.list',
  'devices.fs.list',
  'devices.fs.read',
  'devices.screen.capture',
  'devices.ui.elements',
  // Metrics are a passive read of counters the device already exposes. Requiring
  // approval for them would make the fleet panel unusable in the default mode.
  'devices.metrics',
]);

const WRITE_TOOLS = new Set([
  'devices.shell.exec',
  'devices.fs.write',
  'devices.ui.click',
  'devices.ui.type',
]);

/**
 * Classify a device tool call against the device approval mode.
 * `smart` allows reads and refuses writes with approval_required until M1 ships
 * a confirm channel; auto allows everything and only audits.
 */
export const evaluateDeviceApproval = ({ approval, tool }) => {
  const mode = approval || 'smart';
  if (mode === 'deny') {
    return { allowed: false, reason: 'permission_denied', detail: 'Device approval mode is deny' };
  }
  if (mode === 'auto') return { allowed: true, reason: 'auto' };
  if (READ_TOOLS.has(tool)) return { allowed: true, reason: 'smart-read' };
  if (WRITE_TOOLS.has(tool)) {
    return {
      allowed: false,
      reason: 'approval_required',
      detail: 'Device is in smart approval mode; write/exec/gui actions require approval',
    };
  }
  return { allowed: false, reason: 'permission_denied', detail: 'Unknown tool' };
};

export const isWriteTool = (tool) => WRITE_TOOLS.has(tool);
export { READ_TOOLS, WRITE_TOOLS };
