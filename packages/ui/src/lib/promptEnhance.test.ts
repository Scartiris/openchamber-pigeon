/**
 * Unit coverage for the prompt-enhancement request: what goes on the wire, which
 * model it names, when it is retried without that model, and how a model's
 * formatting is stripped back off the answer.
 *
 * The stores and the transport are mocked, so this file runs on its own
 * (`bun test <path>`): `mock.module` is process-global.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import type { PromptEnhanceRequestBody, PromptEnhanceResult } from './promptEnhance';

type SentRequest = { url: string; body: PromptEnhanceRequestBody };

const sent: SentRequest[] = [];
let respond: (request: SentRequest, attempt: number) => Response;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (input: string, init: RequestInit = {}) => {
    // SAFETY: the module under test is the only writer of this body in this
    // process, and its shape is the contract `buildPromptEnhanceBody` returns.
    const body = JSON.parse(String(init.body ?? '{}')) as PromptEnhanceRequestBody;
    const request: SentRequest = { url: String(input), body };
    sent.push(request);
    return respond(request, sent.length - 1);
  },
}));

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({ currentProviderId: 'openai', currentModelId: 'gpt-5' }),
  },
}));

mock.module('@/sync/selection-store', () => ({
  useSelectionStore: {
    getState: () => ({
      getSessionModelSelection: (sessionId: string) => (
        sessionId === 's-known' ? { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' } : null
      ),
    }),
  },
}));

const {
  PROMPT_ENHANCE_MAX_INPUT_CHARS,
  buildPromptEnhanceBody,
  normalizeEnhancedPrompt,
  requestPromptEnhancement,
  resolvePromptEnhanceModel,
} = await import('./promptEnhance');

type EnhancePayload = { text: string; providerID?: string; modelID?: string; source?: string };

const jsonResponse = (payload: EnhancePayload, status = 200): Response => new Response(
  JSON.stringify(payload),
  { status, headers: { 'content-type': 'application/json' } },
);

const enhance = (overrides: Partial<Parameters<typeof requestPromptEnhancement>[0]> = {}) =>
  requestPromptEnhancement({
    text: '写个登录页',
    model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
    sessionID: 's-known',
    directory: '/repo',
    ...overrides,
  });

/**
 * Runs a request and reports how it ended, so a test never has to assert on a
 * thrown value: an enhancement failure is named by its reason, and anything
 * else is reported as not being one.
 */
const outcomeOf = async (promise: Promise<PromptEnhanceResult>): Promise<string> => {
  try {
    const result = await promise;
    return `ok:${result.text}`;
  } catch (error) {
    return error instanceof Error && 'reason' in error ? String(error.reason) : 'not-an-enhance-error';
  }
};

describe('normalizeEnhancedPrompt', () => {
  test('drops a reasoning block and the code fence the model wrapped its answer in', () => {
    expect(normalizeEnhancedPrompt('<think>the user wants a login page</think>\n```markdown\nBuild a login page.\n```'))
      .toBe('Build a login page.');
    expect(normalizeEnhancedPrompt('```\nBuild a login page.\n```')).toBe('Build a login page.');
  });

  test('unwraps the whole answer only when the quotes wrap it', () => {
    expect(normalizeEnhancedPrompt('"Build a login page."')).toBe('Build a login page.');
    expect(normalizeEnhancedPrompt('\u300cBuild a login page.\u300d')).toBe('Build a login page.');
    // Quotes inside the prompt are the author's, not decoration.
    expect(normalizeEnhancedPrompt('"login" and "signup" pages')).toBe('"login" and "signup" pages');
  });

  test('a fence in the middle of the answer is content, not decoration', () => {
    const answer = 'Add a test:\n```ts\nit("works", () => {});\n```';
    expect(normalizeEnhancedPrompt(answer)).toBe(answer);
  });

  test('an answer with nothing in it normalizes to nothing', () => {
    expect(normalizeEnhancedPrompt('   \n  ')).toBe('');
    expect(normalizeEnhancedPrompt('<think>hmm</think>')).toBe('');
  });
});

