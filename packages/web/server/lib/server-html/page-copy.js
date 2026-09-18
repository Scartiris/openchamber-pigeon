// Server-owned copy for standalone HTML pages (OAuth callbacks, API-only mode).
//
// The server cannot import `packages/ui`. This module keeps page chrome keyed
// by outcome id so a future multi-locale ship is a dictionary swap. The pigeon
// fork locks the product UI to Simplified Chinese; these pages follow that
// default so a Chinese operator opening a system-browser callback is not
// dropped into English.

export const DEFAULT_SERVER_PAGE_LOCALE = 'zh-CN';

const PAGE_COPY = {
  en: {
    'server.page.lang': 'en',
    'server.page.titleSuffix': '— OpenChamber',
    'server.oauth.desktopReturn': 'Return to OpenChamber',
    'server.oauth.message.closeTab': 'You can close this tab and return to OpenChamber.',
    'server.oauth.guests.title.unknownExtension': 'Unknown extension',
    'server.oauth.guests.message.notInstalled': 'That extension is not installed.',
    'server.oauth.guests.title.connected': 'Connected',
    'server.oauth.guests.title.couldNotConnect': 'Could not connect',
    'server.oauth.guests.message.callbackFailed': 'The authorization callback failed.',
    'server.oauth.guests.code.STATE_MISMATCH': 'Authorization state was missing or expired.',
    'server.oauth.mcp.title.failed': 'Authorization Failed',
    'server.oauth.mcp.title.complete': 'Authorization Complete',
    'server.oauth.mcp.message.noCode': 'The provider did not return an authorization code. Start authorization again from MCP Settings.',
    'server.oauth.mcp.message.unknownSession': 'This authorization session has expired or is unknown to the running app. Return to OpenChamber and click Authorize again.',
    'server.oauth.mcp.message.upstreamRejected': 'OpenCode rejected the authorization code ({status}). Start authorization again from MCP Settings.',
    'server.oauth.mcp.message.completeFailed': 'Failed to complete MCP authorization.',
    'server.oauth.linear.title.complete': 'Authorization Complete',
    'server.oauth.linear.title.failed': 'Authorization Failed',
    'server.oauth.linear.message.failed': 'Linear authorization failed. Return to OpenChamber and click Connect again.',
    'server.oauth.linear.code.MISSING_CODE': 'Linear did not return an authorization code.',
    'server.oauth.linear.code.UNKNOWN_STATE': 'This authorization session has expired or is unknown to the running app. Return to OpenChamber and click Connect again.',
    'server.apiOnly.title': 'OpenChamber API-only mode',
    'server.apiOnly.heading': 'OpenChamber is running in headless mode',
    'server.apiOnly.description': 'This server is ready. Open it from the OpenChamber desktop or mobile app to use it.',
    'server.apiOnly.copyCommand': 'Copy command',
    'server.apiOnly.logoAria': 'OpenChamber logo',
    'server.apiOnly.message': 'OpenChamber is running in API-only mode',
    'server.opencode.provider.savedDeferred': 'Provider {id} saved. Restart OpenCode to apply.',
    'server.opencode.provider.disconnectedDeferred': 'Provider disconnected successfully. Restart OpenCode to apply.',
    'server.opencode.agentsMd.savedDeferred': 'AGENTS.md saved. Restart OpenCode to apply.',
    'server.opencode.skills.installedDeferred': 'Skills installed successfully. Restart OpenCode to apply.',
    'server.opencode.skills.noneInstalled': 'No skills were installed',
    'server.opencode.skill.createdDeferred': 'Skill {name} created successfully. Restart OpenCode to apply.',
    'server.opencode.skill.updatedDeferred': 'Skill {name} updated successfully. Restart OpenCode to apply.',
    'server.opencode.skill.deletedDeferred': 'Skill {name} deleted successfully. Restart OpenCode to apply.',
    'server.opencode.skill.renamed': 'Skill renamed to {name} successfully. Reloading interface…',
    'server.opencode.skill.fileSaved': 'File {path} saved successfully',
    'server.opencode.skill.fileDeleted': 'File {path} deleted successfully',
    'server.opencode.plugin.entryCreated': 'Plugin entry created. Restart OpenCode to apply.',
    'server.opencode.plugin.entryUpdated': 'Plugin entry updated. Restart OpenCode to apply.',
    'server.opencode.plugin.entryDeleted': 'Plugin entry deleted. Restart OpenCode to apply.',
    'server.opencode.plugin.fileCreated': 'Plugin file created. Restart OpenCode to apply.',
    'server.opencode.plugin.fileUpdated': 'Plugin file updated. Restart OpenCode to apply.',
    'server.opencode.plugin.fileDeleted': 'Plugin file deleted. Restart OpenCode to apply.',
    'server.opencode.mcp.createdDeferred': 'MCP server "{name}" created. Restart OpenCode to apply.',
    'server.opencode.mcp.updatedDeferred': 'MCP server "{name}" updated. Restart OpenCode to apply.',
    'server.opencode.mcp.deletedDeferred': 'MCP server "{name}" deleted. Restart OpenCode to apply.',
    'server.opencode.agent.createdDeferred': 'Agent {name} created successfully. Restart OpenCode to apply.',
    'server.opencode.agent.updatedDeferred': 'Agent {name} updated successfully. Restart OpenCode to apply.',
    'server.opencode.agent.deletedDeferred': 'Agent {name} deleted successfully. Restart OpenCode to apply.',
    'server.opencode.command.createdDeferred': 'Command {name} created successfully. Restart OpenCode to apply.',
    'server.opencode.command.updatedDeferred': 'Command {name} updated successfully. Restart OpenCode to apply.',
    'server.opencode.command.deletedDeferred': 'Command {name} deleted successfully. Restart OpenCode to apply.',
    'server.opencode.config.reloaded': 'Configuration reloaded successfully. Refreshing interface…',
    'server.opencode.config.manualRestart': 'Configuration is saved on disk. Restart your connected OpenCode server to apply the changes.',
    'server.opencode.config.applyFailed': 'Failed to reload configuration',
    'server.session.interruptedByRestart': 'Interrupted by OpenCode restart',
    'server.session.interruptedByRestartDetail': 'The running turn was interrupted when OpenCode restarted.',
    'server.openviking.notConfigured': 'This workbench has no OpenViking configured (OPENVIKING_URL / OPENVIKING_API_KEY are incomplete).',
    'server.openviking.unreachable': 'Cannot reach OpenViking ({upstream}). Is the container running?',
    'server.pigeonBrain.notConfigured': 'This workbench has no pigeon-brain configured (PIGEON_BRAIN_URL is empty).',
    'server.pigeonBrain.unreachable': 'Cannot reach pigeon-brain ({url}). Is the container running?',
  },
  'zh-CN': {
    'server.page.lang': 'zh-CN',
    'server.page.titleSuffix': '— OpenChamber',
    'server.oauth.desktopReturn': '返回 OpenChamber',
    'server.oauth.message.closeTab': '可以关闭此标签页，然后返回 OpenChamber。',
    'server.oauth.guests.title.unknownExtension': '未知扩展',
    'server.oauth.guests.message.notInstalled': '该扩展尚未安装。',
    'server.oauth.guests.title.connected': '已连接',
    'server.oauth.guests.title.couldNotConnect': '无法连接',
    'server.oauth.guests.message.callbackFailed': '授权回调失败。',
    'server.oauth.guests.code.STATE_MISMATCH': '授权状态缺失或已过期。',
    'server.oauth.mcp.title.failed': '授权失败',
    'server.oauth.mcp.title.complete': '授权完成',
    'server.oauth.mcp.message.noCode': '提供商未返回授权码。请在 MCP 设置中重新发起授权。',
    'server.oauth.mcp.message.unknownSession': '此授权会话已过期，或当前应用无法识别。请返回 OpenChamber 后再次点击授权。',
    'server.oauth.mcp.message.upstreamRejected': 'OpenCode 拒绝了该授权码（{status}）。请在 MCP 设置中重新发起授权。',
    'server.oauth.mcp.message.completeFailed': '无法完成 MCP 授权。',
    'server.oauth.linear.title.complete': '授权完成',
    'server.oauth.linear.title.failed': '授权失败',
    'server.oauth.linear.message.failed': 'Linear 授权失败。请返回 OpenChamber 后再次点击连接。',
    'server.oauth.linear.code.MISSING_CODE': 'Linear 未返回授权码。',
    'server.oauth.linear.code.UNKNOWN_STATE': '此授权会话已过期，或当前应用无法识别。请返回 OpenChamber 后再次点击连接。',
    'server.apiOnly.title': 'OpenChamber API-only 模式',
    'server.apiOnly.heading': 'OpenChamber 正在以 headless 模式运行',
    'server.apiOnly.description': '服务器已就绪。请从 OpenChamber 桌面端或移动端打开后使用。',
    'server.apiOnly.copyCommand': '复制命令',
    'server.apiOnly.logoAria': 'OpenChamber 标志',
    'server.apiOnly.message': 'OpenChamber 正在以 API-only 模式运行',
    'server.opencode.provider.savedDeferred': '提供商 {id} 已保存。请重启 OpenCode 以应用。',
    'server.opencode.provider.disconnectedDeferred': '提供商已断开连接。请重启 OpenCode 以应用。',
    'server.opencode.agentsMd.savedDeferred': 'AGENTS.md 已保存。请重启 OpenCode 以应用。',
    'server.opencode.skills.installedDeferred': '技能安装成功。请重启 OpenCode 以应用。',
    'server.opencode.skills.noneInstalled': '没有安装任何技能',
    'server.opencode.skill.createdDeferred': '技能 {name} 创建成功。请重启 OpenCode 以应用。',
    'server.opencode.skill.updatedDeferred': '技能 {name} 更新成功。请重启 OpenCode 以应用。',
    'server.opencode.skill.deletedDeferred': '技能 {name} 已删除。请重启 OpenCode 以应用。',
    'server.opencode.skill.renamed': '技能已重命名为 {name}。正在刷新界面…',
    'server.opencode.skill.fileSaved': '文件 {path} 保存成功',
    'server.opencode.skill.fileDeleted': '文件 {path} 删除成功',
    'server.opencode.plugin.entryCreated': '插件条目已创建。请重启 OpenCode 以应用。',
    'server.opencode.plugin.entryUpdated': '插件条目已更新。请重启 OpenCode 以应用。',
    'server.opencode.plugin.entryDeleted': '插件条目已删除。请重启 OpenCode 以应用。',
    'server.opencode.plugin.fileCreated': '插件文件已创建。请重启 OpenCode 以应用。',
    'server.opencode.plugin.fileUpdated': '插件文件已更新。请重启 OpenCode 以应用。',
    'server.opencode.plugin.fileDeleted': '插件文件已删除。请重启 OpenCode 以应用。',
    'server.opencode.mcp.createdDeferred': 'MCP 服务器「{name}」已创建。请重启 OpenCode 以应用。',
    'server.opencode.mcp.updatedDeferred': 'MCP 服务器「{name}」已更新。请重启 OpenCode 以应用。',
    'server.opencode.mcp.deletedDeferred': 'MCP 服务器「{name}」已删除。请重启 OpenCode 以应用。',
    'server.opencode.agent.createdDeferred': '智能体 {name} 创建成功。请重启 OpenCode 以应用。',
    'server.opencode.agent.updatedDeferred': '智能体 {name} 更新成功。请重启 OpenCode 以应用。',
    'server.opencode.agent.deletedDeferred': '智能体 {name} 已删除。请重启 OpenCode 以应用。',
    'server.opencode.command.createdDeferred': '命令 {name} 创建成功。请重启 OpenCode 以应用。',
    'server.opencode.command.updatedDeferred': '命令 {name} 更新成功。请重启 OpenCode 以应用。',
    'server.opencode.command.deletedDeferred': '命令 {name} 已删除。请重启 OpenCode 以应用。',
    'server.opencode.config.reloaded': '配置重新加载成功。正在刷新界面…',
    'server.opencode.config.manualRestart': '配置已保存到磁碟。请重启已连接的 OpenCode 服务器以应用更改。',
    'server.opencode.config.applyFailed': '无法重新加载配置',
    'server.session.interruptedByRestart': '因 OpenCode 重启而中断',
    'server.session.interruptedByRestartDetail': '当前回合在 OpenCode 重启时被中断。',
    'server.openviking.notConfigured': '这台工作台没有配置 OpenViking（环境变量 OPENVIKING_URL / OPENVIKING_API_KEY 未配全）。',
    'server.openviking.unreachable': '连不上 OpenViking（{upstream}）。容器在跑吗？',
    'server.pigeonBrain.notConfigured': '这台工作台没有配置 pigeon-brain（环境变量 PIGEON_BRAIN_URL 为空）。',
    'server.pigeonBrain.unreachable': '连不上 pigeon-brain（{url}）。容器在跑吗？',
  },
};

