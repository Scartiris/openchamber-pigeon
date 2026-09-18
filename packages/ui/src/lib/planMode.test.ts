import { describe, expect, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';

import {
  DRAFT_SESSION_KEY,
  PLAN_AGENT_NAME,
  getSelectablePrimaryAgents,
  isPlanAgentAvailable,
  isPlanAgentName,
  resolvePlanRestoreAgent,
  resolvePlanToggleDecision,
} from './planMode';

// Same shape the config store tests build agents with: the rules under test
// only read `name`, `mode` and the two hidden flags.
type TestAgent = {
  name: string;
  mode?: string;
  hidden?: boolean;
  options?: { hidden?: boolean };
};

// SAFETY: the SDK's Agent carries fields these rules never read; the helper
// supplies every field they do read, so the assertion only narrows the surplus.
const testAgent = ({ name, mode = 'primary', hidden, options }: TestAgent): Agent => ({
  name,
  mode,
  hidden,
  options,
  permission: {},
}) as Agent;

const planAgent = testAgent({ name: 'plan' });
const buildAgent = testAgent({ name: 'build' });
const workAgent = testAgent({ name: '工作' });

describe('isPlanAgentName', () => {
  test('matches only the plan agent name', () => {
    expect(isPlanAgentName(PLAN_AGENT_NAME)).toBe(true);
    expect(isPlanAgentName('build')).toBe(false);
    expect(isPlanAgentName(null)).toBe(false);
    expect(isPlanAgentName(undefined)).toBe(false);
    expect(isPlanAgentName('')).toBe(false);
  });
});

describe('getSelectablePrimaryAgents', () => {
  test('keeps visible primary agents and drops hidden and subagent ones', () => {
    const agents = [
      buildAgent,
      planAgent,
      testAgent({ name: 'review', mode: 'subagent' }),
      testAgent({ name: 'title', hidden: true }),
      testAgent({ name: 'compaction', options: { hidden: true } }),
    ];

    expect(getSelectablePrimaryAgents(agents).map((agent) => agent.name)).toEqual(['build', 'plan']);
  });
});

describe('isPlanAgentAvailable', () => {
  test('is true only when a selectable plan agent is offered', () => {
    expect(isPlanAgentAvailable([buildAgent, planAgent])).toBe(true);
    expect(isPlanAgentAvailable([buildAgent])).toBe(false);
    expect(isPlanAgentAvailable([])).toBe(false);
  });

  test('a hidden plan agent does not count', () => {
    expect(isPlanAgentAvailable([testAgent({ name: 'plan', hidden: true })])).toBe(false);
  });

  test('a plan subagent does not count', () => {
    expect(isPlanAgentAvailable([testAgent({ name: 'plan', mode: 'subagent' })])).toBe(false);
  });
});

describe('resolvePlanRestoreAgent', () => {
  test('returns what this session used before plan mode', () => {
    expect(resolvePlanRestoreAgent({
      agents: [buildAgent, planAgent, workAgent],
      rememberedAgent: '工作',
    })).toBe('工作');
  });

  test('falls through a stale, hidden or unknown remembered agent', () => {
    const agents = [buildAgent, planAgent, workAgent, testAgent({ name: 'archived', hidden: true })];

    expect(resolvePlanRestoreAgent({ agents, rememberedAgent: PLAN_AGENT_NAME })).toBe('build');
    expect(resolvePlanRestoreAgent({ agents, rememberedAgent: 'archived' })).toBe('build');
    expect(resolvePlanRestoreAgent({ agents, rememberedAgent: 'gone' })).toBe('build');
    expect(resolvePlanRestoreAgent({ agents, rememberedAgent: '' })).toBe('build');
  });

  test('prefers recently used agents over the configured default', () => {
    expect(resolvePlanRestoreAgent({
      agents: [buildAgent, planAgent, workAgent],
      recentAgents: [PLAN_AGENT_NAME, '工作'],
      settingsDefaultAgent: 'build',
    })).toBe('工作');
  });

  test('uses the configured default when nothing else is remembered', () => {
    expect(resolvePlanRestoreAgent({
      agents: [buildAgent, planAgent, workAgent],
      settingsDefaultAgent: '工作',
    })).toBe('工作');
  });

  test('falls back to build, then to any other selectable primary agent', () => {
    expect(resolvePlanRestoreAgent({ agents: [planAgent, workAgent] })).toBe('工作');
    expect(resolvePlanRestoreAgent({ agents: [buildAgent, planAgent] })).toBe('build');
  });

  test('returns null when the plan agent is the only selectable one', () => {
    expect(resolvePlanRestoreAgent({ agents: [planAgent, testAgent({ name: 'title', hidden: true })] })).toBeNull();
    expect(resolvePlanRestoreAgent({ agents: [] })).toBeNull();
  });
});

describe('resolvePlanToggleDecision', () => {
  const agents = [buildAgent, planAgent, workAgent];

  test('turning the switch on selects the plan agent', () => {
    expect(resolvePlanToggleDecision({ enabled: false, agents })).toEqual({
      kind: 'enable',
      agent: PLAN_AGENT_NAME,
    });
  });

  test('turning the switch off restores the remembered agent', () => {
    expect(resolvePlanToggleDecision({ enabled: true, agents, rememberedAgent: '工作' })).toEqual({
      kind: 'disable',
      agent: '工作',
    });
  });

  test('is unavailable when the runtime offers no plan agent', () => {
    expect(resolvePlanToggleDecision({ enabled: false, agents: [buildAgent] })).toEqual({ kind: 'unavailable' });
  });

  test('is unavailable when turning it off would strand the session on plan', () => {
    expect(resolvePlanToggleDecision({ enabled: true, agents: [planAgent] })).toEqual({ kind: 'unavailable' });
  });
});

describe('DRAFT_SESSION_KEY', () => {
  test('names the new-session draft bucket', () => {
    expect(DRAFT_SESSION_KEY).toBe('__draft__');
  });
});
