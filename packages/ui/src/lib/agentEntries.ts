/**
 * Which workbench entries (代码 / 工作) an agent may appear in.
 *
 * Project directories already decide the *default* agent (`project.defaultAgent`
 * → code falls through to `build`, work binds 工作). This module is the other
 * half: which named agents the picker offers while the user is in an entry.
 *
 * No membership recorded = visible everywhere (backwards compatible with agents
 * that predate this map, and with built-ins such as `build`).
 */

import type { WorkspaceEntry } from '@/lib/workspaceEntry';

export type AgentEntryMembership = Partial<Record<string, WorkspaceEntry[]>>;

/**
 * Deployment defaults. `工作` is the work partition's agent — offering it while
 * the user is browsing 代码 sessions is noise; code keeps the built-in `build`.
 */
export const DEFAULT_AGENT_ENTRY_MEMBERSHIP = {
  工作: ['work'],
} satisfies AgentEntryMembership;

/**
 * Live override map. A `Map` (not a typed object literal) so this module can
 * hold a sparse name→entries store without widening an open dictionary type;
 * missing keys still mean "every entry" at read time.
 */
const live = new Map<string, WorkspaceEntry[]>();

const seedLiveFromDefaults = (): void => {
  live.clear();
  for (const [name, entries] of Object.entries(DEFAULT_AGENT_ENTRY_MEMBERSHIP)) {
    if (entries) live.set(name, entries);
  }
};
seedLiveFromDefaults();

export const replaceAgentEntryMembership = (next: AgentEntryMembership): void => {
  seedLiveFromDefaults();
  for (const [name, entries] of Object.entries(next)) {
    if (entries) live.set(name, entries);
  }
};

export const readAgentEntryMembership = (): AgentEntryMembership =>
  Object.fromEntries(live.entries()) satisfies AgentEntryMembership;

export const agentAppearsInEntry = (
  agentName: string,
  entry: WorkspaceEntry,
  membership: AgentEntryMembership = readAgentEntryMembership(),
): boolean => {
  const allowed = membership[agentName];
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(entry);
};

export const filterAgentsForEntry = <A extends { name: string }>(
  agents: readonly A[],
  entry: WorkspaceEntry | null | undefined,
  membership: AgentEntryMembership = readAgentEntryMembership(),
): A[] => {
  if (!entry) return [...agents];
  return agents.filter((agent) => agentAppearsInEntry(agent.name, entry, membership));
};