/**
 * Server pages follow the product default (zh-CN on this fork). Accept-Language
 * is still honored when the browser asks for English explicitly.
 */
export function normalizeServerPageLocale(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const header = raw == null ? '' : String(raw);
  if (!header.trim()) return DEFAULT_SERVER_PAGE_LOCALE;
  const tags = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((param) => param.trim().startsWith('q='));
      const quality = q ? Number.parseFloat(q.trim().slice(2)) : 1;
      return { tag: (tag || '').trim().toLowerCase(), quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((entry) => entry.tag && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of tags) {
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
    if (tag === 'zh-cn' || tag === 'zh-hans' || tag === 'zh') return 'zh-CN';
  }
  return DEFAULT_SERVER_PAGE_LOCALE;
}

export function serverPageCopy(reqOrHeader) {
  const header = reqOrHeader && typeof reqOrHeader === 'object' && 'headers' in reqOrHeader
    ? reqOrHeader.headers?.['accept-language']
    : reqOrHeader;
  const locale = normalizeServerPageLocale(header);
  return PAGE_COPY[locale] ?? PAGE_COPY[DEFAULT_SERVER_PAGE_LOCALE];
}

export function serverPageLang(reqOrHeader) {
  return serverPageCopy(reqOrHeader)['server.page.lang'] ?? DEFAULT_SERVER_PAGE_LOCALE;
}

/**
 * Localized user-facing server message by outcome key.
 * Default locale is zh-CN on this fork; Accept-Language: en still returns English.
 */
export function serverMessage(reqOrHeader, key, params) {
  const copy = serverPageCopy(reqOrHeader);
  return formatServerPageCopy(copy, key, params);
}

export function formatServerPageCopy(copy, key, params) {
  const template = copy[key] ?? PAGE_COPY.en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

export const __testing = { PAGE_COPY, DEFAULT_SERVER_PAGE_LOCALE };
