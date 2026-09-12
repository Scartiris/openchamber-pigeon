import { beforeEach, describe, expect, test } from 'bun:test';

import { CONTEXT_SURFACES, getVisibleContextRailSurfaces } from '../lib/surfaces/registry';
import { useUIStore } from './useUIStore';

const DIRECTORY = '/repo';
const getTabs = () => useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.tabs ?? [];
const getDocTabs = () => getTabs().filter((tab) => tab.mode === 'doc');
const getActiveTabId = () => useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.activeTabId ?? null;

beforeEach(() => {
  useUIStore.setState({ contextPanelByDirectory: {}, contextRailOrder: [] });
});

describe('document preview tabs', () => {
  test('opens a document preview tab for a file path', () => {
    useUIStore.getState().openContextDocument(DIRECTORY, '/repo/report.docx');

    const tabs = getDocTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].targetPath).toBe('/repo/report.docx');
    expect(getActiveTabId()).toBe(tabs[0].id);
    expect(useUIStore.getState().contextPanelByDirectory[DIRECTORY].isOpen).toBe(true);
  });

  test('focuses the existing tab instead of duplicating the same document', () => {
    useUIStore.getState().openContextDocument(DIRECTORY, '/repo/report.docx');
    useUIStore.getState().openContextDocument(DIRECTORY, '/repo/budget.xlsx');
    useUIStore.getState().openContextDocument(DIRECTORY, '/repo/report.docx');

    const tabs = getDocTabs();
    expect(tabs).toHaveLength(2);
    expect(getActiveTabId()).toBe(tabs.find((tab) => tab.targetPath === '/repo/report.docx')?.id ?? '');
  });

  test('keeps several documents open side by side (multi-instance mode)', () => {
    useUIStore.getState().openContextDocument(DIRECTORY, '/repo/a.docx');
    useUIStore.getState().openContextDocument(DIRECTORY, '/repo/b.pptx');
    useUIStore.getState().openContextDocument(DIRECTORY, '/repo/c.pdf');

    expect(getDocTabs().map((tab) => tab.targetPath)).toEqual([
      '/repo/a.docx',
      '/repo/b.pptx',
      '/repo/c.pdf',
    ]);
  });

  test('ignores empty arguments', () => {
    useUIStore.getState().openContextDocument('', '/repo/a.docx');
    useUIStore.getState().openContextDocument(DIRECTORY, '');

    expect(getTabs()).toHaveLength(0);
  });

  test('a document tab is independent from a file editor tab for the same path', () => {
    useUIStore.getState().openContextFile(DIRECTORY, '/repo/report.docx');
    useUIStore.getState().openContextDocument(DIRECTORY, '/repo/report.docx');

    expect(getTabs().filter((tab) => tab.mode === 'file')).toHaveLength(1);
    expect(getDocTabs()).toHaveLength(1);
  });

  test('closing the tab removes it', () => {
    useUIStore.getState().openContextDocument(DIRECTORY, '/repo/a.docx');
    const tabId = getDocTabs()[0].id;

    useUIStore.getState().closeContextPanelTab(DIRECTORY, tabId);

    expect(getDocTabs()).toHaveLength(0);
  });
});

describe('document preview rail surface', () => {
  const railSurfaces = (hasDocTab: boolean) => getVisibleContextRailSurfaces({
    railOrder: [],
    planModeEnabled: false,
    isVSCode: false,
    screenWidth: 1440,
    tabs: hasDocTab ? [{ mode: 'doc' as const }] : [],
    linearConnected: false,
    githubConnected: false,
  });

  test('is registered once, with content-driven availability', () => {
    const surfaces = CONTEXT_SURFACES.filter((surface) => surface.mode === 'doc');
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0].availability).toBe('has-content');
    expect(surfaces[0].labelKey).toBe('contextPanel.mode.doc');
  });

  test('stays off the rail until a document tab exists', () => {
    expect(railSurfaces(false).some((surface) => surface.mode === 'doc')).toBe(false);
    expect(railSurfaces(true).some((surface) => surface.mode === 'doc')).toBe(true);
  });
});
