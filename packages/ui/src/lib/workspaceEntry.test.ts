import { describe, expect, test } from 'bun:test';

import {
  ENTRY_ICONS,
  ENTRY_LABEL_KEY,
  ENTRY_ORDER,
  entryShowsManagedChats,
  resolveEntryDraftTarget,
  resolveWorkspaceEntry,
  selectProjectsForEntry,
} from './workspaceEntry';

type TestProject = {
  id: string;
  path: string;
  addedAt?: number;
  lastOpenedAt?: number;
};

// The registered projects as the server actually has them (settings.json, 2026-09-20).
const testProject = (id: string, path: string, extra: Partial<TestProject> = {}): TestProject => ({
  id,
  path,
  ...extra,
});

describe('resolveWorkspaceEntry', () => {
  test('the work partition root and everything nested under it is work', () => {
    expect(resolveWorkspaceEntry('/home/openchamber/workspaces/work')).toBe('work');
    expect(resolveWorkspaceEntry('/home/openchamber/workspaces/work/公文')).toBe('work');
    expect(resolveWorkspaceEntry('/home/openchamber/workspaces/work/示例')).toBe('work');
    // 专项 below a 专项, and a worktree checkout, are still the same partition.
    expect(resolveWorkspaceEntry('/home/openchamber/workspaces/work/公文/模板/2026')).toBe('work');
  });

  test('the host bind-mount path and a Windows checkout match the same rule', () => {
    expect(resolveWorkspaceEntry('/opt/openchamber-pigeon/workspaces/work/公文')).toBe('work');
    expect(resolveWorkspaceEntry('T:\\dev\\workspaces\\work')).toBe('work');
  });

  test('a trailing slash on the partition root still reads as work', () => {
    expect(resolveWorkspaceEntry('/home/openchamber/workspaces/work/')).toBe('work');
  });

  test('the code partition and everything else is code', () => {
    expect(resolveWorkspaceEntry('/home/openchamber/workspaces/code')).toBe('code');
    expect(resolveWorkspaceEntry('/home/openchamber/workspaces/code/示例')).toBe('code');
    // The unlabelled home project the deployment carries.
    expect(resolveWorkspaceEntry('/home/openchamber')).toBe('code');
    // Managed chats live under the config dir, not the workspaces tree.
    expect(resolveWorkspaceEntry('/home/openchamber/.config/openchamber/chats/2026-09-20')).toBe('code');
  });

  test('the rule reads segments, not a prefix', () => {
    // A directory merely *named* like the partition, or sharing its prefix, is not it.
    expect(resolveWorkspaceEntry('/home/openchamber/workspaces')).toBe('code');
    expect(resolveWorkspaceEntry('/home/openchamber/workspaces-worker')).toBe('code');
    expect(resolveWorkspaceEntry('/srv/warehouse/work')).toBe('code');
    expect(resolveWorkspaceEntry('/home/openchamber/backups/work')).toBe('code');
  });

  test('segment matching is case-sensitive, so a differently-named directory is not captured', () => {
    expect(resolveWorkspaceEntry('/home/openchamber/workspaces/Work')).toBe('code');
    expect(resolveWorkspaceEntry('/home/openchamber/Workspaces/work')).toBe('code');
  });

  test('nothing usable is code, never a crash', () => {
    expect(resolveWorkspaceEntry(null)).toBe('code');
    expect(resolveWorkspaceEntry(undefined)).toBe('code');
    expect(resolveWorkspaceEntry('')).toBe('code');
    expect(resolveWorkspaceEntry('   ')).toBe('code');
  });
});

describe('selectProjectsForEntry', () => {
  const projects = [
    testProject('work', '/home/openchamber/workspaces/work'),
    testProject('work-gongwen', '/home/openchamber/workspaces/work/公文'),
    testProject('code', '/home/openchamber/workspaces/code'),
    testProject('home', '/home/openchamber'),
    testProject('work-demo', '/home/openchamber/workspaces/work/示例'),
  ];

  test('partitions the registered projects, keeping the caller\'s order', () => {
    expect(selectProjectsForEntry(projects, 'work').map((project) => project.id))
      .toEqual(['work', 'work-gongwen', 'work-demo']);
    expect(selectProjectsForEntry(projects, 'code').map((project) => project.id))
      .toEqual(['code', 'home']);
  });

  test('an entry with no project yields an empty list rather than a guess', () => {
    expect(selectProjectsForEntry([testProject('code', '/home/openchamber/workspaces/code')], 'work')).toEqual([]);
    expect(selectProjectsForEntry([], 'code')).toEqual([]);
  });
});

