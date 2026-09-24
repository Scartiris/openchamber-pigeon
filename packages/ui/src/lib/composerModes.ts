/**
 * The composer's modes: who answers, and what that agent is allowed to do.
 *
 * One switch, three positions, in the composer's own footer:
 *
 *   build — the working agent: whatever this session was using before
 *   plan  — OpenCode's read-only planning agent (reads, writes plan files only)
 *   chat  — a conversation-only agent: no file writes, no commands, no artifacts
 *
 * The mode is not state of its own. It is read back from the session's effective
 * agent and written through `setAgent`, so the switch, the model controls and the
 * cycle shortcut cannot disagree. Both special agents are kept out of the agent
 * lists (`isAgentChoice`), so the switch is the only way to reach them — and this
 * module owns those rules so the pickers and the switch read the same ones.
 */

import type { Agent } from '@opencode-ai/sdk/v2';

import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { filterVisibleAgents } from '@/stores/useAgentsStore';
import { filterAgentsForEntry, type AgentEntryMembership } from '@/lib/agentEntries';
import type { WorkspaceEntry } from '@/lib/workspaceEntry';

export type ComposerMode = 'build' | 'plan' | 'chat';

/** OpenCode's built-in read-only planning agent. */
export const PLAN_AGENT_NAME = 'plan';

/** The conversation-only agent defined for this deployment (`ops/workmode/chat.md`). */
export const CHAT_AGENT_NAME = 'chat';

/** OpenCode's built-in default agent (code entry; i18n display 构建). */
const BUILD_AGENT_NAME = 'build';

/**
 * The agent each mode runs on. `build` has none of its own: it means "not one of
 * the special modes", so it resolves through the restore chain instead.
 */
export const MODE_AGENT_NAME = {
  build: null,
  plan: PLAN_AGENT_NAME,
  chat: CHAT_AGENT_NAME,
} satisfies Record<ComposerMode, string | null>;

const MODE_AGENT_NAMES: readonly string[] = [PLAN_AGENT_NAME, CHAT_AGENT_NAME];

/**
 * Session key for the composer while it is still a new-session draft. The
 * restore memory is keyed by session, and a draft has no id yet.
 */
export const DRAFT_SESSION_KEY = '__draft__';

export const isModeAgentName = (agentName: string | null | undefined): boolean =>
  agentName !== null
  && agentName !== undefined
  && MODE_AGENT_NAMES.includes(agentName);

/** Which position the switch shows for this agent. Anything not special is `build`. */
export const resolveComposerMode = (agentName: string | null | undefined): ComposerMode => {
  if (agentName === PLAN_AGENT_NAME) return 'plan';
  if (agentName === CHAT_AGENT_NAME) return 'chat';
  return 'build';
};

/**
 * Agents the composer's own picker offers: visible (hidden internal agents such
 * as `title` and `compaction` are excluded) and primary.
 */
export const getSelectablePrimaryAgents = (agents: readonly Agent[]): Agent[] =>
  filterVisibleAgents([...agents]).filter((agent) => isPrimaryMode(agent.mode));

/**
 * Whether an agent is offered to the user as an explicit choice.
 *
 * Plan and chat are ordinary picker entries again (the composer mode switch is
 * gone) — the right-hand agent menu lists every visible agent, including those.
 */
export const isAgentChoice = (_agentName: string): boolean => true;

/** The list the pickers show: visible agents, then the workbench-entry filter. */
export const filterAgentChoices = (
  agents: readonly Agent[],
  options?: {
    entry?: WorkspaceEntry | null;
    membership?: AgentEntryMembership;
  },
): Agent[] => {
  const choices = filterVisibleAgents([...agents]);
  return filterAgentsForEntry(choices, options?.entry, options?.membership);
};

/**
 * The agent a project's `defaultAgent` asks for, or undefined when it asks for
 * something a project must not own.
 *
 * The project directory is the user's one switch for "what kind of work this is",
 * so its default agent has to beat the app-wide default. Two things it must not
 * beat: a hand-picked agent in this session (`resolveSelectionWithManualGuard`
 * owns that), and either agent the mode switch owns — binding `plan` to a
 * directory would open the switch on a position the user cannot leave by pressing
 * it, because leaving means returning to the agent they never chose.
 */
export const resolveProjectDefaultAgent = (agentName: string | null | undefined): string | undefined =>
  agentName && isAgentChoice(agentName) ? agentName : undefined;

/** Whether the switch can offer this position at all. */
export const isModeAvailable = (agents: readonly Agent[], mode: ComposerMode): boolean => {
  const selectable = getSelectablePrimaryAgents(agents);
  if (mode === 'build') {
    return selectable.some((agent) => !isModeAgentName(agent.name));
  }
  return selectable.some((agent) => agent.name === MODE_AGENT_NAME[mode]);
};

export interface BuildModeAgentOptions {
  agents: readonly Agent[];
  /** What this session used before it entered one of the special modes. */
  rememberedAgent?: string | null;
  /** Persisted "recently used agents", most recent first. */
  recentAgents?: readonly string[];
  /** The agent configured as the app-wide default. */
  settingsDefaultAgent?: string | null;
}

/**
 * The agent the `build` position returns to, ordered by how strong the evidence
 * is: what this session actually used, then what the user used lately, then the
 * configured default, then `build`.
 *
 * Returns null only when the agent list offers nothing but the two special
 * agents, which makes the position unavailable rather than stranding the session
 * on a mode the user just left.
 */
export const resolveBuildModeAgent = (options: BuildModeAgentOptions): string | null => {
  const selectable = getSelectablePrimaryAgents(options.agents);
  const selectableNames = new Set(selectable.map((agent) => agent.name));
  // Restore to a *working* agent, never plan/chat — those are picker choices now,
  // but this chain is what "leave the special mode" would have returned to.
  const isRestorable = (agentName: string | null | undefined): agentName is string =>
    agentName !== null
    && agentName !== undefined
    && agentName.length > 0
    && !isModeAgentName(agentName)
    && selectableNames.has(agentName);

  if (isRestorable(options.rememberedAgent)) return options.rememberedAgent;

  for (const recentAgent of options.recentAgents ?? []) {
    if (isRestorable(recentAgent)) return recentAgent;
  }

  if (isRestorable(options.settingsDefaultAgent)) return options.settingsDefaultAgent;
  if (selectableNames.has(BUILD_AGENT_NAME)) return BUILD_AGENT_NAME;

  return selectable.find((agent) => !isModeAgentName(agent.name))?.name ?? null;
};

export type ModeSelectionDecision =
  | { kind: 'select'; agent: string }
  | { kind: 'unavailable' };

export interface ModeSelectionOptions extends BuildModeAgentOptions {
  mode: ComposerMode;
}

/**
 * What choosing a position must do. Every direction is resolved here rather than
 * in the component, so "no such agent" and "nothing to return to" are decided in
 * one place and covered by tests.
 */
export const resolveModeSelection = (options: ModeSelectionOptions): ModeSelectionDecision => {
  if (!isModeAvailable(options.agents, options.mode)) return { kind: 'unavailable' };

  const fixedAgent = MODE_AGENT_NAME[options.mode];
  if (fixedAgent) return { kind: 'select', agent: fixedAgent };

  const buildAgent = resolveBuildModeAgent(options);
  return buildAgent ? { kind: 'select', agent: buildAgent } : { kind: 'unavailable' };
};
