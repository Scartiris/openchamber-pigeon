/**
 * Mounted coverage for the workbench entry switch.
 *
 * `lib/workspaceEntry.test.ts` owns the rule; only a mounted component proves the
 * press reaches the store, that the right-hand pane follows into the new entry, and
 * that the side effects the switch owns (closing a full-page surface, opening a
 * draft when there is nothing to jump to) actually fire.
 *
 * The package has no DOM test environment, so this file builds its own happy-dom
 * window — the same arrangement `ComposerModeSwitch.test.tsx` uses. Run it on its
 * own (`bun test <path>`): the globals it installs are process-wide.
 */

import React, { act } from 'react';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { WorkspaceEntrySwitch } from './WorkspaceEntrySwitch';
import { TitlebarLeftControls } from './TitlebarLeftControls';
import { I18nProvider } from '@/lib/i18n';
import type { ProjectEntry } from '@/lib/api/types';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const WORK_ROOT = '/home/openchamber/workspaces/work';
const WORK_GONGWEN = '/home/openchamber/workspaces/work/公文';
const CODE_ROOT = '/home/openchamber/workspaces/code';
const HOME = '/home/openchamber';
// Registered nowhere: the sidebar hides such a session, so the pane must not jump to it.
const ORPHAN = '/srv/elsewhere/scratch';

const testProject = (id: string, path: string, extra: Partial<ProjectEntry> = {}): ProjectEntry => ({
  id,
  path,
  ...extra,
});

// The switch reads `id`, `time.updated` and the session-index fields the SDK's base
// Session type omits, so the fixture names exactly those and nothing else.
type IndexedSessionFields = Partial<{ directory: string; parentID: string | null; projectID: string }>;

// SAFETY: `IndexedSessionFields` is the set of extra keys the real index carries on
// top of Session and the tests below pass only members of it, so the spread result
// is a Session for every purpose the component has.
const testSession = (
  id: string,
  directory: string,
  updated: number,
  extra: IndexedSessionFields = {},
): Session => ({
  id,
  slug: id,
  projectID: id,
  title: id,
  version: '1',
  time: { created: 1, updated },
  directory,
  ...extra,
}) as Session;

const projects = (): ProjectEntry[] => [
  testProject('home', HOME),
  testProject('code', CODE_ROOT, { lastOpenedAt: 10 }),
  testProject('work', WORK_ROOT, { lastOpenedAt: 20 }),
  testProject('work-gongwen', WORK_GONGWEN, { lastOpenedAt: 40 }),
];

const sessions = (): Session[] => [
  testSession('s-work', WORK_GONGWEN, 300),
  testSession('s-work-child', WORK_GONGWEN, 900, { parentID: 's-work' }),
  testSession('s-code', CODE_ROOT, 500),
  testSession('s-orphan', ORPHAN, 1_000),
];

const originalFetch = globalThis.fetch;

const mountTree = async (node: React.ReactElement) => {
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
  // React DOM decides how to wire input events while the module is first evaluated,
  // so it is imported only after this window owns the globals. A top-level import
  // would make that decision for every other test file sharing this process, and the
  // archive page's search test is one of them.
  const { createRoot } = await import('react-dom/client');
  // SAFETY: these stores fire background reads on change; an empty JSON answer
  // keeps the test off the network without changing the path under test.
  globalThis.fetch = (async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as typeof fetch;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<I18nProvider>{node}</I18nProvider>);
  });
  return { container, root };
};

const mountSwitch = () => mountTree(<WorkspaceEntrySwitch />);
const mountTitlebar = () => mountTree(<TitlebarLeftControls />);

const surface = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-workspace-entry]');

const entryButtons = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[data-workspace-entry] button'));

const clickEntry = async (container: HTMLElement, index: number) => {
  const buttons = entryButtons(container);
  expect(buttons.length).toBe(2);
  await act(async () => {
    buttons[index]?.click();
  });
};

const pressedIndex = (container: HTMLElement) =>
  entryButtons(container).findIndex((button) => button.getAttribute('aria-pressed') === 'true');

const buttonWithIcon = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.querySelector('use')?.getAttribute('href') === `#oc-${name}`);

