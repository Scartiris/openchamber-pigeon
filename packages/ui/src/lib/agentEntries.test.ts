import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_AGENT_ENTRY_MEMBERSHIP,
  agentAppearsInEntry,
  filterAgentsForEntry,
  readAgentEntryMembership,
  replaceAgentEntryMembership,
} from './agentEntries';

describe('agentAppearsInEntry', () => {
  test('defaults hide 工作 from code and hide build from work', () => {
    expect(agentAppearsInEntry('工作', 'work')).toBe(true);
    expect(agentAppearsInEntry('工作', 'code')).toBe(false);
    expect(agentAppearsInEntry('build', 'code')).toBe(true);
    expect(agentAppearsInEntry('build', 'work')).toBe(false);
  });

  test('agents with no membership appear everywhere', () => {
    expect(agentAppearsInEntry('custom-reviewer', 'code')).toBe(true);
    expect(agentAppearsInEntry('custom-reviewer', 'work')).toBe(true);
  });

  test('replaceAgentEntryMembership merges over deployment defaults', () => {
    replaceAgentEntryMembership({ '工作': ['code', 'work'], reviewer: ['work'] });
    expect(agentAppearsInEntry('工作', 'code')).toBe(true);
    expect(agentAppearsInEntry('build', 'code')).toBe(true);
    expect(agentAppearsInEntry('build', 'work')).toBe(false);
    expect(agentAppearsInEntry('reviewer', 'code')).toBe(false);
    expect(agentAppearsInEntry('reviewer', 'work')).toBe(true);
    replaceAgentEntryMembership({});
    expect(agentAppearsInEntry('工作', 'code')).toBe(false);
    expect(agentAppearsInEntry('build', 'work')).toBe(false);
    expect(readAgentEntryMembership()['工作']).toEqual(DEFAULT_AGENT_ENTRY_MEMBERSHIP['工作']);
    expect(readAgentEntryMembership()['build']).toEqual(DEFAULT_AGENT_ENTRY_MEMBERSHIP['build']);
  });
});

describe('filterAgentsForEntry', () => {
  const agents = [{ name: 'build' }, { name: '工作' }, { name: 'reviewer' }];

  test('filters the list for a pinned entry', () => {
    replaceAgentEntryMembership({ reviewer: ['work'] });
    expect(filterAgentsForEntry(agents, 'code').map((a) => a.name)).toEqual(['build']);
    expect(filterAgentsForEntry(agents, 'work').map((a) => a.name)).toEqual(['工作', 'reviewer']);
    replaceAgentEntryMembership({});
  });

  test('null entry keeps every agent (first paint / never chosen)', () => {
    expect(filterAgentsForEntry(agents, null)).toHaveLength(3);
  });
});
