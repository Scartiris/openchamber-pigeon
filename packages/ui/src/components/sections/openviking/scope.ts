import type { I18nKey } from '@/lib/i18n';
import type { SettingsPageSlug } from '@/lib/settings/metadata';

/**
 * 记忆与知识库这两个作用域的文案/行为差异。
 *
 * 它们在 OpenViking 里是同一套 `viking://` 文件系统的两个根
 * （`viking://user/<user>/memories` 与 `viking://resources`），
 * 浏览与设置的行为完全一致 —— 差异只有文案与根 URI。
 * 把差异收在这张表里，页面组件就能只写一份。
 *
 * 文案字段标成 `I18nKey` 而不是 `string`：`t()` 只接受字典里真实存在的键，
 * 写成 `string` 会在调用点丢掉这层编译期检查（本轮 type-check 就是这么发现的）。
 */
export type OpenVikingScope = 'memory' | 'knowledge';

export interface OpenVikingScopeMeta {
  settingsSlug: SettingsPageSlug;
  browseSlug: SettingsPageSlug;
  sidebarTitleKey: I18nKey;
  sidebarDescriptionKey: I18nKey;
  settingsTitleKey: I18nKey;
  settingsDescriptionKey: I18nKey;
  emptyKey: I18nKey;
  scopeUri: string;
}

export const OPENVIKING_SCOPE_META: Record<OpenVikingScope, OpenVikingScopeMeta> = {
  memory: {
    settingsSlug: 'memory-settings',
    browseSlug: 'memory-browse',
    sidebarTitleKey: 'settings.openviking.memory.sidebar.title',
    sidebarDescriptionKey: 'settings.openviking.memory.sidebar.description',
    settingsTitleKey: 'settings.page.memorySettings.title',
    settingsDescriptionKey: 'settings.page.memorySettings.description',
    emptyKey: 'settings.openviking.memory.empty',
    scopeUri: 'viking://user',
  },
  knowledge: {
    settingsSlug: 'knowledge-settings',
    browseSlug: 'knowledge-browse',
    sidebarTitleKey: 'settings.openviking.knowledge.sidebar.title',
    sidebarDescriptionKey: 'settings.openviking.knowledge.sidebar.description',
    settingsTitleKey: 'settings.page.knowledgeSettings.title',
    settingsDescriptionKey: 'settings.page.knowledgeSettings.description',
    emptyKey: 'settings.openviking.knowledge.empty',
    scopeUri: 'viking://resources',
  },
};
