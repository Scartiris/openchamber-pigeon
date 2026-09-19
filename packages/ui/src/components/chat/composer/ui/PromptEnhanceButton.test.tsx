/**
 * Mounted coverage for the prompt-enhancement button and the action behind it.
 * `lib/promptEnhance.test.ts` owns the request itself; only a mounted component
 * proves the press reaches the hook, that the composer's text is what gets
 * sent, and that an answer which arrived after the user typed again is dropped
 * instead of overwriting them.
 *
 * The package has no DOM test environment, so this file builds its own
 * happy-dom window — the same arrangement `ComposerModeSwitch.test.tsx` uses.
 * Run it on its own (`bun test <path>`): the globals it installs are
 * process-wide, and `sonner` is replaced to capture the toasts.
 */

import React, { act } from 'react';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { PromptEnhanceButton } from './PromptEnhanceButton';
import { usePromptEnhance } from '@/hooks/usePromptEnhance';
import type { PromptEnhanceRequestBody } from '@/lib/promptEnhance';
import { I18nProvider } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';

type ToastAction = { label: string; onClick: () => void };
type ToastOptions = { action?: ToastAction; description?: string };
type ToastCall = { kind: string; title: string; options?: ToastOptions };

const toasts: ToastCall[] = [];
const recordToast = (kind: string) => (title: string, options?: ToastOptions) => {
  toasts.push({ kind, title, options });
  return toasts.length;
};

mock.module('sonner', () => ({
  toast: Object.assign(recordToast('default'), {
    success: recordToast('success'),
    error: recordToast('error'),
    info: recordToast('info'),
    warning: recordToast('warning'),
  }),
}));

/** What the enhancement put on the wire, parsed back into the body it sent. */
type RecordedRequest = { url: string; body: PromptEnhanceRequestBody };

const ENHANCE_ROUTE = /\/api\/small-model\/generate/;

const requests: RecordedRequest[] = [];
const pendingResponses: Array<(response: Response) => void> = [];
const originalFetch = globalThis.fetch;

/** Other modules in the graph read on change; only the enhancement is ours. */
const enhanceRequests = () => requests.filter((request) => ENHANCE_ROUTE.test(request.url));

const installWindow = () => {
  const win = new Window({ url: 'http://localhost' });
  const values = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    localStorage: win.localStorage,
    HTMLElement: win.HTMLElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLInputElement: win.HTMLInputElement,
    Element: win.Element,
    Node: win.Node,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent,
    PointerEvent: win.PointerEvent,
    KeyboardEvent: win.KeyboardEvent,
    DocumentFragment: win.DocumentFragment,
    SVGElement: win.SVGElement,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
};

/**
 * Every request stays unanswered until the test resolves it, so the in-flight
 * window the guards exist for can be held open deliberately. Only the
 * enhancement is answerable; anything else stays pending, which is what "off
 * the network" means here.
 */
const installFetch = () => {
  // SAFETY: this stands in for the global fetch the runtime calls; it takes the
  // same arguments and answers with a real Response.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    // SAFETY: the module under test is the only writer of this body in this
    // process, and its shape is the contract `buildPromptEnhanceBody` returns.
    const body = JSON.parse(String(init?.body ?? '{}')) as PromptEnhanceRequestBody;
    const request: RecordedRequest = { url: String(input), body };
    requests.push(request);
    return new Promise<Response>((resolve) => {
      if (ENHANCE_ROUTE.test(request.url)) pendingResponses.push(resolve);
    });
  }) as typeof fetch;
};

type EnhanceAnswer = { text: string; providerID?: string; modelID?: string; source?: string };

const answer = (payload: EnhanceAnswer, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** Reads back the composer state the hook treated as the live draft. */
type Harness = { draft: () => string };

const Harness = ({ initialDraft, onReady }: { initialDraft: string; onReady: (harness: Harness) => void }) => {
  const [text, setText] = React.useState(initialDraft);
  const textRef = React.useRef(text);
  textRef.current = text;

  const { isEnhancing, enhance } = usePromptEnhance({
    sessionId: 's1',
    directory: '/repo',
    readDraft: React.useCallback(() => textRef.current, []),
    writeDraft: React.useCallback((next: string) => setText(next), []),
  });

  onReady({ draft: () => textRef.current });

  return (
    <div>
      <span data-testid="draft">{text}</span>
      <button
        type="button"
        data-testid="user-types"
        onClick={() => setText('用户自己又补了一句')}
      />
      <PromptEnhanceButton
        footerIconButtonClass="oc-footer-button"
        iconSizeClass="size-4"
        canEnhance={text.trim().length > 0}
        isEnhancing={isEnhancing}
        onEnhance={enhance}
      />
    </div>
  );
};

const mountHarness = async (initialDraft: string) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let harness: Harness = { draft: () => '' };

  await act(async () => {
    root.render(
      <I18nProvider>
        <Harness initialDraft={initialDraft} onReady={(next) => { harness = next; }} />
      </I18nProvider>,
    );
  });

  const button = () => container.querySelector<HTMLButtonElement>('[data-prompt-enhance]');
  const click = async (element: HTMLButtonElement | null) => {
    await act(async () => {
      element?.click();
    });
  };

  return {
    container,
    button,
    click,
    userTypes: () => container.querySelector<HTMLButtonElement>('[data-testid="user-types"]'),
    draft: () => harness.draft(),
  };
};

