import type { SidebarSection } from '@/constants/sidebar';
import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';

export type SettingsPageSlug =
  | 'home'
  | 'general'
  | 'projects'
  | 'remote-instances'
  | 'providers'
  | 'usage'
  | 'agents'
  | 'behavior'
  | 'commands'
  | 'mcp'
  | 'plugins'
  | 'skills.installed'
  | 'skills.catalog'
  | 'git'
  | 'appearance'
  | 'chat'
  | 'shortcuts'
  | 'sessions'
  | 'magic-prompts'
  | 'snippets'
  | 'notifications'
  | 'voice'
  | 'tunnel'
  | 'about'
  | 'integrations'
  | 'memory-browse'
  | 'knowledge-settings'
  | 'knowledge-browse'
  | 'devices'
  | 'extensions';

type SettingsPageGroup =
  | 'general'
  | 'projects'
  | 'opencode'
  | 'content';

export interface SettingsRuntimeContext {
  isVSCode: boolean;
  isWeb: boolean;
  isDesktop: boolean;
  isMobile: boolean;
}

export interface SettingsPageMeta {
  slug: SettingsPageSlug;
  /** Search/keyword fallback title; UI chrome should prefer `settingsPageTitleKey`. */
  title: string;
  group: SettingsPageGroup;
  kind: 'single' | 'split';
  description?: string;
  keywords?: string[];
  isAvailable?: (ctx: SettingsRuntimeContext) => boolean;
}

const SETTINGS_TITLE_KEYS = {
  home: 'settings.page.home.title',
  general: 'settings.page.general.title',
  projects: 'settings.page.projects.title',
  'remote-instances': 'settings.page.remoteInstances.title',
  providers: 'settings.page.providers.title',
  usage: 'settings.page.usage.title',
  agents: 'settings.page.agents.title',
  behavior: 'settings.page.behavior.title',
  commands: 'settings.page.commands.title',
  mcp: 'settings.page.mcp.title',
  plugins: 'settings.page.plugins.title',
  'skills.installed': 'settings.page.skills.title',
  'skills.catalog': 'settings.page.skillsCatalog.title',
  git: 'settings.page.git.title',
  appearance: 'settings.page.appearance.title',
  chat: 'settings.page.chat.title',
  shortcuts: 'settings.page.shortcuts.title',
  sessions: 'settings.page.sessions.title',
  'magic-prompts': 'settings.page.magicPrompts.title',
  snippets: 'settings.page.snippets.title',
  notifications: 'settings.page.notifications.title',
  voice: 'settings.page.voice.title',
  tunnel: 'settings.page.tunnel.title',
  about: 'settings.page.about.title',
  integrations: 'settings.page.integrations.title',
  'memory-browse': 'settings.page.memoryBrowse.title',
  'knowledge-settings': 'settings.page.knowledgeSettings.title',
  'knowledge-browse': 'settings.page.knowledgeBrowse.title',
  devices: 'settings.page.devices.title',
  extensions: 'settings.page.extensions.title',
} as const satisfies Record<SettingsPageSlug, I18nKey>;

export function settingsPageTitleKey(slug: SettingsPageSlug): I18nKey {
  return SETTINGS_TITLE_KEYS[slug];
}

