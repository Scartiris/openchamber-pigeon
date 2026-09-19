import React from 'react';

import {
  DRAFT_SESSION_KEY,
  type ComposerMode,
  isModeAvailable,
  resolveComposerMode,
  resolveModeSelection,
} from '@/lib/composerModes';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

export interface ComposerModeState {
  /** Which position this composer's session currently sits in. */
  mode: ComposerMode;
  /** Which positions the runtime can offer; an unavailable one stays visible but inert. */
  availability: Record<ComposerMode, boolean>;
  /**
   * False for an embedded chat column. Its composer must not render the switch:
   * `setAgent` persists against the session the app is showing, not the column's.
   */
  ownsCurrentSession: boolean;
  selectMode: (mode: ComposerMode) => void;
}

/**
 * Binds the composer's mode switch to the session's agent.
 *
 * The switch owns no state of its own: the position is read back from the
 * session's effective agent and choosing one writes through `setAgent`, so the
 * pickers, the cycle shortcut and the switch can never disagree. What it does own
 * is the plan-mode gate — the flag every plan surface reads — and the agent the
 * `build` position returns to.
 */
export const useComposerMode = (sessionId: string | null): ComposerModeState => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const agents = useConfigStore((state) => state.agents);
  const currentAgentName = useConfigStore((state) => state.currentAgentName);
  const settingsDefaultAgent = useConfigStore((state) => state.settingsDefaultAgent);
  const setAgent = useConfigStore((state) => state.setAgent);
  // What the switch shows is what the next send carries: the session's own choice
  // when it has one, the live selection before that.
  const sessionAgentName = useSelectionStore((state) => (
    sessionId ? state.sessionAgentSelections.get(sessionId) ?? null : null
  ));
  const recentAgents = useUIStore((state) => state.recentAgents);
  const addRecentAgent = useUIStore((state) => state.addRecentAgent);
  const setPlanModeSwitchOn = useFeatureFlagsStore((state) => state.setPlanModeSwitchOn);
  const rememberComposerRestoreAgent = useFeatureFlagsStore((state) => state.rememberComposerRestoreAgent);

  const effectiveAgentName = sessionAgentName ?? currentAgentName;
  const mode = resolveComposerMode(effectiveAgentName);
  const availability = React.useMemo<Record<ComposerMode, boolean>>(() => ({
    build: isModeAvailable(agents, 'build'),
    plan: isModeAvailable(agents, 'plan'),
    chat: isModeAvailable(agents, 'chat'),
  }), [agents]);
  const sessionKey = sessionId ?? DRAFT_SESSION_KEY;
  const ownsCurrentSession = sessionId === currentSessionId;

  React.useEffect(() => {
    // One writer for the gate: an embedded column has its own session, and the
    // plan surfaces belong to the session the app is showing.
    if (!ownsCurrentSession) return;

    setPlanModeSwitchOn(mode === 'plan');

    // Working with a normal agent is what the `build` position returns to; the two
    // special modes must not overwrite it, or leaving them would land on whatever
    // the last special agent happened to be.
    if (mode === 'build' && effectiveAgentName) {
      rememberComposerRestoreAgent(sessionKey, effectiveAgentName);
    }
  }, [
    effectiveAgentName,
    mode,
    ownsCurrentSession,
    rememberComposerRestoreAgent,
    sessionKey,
    setPlanModeSwitchOn,
  ]);

  const selectMode = React.useCallback((nextMode: ComposerMode) => {
    const decision = resolveModeSelection({
      mode: nextMode,
      agents,
      rememberedAgent: useFeatureFlagsStore.getState().composerRestoreAgentBySession[sessionKey] ?? null,
      recentAgents,
      settingsDefaultAgent,
    });
    if (decision.kind === 'unavailable') return;
    if (decision.agent === effectiveAgentName) return;

    // `setAgent` also persists this session's choice, and `keepModelSelection`
    // keeps it an agent change and nothing else: the model and effort in use stay
    // put instead of being replaced by the new agent's own defaults.
    setAgent(decision.agent, { keepModelSelection: true });
    addRecentAgent(decision.agent);
  }, [addRecentAgent, agents, effectiveAgentName, recentAgents, sessionKey, setAgent, settingsDefaultAgent]);

  return { mode, availability, ownsCurrentSession, selectMode };
};
