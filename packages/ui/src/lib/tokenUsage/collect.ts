import type { Session } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { mapWithConcurrency } from '@/lib/concurrency';
import {
  aggregateTokenUsage,
  emptyTokenUsageSnapshot,
  extractAssistantUsageSample,
  type AssistantUsageSample,
  type TokenUsageSnapshot,
} from './aggregate';

const MESSAGE_FETCH_CONCURRENCY = 12;
/** Cap how many sessions we scan so a huge history cannot stall the header. */
const MAX_SCANNED_SESSIONS = 200;

type SessionScanEntry = {
  /** Session `time.updated` when this cache entry was produced. */
  updatedAt: number;
  samples: AssistantUsageSample[];
};

/**
 * Per-session sample cache so a refresh only re-downloads sessions whose
 * `time.updated` moved. Cleared on runtime switch via {@link resetTokenUsageCollectCache}.
 */
const sessionScanCache = new Map<string, SessionScanEntry>();

export const resetTokenUsageCollectCache = (): void => {
  sessionScanCache.clear();
};

/**
 * Scan assistant messages from recently active sessions and aggregate them into
 * daily / weekly / monthly token consumption.
 *
 * Failure handling: one unreadable session must not erase the rest. Session
 * message fetches that fail increment `failedSessions`; the window totals still
 * include every session that answered.
 */
export const collectTokenUsage = async (options: {
  sessions: readonly Session[];
  nowMs: number;
  concurrency?: number;
  maxSessions?: number;
}): Promise<TokenUsageSnapshot> => {
  const {
    sessions,
    nowMs,
    concurrency = MESSAGE_FETCH_CONCURRENCY,
    maxSessions = MAX_SCANNED_SESSIONS,
  } = options;
  const monthStartMs = nowMs - 29 * 24 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000;
  const candidates = sessions
    .filter((session) => {
      const updated = session.time?.updated ?? session.time?.created ?? 0;
      return Number.isFinite(updated) && updated >= monthStartMs;
    })
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    .slice(0, maxSessions);

  if (candidates.length === 0) {
    return emptyTokenUsageSnapshot(nowMs);
  }

  const samples: AssistantUsageSample[] = [];
  let failedSessions = 0;
  let scannedSessions = 0;

  await mapWithConcurrency(candidates, concurrency, async (session) => {
    const sessionUpdatedAt = session.time?.updated ?? session.time?.created ?? 0;
    const cached = sessionScanCache.get(session.id);
    if (cached && cached.updatedAt >= sessionUpdatedAt) {
      samples.push(...cached.samples);
      scannedSessions += 1;
      return;
    }

    try {
      const messages = await opencodeClient.getSessionMessages(session.id, undefined, session.directory);
      const sessionSamples: AssistantUsageSample[] = [];
      for (const message of messages) {
        const sample = extractAssistantUsageSample(message.info);
        if (sample) {
          sessionSamples.push(sample);
        }
      }
      sessionScanCache.set(session.id, { updatedAt: sessionUpdatedAt, samples: sessionSamples });
      samples.push(...sessionSamples);
      scannedSessions += 1;
    } catch {
      // Do not cache failures: the next refresh should retry this session.
      failedSessions += 1;
      scannedSessions += 1;
    }
  });

  // Drop cache entries for sessions that fell out of the candidate set so a
  // deleted or long-idle session cannot grow without bound.
  if (sessionScanCache.size > maxSessions) {
    const keep = new Set(candidates.map((session) => session.id));
    for (const sessionId of Array.from(sessionScanCache.keys())) {
      if (!keep.has(sessionId)) {
        sessionScanCache.delete(sessionId);
      }
    }
  }

  return aggregateTokenUsage(samples, {
    nowMs,
    scannedSessions,
    failedSessions,
  });
};
