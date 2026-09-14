/**
 * Pure helpers for turning assistant-message token payloads into period
 * consumption stats (today / last 7 days / last 30 days), broken down by model
 * and cache hit.
 */

import type { Message } from '@opencode-ai/sdk/v2';

export type ModelTokenUsage = {
  /** `providerID/modelID`, or a fallback key when either is missing. */
  key: string;
  providerID: string;
  modelID: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  messages: number;
  /** Inclusive input total: input + cache.read + cache.write. 0 when unknown. */
  inputProcessed: number;
};

export type TokenUsageWindow = {
  /** Inclusive start of the window, epoch ms. */
  startMs: number;
  /** Exclusive end of the window, epoch ms. */
  endMs: number;
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  /** cacheRead / inputProcessed, 0-100. Meaningless when `hasCacheInput` is false. */
  cacheHitPercent: number;
  hasCacheInput: boolean;
  models: ModelTokenUsage[];
};

export type TokenUsageSnapshot = {
  today: TokenUsageWindow;
  last7Days: TokenUsageWindow;
  last30Days: TokenUsageWindow;
  /** Number of sessions whose messages were scanned. */
  scannedSessions: number;
  /** Number of sessions that failed while fetching messages. */
  failedSessions: number;
  collectedAt: number;
};

export type AssistantUsageSample = {
  timeMs: number;
  providerID: string;
  modelID: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** Prefer the server-reported window total when present. */
  reportedTotal?: number | null;
};

type UsageWindows = {
  today: [number, number];
  last7Days: [number, number];
  last30Days: [number, number];
};

