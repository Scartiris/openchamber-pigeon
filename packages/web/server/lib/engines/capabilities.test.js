import { describe, expect, test } from 'bun:test';
import {
  ENGINE_CAPABILITY_IDS,
  REQUIRED_FOR_CHAT,
  canServeChat,
  isKnownEngineCapability,
  missingForChat,
  splitEngineCapabilities,
} from './capabilities.js';

describe('engine capability vocabulary', () => {
  test('词表是闭集且不含重复', () => {
    expect(ENGINE_CAPABILITY_IDS.length).toBeGreaterThan(0);
    expect(new Set(ENGINE_CAPABILITY_IDS).size).toBe(ENGINE_CAPABILITY_IDS.length);
  });

  test('进主聊天流只要求「能建会话 + 能流式」', () => {
    // 这条线定高了第二个引擎就永远进不来；这里把它钉住。
    expect([...REQUIRED_FOR_CHAT]).toEqual(['sessions', 'streaming']);
  });

  test('认识的留下、不认识的单独报出来（不是静默、也不是报错）', () => {
    const { known, unknown } = splitEngineCapabilities([
      'sessions', 'streamingg', 'streaming', 'sessions', '', 'tools',
    ]);
    expect(known).toEqual(['sessions', 'streaming', 'tools']);
    expect(unknown).toEqual(['streamingg']);
  });

  test('空值不参与"不认识"的统计（空 id 不是拼错的能力）', () => {
    expect(splitEngineCapabilities(['', 'tools'])).toEqual({ known: ['tools'], unknown: [] });
  });

  test('没给参数就按"什么都没声明"处理，而不是抛', () => {
    expect(splitEngineCapabilities()).toEqual({ known: [], unknown: [] });
    expect(splitEngineCapabilities([])).toEqual({ known: [], unknown: [] });
  });

  test('canServeChat / missingForChat 是互补的判断', () => {
    expect(canServeChat(['sessions', 'streaming'])).toBe(true);
    expect(canServeChat(['sessions'])).toBe(false);
    expect(missingForChat(['sessions'])).toEqual(['streaming']);
    expect(missingForChat(['sessions', 'streaming'])).toEqual([]);
    expect(canServeChat()).toBe(false);
  });

  test('isKnownEngineCapability 只认词表里的 id', () => {
    expect(isKnownEngineCapability('diffs')).toBe(true);
    expect(isKnownEngineCapability('diff')).toBe(false);
    expect(isKnownEngineCapability(42)).toBe(false);
  });
});
