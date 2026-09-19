import { create } from 'zustand';

type FeatureFlagsStore = {
  /**
   * Effective plan-mode gate. Every plan surface — the plan tab, the plan rail
   * surface, the synthetic plan messages — reads this one flag, so it is the
   * host capability OR the composer's plan position, whichever turned it on.
   */
  planModeEnabled: boolean;
  /**
   * Host capability reported by `/health`
   * (`OPENCODE_EXPERIMENTAL_PLAN_MODE`). This is what the runtime shells set at
   * boot; it is not the user's preference.
   */
  hostPlanModeEnabled: boolean;
  /** True while the current session sits in the composer's plan position. */
  planModeSwitchOn: boolean;
  setPlanModeEnabled: (enabled: boolean) => void;
  setPlanModeSwitchOn: (on: boolean) => void;
  /**
   * Session key -> the agent this session was working with, so the composer's
   * `build` position returns to it. In-memory on purpose: the session's own agent
   * selection is the persisted truth, and `resolveBuildModeAgent` has a fallback
   * chain for a freshly loaded page.
   */
  composerRestoreAgentBySession: Record<string, string>;
  rememberComposerRestoreAgent: (sessionKey: string, agentName: string | null) => void;
};

const resolvePlanModeGate = (hostPlanModeEnabled: boolean, planModeSwitchOn: boolean): boolean =>
  hostPlanModeEnabled || planModeSwitchOn;

export const useFeatureFlagsStore = create<FeatureFlagsStore>((set) => ({
  planModeEnabled: false,
  hostPlanModeEnabled: false,
  planModeSwitchOn: false,
  setPlanModeEnabled: (enabled) => set((state) => {
    if (state.hostPlanModeEnabled === enabled) return state;
    return {
      hostPlanModeEnabled: enabled,
      planModeEnabled: resolvePlanModeGate(enabled, state.planModeSwitchOn),
    };
  }),
  setPlanModeSwitchOn: (on) => set((state) => {
    if (state.planModeSwitchOn === on) return state;
    return {
      planModeSwitchOn: on,
      planModeEnabled: resolvePlanModeGate(state.hostPlanModeEnabled, on),
    };
  }),
  composerRestoreAgentBySession: {},
  rememberComposerRestoreAgent: (sessionKey, agentName) => set((state) => {
    if ((state.composerRestoreAgentBySession[sessionKey] ?? null) === agentName) return state;

    const nextRestoreAgents = { ...state.composerRestoreAgentBySession };
    if (agentName) {
      nextRestoreAgents[sessionKey] = agentName;
    } else {
      delete nextRestoreAgents[sessionKey];
    }

    return { composerRestoreAgentBySession: nextRestoreAgents };
  }),
}));