describe('PromptEnhanceButton', () => {
  beforeEach(() => {
    toasts.length = 0;
    requests.length = 0;
    pendingResponses.length = 0;
    installWindow();
    installFetch();
    useConfigStore.setState({ currentProviderId: 'openai', currentModelId: 'gpt-5' });
    useSelectionStore.setState({
      sessionModelSelections: new Map([['s1', { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' }]]),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('sends the composer text to the session\'s own model and applies the rewrite', async () => {
    const mounted = await mountHarness('写个登录页');
    expect(mounted.button()?.disabled).toBe(false);

    await mounted.click(mounted.button());

    expect(enhanceRequests()).toHaveLength(1);
    expect(enhanceRequests()[0].url).toContain('/api/small-model/generate');
    expect(enhanceRequests()[0].body.prompt).toBe('写个登录页');
    expect(enhanceRequests()[0].body.model).toBe('anthropic/claude-sonnet-4-5');
    // The button reports the work in progress instead of inviting a second run.
    expect(mounted.button()?.disabled).toBe(true);
    expect(mounted.button()?.getAttribute('aria-busy')).toBe('true');

    pendingResponses[0](answer({ text: '```\n做个登录页：邮箱 + 密码。\n```', modelID: 'claude-sonnet-4-5' }));
    await flush();

    expect(mounted.draft()).toBe('做个登录页：邮箱 + 密码。');
    expect(mounted.container.querySelector('[data-testid="draft"]')?.textContent).toBe('做个登录页：邮箱 + 密码。');
    expect(mounted.button()?.disabled).toBe(false);
    expect(toasts.at(-1)?.kind).toBe('success');
  });

  test('the success toast can put the original draft back', async () => {
    const mounted = await mountHarness('写个登录页');
    await mounted.click(mounted.button());
    pendingResponses[0](answer({ text: '做个登录页：邮箱 + 密码。' }));
    await flush();

    const action = toasts.at(-1)?.options?.action;
    expect(action).toBeDefined();
    await act(async () => {
      action?.onClick();
    });

    expect(mounted.draft()).toBe('写个登录页');
  });

  test('typing while the rewrite runs keeps the user\'s text and drops the answer', async () => {
    const mounted = await mountHarness('写个登录页');
    await mounted.click(mounted.button());

    await mounted.click(mounted.userTypes());
    expect(mounted.draft()).toBe('用户自己又补了一句');

    pendingResponses[0](answer({ text: '做个登录页：邮箱 + 密码。' }));
    await flush();

    expect(mounted.draft()).toBe('用户自己又补了一句');
    expect(toasts.at(-1)?.kind).toBe('info');
  });

  test('a failed rewrite keeps the draft and says why', async () => {
    const mounted = await mountHarness('写个登录页');
    await mounted.click(mounted.button());

    pendingResponses[0](answer({ text: '' }, 401));
    await flush();
    // The retry without the session model is the second request, and it fails too.
    expect(enhanceRequests()).toHaveLength(2);
    pendingResponses[1](answer({ text: '' }, 404));
    await flush();

    expect(mounted.draft()).toBe('写个登录页');
    expect(toasts.at(-1)?.kind).toBe('error');
    expect(mounted.button()?.disabled).toBe(false);
  });

  test('an empty composer cannot ask for a rewrite', async () => {
    const mounted = await mountHarness('   ');

    expect(mounted.button()?.disabled).toBe(true);
    await mounted.click(mounted.button());

    expect(enhanceRequests()).toHaveLength(0);
  });

  test('a second press while a rewrite is running is ignored', async () => {
    const mounted = await mountHarness('写个登录页');
    await mounted.click(mounted.button());
    await mounted.click(mounted.button());

    expect(enhanceRequests()).toHaveLength(1);
  });
});