describe('WorkspaceEntrySwitch', () => {
  beforeEach(() => {
    useProjectsStore.setState({ projects: projects(), activeProjectId: 'code' });
    useGlobalSessionsStore.setState({ activeSessions: sessions() });
    useSessionDisplayStore.setState({ workspaceEntry: null });
    useUIStore.setState({ isArchivePageOpen: false });
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
    useSessionUIStore.getState().closeNewSessionDraft();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    // These stores are process-wide singletons and `bun test` runs several files in one
    // process, so a work directory left on screen here silently decides what another
    // file's `useWorkspaceEntry()` derives — the next file then fails for a reason it
    // cannot see. Clearing is part of the teardown, not a courtesy.
    useSessionDisplayStore.setState({ workspaceEntry: null });
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
    useSessionUIStore.getState().closeNewSessionDraft();
  });

  test('offers both entries, code pressed, because that is where everything already was', async () => {
    const { container } = await mountSwitch();
    const buttons = entryButtons(container);

    expect(buttons.map((button) => button.querySelector('use')?.getAttribute('href')))
      .toEqual(['#oc-code', '#oc-briefcase']);
    expect(pressedIndex(container)).toBe(0);
    expect(surface(container)?.getAttribute('data-workspace-entry')).toBe('code');
  });

  test('each stop says what choosing it does', async () => {
    const { container } = await mountSwitch();
    const titles = entryButtons(container).map((button) => button.getAttribute('title') ?? '');

    // The stop's `title` is the only place an uncovered entry is explained, so it has
    // to carry the name and what the entry means for the list.
    expect(titles[0]).toBe('代码 — 侧栏只列出这一区的会话。');
    expect(titles[1]).toContain('工作');
  });

  test('pressing work pins the entry and jumps the pane to that entry\'s newest session', async () => {
    const { container } = await mountSwitch();
    await clickEntry(container, 1);

    expect(useSessionDisplayStore.getState().workspaceEntry).toBe('work');
    expect(surface(container)?.getAttribute('data-workspace-entry')).toBe('work');
    expect(pressedIndex(container)).toBe(1);
    // Newest *root* session: `s-work-child` is newer still but is a sub-session, and
    // `s-orphan` is newer than both but no registered project claims it, so the
    // sidebar would not list either.
    expect(useSessionUIStore.getState().currentSessionId).toBe('s-work');
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(WORK_GONGWEN);
  });

  test('pressing code moves the pane back to a code session', async () => {
    const { container } = await mountSwitch();
    await clickEntry(container, 1);
    await clickEntry(container, 0);

    expect(useSessionDisplayStore.getState().workspaceEntry).toBe('code');
    expect(useSessionUIStore.getState().currentSessionId).toBe('s-code');
  });

  test('an entry with no session opens a draft in its most recently used project', async () => {
    useGlobalSessionsStore.setState({ activeSessions: [testSession('s-code', CODE_ROOT, 500)] });
    const { container } = await mountSwitch();
    await clickEntry(container, 1);

    const draft = useSessionUIStore.getState().newSessionDraft;
    expect(draft.open).toBe(true);
    expect([draft.selectedProjectId, draft.directoryOverride])
      .toEqual(['work-gongwen', WORK_GONGWEN]);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  });

  test('a session no registered project owns is never the jump target', async () => {
    useGlobalSessionsStore.setState({ activeSessions: [testSession('s-orphan', ORPHAN, 1_000)] });
    const { container } = await mountSwitch();
    await clickEntry(container, 1);

    // It is the newest session in the whole store, and an entry would claim it if the
    // rule read the session's own path instead of the project that owns it. The work
    // entry has nothing left, so the press has to fall through to a draft.
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    const draft = useSessionUIStore.getState().newSessionDraft;
    expect([draft.open, draft.selectedProjectId]).toEqual([true, 'work-gongwen']);
  });

  test('pressing the entry already shown changes nothing', async () => {
    const { container } = await mountSwitch();
    await clickEntry(container, 0);

    // The position is derived from the session on screen until the user chooses, so
    // pressing the stop that merely repeats it must not pin the choice or navigate.
    expect(useSessionDisplayStore.getState().workspaceEntry).toBeNull();
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
  });

  test('switching closes a full-page surface left open over the old list', async () => {
    useUIStore.setState({ isArchivePageOpen: true });
    const { container } = await mountSwitch();
    await clickEntry(container, 1);

    expect(useUIStore.getState().isArchivePageOpen).toBe(false);
  });

  test('every stop is a real hit area and the thumb copies its geometry', async () => {
    const { container } = await mountSwitch();
    const buttons = entryButtons(container);
    const thumb = container.querySelector<HTMLElement>('[data-workspace-entry] span[aria-hidden]');

    // A stop with no width is the bug this guards: the thumb overflows the track and
    // sits on the neighbouring control, and the button has no hit area at all.
    for (const button of buttons) {
      expect(button.className).toContain('h-6');
      expect(button.className).toContain('w-6');
      expect(button.querySelector('svg')?.getAttribute('class')).toContain('h-[18px]');
    }
    expect(thumb?.className).toContain('h-6');
    expect(thumb?.className).toContain('w-6');
  });

  describe('mounted into the titlebar', () => {
    test('shares the measured cluster with the sidebar toggle', async () => {
      const { container } = await mountTitlebar();
      const host = surface(container);
      const sidebarToggle = buttonWithIcon(container, 'layout-left');

      expect(host).not.toBeNull();
      expect(sidebarToggle).not.toBeUndefined();
      // The overlay publishes its own width so the header can reserve the same space
      // when the sidebar is collapsed. A switch mounted outside that cluster widens
      // nothing that is measured, and the title slides under it for a frame on load —
      // so the sibling relation is the assertion, not the switch merely existing.
      expect(host?.parentElement).toBe(sidebarToggle?.parentElement);
    });

    test('mounting the titlebar publishes the width the header reserves', async () => {
      await mountTitlebar();

      expect(document.documentElement.getAttribute('style') ?? '')
        .toContain('--oc-titlebar-controls-width');
    });
  });
});
