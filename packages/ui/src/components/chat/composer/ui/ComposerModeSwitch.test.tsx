/**
 * Mounted coverage for the composer mode switch's wiring: the pure rules live in
 * `lib/composerModes.test.ts`, but only a mounted component proves a click reaches
 * `setAgent`, that the session's choice is persisted with it, that the model and
 * effort survive the change, and that the shared plan-mode gate follows.
 *
 * The package has no DOM test environment, so this file builds its own happy-dom
 * window — the same arrangement `MobilePillComposer.test.tsx` uses. Run it on its
 * own (`bun test <path>`): the globals it installs are process-wide.
 */

import React, { act } from 'react';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import type { Agent } from '@opencode-ai/sdk/v2';

import { ComposerModeSwitch } from './ComposerModeSwitch';
import { I18nProvider } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useUIStore } from '@/stores/useUIStore';

// SAFETY: the switch never reads the SDK fields this helper leaves out.
const testAgent = (name: string, mode = 'primary'): Agent => ({ name, mode, permission: {} }) as Agent;

const originalFetch = globalThis.fetch;

const mountSwitch = async (sessionId: string | null) => {
  const win = new Window({ url: 'http://localhost' });
  const values = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    localStorage: win.localStorage,
    // Base UI's floating helpers test values against the global constructors.
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
  // SAFETY: these stores fire background reads on change; an empty JSON answer
  // keeps the test off the network without changing the path under test.
  globalThis.fetch = (async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as typeof fetch;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <ComposerModeSwitch sessionId={sessionId} />
      </I18nProvider>,
    );
  });
  return { container, root };
};

const modeButtons = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[data-composer-mode-switch] button'));

/** The label naming the current mode, to the left of the slider. */
const modeLabel = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-composer-mode-switch] > span')?.textContent ?? '';

/** The positions are ordered build / plan / chat, left to right. */
const clickMode = async (container: HTMLElement, index: number) => {
  const buttons = modeButtons(container);
  expect(buttons.length).toBe(3);
  await act(async () => {
    buttons[index]?.click();
  });
};

const pressedMode = (container: HTMLElement) =>
  modeButtons(container).findIndex((button) => button.getAttribute('aria-pressed') === 'true');

