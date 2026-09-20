import { describe, expect, test } from 'bun:test';
import { migrateSessionDisplayState, useSessionDisplayStore } from './useSessionDisplayStore';

describe('useSessionDisplayStore project sorting', () => {
  test('defaults to manual ordering', () => {
    expect(useSessionDisplayStore.getState().projectSortOrder).toBe('manual');
  });

  test('migrates the v2 recent default to manual', () => {
    const migrated = migrateSessionDisplayState({ projectSortOrder: 'recent' }, 2);

    expect(migrated.projectSortOrder).toBe('manual');
  });

  for (const projectSortOrder of ['manual', 'a-z', 'z-a', 'date-added'] as const) {
    test(`preserves the v2 ${projectSortOrder} sort order`, () => {
      const migrated = migrateSessionDisplayState({ projectSortOrder }, 2);

      expect(migrated.projectSortOrder).toBe(projectSortOrder);
    });
  }

  test('v3→v4 drops the removed displayMode key and keeps the rest', () => {
    const migrated = migrateSessionDisplayState(
      { displayMode: 'default', projectSortOrder: 'a-z', showRecentSection: false, showArchivedSessions: true },
      3,
    );

    expect('displayMode' in migrated).toBe(false);
    expect(migrated.projectSortOrder).toBe('a-z');
    expect(migrated.showRecentSection).toBe(false);
    expect(migrated.showArchivedSessions).toBe(true);
  });
});

describe('useSessionDisplayStore project display', () => {
  test('defaults to showing all projects without a selected single project', () => {
    expect(useSessionDisplayStore.getState().projectDisplayMode).toBe('all');
    expect(useSessionDisplayStore.getState().singleProjectId).toBeNull();
  });

  test('stores the single-project mode independently from session grouping', () => {
    useSessionDisplayStore.getState().setProjectDisplayMode('single');
    useSessionDisplayStore.getState().setSingleProjectId('project-alpha');
    useSessionDisplayStore.getState().setSessionGroupingMode('flat');

    expect(useSessionDisplayStore.getState().projectDisplayMode).toBe('single');
    expect(useSessionDisplayStore.getState().singleProjectId).toBe('project-alpha');
    expect(useSessionDisplayStore.getState().sessionGroupingMode).toBe('flat');

    useSessionDisplayStore.setState({
      projectDisplayMode: 'all',
      singleProjectId: null,
      sessionGroupingMode: 'by-worktree',
    });
  });
});

describe('useSessionDisplayStore workspace entry', () => {
  test('starts unchosen, so the session on screen decides the first frame', () => {
    expect(useSessionDisplayStore.getState().workspaceEntry).toBeNull();
  });

  test('pressing the switch pins the entry', () => {
    useSessionDisplayStore.getState().setWorkspaceEntry('work');
    expect(useSessionDisplayStore.getState().workspaceEntry).toBe('work');

    useSessionDisplayStore.getState().setWorkspaceEntry('code');
    expect(useSessionDisplayStore.getState().workspaceEntry).toBe('code');

    useSessionDisplayStore.setState({ workspaceEntry: null });
  });

  test('a v5 blob carries no entry, and migration invents none', () => {
    const migrated = migrateSessionDisplayState({ projectSortOrder: 'a-z', showRecentSection: false }, 5);

    expect('workspaceEntry' in migrated).toBe(false);
    expect(migrated.projectSortOrder).toBe('a-z');
    expect(migrated.showRecentSection).toBe(false);
  });

  test('a stored entry survives migration untouched', () => {
    const migrated = migrateSessionDisplayState({ workspaceEntry: 'work', projectSortOrder: 'manual' }, 6);

    expect(migrated.workspaceEntry).toBe('work');
  });
});