describe('resolvePromptEnhanceModel', () => {
  test('the session\'s own selection wins over the app-wide one', () => {
    expect(resolvePromptEnhanceModel('s-known')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-5',
    });
  });

  test('a session with no selection of its own falls back to the app-wide model', () => {
    expect(resolvePromptEnhanceModel('s-new')).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    expect(resolvePromptEnhanceModel(null)).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
  });
});

describe('buildPromptEnhanceBody', () => {
  test('names the model as provider/model and refuses a truncated draft', () => {
    const body = buildPromptEnhanceBody({
      text: '写个登录页',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
      sessionID: 's1',
      directory: '/repo',
    });

    expect(body.model).toBe('anthropic/claude-sonnet-4-5');
    expect(body.onOverflow).toBe('error');
    expect(body.prompt).toBe('写个登录页');
    expect(body.sessionID).toBe('s1');
    expect(body.directory).toBe('/repo');
  });

  test('leaves the output budget to the server: a short-looking request is not a small one for a thinking model', () => {
    const body = buildPromptEnhanceBody({ text: 'hi', model: null });

    expect('maxOutputTokens' in body).toBe(false);
  });

  test('leaves the model unnamed when the caller has none, so the route resolves one', () => {
    const body = buildPromptEnhanceBody({ text: 'hi', model: null });
    expect(body.model).toBeUndefined();
    expect(body.sessionID).toBeUndefined();
    expect(body.directory).toBeUndefined();
  });
});

describe('requestPromptEnhancement', () => {
  beforeEach(() => {
    sent.length = 0;
    respond = () => jsonResponse({ text: 'Build a login page.', providerID: 'anthropic', modelID: 'claude-sonnet-4-5', source: 'request' });
  });

  afterEach(() => {
    sent.length = 0;
  });

  test('asks the session\'s model once and returns the cleaned prompt', async () => {
    respond = () => jsonResponse({
      text: '```\nBuild a login page with email and password.\n```',
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-5',
      source: 'request',
    });

    const result = await enhance();

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('/api/small-model/generate');
    expect(sent[0].body.model).toBe('anthropic/claude-sonnet-4-5');
    expect(sent[0].body.system).toContain('Return ONLY the rewritten prompt');
    expect(result.text).toBe('Build a login page with email and password.');
    expect(result.modelID).toBe('claude-sonnet-4-5');
  });

  test('falls back to the route\'s own model when the session model cannot be called', async () => {
    respond = (_request, attempt) => (attempt === 0
      ? jsonResponse({ text: '' }, 401)
      : jsonResponse({ text: 'Build a login page.', providerID: 'google', modelID: 'gemini-2.5-flash', source: 'family-scan' }));

    const result = await enhance();

    expect(sent).toHaveLength(2);
    expect(sent[1].body.model).toBeUndefined();
    // The answer reports who actually did the work instead of the model asked.
    expect(result).toMatchObject({ providerID: 'google', modelID: 'gemini-2.5-flash', source: 'family-scan' });
  });

  test('does not repeat a request the model itself rejected as too large', async () => {
    respond = () => jsonResponse({ text: '' }, 413);

    expect(await outcomeOf(enhance())).toBe('tooLong');
    expect(sent).toHaveLength(1);
  });

  test('reports a missing login as unavailable rather than as a generic failure', async () => {
    respond = () => jsonResponse({ text: '' }, 401);

    expect(await outcomeOf(enhance({ model: null }))).toBe('unavailable');
  });

  test('an oversized draft never reaches the network', async () => {
    expect(await outcomeOf(enhance({ text: 'x'.repeat(PROMPT_ENHANCE_MAX_INPUT_CHARS + 1) }))).toBe('tooLong');
    expect(sent).toHaveLength(0);
  });

  test('an empty answer is a failure, not an empty prompt', async () => {
    respond = () => jsonResponse({ text: '<think>no idea</think>' });

    expect(await outcomeOf(enhance())).toBe('failed');
  });

  test('an unreadable answer is a failure, not a prompt built from nothing', async () => {
    respond = () => new Response('<html>gateway</html>', { status: 200 });

    expect(await outcomeOf(enhance())).toBe('failed');
  });
});