describe('ComposerModeSwitch', () => {
  beforeEach(() => {
    useConfigStore.setState({
      agents: [testAgent('build'), testAgent('plan'), testAgent('chat'), testAgent('工作')],
      currentAgentName: '工作',
      settingsDefaultAgent: undefined,
      currentProviderId: 'p',
      currentModelId: 'new',
      currentVariant: 'high',
      currentVariantSelection: { override: 'high', inherited: 'low' },
      settingsDefaultModel: undefined,
      settingsDefaultVariant: 'low',
      selectionSource: 'manual',
    });
    useSessionUIStore.setState({ currentSessionId: 's1' });
    useSelectionStore.setState({
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      agentModelVariantSelections: new Map(),
    });
    useUIStore.setState({ recentAgents: [] });
    useFeatureFlagsStore.setState({
      planModeEnabled: false,
      hostPlanModeEnabled: false,
      planModeSwitchOn: false,
      composerRestoreAgentBySession: {},
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('shows the current mode as a label with a three-stop slider beside it', async () => {
    const { container } = await mountSwitch('s1');

    expect(modeLabel(container)).toBe('施工');
    expect(modeButtons(container)).toHaveLength(3);
    expect(pressedMode(container)).toBe(0);
  });

  test('every stop is a real hit area, and the thumb takes its size from one', async () => {
    const { container } = await mountSwitch('s1');
    const buttons = modeButtons(container);
    const thumb = container.querySelector<HTMLElement>('[data-composer-mode-switch] span[aria-hidden]');

    // A stop with no width is the bug this guards: the thumb then overflows the
    // track and lands on top of whatever sits next to the control.
    for (const button of buttons) {
      expect(button.className).toContain('w-[14px]');
      expect(button.className).toContain('h-[18px]');
    }
    // The thumb copies the stop's geometry instead of declaring its own.
    expect(thumb?.className).toContain('w-[14px]');
    expect(thumb?.className).toContain('h-[18px]');

    // An icon with no size class is the glyph-side version of the same bug: an
    // <svg> with a viewBox but no width/height lays out at its 300×150 default,
    // which swallows the whole track. 12px fills the 14×18 stop with 1px to
    // spare on each side.
    for (const button of buttons) {
      const icon = button.querySelector('svg');
      expect(icon?.getAttribute('class')).toContain('h-3');
      expect(icon?.getAttribute('class')).toContain('w-3');
    }
  });

  test('the thumb is centred on the track axis, not pinned to the padding edge', async () => {
    const { container } = await mountSwitch('s1');
    const thumb = container.querySelector<HTMLElement>('[data-composer-mode-switch] span[aria-hidden]');

    // A stop is 18px tall inside a 22px track with 2px padding, so it overflows
    // the 16px content box and flex-centring lifts it above the padding edge. A
    // thumb pinned with `top-0.5` therefore sat 1px low, putting the covered
    // stop's icon visibly off-centre inside it.
    expect(thumb?.className).toContain('top-1/2');
    expect(thumb?.style.transform).toContain('-50%');
  });

  test('every position carries an icon, and only the covered one is lit', async () => {
    const { container } = await mountSwitch('s1');
    const buttons = modeButtons(container);

    // Without a glyph an uncovered position is blank track: the thumb marks
    // where the choice is, and nothing says what the other positions do.
    const glyphs = buttons.map((button) => button.querySelector('use')?.getAttribute('href'));
    expect(glyphs).toEqual(['#oc-hammer', '#oc-file-text', '#oc-chat-4']);

    // The covered stop's icon is drawn on the thumb, so it takes the selection
    // foreground; the uncovered ones stay muted.
    const iconClasses = buttons.map((button) => button.querySelector('svg')?.getAttribute('class') ?? '');
    expect(iconClasses[0]).toContain('text-interactive-selection-foreground');
    expect(iconClasses[1]).toContain('text-muted-foreground');
    expect(iconClasses[2]).toContain('text-muted-foreground');

    // Moving the thumb moves the lit glyph with it.
    await clickMode(container, 2);
    const afterMove = modeButtons(container).map((button) => button.querySelector('svg')?.getAttribute('class') ?? '');
    expect(afterMove[0]).toContain('text-muted-foreground');
    expect(afterMove[2]).toContain('text-interactive-selection-foreground');
  });

  test('the label follows the selected stop', async () => {
    const { container } = await mountSwitch('s1');

    await clickMode(container, 1);
    expect(modeLabel(container)).toBe('计划');

    await clickMode(container, 2);
    expect(modeLabel(container)).toBe('聊天');

    await clickMode(container, 0);
    expect(modeLabel(container)).toBe('施工');
  });

  test('the middle position selects the plan agent and opens the plan gate', async () => {
    const { container } = await mountSwitch('s1');
    await clickMode(container, 1);

    expect(useConfigStore.getState().currentAgentName).toBe('plan');
    expect(useSelectionStore.getState().sessionAgentSelections.get('s1')).toBe('plan');
    expect(useFeatureFlagsStore.getState().planModeEnabled).toBe(true);
    expect(pressedMode(container)).toBe(1);
  });

  test('the right position selects the chat agent and leaves the plan gate closed', async () => {
    const { container } = await mountSwitch('s1');
    await clickMode(container, 2);

    expect(useConfigStore.getState().currentAgentName).toBe('chat');
    expect(useSelectionStore.getState().sessionAgentSelections.get('s1')).toBe('chat');
    expect(useFeatureFlagsStore.getState().planModeEnabled).toBe(false);
    expect(pressedMode(container)).toBe(2);
  });

  test('going straight from chat back to the working position restores the agent', async () => {
    const { container } = await mountSwitch('s1');
    await clickMode(container, 2);
    expect(useConfigStore.getState().currentAgentName).toBe('chat');

    await clickMode(container, 0);

    expect(useConfigStore.getState().currentAgentName).toBe('工作');
    expect(pressedMode(container)).toBe(0);
  });

  test('neither special position moves the model or the effort', async () => {
    const { container } = await mountSwitch('s1');
    await clickMode(container, 1);
    await clickMode(container, 2);

    const state = useConfigStore.getState();
    expect([state.currentProviderId, state.currentModelId]).toEqual(['p', 'new']);
    expect(state.currentVariant).toBe('high');
    expect(state.currentVariantSelection).toEqual({ override: 'high', inherited: 'low' });
  });

  test('the two special agents are not offered in the picker list, and the switch still selects them', async () => {
    const { container } = await mountSwitch('s1');

    // Every picker, `@`-mention list and cycle shortcut reads this list.
    const offered = useConfigStore.getState().getVisibleAgents().map((agent) => agent.name);
    expect(offered).not.toContain('plan');
    expect(offered).not.toContain('chat');
    expect(offered).toContain('工作');

    await clickMode(container, 2);
    expect(useConfigStore.getState().currentAgentName).toBe('chat');
  });

  test('a position whose agent is missing is inert but still visible', async () => {
    useConfigStore.setState({ agents: [testAgent('build'), testAgent('plan'), testAgent('工作')] });
    const { container } = await mountSwitch('s1');
    const buttons = modeButtons(container);

    expect(buttons[2]?.getAttribute('aria-disabled')).toBe('true');
    await clickMode(container, 2);

    expect(useConfigStore.getState().currentAgentName).toBe('工作');
    expect(pressedMode(container)).toBe(0);
  });

  test('renders nothing in a composer that does not own the app session', async () => {
    const { container } = await mountSwitch('other-session');

    expect(modeButtons(container)).toHaveLength(0);
    expect(container.textContent).toBe('');
  });
});
