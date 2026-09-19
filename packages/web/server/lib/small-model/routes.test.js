import { describe, expect, test } from 'bun:test';

import { registerSmallModelRoutes } from './routes.js';

/**
 * The route is thin on purpose; what it can get wrong is the shape it hands the
 * service. A fake app that keeps its handlers, plus a fake service that records
 * its arguments, is enough to see exactly that.
 */
const invokeGenerate = async (body, generate) => {
  const calls = [];
  const service = async (options) => {
    calls.push(options);
    return generate ? generate(options) : { text: 'ok' };
  };

  const handlers = new Map();
  registerSmallModelRoutes(
    {
      get: (path, handler) => handlers.set(`GET ${path}`, handler),
      post: (path, handler) => handlers.set(`POST ${path}`, handler),
    },
    { getSmallModelService: async () => ({ generateSmallModelText: service }) },
  );

  let status = 200;
  let payload;
  await handlers.get('POST /api/small-model/generate')(
    { body },
    {
      status(code) {
        status = code;
        return this;
      },
      json(value) {
        payload = value;
        return this;
      },
    },
  );

  return { calls, status, payload };
};

describe('POST /api/small-model/generate', () => {
  test('passes an explicit overflow mode through, so a caller can refuse truncation', async () => {
    const { calls } = await invokeGenerate({ prompt: 'hi', onOverflow: 'error' });

    expect(calls[0].onOverflow).toBe('error');
  });

  test('defaults to truncation and never trusts an unknown value', async () => {
    for (const onOverflow of [undefined, 'truncate', 'ERROR', ' error', true, 1, {}]) {
      const { calls } = await invokeGenerate({ prompt: 'hi', onOverflow });
      expect(calls[0].onOverflow).toBe('truncate');
    }
  });

  test('restrictToPreferredProvider is only on when the caller said so exactly', async () => {
    const on = await invokeGenerate({ prompt: 'hi', restrictToPreferredProvider: true });
    const off = await invokeGenerate({ prompt: 'hi', restrictToPreferredProvider: 'true' });

    expect(on.calls[0].restrictToPreferredProvider).toBe(true);
    expect(off.calls[0].restrictToPreferredProvider).toBe(false);
  });

  test('a context overflow answers 413 with its code, not a generic failure', async () => {
    const { status, payload } = await invokeGenerate({ prompt: 'hi', onOverflow: 'error' }, async () => {
      throw Object.assign(new Error('too large'), { statusCode: 413, code: 'context-too-small' });
    });

    expect(status).toBe(413);
    expect(payload.code).toBe('context-too-small');
  });
});
