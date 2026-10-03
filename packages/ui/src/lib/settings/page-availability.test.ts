import { describe, expect, test } from 'bun:test';

import { SETTINGS_PAGE_METADATA, settingsPageTitleKey, type SettingsPageSlug, type SettingsRuntimeContext } from './metadata';

/**
 * 为什么专门给「引擎」页写一条可达性测试：
 *
 * 2026-10-03 用户问「切换按钮在哪呢」—— 我上一版把引擎切换器放进了「关于」页，
 * 而「关于」的可见性是 `ctx.isMobile && !ctx.isVSCode`，于是**桌面版根本没有入口**。
 * 当时的"验收"只查了产物里有没有那些文案字符串（`verify-ui-dist.sh`），
 * **没有验证它在桌面上够不够得着** —— 功能写完了、测过了、上线了，用户却看不到。
 *
 * 这条测试就是那个缺口：**用户可见面必须断言"在用户用的那个 surface 上可达"**。
 */

const ctx = (over: Partial<SettingsRuntimeContext>): SettingsRuntimeContext => ({
  isVSCode: false,
  isWeb: true,
  isDesktop: false,
  isMobile: false,
  ...over,
});

const pageOf = (slug: SettingsPageSlug) => {
  const page = SETTINGS_PAGE_METADATA.find((entry) => entry.slug === slug);
  if (!page) throw new Error(`设置页注册表里没有 ${slug}`);
  return page;
};

const available = (slug: SettingsPageSlug, context: SettingsRuntimeContext): boolean => {
  const page = pageOf(slug);
  return page.isAvailable ? page.isAvailable(context) : true;
};

describe('settings page availability', () => {
  test('引擎页在**桌面浏览器**上可达（这正是用户问"按钮在哪"的场景）', () => {
    expect(available('engine', ctx({ isWeb: true, isMobile: false, isDesktop: false }))).toBe(true);
  });

  test('引擎页在桌面壳 / 移动端 / VS Code 里也都可达', () => {
    expect(available('engine', ctx({ isDesktop: true, isWeb: false }))).toBe(true);
    expect(available('engine', ctx({ isMobile: true }))).toBe(true);
    expect(available('engine', ctx({ isVSCode: true }))).toBe(true);
  });

  test('「关于」页仍然是**移动端专属**（引擎页当初就是被这个条件挡住的）', () => {
    // 这条不是"顺手记一下"：它解释了为什么引擎切换器不能放在「关于」页里。
    // 如果哪天有人把 about 改成所有 surface 可见，这条会红 —— 那时可以重新考虑合并两页。
    expect(available('about', ctx({ isMobile: true }))).toBe(true);
    expect(available('about', ctx({ isMobile: false }))).toBe(false);
  });

  test('引擎页有标题键，且与其它页一样能取到', () => {
    expect(settingsPageTitleKey('engine')).toBe('settings.page.engine.title');
  });

  test('引擎页归在 opencode 组（引擎是 OpenCode 侧的事，不是通用设置）', () => {
    expect(pageOf('engine').group).toBe('opencode');
  });
});
