/**
 * Mounted coverage for the plan-mode switch's wiring: the pure rules live in
 * `lib/planMode.test.ts`, but only a mounted component proves a click reaches
 * `setAgent`, that the session's choice is persisted with it, and that the
 * shared plan-mode gate follows.
 *
 * The package has no DOM test environment, so this file builds its own
 * happy-dom window — the same arrangement `MobilePillComposer.test.tsx` uses.
 * Run it on its own (`bun test <path>`): the globals it installs are
 * process-wide.
 */

import React, { act } from 'react';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import type { Agent } from '@opencode-ai/sdk/v2';

import { PlanModeSwitchButton } from './PlanModeSwitchButton';
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
        <PlanModeSwitchButton sessionId={sessionId} withTooltip />
      </I18nProvider>,
    );
  });
  return { container, root };
};

const switchElement = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="switch"]');

const clickSwitch = async (container: HTMLElement) => {
  const element = switchElement(container);
  expect(element).not.toBeNull();
  await act(async () => {
    element?.click();
  });
};

describe('PlanModeSwitchButton', () => {
  beforeEach(() => {
    useConfigStore.setState({
      agents: [testAgent('build'), testAgent('plan'), testAgent('工作')],
      currentAgentName: '工作',
      settingsDefaultAgent: undefined,
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      currentVariantSelection: { override: undefined, inherited: undefined },
      settingsDefaultModel: undefined,
      settingsDefaultVariant: undefined,
      selectionSource: 'auto',
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
      planRestoreAgentBySession: {},
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('renders off and available', async () => {
    const { container } = await mountSwitch('s1');
    const element = switchElement(container);

    expect(element).not.toBeNull();
    expect(element?.getAttribute('aria-checked')).toBe('false');
    expect(element?.getAttribute('aria-disabled')).toBeNull();
  });

  test('its visible label toggles the switch', async () => {
    const { container } = await mountSwitch('s1');
    const label = container.querySelector('label');
    expect(label).not.toBeNull();

    await act(async () => {
      label?.click();
    });

    expect(useConfigStore.getState().currentAgentName).toBe('plan');
  });

  test('turning it on selects the plan agent, persists it and opens the plan gate', async () => {
    const { container } = await mountSwitch('s1');
    await clickSwitch(container);

    expect(useConfigStore.getState().currentAgentName).toBe('plan');
    expect(useSelectionStore.getState().sessionAgentSelections.get('s1')).toBe('plan');
    expect(useFeatureFlagsStore.getState().planModeEnabled).toBe(true);
    expect(switchElement(container)?.getAttribute('aria-checked')).toBe('true');
  });

  /**
   * A session that already has a model recorded for the plan agent. That record
   * is what used to move the model: the per-agent restore read it back and
   * applied it over the model actually in use.
   */
  const useSessionWherePlanAlreadyHasAModel = () => {
    useConfigStore.setState({
      agents: [testAgent('工作'), testAgent('plan')],
      currentAgentName: '工作',
      currentProviderId: 'p',
      currentModelId: 'new',
      currentVariant: 'high',
      currentVariantSelection: { override: 'high', inherited: 'low' },
      settingsDefaultModel: undefined,
      settingsDefaultVariant: 'low',
      selectionSource: 'manual',
    });
    useSelectionStore.setState({
      sessionAgentModelSelections: new Map([['s1', new Map([['plan', { providerId: 'p', modelId: 'other' }]])]]),
    });
  };

  test('turning it on keeps the model and the effort in use', async () => {
    useSessionWherePlanAlreadyHasAModel();
    const { container } = await mountSwitch('s1');
    await clickSwitch(container);

    const state = useConfigStore.getState();
    expect(state.currentAgentName).toBe('plan');
    expect([state.currentProviderId, state.currentModelId]).toEqual(['p', 'new']);
    expect(state.currentVariant).toBe('high');
    expect(state.currentVariantSelection).toEqual({ override: 'high', inherited: 'low' });

    // Recorded for the plan agent too: the per-agent restore and the effort
    // reconciler read this back, and a stale record moves the model again.
    const selection = useSelectionStore.getState();
    expect(selection.getAgentModelForSession('s1', 'plan')).toEqual({ providerId: 'p', modelId: 'new' });
    expect(selection.getAgentModelVariantForSession('s1', 'plan', 'p', 'new')).toBe('high');
  });

  test('turning it off keeps the model and the effort too', async () => {
    useSessionWherePlanAlreadyHasAModel();
    const { container, root } = await mountSwitch('s1');
    await clickSwitch(container);
    expect(useConfigStore.getState().currentAgentName).toBe('plan');

    await act(async () => {
      root.render(
        <I18nProvider>
          <PlanModeSwitchButton sessionId="s1" withTooltip />
        </I18nProvider>,
      );
    });
    await clickSwitch(container);

    const state = useConfigStore.getState();
    expect(state.currentAgentName).toBe('工作');
    expect([state.currentProviderId, state.currentModelId]).toEqual(['p', 'new']);
    expect(state.currentVariant).toBe('high');
    expect(useSelectionStore.getState().getAgentModelForSession('s1', '工作')).toEqual({ providerId: 'p', modelId: 'new' });
  });

  test('turning it off returns to the agent this session used before', async () => {
    const { container, root } = await mountSwitch('s1');
    await clickSwitch(container);
    expect(useConfigStore.getState().currentAgentName).toBe('plan');

    await act(async () => {
      root.render(
        <I18nProvider>
          <PlanModeSwitchButton sessionId="s1" withTooltip />
        </I18nProvider>,
      );
    });
    await clickSwitch(container);

    expect(useConfigStore.getState().currentAgentName).toBe('工作');
    expect(useSelectionStore.getState().sessionAgentSelections.get('s1')).toBe('工作');
    expect(useFeatureFlagsStore.getState().planModeEnabled).toBe(false);
  });

  test('picking the plan agent elsewhere shows as on', async () => {
    const { container } = await mountSwitch('s1');

    await act(async () => {
      useSelectionStore.getState().saveSessionAgentSelection('s1', 'plan');
    });

    expect(switchElement(container)?.getAttribute('aria-checked')).toBe('true');
    expect(useFeatureFlagsStore.getState().planModeEnabled).toBe(true);
  });

  test('is disabled when the runtime offers no plan agent', async () => {
    useConfigStore.setState({ agents: [testAgent('build'), testAgent('工作')] });
    const { container } = await mountSwitch('s1');

    expect(switchElement(container)?.getAttribute('aria-disabled')).toBe('true');
  });

  test('renders nothing in a composer that does not own the app session', async () => {
    const { container } = await mountSwitch('other-session');

    expect(switchElement(container)).toBeNull();
    expect(container.textContent).toBe('');
  });
});