const nonNegative = (value: number | null | undefined): number => {
  if (value == null || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
};

const emptyWindow = (startMs: number, endMs: number): TokenUsageWindow => ({
  startMs,
  endMs,
  total: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  messages: 0,
  cacheHitPercent: 0,
  hasCacheInput: false,
  models: [],
});

/** Local-midnight start of the day containing `nowMs`. */
export const startOfLocalDay = (nowMs: number): number => {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

export const resolveUsageWindows = (nowMs: number): UsageWindows => {
  const dayStart = startOfLocalDay(nowMs);
  const nextDayStart = dayStart + 24 * 60 * 60 * 1000;
  const weekStart = dayStart - 6 * 24 * 60 * 60 * 1000;
  const monthStart = dayStart - 29 * 24 * 60 * 60 * 1000;
  return {
    today: [dayStart, nextDayStart],
    last7Days: [weekStart, nextDayStart],
    last30Days: [monthStart, nextDayStart],
  };
};

export const sampleTotalTokens = (sample: AssistantUsageSample): number => {
  const reported = sample.reportedTotal;
  if (reported != null && Number.isFinite(reported) && reported > 0) {
    return reported;
  }
  return sample.input + sample.output + sample.reasoning + sample.cacheRead + sample.cacheWrite;
};

/**
 * Decode one OpenCode message into a usage sample.
 *
 * Non-assistant messages and assistant turns without a usable timestamp are
 * ignored. Token fields are coerced to non-negative numbers so a partial
 * server payload cannot invent negative consumption.
 */
export const extractAssistantUsageSample = (info: Message): AssistantUsageSample | null => {
  if (info.role !== 'assistant') {
    return null;
  }
  const created = info.time.created;
  if (!Number.isFinite(created) || created <= 0) {
    return null;
  }

  const providerID = info.providerID.trim().length > 0 ? info.providerID.trim() : 'unknown';
  const modelID = info.modelID.trim().length > 0 ? info.modelID.trim() : 'unknown';

  const tokens = info.tokens;
  const input = nonNegative(tokens.input);
  const output = nonNegative(tokens.output);
  const reasoning = nonNegative(tokens.reasoning);
  const cacheRead = nonNegative(tokens.cache.read);
  const cacheWrite = nonNegative(tokens.cache.write);
  const reported = tokens.total;
  const reportedTotal = reported != null && Number.isFinite(reported) && reported > 0
    ? reported
    : null;

  return {
    timeMs: created,
    providerID,
    modelID,
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    reportedTotal,
  };
};

const modelKey = (sample: AssistantUsageSample): string =>
  `${sample.providerID}/${sample.modelID}`;

const emptyModel = (sample: AssistantUsageSample): ModelTokenUsage => ({
  key: modelKey(sample),
  providerID: sample.providerID,
  modelID: sample.modelID,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  messages: 0,
  inputProcessed: 0,
});

const addSampleToModel = (model: ModelTokenUsage, sample: AssistantUsageSample, total: number): void => {
  model.input += sample.input;
  model.output += sample.output;
  model.reasoning += sample.reasoning;
  model.cacheRead += sample.cacheRead;
  model.cacheWrite += sample.cacheWrite;
  model.total += total;
  model.messages += 1;
  model.inputProcessed += sample.input + sample.cacheRead + sample.cacheWrite;
};

const finalizeWindow = (
  startMs: number,
  endMs: number,
  models: Map<string, ModelTokenUsage>,
): TokenUsageWindow => {
  const window = emptyWindow(startMs, endMs);
  for (const model of models.values()) {
    window.total += model.total;
    window.input += model.input;
    window.output += model.output;
    window.reasoning += model.reasoning;
    window.cacheRead += model.cacheRead;
    window.cacheWrite += model.cacheWrite;
    window.messages += model.messages;
  }
  const inputProcessed = window.input + window.cacheRead + window.cacheWrite;
  window.hasCacheInput = inputProcessed > 0;
  window.cacheHitPercent = inputProcessed > 0
    ? Math.min(100, Math.max(0, (window.cacheRead / inputProcessed) * 100))
    : 0;
  window.models = Array.from(models.values()).sort((a, b) => b.total - a.total);
  return window;
};

export const aggregateTokenUsage = (
  samples: readonly AssistantUsageSample[],
  options: { nowMs: number; scannedSessions: number; failedSessions: number },
): TokenUsageSnapshot => {
  const ranges = resolveUsageWindows(options.nowMs);
  const todayModels = new Map<string, ModelTokenUsage>();
  const weekModels = new Map<string, ModelTokenUsage>();
  const monthModels = new Map<string, ModelTokenUsage>();

  for (const sample of samples) {
    if (sample.timeMs < ranges.last30Days[0] || sample.timeMs >= ranges.last30Days[1]) {
      continue;
    }
    const total = sampleTotalTokens(sample);
    const key = modelKey(sample);

    const month = monthModels.get(key) ?? emptyModel(sample);
    addSampleToModel(month, sample, total);
    monthModels.set(key, month);

    if (sample.timeMs >= ranges.last7Days[0]) {
      const week = weekModels.get(key) ?? emptyModel(sample);
      addSampleToModel(week, sample, total);
      weekModels.set(key, week);
    }

    if (sample.timeMs >= ranges.today[0]) {
      const today = todayModels.get(key) ?? emptyModel(sample);
      addSampleToModel(today, sample, total);
      todayModels.set(key, today);
    }
  }

  return {
    today: finalizeWindow(ranges.today[0], ranges.today[1], todayModels),
    last7Days: finalizeWindow(ranges.last7Days[0], ranges.last7Days[1], weekModels),
    last30Days: finalizeWindow(ranges.last30Days[0], ranges.last30Days[1], monthModels),
    scannedSessions: Math.max(0, options.scannedSessions),
    failedSessions: Math.max(0, options.failedSessions),
    collectedAt: options.nowMs,
  };
};

export const emptyTokenUsageSnapshot = (nowMs: number): TokenUsageSnapshot => {
  const ranges = resolveUsageWindows(nowMs);
  return {
    today: emptyWindow(ranges.today[0], ranges.today[1]),
    last7Days: emptyWindow(ranges.last7Days[0], ranges.last7Days[1]),
    last30Days: emptyWindow(ranges.last30Days[0], ranges.last30Days[1]),
    scannedSessions: 0,
    failedSessions: 0,
    collectedAt: nowMs,
  };
};
