/**
 * Plan mode as a user-facing switch.
 *
 * Plan mode is not a second source of truth next to the session's agent: it is
 * a *view* of it. "On" means the session's effective agent is the `plan` agent,
 * so picking that agent anywhere else (the model controls, the cycle
 * shortcut, a restored session) turns the switch on too.
 *
 * This module owns the pure rules — which agents can hold the plan role and
 * which agent the switch restores when it goes off — so the switch hook and its
 * tests read the same rules instead of restating them.
 */

import type { Agent } from '@opencode-ai/sdk/v2';

import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { filterVisibleAgents } from '@/stores/useAgentsStore';

/** OpenCode's built-in read-only planning agent. */
export const PLAN_AGENT_NAME = 'plan';

/** OpenCode's built-in default agent, used as the last named fallback. */
const BUILD_AGENT_NAME = 'build';

/**
 * Session key for the composer while it is still a new-session draft. The
 * restore memory is keyed by session, and a draft has no id yet.
 */
export const DRAFT_SESSION_KEY = '__draft__';

export const isPlanAgentName = (agentName: string | null | undefined): boolean =>
  agentName === PLAN_AGENT_NAME;

/**
 * Agents the composer's own picker offers: visible (hidden internal agents such
 * as `title` and `compaction` are excluded) and primary.
 */
export const getSelectablePrimaryAgents = (agents: readonly Agent[]): Agent[] =>
  filterVisibleAgents([...agents]).filter((agent) => isPrimaryMode(agent.mode));

export const isPlanAgentAvailable = (agents: readonly Agent[]): boolean =>
  getSelectablePrimaryAgents(agents).some((agent) => isPlanAgentName(agent.name));

export interface PlanRestoreCandidateOptions {
  agents: readonly Agent[];
  /** What this session used before plan mode, recorded while the switch is off. */
  rememberedAgent?: string | null;
  /** Persisted "recently used agents", most recent first. */
  recentAgents?: readonly string[];
  /** The agent configured as the app-wide default. */
  settingsDefaultAgent?: string | null;
}

/**
 * The agent the switch returns to when it is turned off, ordered by how strong
 * the evidence is: what this session actually used, then what the user used
 * lately, then the configured default, then `build`.
 *
 * Returns null only when the agent list offers nothing but `plan`, which makes
 * the switch unavailable rather than stranding the session on the plan agent.
 */
export const resolvePlanRestoreAgent = (options: PlanRestoreCandidateOptions): string | null => {
  const selectable = getSelectablePrimaryAgents(options.agents);
  const selectableNames = new Set(selectable.map((agent) => agent.name));
  const isRestorable = (agentName: string | null | undefined): agentName is string =>
    agentName !== null
    && agentName !== undefined
    && agentName.length > 0
    && !isPlanAgentName(agentName)
    && selectableNames.has(agentName);

  if (isRestorable(options.rememberedAgent)) return options.rememberedAgent;

  for (const recentAgent of options.recentAgents ?? []) {
    if (isRestorable(recentAgent)) return recentAgent;
  }

  if (isRestorable(options.settingsDefaultAgent)) return options.settingsDefaultAgent;
  if (selectableNames.has(BUILD_AGENT_NAME)) return BUILD_AGENT_NAME;

  return selectable.find((agent) => !isPlanAgentName(agent.name))?.name ?? null;
};

export type PlanToggleDecision =
  | { kind: 'enable'; agent: string }
  | { kind: 'disable'; agent: string }
  | { kind: 'unavailable' };

export interface PlanToggleDecisionOptions extends PlanRestoreCandidateOptions {
  /** True while the session's effective agent is already the plan agent. */
  enabled: boolean;
}

/**
 * What a click on the switch must do. Both directions are resolved here rather
 * than in the component so the "no plan agent" and "nothing to return to"
 * cases are decided in one place and covered by tests.
 */
export const resolvePlanToggleDecision = (options: PlanToggleDecisionOptions): PlanToggleDecision => {
  if (!isPlanAgentAvailable(options.agents)) return { kind: 'unavailable' };
  if (!options.enabled) return { kind: 'enable', agent: PLAN_AGENT_NAME };

  const restoreAgent = resolvePlanRestoreAgent(options);
  if (!restoreAgent) return { kind: 'unavailable' };

  return { kind: 'disable', agent: restoreAgent };
};
