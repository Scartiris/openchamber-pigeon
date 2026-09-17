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
  browseSlug: SettingsPageSlug;
  sidebarTitleKey: I18nKey;
  sidebarDescriptionKey: I18nKey;
  /** 设置页的标题/描述 —— 只有 `OpenVikingSettingsPage` 用 */
  settingsTitleKey: I18nKey;
  settingsDescriptionKey: I18nKey;
  /**
   * 浏览页的标题/描述 —— 只有 `OpenVikingBrowsePage` 用。
   *
   * ★ 这两个字段是必需的，别让浏览页复用 `settingsTitleKey`：
   * 复用过的后果是浏览页顶栏显示「记忆设置」+ 设置页的描述（实机截图抓到的），
   * 因为 `settingsTitleKey` 指向的是 `settings.page.memorySettings.*`。
   */
  browseTitleKey: I18nKey;
  browseDescriptionKey: I18nKey;
  emptyKey: I18nKey;
  scopeUri: string;
}

export const OPENVIKING_SCOPE_META: Record<OpenVikingScope, OpenVikingScopeMeta> = {
  memory: {
    browseSlug: 'memory-browse',
    sidebarTitleKey: 'settings.openviking.memory.sidebar.title',
    sidebarDescriptionKey: 'settings.openviking.memory.sidebar.description',
    // 设置页已删；字段仍在类型上，知识库作用域仍在用同一结构。
    settingsTitleKey: 'settings.page.memorySettings.title',
    settingsDescriptionKey: 'settings.page.memorySettings.description',
    browseTitleKey: 'settings.page.memoryBrowse.title',
    browseDescriptionKey: 'settings.page.memoryBrowse.description',
    emptyKey: 'settings.openviking.memory.empty',
    scopeUri: 'viking://user',
  },
  knowledge: {
    browseSlug: 'knowledge-browse',
    sidebarTitleKey: 'settings.openviking.knowledge.sidebar.title',
    sidebarDescriptionKey: 'settings.openviking.knowledge.sidebar.description',
    settingsTitleKey: 'settings.page.knowledgeSettings.title',
    settingsDescriptionKey: 'settings.page.knowledgeSettings.description',
    browseTitleKey: 'settings.page.knowledgeBrowse.title',
    browseDescriptionKey: 'settings.page.knowledgeBrowse.description',
    emptyKey: 'settings.openviking.knowledge.empty',
    scopeUri: 'viking://resources',
  },
};
