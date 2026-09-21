import { describe, expect, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';

import {
  CHAT_AGENT_NAME,
  DRAFT_SESSION_KEY,
  PLAN_AGENT_NAME,
  filterAgentChoices,
  getSelectablePrimaryAgents,
  isAgentChoice,
  isModeAgentName,
  isModeAvailable,
  resolveBuildModeAgent,
  resolveComposerMode,
  resolveModeSelection,
  resolveProjectDefaultAgent,
} from './composerModes';

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
const chatAgent = testAgent({ name: 'chat' });
const buildAgent = testAgent({ name: 'build' });
const workAgent = testAgent({ name: '工作' });

describe('isModeAgentName / isAgentChoice', () => {
  test('the two special agents are modes, not choices', () => {
    expect(isModeAgentName(PLAN_AGENT_NAME)).toBe(true);
    expect(isModeAgentName(CHAT_AGENT_NAME)).toBe(true);
    expect(isAgentChoice(PLAN_AGENT_NAME)).toBe(false);
    expect(isAgentChoice(CHAT_AGENT_NAME)).toBe(false);
  });

  test('ordinary agents stay choosable', () => {
    expect(isModeAgentName('build')).toBe(false);
    expect(isAgentChoice('build')).toBe(true);
    expect(isAgentChoice('工作')).toBe(true);
    expect(isModeAgentName(null)).toBe(false);
    expect(isModeAgentName(undefined)).toBe(false);
    expect(isModeAgentName('')).toBe(false);
  });
});

describe('resolveProjectDefaultAgent', () => {
  test('an ordinary agent named by a project is honoured', () => {
    expect(resolveProjectDefaultAgent('工作')).toBe('工作');
    expect(resolveProjectDefaultAgent('build')).toBe('build');
  });

  test('neither agent the mode switch owns can be a project default', () => {
    expect(resolveProjectDefaultAgent(PLAN_AGENT_NAME)).toBeUndefined();
    expect(resolveProjectDefaultAgent(CHAT_AGENT_NAME)).toBeUndefined();
  });

  test('an unset default stays unset', () => {
    expect(resolveProjectDefaultAgent(undefined)).toBeUndefined();
    expect(resolveProjectDefaultAgent(null)).toBeUndefined();
    expect(resolveProjectDefaultAgent('')).toBeUndefined();
  });
});

describe('getSelectablePrimaryAgents', () => {
  test('keeps visible primary agents and drops hidden and subagent ones', () => {
    const agents = [
      buildAgent,
      planAgent,
      chatAgent,
      testAgent({ name: 'review', mode: 'subagent' }),
      testAgent({ name: 'title', hidden: true }),
      testAgent({ name: 'compaction', options: { hidden: true } }),
    ];

    expect(getSelectablePrimaryAgents(agents).map((agent) => agent.name))
      .toEqual(['build', 'plan', 'chat']);
  });
});

describe('filterAgentChoices', () => {
  const agents = [
    testAgent({ name: 'build' }),
    testAgent({ name: 'plan' }),
    testAgent({ name: 'chat' }),
    testAgent({ name: '工作' }),
    testAgent({ name: 'reviewer' }),
  ];

  test('drops the mode-switch agents from pickers', () => {
    expect(filterAgentChoices(agents).map((agent) => agent.name)).toEqual(['build', '工作', 'reviewer']);
  });

  test('build is code-only; 工作 is work-only', () => {
    expect(filterAgentChoices(agents, { entry: 'code' }).map((a) => a.name))
      .toEqual(['build', 'reviewer']);
    expect(filterAgentChoices(agents, { entry: 'work' }).map((a) => a.name))
      .toEqual(['工作', 'reviewer']);
  });

  test('a hidden agent is not a choice either', () => {
    expect(filterAgentChoices([testAgent({ name: 'chat', hidden: true })])).toEqual([]);
  });
});

describe('resolveComposerMode', () => {
  test('reads the position back from the agent', () => {
    expect(resolveComposerMode(PLAN_AGENT_NAME)).toBe('plan');
    expect(resolveComposerMode(CHAT_AGENT_NAME)).toBe('chat');
  });

  test('anything that is not a special agent is the working position', () => {
    expect(resolveComposerMode('build')).toBe('build');
    expect(resolveComposerMode('工作')).toBe('build');
    expect(resolveComposerMode(null)).toBe('build');
    expect(resolveComposerMode(undefined)).toBe('build');
    expect(resolveComposerMode('')).toBe('build');
  });
});

describe('isModeAvailable', () => {
  test('each position needs its own agent, and build needs an ordinary one', () => {
    expect(isModeAvailable([buildAgent, planAgent, chatAgent], 'build')).toBe(true);
    expect(isModeAvailable([buildAgent, planAgent, chatAgent], 'plan')).toBe(true);
    expect(isModeAvailable([buildAgent, planAgent, chatAgent], 'chat')).toBe(true);

    expect(isModeAvailable([buildAgent], 'plan')).toBe(false);
    expect(isModeAvailable([buildAgent], 'chat')).toBe(false);
    // Nothing to work with: the switches that only offer the special agents.
    expect(isModeAvailable([planAgent, chatAgent], 'build')).toBe(false);
  });

  test('a hidden or subagent special agent does not count', () => {
    expect(isModeAvailable([buildAgent, testAgent({ name: 'chat', hidden: true })], 'chat')).toBe(false);
    expect(isModeAvailable([buildAgent, testAgent({ name: 'plan', mode: 'subagent' })], 'plan')).toBe(false);
  });
});

describe('resolveBuildModeAgent', () => {
  const agents = [buildAgent, planAgent, chatAgent, workAgent];

  test('returns what this session worked with before the special modes', () => {
    expect(resolveBuildModeAgent({ agents, rememberedAgent: '工作' })).toBe('工作');
  });

  test('never returns a special agent, even as a remembered one', () => {
    expect(resolveBuildModeAgent({ agents, rememberedAgent: PLAN_AGENT_NAME })).toBe('build');
    expect(resolveBuildModeAgent({ agents, rememberedAgent: CHAT_AGENT_NAME })).toBe('build');
    expect(resolveBuildModeAgent({ agents, recentAgents: [CHAT_AGENT_NAME], settingsDefaultAgent: PLAN_AGENT_NAME }))
      .toBe('build');
  });

  test('prefers recently used agents over the configured default', () => {
    expect(resolveBuildModeAgent({
      agents,
      recentAgents: [PLAN_AGENT_NAME, '工作'],
      settingsDefaultAgent: 'build',
    })).toBe('工作');
  });

  test('falls back to the configured default, then build, then any ordinary agent', () => {
    expect(resolveBuildModeAgent({ agents, settingsDefaultAgent: '工作' })).toBe('工作');
    expect(resolveBuildModeAgent({ agents: [buildAgent, planAgent] })).toBe('build');
    expect(resolveBuildModeAgent({ agents: [planAgent, workAgent] })).toBe('工作');
  });

  test('returns null when only the special agents are selectable', () => {
    expect(resolveBuildModeAgent({ agents: [planAgent, chatAgent] })).toBeNull();
    expect(resolveBuildModeAgent({ agents: [] })).toBeNull();
  });
});

describe('resolveModeSelection', () => {
  const agents = [buildAgent, planAgent, chatAgent, workAgent];

  test('the middle and right positions select their own agent', () => {
    expect(resolveModeSelection({ mode: 'plan', agents })).toEqual({ kind: 'select', agent: PLAN_AGENT_NAME });
    expect(resolveModeSelection({ mode: 'chat', agents })).toEqual({ kind: 'select', agent: CHAT_AGENT_NAME });
  });

  test('the working position restores the agent from before', () => {
    expect(resolveModeSelection({ mode: 'build', agents, rememberedAgent: '工作' }))
      .toEqual({ kind: 'select', agent: '工作' });
  });

  test('is unavailable when the runtime offers no such agent', () => {
    expect(resolveModeSelection({ mode: 'chat', agents: [buildAgent, planAgent] }))
      .toEqual({ kind: 'unavailable' });
    expect(resolveModeSelection({ mode: 'plan', agents: [buildAgent, chatAgent] }))
      .toEqual({ kind: 'unavailable' });
  });

  test('is unavailable when the working position has nothing to return to', () => {
    expect(resolveModeSelection({ mode: 'build', agents: [planAgent, chatAgent] }))
      .toEqual({ kind: 'unavailable' });
  });
});

describe('DRAFT_SESSION_KEY', () => {
  test('names the new-session draft bucket', () => {
    expect(DRAFT_SESSION_KEY).toBe('__draft__');
  });
});
