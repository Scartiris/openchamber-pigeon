import { describe, expect, test } from 'bun:test';
import {
  ENGINE_CAPABILITY_IDS,
  REQUIRED_FOR_CHAT,
  canServeChat,
  knownCapabilities,
  missingForChat,
  missingSurfaces,
  shouldRenderSurface,
} from './capabilities';

/**
 * 这一组测的是**降级规则**本身：一个"弱引擎"（只有 sessions+streaming）也要能用，
 * 缺什么就把对应的面收起来 —— 而不是渲染出一堆点了没反应的东西。
 */

describe('引擎能力：认识的收下、不认识的丢掉', () => {
  test('正常的声明原样收下，且去重', () => {
    expect(knownCapabilities(['sessions', 'streaming', 'sessions'])).toEqual(['sessions', 'streaming']);
  });

  test('不认识的丢掉（服务端已经报过 warning，UI 不该崩也不该渲染它）', () => {
    expect(knownCapabilities(['sessions', 'telepathy', 'streaming'])).toEqual(['sessions', 'streaming']);
  });

  test('空值/非数组不炸', () => {
    expect(knownCapabilities(undefined)).toEqual([]);
    expect(knownCapabilities(null)).toEqual([]);
    expect(knownCapabilities(['', 'sessions'])).toEqual(['sessions']);
  });
});

describe('引擎能力：能不能进主聊天流', () => {
  test('sessions + streaming 就够（门槛刻意低：定高了第二个引擎永远进不来）', () => {
    expect(canServeChat(['sessions', 'streaming'])).toBe(true);
    expect(canServeChat(['sessions', 'streaming', 'tools', 'diffs'])).toBe(true);
  });

  test('缺任何一个地基都不行，且说得出缺哪个', () => {
    expect(canServeChat(['sessions'])).toBe(false);
    expect(missingForChat(['sessions'])).toEqual(['streaming']);
    expect(canServeChat(['streaming'])).toBe(false);
    expect(missingForChat(['streaming'])).toEqual(['sessions']);
    expect(canServeChat([])).toBe(false);
    expect(missingForChat([])).toEqual(['sessions', 'streaming']);
  });

  test('把能力拼错等于没有（拼错 streamingg 不能蒙混过关）', () => {
    expect(canServeChat(['sessions', 'streamingg'])).toBe(false);
    expect(missingForChat(['sessions', 'streamingg'])).toEqual(['streaming']);
  });
});

describe('引擎能力：按能力降级（缺的面收起来，而不是留个没反应的按钮）', () => {
  test('有就渲染、没有就不渲染', () => {
    const caps = ['sessions', 'streaming', 'tools'];
    expect(shouldRenderSurface(caps, 'tools')).toBe(true);
    expect(shouldRenderSurface(caps, 'diffs')).toBe(false);
    expect(shouldRenderSurface(caps, 'mcp')).toBe(false);
  });

  test('缺什么一次说清（界面用它解释"这个引擎少了什么"）', () => {
    const missing = missingSurfaces(['sessions', 'streaming']);
    expect(missing).not.toContain('sessions');
    expect(missing).not.toContain('streaming');
    expect(missing).toContain('diffs');
    expect(missing).toContain('agents');
    expect(missing.length).toBe(ENGINE_CAPABILITY_IDS.length - 2);
  });

  test('降级不等于禁用：缺一堆面的引擎照样能进聊天流', () => {
    const weak = ['sessions', 'streaming'];
    expect(canServeChat(weak)).toBe(true);
    expect(shouldRenderSurface(weak, 'diffs')).toBe(false);
  });
});

describe('词表镜像：与 required 集合的约定', () => {
  test('REQUIRED_FOR_CHAT 的两项都在词表里（不然门槛就成了永远过不去）', () => {
    for (const id of REQUIRED_FOR_CHAT) {
      expect(ENGINE_CAPABILITY_IDS).toContain(id);
    }
  });

  /**
   * ⚠️ 这条是**防止两份词表漂移**的：UI 这份是服务端 `capabilities.js` 的镜像。
   * 真要比对得读服务端文件 —— 那超出 UI 包的范围，所以这里只钉住"数量与关键项"，
   * 服务端那边有它自己的测试（`server/lib/engines/capabilities.test.js`）。
   * 真要改词表：**两边一起改**，并跑两边的测试。
   */
  test('词表规模与关键项（漂移时这条会红，提醒你两边一起改）', () => {
    expect(ENGINE_CAPABILITY_IDS.length).toBe(15);
    expect(ENGINE_CAPABILITY_IDS).toContain('diffs');
    expect(ENGINE_CAPABILITY_IDS).toContain('permissions');
    expect(ENGINE_CAPABILITY_IDS).toContain('projects');
  });
});
