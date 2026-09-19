import React from 'react';

import {
  DRAFT_SESSION_KEY,
  isPlanAgentAvailable,
  isPlanAgentName,
  resolvePlanToggleDecision,
} from '@/lib/planMode';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

export interface PlanModeSwitchState {
  /** True while this composer's session runs on the plan agent. */
  enabled: boolean;
  /** False when the runtime offers no selectable primary agent named `plan`. */
  available: boolean;
  /**
   * False for an embedded chat column. Its composer must not render the switch:
   * `setAgent` persists against the session the app is showing, not the column's.
   */
  ownsCurrentSession: boolean;
  onToggle: () => void;
}

/**
 * Binds the composer's plan-mode switch to the session's agent.
 *
 * The switch owns no state of its own. It reads its position from the session's
 * effective agent and writes through `setAgent`, so the picker, the cycle
 * shortcut and the switch can never disagree. What it does own is the plan-mode
 * gate — the flag every plan surface reads — and the agent to return to.
 */
export const usePlanModeSwitch = (sessionId: string | null): PlanModeSwitchState => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const agents = useConfigStore((state) => state.agents);
  const currentAgentName = useConfigStore((state) => state.currentAgentName);
  const settingsDefaultAgent = useConfigStore((state) => state.settingsDefaultAgent);
  const setAgent = useConfigStore((state) => state.setAgent);
  // What the switch shows is what the next send carries: the session's own
  // choice when it has one, the live selection before that.
  const sessionAgentName = useSelectionStore((state) => (
    sessionId ? state.sessionAgentSelections.get(sessionId) ?? null : null
  ));
  const recentAgents = useUIStore((state) => state.recentAgents);
  const addRecentAgent = useUIStore((state) => state.addRecentAgent);
  const setPlanModeSwitchOn = useFeatureFlagsStore((state) => state.setPlanModeSwitchOn);
  const rememberPlanRestoreAgent = useFeatureFlagsStore((state) => state.rememberPlanRestoreAgent);

  const effectiveAgentName = sessionAgentName ?? currentAgentName;
  const enabled = isPlanAgentName(effectiveAgentName);
  const available = React.useMemo(() => isPlanAgentAvailable(agents), [agents]);
  const sessionKey = sessionId ?? DRAFT_SESSION_KEY;
  const ownsCurrentSession = sessionId === currentSessionId;

  React.useEffect(() => {
    // One writer for the gate: an embedded column has its own session, and the
    // plan surfaces belong to the session the app is showing.
    if (!ownsCurrentSession) return;

    if (enabled) {
      setPlanModeSwitchOn(true);
      return;
    }

    setPlanModeSwitchOn(false);
    // Selecting any other agent — with this switch, the picker, or the cycle
    // shortcut — becomes the agent plan mode returns to.
    if (effectiveAgentName) {
      rememberPlanRestoreAgent(sessionKey, effectiveAgentName);
    }
  }, [
    effectiveAgentName,
    enabled,
    ownsCurrentSession,
    rememberPlanRestoreAgent,
    sessionKey,
    setPlanModeSwitchOn,
  ]);

  const onToggle = React.useCallback(() => {
    const decision = resolvePlanToggleDecision({
      enabled,
      agents,
      rememberedAgent: useFeatureFlagsStore.getState().planRestoreAgentBySession[sessionKey] ?? null,
      recentAgents,
      settingsDefaultAgent,
    });
    if (decision.kind === 'unavailable') return;

    // `setAgent` still persists this session's choice; `keepModelSelection` is
    // what makes the switch an agent change and nothing else — without it the
    // plan agent's own model and effort would replace the ones in use.
    setAgent(decision.agent, { keepModelSelection: true });
    addRecentAgent(decision.agent);
  }, [addRecentAgent, agents, enabled, recentAgents, sessionKey, setAgent, settingsDefaultAgent]);

  return { enabled, available, ownsCurrentSession, onToggle };
};