describe('resolveEntryDraftTarget', () => {
  test('prefers the most recently opened project in the entry', () => {
    const projects = [
      testProject('work', '/home/openchamber/workspaces/work', { lastOpenedAt: 100, addedAt: 1 }),
      testProject('work-gongwen', '/home/openchamber/workspaces/work/公文', { lastOpenedAt: 300, addedAt: 2 }),
      testProject('code', '/home/openchamber/workspaces/code', { lastOpenedAt: 900, addedAt: 3 }),
    ];
    expect(resolveEntryDraftTarget(projects, 'work'))
      .toEqual({ selectedProjectId: 'work-gongwen', directoryOverride: '/home/openchamber/workspaces/work/公文' });
  });

  test('falls back to the added time when nothing records an open', () => {
    const projects = [
      testProject('work', '/home/openchamber/workspaces/work', { addedAt: 1 }),
      testProject('work-demo', '/home/openchamber/workspaces/work/示例', { addedAt: 5 }),
    ];
    expect(resolveEntryDraftTarget(projects, 'work')?.selectedProjectId).toBe('work-demo');
  });

  test('breaks a tie on the sidebar order, which is the order the user arranged', () => {
    const projects = [
      testProject('work', '/home/openchamber/workspaces/work'),
      testProject('work-demo', '/home/openchamber/workspaces/work/示例'),
    ];
    expect(resolveEntryDraftTarget(projects, 'work')?.selectedProjectId).toBe('work');
  });

  test('an empty entry has no target, so the caller keeps its own behaviour', () => {
    const projects = [testProject('code', '/home/openchamber/workspaces/code')];
    expect(resolveEntryDraftTarget(projects, 'work')).toBeNull();
    expect(resolveEntryDraftTarget([], 'code')).toBeNull();
  });
});

describe('entryShowsManagedChats', () => {
  test('only the code entry, and every entry gets an answer', () => {
    expect(ENTRY_ORDER.map((entry) => [entry, entryShowsManagedChats(entry)] as const))
      .toEqual([['code', true], ['work', false]]);
  });

  test('says what the path rule says about the directory chats live in', () => {
    // Not a second opinion: chats are created under `<home>/.config/openchamber/chats`,
    // and this predicate is only honest while the rule keeps classifying that as code.
    // A new partition shape that captured it would turn this red instead of quietly
    // hiding the chats block from the entry the user is in.
    //
    // The bare root is pinned too, but the path the app actually classifies is a
    // per-chat descendant — this is the directory `createChatDirectory` builds, taken
    // verbatim from the deployed store (`…/chats/2026-09-15/session-9fbcdbd9-…`).
    const chatsRoot = '/home/openchamber/.config/openchamber/chats';
    const oneChat = `${chatsRoot}/2026-09-15/session-9fbcdbd9-c445-42da-8b39-45e02d9a1c00`;
    for (const directory of [chatsRoot, oneChat]) {
      const entry = resolveWorkspaceEntry(directory);
      expect(entry).toBe('code');
      expect(entryShowsManagedChats(entry)).toBe(true);
    }
  });
});

describe('ENTRY_ORDER', () => {
  test('code reads first, because it is where everything already was', () => {
    expect(ENTRY_ORDER).toEqual(['code', 'work']);
  });

  test('every entry has a glyph and the label keys the dictionaries ship', () => {
    // Pinned exactly rather than "truthy": these two maps are what the switch renders,
    // and a label key that drifted from the dictionaries is a missing translation.
    expect(ENTRY_ICONS).toEqual({ code: 'code', work: 'briefcase' });
    expect(ENTRY_LABEL_KEY).toEqual({
      code: 'header.workspaceEntry.code',
      work: 'header.workspaceEntry.work',
    });
  });
});