export const SETTINGS_PAGE_METADATA: readonly SettingsPageMeta[] = [
  {
    slug: 'home',
    title: '设置',
    group: 'general',
    kind: 'single',
    description: '搜索并跳转到常用页面。',
    keywords: ['search', 'settings'],
  },
  {
    slug: 'general',
    title: '通用',
    group: 'general',
    kind: 'single',
    keywords: ['general', 'startup', 'launch at login', 'autostart', 'tray', 'password', 'passkey', 'security', 'privacy', 'telemetry', 'transport', 'network', 'lan', 'binary', 'cli'],
  },
  {
    slug: 'projects',
    title: '项目',
    group: 'projects',
    kind: 'split',
    keywords: ['project', 'projects', 'worktree', 'worktrees', 'repo', 'repository', 'directory'],
  },
  {
    slug: 'remote-instances',
    title: '远程实例',
    group: 'projects',
    kind: 'single',
    keywords: ['ssh', 'remote', 'instances', 'tunnels', 'forwarding', 'connection'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    slug: 'providers',
    title: '提供商',
    group: 'opencode',
    kind: 'split',
    keywords: ['provider', 'providers', 'models', 'model', 'api key', 'api keys', 'openai', 'anthropic', 'ollama', 'credentials'],
  },
  {
    slug: 'usage',
    title: '用量',
    group: 'general',
    kind: 'split',
    keywords: ['quota', 'billing', 'tokens', 'usage', 'limits'],
  },
  {
    slug: 'agents',
    title: '智能体',
    group: 'opencode',
    kind: 'split',
    keywords: ['agent', 'agents', 'prompts', 'tools', 'permissions'],
  },
  {
    slug: 'behavior',
    title: '行为',
    group: 'opencode',
    kind: 'single',
    keywords: ['behavior', 'agents.md', 'system prompt', 'global rules', 'instructions', 'override'],
  },
  {
    slug: 'commands',
    title: '命令',
    group: 'opencode',
    kind: 'split',
    keywords: ['command', 'commands', 'slash', 'macros', 'automation'],
  },
  {
    slug: 'mcp',
    title: 'MCP',
    group: 'opencode',
    kind: 'split',
    keywords: ['mcp', 'model context protocol', 'servers', 'tools', 'remote', 'stdio'],
  },
  {
    slug: 'plugins',
    title: '插件',
    group: 'opencode',
    kind: 'split',
    keywords: ['plugin', 'plugins', 'addons', 'npm', 'opencode-wakatime'],
  },
  {
    slug: 'skills.installed',
    title: '技能',
    group: 'content',
    kind: 'split',
    keywords: ['skill', 'skills', 'instructions', 'install', 'catalog'],
  },
  {
    slug: 'skills.catalog',
    title: '技能目录',
    group: 'content',
    kind: 'single',
    keywords: ['install', 'catalog', 'external', 'repository', 'skills catalog'],
  },
  {
    slug: 'git',
    title: 'Git',
    group: 'projects',
    kind: 'single',
    keywords: ['git', 'identity', 'identities', 'ssh', 'profiles', 'credentials', 'keys', 'commit', 'gitmoji'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    slug: 'appearance',
    title: '外观',
    group: 'general',
    kind: 'single',
    keywords: ['theme', 'font', 'spacing', 'padding', 'corner radius', 'radius', 'input bar', 'keyboard', 'viewport', 'mobile', 'terminal', 'pwa', 'install name', 'app shortcuts'],
  },
  {
    slug: 'chat',
    title: '聊天',
    group: 'general',
    kind: 'single',
    keywords: ['tools', 'diff', 'reasoning', 'dotfiles', 'draft', 'queue', 'output', 'copy', 'image', 'split messages', 'message actions'],
  },
  {
    slug: 'shortcuts',
    title: '快捷键',
    group: 'general',
    kind: 'single',
    keywords: ['keyboard', 'hotkeys', 'shortcuts', 'bindings'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    slug: 'sessions',
    title: '会话',
    group: 'general',
    kind: 'single',
    keywords: ['defaults', 'default agent', 'default model', 'retention', 'memory', 'limits', 'zen'],
  },
  {
    slug: 'magic-prompts',
    title: '魔法提示词',
    group: 'content',
    kind: 'split',
    keywords: ['prompts', 'templates', 'git', 'github', 'review', 'commit', 'pull request'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    slug: 'snippets',
    title: '代码片段',
    group: 'content',
    kind: 'split',
    keywords: ['prompt', 'templates', 'multi-run', 'strategy', 'approach'],
  },

  { slug: 'notifications', title: '通知', group: 'general', kind: 'single', keywords: ['alerts', 'native', 'summary', 'summarization'], },
  { slug: 'voice', title: '语音', group: 'general', kind: 'single', keywords: ['tts', 'speech', 'voice'], isAvailable: (ctx) => !ctx.isVSCode },
  { slug: 'tunnel', title: '外部隧道', group: 'projects', kind: 'single', keywords: ['tunnel', 'external', 'cloudflare', 'qr', 'remote', 'mobile', 'share'], isAvailable: (ctx) => !ctx.isVSCode },
  { slug: 'about', title: '关于', group: 'general', kind: 'single', keywords: ['about', 'version', 'updates', 'release', 'changelog'], isAvailable: (ctx) => ctx.isMobile && !ctx.isVSCode },
  { slug: 'integrations', title: '集成', group: 'general', kind: 'single', keywords: ['integration', 'connect', 'oauth', 'github', 'linear', 'extension'], isAvailable: (ctx) => !ctx.isVSCode },
  // OpenViking：记忆侧只留浏览（设置与浏览重复，已删 memory-settings）。
  // 知识库暂仍保留「设置 + 浏览」两页；浏览页是 split，需要整页宽度。
  {
    slug: 'memory-browse',
    title: '记忆浏览',
    group: 'general',
    kind: 'split',
    description: '按文件树浏览 OpenViking 里的长期记忆。',
    keywords: ['memory', 'browse', 'tree', 'viking', '记忆', '浏览'],
    isAvailable: (ctx) => !ctx.isVSCode && !ctx.isMobile,
  },
  {
    slug: 'knowledge-settings',
    title: '知识库设置',
    group: 'general',
    kind: 'single',
    description: 'OpenViking 知识库的连接与就绪状态。',
    keywords: ['knowledge', 'resource', 'openviking', '知识库', '资源'],
    isAvailable: (ctx) => !ctx.isVSCode && !ctx.isMobile,
  },
  {
    slug: 'knowledge-browse',
    title: '知识库浏览',
    group: 'general',
    kind: 'split',
    description: '按文件树浏览 OpenViking 里的资源与文档。',
    keywords: ['knowledge', 'resource', 'browse', 'tree', 'viking', '知识库', '浏览'],
    isAvailable: (ctx) => !ctx.isVSCode && !ctx.isMobile,
  },
  {
    slug: 'devices',
    title: '设备',
    group: 'general',
    kind: 'single',
    description: '登记 Windows 设备，供 agent 通过 MCP 操作。',
    keywords: ['device', 'devices', 'mcp', 'ssh', 'screen', 'computer use', '设备', '多设备'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    slug: 'extensions',
    title: '扩展',
    group: 'general',
    kind: 'single',
    keywords: ['extension', 'extensions', 'guest', 'panel', 'rail', 'folder', 'zip', 'git', 'url'],
    isAvailable: (ctx) => !ctx.isVSCode && !ctx.isMobile,
  },
] as const;

const LEGACY_SIDEBAR_SECTION_TO_SETTINGS_SLUG: Record<SidebarSection, SettingsPageSlug> = {
  sessions: 'sessions',
  agents: 'agents',
  commands: 'commands',
  mcp: 'mcp',
  skills: 'skills.installed',
  providers: 'providers',
  usage: 'usage',
  'git-identities': 'git',
  settings: 'home',
};

export function getSettingsPageMeta(slug: string): SettingsPageMeta | null {
  const normalized = slug.trim().toLowerCase();
  return (SETTINGS_PAGE_METADATA as readonly SettingsPageMeta[]).find((page) => page.slug === normalized) ?? null;
}

export function resolveSettingsSlug(value: string | null | undefined): SettingsPageSlug {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) {
    return 'home';
  }

  const legacy = (LEGACY_SIDEBAR_SECTION_TO_SETTINGS_SLUG as Record<string, SettingsPageSlug>)[normalized];
  if (legacy) {
    return legacy;
  }

  const direct = getSettingsPageMeta(normalized);
  if (direct) {
    return direct.slug;
  }

  return 'home';
}

// Lives here (not in SettingsView) so light consumers such as the command
// palette can render settings entries without statically importing the whole
// settings surface into the eager startup graph.
export function getSettingsNavIcon(slug: SettingsPageSlug): IconName | null {
  switch (slug) {
    case 'general':
      return 'settings-3';
    case 'projects':
      return 'folders';
    case 'remote-instances':
      return 'computer';
    case 'appearance':
      return 'palette';
    case 'chat':
      return 'chat-ai-3';
    case 'magic-prompts':
      return 'ai-generate-2';
    case 'snippets':
      return 'chat-thread';
    case 'notifications':
      return 'notification-3';
    case 'shortcuts':
      return 'command';
    case 'sessions':
      return 'chat-history';

    case 'providers':
      return 'cloud';
    case 'agents':
      return 'ai-agent';
    case 'behavior':
      return 'brain';
    case 'commands':
      return 'slash-commands-2';
    case 'mcp':
      return null;
    case 'plugins':
      return 'plug-2';

    case 'skills.installed':
      return 'book-open';
    case 'skills.catalog':
      return 'book';

    case 'git':
      return 'git-branch';

    case 'devices':
      return 'computer';

    // OpenViking 浏览用树图标；知识库设置仍是齿轮。
    case 'knowledge-settings':
      return 'settings-3';
    case 'memory-browse':
      return 'brain';
    case 'knowledge-browse':
      return 'node-tree';
    case 'integrations':
      return 'plug';
    case 'extensions':
      return 'apps';

    case 'usage':
      return 'bar-chart-2';
    case 'voice':
      return 'mic';
    case 'tunnel':
      return 'home-office';
    case 'about':
      return 'information';
    case 'home':
      return null;
    default:
      return 'robot-2';
  }
}
