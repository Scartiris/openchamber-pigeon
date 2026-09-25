import type { Agent } from '@opencode-ai/sdk/v2';
import { getProviderModelDisplayName, type DisplayProvider } from '@/lib/modelDisplay';
import { agentBuiltinLabelKey, formatAgentDisplayName } from '@/lib/agentDisplayName';
import { formatMessage, useI18nStore, type I18nKey } from '@/lib/i18n';

export type MobileControlsPanel = 'model' | 'agent' | 'variant' | null;

export const isPrimaryMode = (mode?: string) => mode === 'primary' || mode === 'all' || mode === undefined || mode === null;

const getCyclablePrimaryAgents = (agents: Agent[]) => agents.filter((agent) => isPrimaryMode(agent.mode));

export const getCycledPrimaryAgentName = (
    agents: Agent[],
    currentAgentName: string | undefined,
    direction: 1 | -1 = 1,
) => {
    const primaryAgents = getCyclablePrimaryAgents(agents);
    if (primaryAgents.length <= 1) {
        return null;
    }

    const currentIndex = primaryAgents.findIndex((agent) => agent.name === currentAgentName);
    const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (safeCurrentIndex + direction + primaryAgents.length) % primaryAgents.length;
    return primaryAgents[nextIndex]?.name ?? null;
};

const translateAgentLabel = (agentName: string) =>
    // SAFETY: dictionary keys are a closed union; this is the generated
    // `agents.builtin.<id>` slot, and formatMessage falls back when missing.
    formatMessage(useI18nStore.getState().dictionary, agentBuiltinLabelKey(agentName) as I18nKey);

export const getAgentDisplayName = (agents: Agent[], agentName?: string) => {
    if (agentName) {
        return formatAgentDisplayName(agentName, translateAgentLabel(agentName));
    }

    const primaryAgents = agents.filter((agent) => isPrimaryMode(agent.mode));
    const buildAgent = primaryAgents.find((agent) => agent.name === 'build');
    const fallbackAgent = buildAgent || primaryAgents[0] || agents[0];
    return fallbackAgent
        ? formatAgentDisplayName(fallbackAgent.name, translateAgentLabel(fallbackAgent.name))
        : 'Select agent';
};

export const getModelDisplayName = (
    provider: DisplayProvider,
    modelId: string | undefined,
    fallbackLabel = '',
) => {
    return getProviderModelDisplayName(provider, modelId, { fallbackLabel });
};

export const formatEffortLabel = (variant?: string) => {
    if (!variant || variant.trim().length === 0) {
        return 'Default';
    }
    const trimmed = variant.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
        return trimmed;
    }
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
};
