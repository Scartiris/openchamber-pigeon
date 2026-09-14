import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2';
import {
  aggregateTokenUsage,
  emptyTokenUsageSnapshot,
  extractAssistantUsageSample,
  resolveUsageWindows,
  sampleTotalTokens,
  startOfLocalDay,
  type AssistantUsageSample,
} from './aggregate';

type AssistantFixture = {
  role: 'assistant' | 'user';
  time?: { created: number };
  providerID?: string;
  modelID?: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
    total?: number;
  };
};

// SAFETY: fixtures supply only the AssistantMessage fields the extractor reads.
const asMessage = (value: AssistantFixture): Message => value as Message;

const at = (offsetDays: number, hour = 12): number => {
  const base = startOfLocalDay(Date.now());
  return base + offsetDays * 24 * 60 * 60 * 1000 + hour * 60 * 60 * 1000;
};

const sample = (overrides: Partial<AssistantUsageSample> = {}): AssistantUsageSample => ({
  timeMs: at(0),
  providerID: 'anthropic',
  modelID: 'claude-sonnet-4',
  input: 100,
  output: 50,
  reasoning: 10,
  cacheRead: 800,
  cacheWrite: 50,
  reportedTotal: null,
  ...overrides,
});

describe('startOfLocalDay', () => {
  test('returns local midnight for any time of day', () => {
    const now = new Date(2026, 2, 15, 18, 42, 11).getTime();
    const expected = new Date(2026, 2, 15, 0, 0, 0, 0).getTime();
    expect(startOfLocalDay(now)).toBe(expected);
  });
});

describe('resolveUsageWindows', () => {
  test('builds overlapping 1/7/30-day windows ending at tomorrow midnight', () => {
    const now = new Date(2026, 2, 15, 10, 0, 0).getTime();
    const ranges = resolveUsageWindows(now);
    const dayStart = new Date(2026, 2, 15, 0, 0, 0, 0).getTime();
    const nextDay = dayStart + 86_400_000;

    expect(ranges.today).toEqual([dayStart, nextDay]);
    expect(ranges.last7Days[0]).toBe(dayStart - 6 * 86_400_000);
    expect(ranges.last30Days[0]).toBe(dayStart - 29 * 86_400_000);
    expect(ranges.last7Days[1]).toBe(nextDay);
    expect(ranges.last30Days[1]).toBe(nextDay);
  });
});

describe('extractAssistantUsageSample', () => {
  test('reads assistant tokens, model, and time', () => {
    const extracted = extractAssistantUsageSample(asMessage({
      role: 'assistant',
      time: { created: at(0) },
      providerID: 'openai',
      modelID: 'gpt-5',
      tokens: {
        input: 10,
        output: 20,
        reasoning: 5,
        cache: { read: 30, write: 2 },
        total: 67,
      },
    }));

    expect(extracted).not.toBeNull();
    expect(extracted?.providerID).toBe('openai');
    expect(extracted?.modelID).toBe('gpt-5');
    expect(extracted?.input).toBe(10);
    expect(extracted?.cacheRead).toBe(30);
    expect(extracted?.reportedTotal).toBe(67);
    expect(sampleTotalTokens(extracted!)).toBe(67);
  });

  test('ignores user messages and missing timestamps', () => {
    expect(extractAssistantUsageSample(asMessage({ role: 'user', time: { created: 1 } }))).toBeNull();
    expect(extractAssistantUsageSample(asMessage({ role: 'assistant', time: { created: 0 } }))).toBeNull();
    expect(extractAssistantUsageSample(asMessage({ role: 'assistant', time: { created: Number.NaN } }))).toBeNull();
  });

  test('falls back to field sum when server total is absent', () => {
    const extracted = extractAssistantUsageSample(asMessage({
      role: 'assistant',
      time: { created: at(0) },
      providerID: 'anthropic',
      modelID: 'claude',
      tokens: {
        input: 1,
        output: 2,
        reasoning: 3,
        cache: { read: 4, write: 5 },
      },
    }));
    expect(sampleTotalTokens(extracted!)).toBe(15);
  });
});

describe('aggregateTokenUsage', () => {
  test('splits samples across today / week / month windows and by model', () => {
    // Anchor "now" to a fixed local calendar day so window membership is stable.
    const now = new Date(2026, 2, 15, 15, 0, 0).getTime();
    const day = (dayOffset: number, hour = 9): number =>
      new Date(2026, 2, 15 + dayOffset, hour, 0, 0).getTime();

    const snapshot = aggregateTokenUsage(
      [
        sample({ timeMs: day(0), modelID: 'a' }),
        sample({ timeMs: day(-1), modelID: 'b' }),
        sample({ timeMs: day(-10), modelID: 'a' }),
        sample({ timeMs: day(-40), modelID: 'a' }), // outside 30d
      ],
      { nowMs: now, scannedSessions: 3, failedSessions: 1 },
    );

    expect(snapshot.scannedSessions).toBe(3);
    expect(snapshot.failedSessions).toBe(1);
    expect(snapshot.today.messages).toBe(1);
    expect(snapshot.last7Days.messages).toBe(2);
    expect(snapshot.last30Days.messages).toBe(3);
    expect(snapshot.today.models.map((m) => m.modelID)).toEqual(['a']);
  });

  test('computes cache hit from processed input and lists models by total', () => {
    const now = Date.now();
    const snapshot = aggregateTokenUsage(
      [
        sample({
          timeMs: startOfLocalDay(now) + 1000,
          providerID: 'anthropic',
          modelID: 'sonnet',
          input: 100,
          output: 10,
          reasoning: 0,
          cacheRead: 900,
          cacheWrite: 0,
        }),
        sample({
          timeMs: startOfLocalDay(now) + 2000,
          providerID: 'openai',
          modelID: 'gpt',
          input: 50,
          output: 5,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        }),
      ],
      { nowMs: now, scannedSessions: 2, failedSessions: 0 },
    );

    expect(snapshot.today.messages).toBe(2);
    expect(snapshot.today.total).toBe(100 + 10 + 900 + 50 + 5);
    expect(snapshot.today.cacheRead).toBe(900);
    expect(snapshot.today.hasCacheInput).toBe(true);
    // 900 / (100+900+50) = 900/1050
    expect(Math.abs(snapshot.today.cacheHitPercent - (900 / 1050) * 100)).toBeLessThan(1e-6);
    expect(snapshot.today.models.map((m) => m.modelID)).toEqual(['sonnet', 'gpt']);
    expect(snapshot.today.models[0]?.cacheRead).toBe(900);
  });

  test('empty snapshot has zero windows and no models', () => {
    const now = Date.now();
    const empty = emptyTokenUsageSnapshot(now);
    expect(empty.today.total).toBe(0);
    expect(empty.last7Days.models).toEqual([]);
    expect(empty.last30Days.messages).toBe(0);
  });
});
