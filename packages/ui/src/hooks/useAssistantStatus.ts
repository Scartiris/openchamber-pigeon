import React from 'react';
import { useChatColumnSession } from '@/components/chat/chatColumnSession';
import type { Message, Part, ReasoningPart, TextPart, ToolPart } from '@opencode-ai/sdk/v2';

import { useI18n, type I18nKey } from '@/lib/i18n';
import type { MessageStreamPhase } from '@/stores/types/sessionTypes';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectorySync, useSessionMessages, useSessionPermissions, useSessionQuestions, useSessionStatus } from '@/sync/sync-context';
import { isFullySyntheticMessage } from '@/lib/messages/synthetic';
import { useCurrentSessionActivity } from './useSessionActivity';

type AssistantActivity = 'idle' | 'streaming' | 'tooling' | 'cooldown' | 'permission';

interface WorkingSummary {
    activity: AssistantActivity;
    hasWorkingContext: boolean;
    hasActiveTools: boolean;
    isWorking: boolean;
    isStreaming: boolean;
    isCooldown: boolean;
    lifecyclePhase: MessageStreamPhase | null;
    statusText: string | null;
    isGenericStatus: boolean;
    isWaitingForPermission: boolean;
    canAbort: boolean;
    compactionDeadline: number | null;
    activePartType?: 'text' | 'tool' | 'reasoning' | 'editing';
    activeToolName?: string;
    wasAborted: boolean;
    abortActive: boolean;
    lastCompletionId: string | null;
    isComplete: boolean;
    retryInfo: { attempt?: number; next?: number } | null;
}

interface FormingSummary {
    isActive: boolean;
    characterCount: number;
}

export interface AssistantStatusSnapshot {
    activeModel: ActiveAssistantModel | null;
    forming: FormingSummary;
    working: WorkingSummary;
}

interface ActiveAssistantModel {
    providerId: string;
    modelId: string;
}

interface ActiveAssistantContext {
    assistantId: string | null;
    model: ActiveAssistantModel | null;
}

const DEFAULT_WORKING: WorkingSummary = {
    activity: 'idle',
    hasWorkingContext: false,
    hasActiveTools: false,
    isWorking: false,
    isStreaming: false,
    isCooldown: false,
    lifecyclePhase: null,
    statusText: null,
    isGenericStatus: true,
    isWaitingForPermission: false,
    canAbort: false,
    compactionDeadline: null,
    activePartType: undefined,
    activeToolName: undefined,
    wasAborted: false,
    abortActive: false,
    lastCompletionId: null,
    isComplete: false,
    retryInfo: null,
};

const EMPTY_PARTS: Part[] = [];
const STATUS_SIGNATURE_SEPARATOR = '\u0000';
const EDITING_TOOLS = new Set(['edit', 'write', 'multiedit', 'apply_patch']);
// pigeon fork: the values below are i18n keys, not display text. The running
// status line is part of the interface, so it is translated where it is
// rendered instead of baking English into the string the status pipeline hands
// around (that string is also the memoisation signature).
const TOOL_STATUS_PHRASES: Record<string, I18nKey> = {
    read: 'assistantStatus.readingFile',
    write: 'assistantStatus.writingFile',
    edit: 'assistantStatus.editingFile',
    multiedit: 'assistantStatus.editingFiles',
    apply_patch: 'assistantStatus.applyingPatch',
    bash: 'assistantStatus.runningCommand',
    grep: 'assistantStatus.searchingContent',
    glob: 'assistantStatus.findingFiles',
    list: 'assistantStatus.listingDirectory',
    task: 'assistantStatus.delegatingTask',
    webfetch: 'assistantStatus.fetchingUrl',
    websearch: 'assistantStatus.searchingWeb',
    codesearch: 'assistantStatus.webCodeSearch',
    todowrite: 'assistantStatus.updatingTodos',
    todoread: 'assistantStatus.readingTodos',
    skill: 'assistantStatus.learningSkill',
    question: 'assistantStatus.askingQuestion',
    plan_enter: 'assistantStatus.switchingToPlanning',
    plan_exit: 'assistantStatus.switchingToBuilding',
};
const WORKING_PHRASE_KEYS: readonly I18nKey[] = [
    'assistantStatus.working',
    'assistantStatus.processing',
    'assistantStatus.preparing',
    'assistantStatus.warmingUp',
    'assistantStatus.gearsTurning',
    'assistantStatus.computing',
    'assistantStatus.calculating',
    'assistantStatus.analyzing',
    'assistantStatus.wheelsSpinning',
    'assistantStatus.calibrating',
    'assistantStatus.synthesizing',
    'assistantStatus.connectingDots',
    'assistantStatus.inspectingLogic',
    'assistantStatus.weighingOptions',
];

type ParsedStatusResult = {
    activePartType: 'text' | 'tool' | 'reasoning' | 'editing' | undefined;
    activeToolName: string | undefined;
    statusText: string;
    isGenericStatus: boolean;
};

/** Translator shape shared by every helper below (`t` from `useI18n()`). */
type TranslateFn = (key: I18nKey, params?: Record<string, string | number>) => string;

const getToolStatusPhrase = (toolName: string, translate: TranslateFn): string => {
    const key = TOOL_STATUS_PHRASES[toolName];
    if (key) {
        return translate(key);
    }

    // Unknown tools reach here (plugin and MCP calls). Keep the identifier the
    // user typed rather than guessing at a translation for it.
    return translate('assistantStatus.usingTool', { tool: toolName });
};

const hashString = (value: string): number => {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }
    return Math.abs(hash);
};

const getStableWorkingPhrase = (key: string, translate: TranslateFn): string => {
    const phraseKey = WORKING_PHRASE_KEYS[hashString(key) % WORKING_PHRASE_KEYS.length] ?? 'assistantStatus.working';
    return translate(phraseKey);
};

const createParsedStatus = (parts: Part[], genericKey: string, translate: TranslateFn): ParsedStatusResult => {
    let activePartType: ParsedStatusResult['activePartType'] = undefined;
    let activeToolName: string | undefined = undefined;

    if (!isFullySyntheticMessage(parts)) {
        for (let index = parts.length - 1; index >= 0; index -= 1) {
            const part = parts[index];
            if (!part) continue;

            switch (part.type) {
                case 'reasoning': {
                    const time = part.time ?? getPartTimeInfo(part);
                    const stillRunning = !time || typeof time.end === 'undefined';
                    if (stillRunning && !activePartType) {
                        activePartType = 'reasoning';
                    }
                    break;
                }
                case 'tool': {
                    const toolStatus = part.state?.status;
                    if ((toolStatus === 'running' || toolStatus === 'pending') && !activePartType) {
                        const toolName = getToolDisplayName(part);
                        if (EDITING_TOOLS.has(toolName)) {
                            activePartType = 'editing';
                            activeToolName = toolName;
                        } else {
                            activePartType = 'tool';
                            activeToolName = toolName;
                        }
                    }
                    break;
                }
                case 'text': {
                    const rawContent = getLegacyTextContent(part) ?? '';
                    if (typeof rawContent === 'string' && rawContent.trim().length > 0) {
                        const time = getPartTimeInfo(part);
                        const streamingPart = !time || typeof time.end === 'undefined';
                        if (streamingPart && !activePartType) {
                            activePartType = 'text';
                        }
                    }
                    break;
                }
                default:
                    break;
            }
        }
    }

    const isGenericStatus = activePartType === undefined;
    const statusText = (() => {
        if (activePartType === 'editing') return activeToolName === 'multiedit' ? getToolStatusPhrase(activeToolName, translate) : translate('assistantStatus.editingFile');
        if (activePartType === 'tool' && activeToolName) return getToolStatusPhrase(activeToolName, translate);
        if (activePartType === 'reasoning') return translate('assistantStatus.thinking');
        if (activePartType === 'text') return translate('assistantStatus.composing');
        return getStableWorkingPhrase(genericKey, translate);
    })();

    return { activePartType, activeToolName, statusText, isGenericStatus };
};

const encodeParsedStatus = (status: ParsedStatusResult): string => {
    return [
        status.activePartType ?? '',
        status.activeToolName ?? '',
        status.statusText,
        status.isGenericStatus ? '1' : '0',
    ].join(STATUS_SIGNATURE_SEPARATOR);
};

const decodeParsedStatus = (signature: string, translate: TranslateFn): ParsedStatusResult => {
    const [activePartType, activeToolName, statusText, isGenericStatus] = signature.split(STATUS_SIGNATURE_SEPARATOR);
    return {
        activePartType: activePartType === 'text' || activePartType === 'tool' || activePartType === 'reasoning' || activePartType === 'editing'
            ? activePartType
            : undefined,
        activeToolName: activeToolName || undefined,
        statusText: statusText ?? translate('assistantStatus.working'),
        isGenericStatus: isGenericStatus === '1',
    };
};

const isReasoningPart = (part: Part): part is ReasoningPart => part.type === 'reasoning';

const isTextPart = (part: Part): part is TextPart => part.type === 'text';

const getLegacyTextContent = (part: Part): string | undefined => {
    if (isTextPart(part)) {
        return part.text;
    }
    const candidate = part as Partial<{ text?: unknown; content?: unknown; value?: unknown }>;
    if (typeof candidate.text === 'string') {
        return candidate.text;
    }
    if (typeof candidate.content === 'string') {
        return candidate.content;
    }
    if (typeof candidate.value === 'string') {
        return candidate.value;
    }
    return undefined;
};

const getPartTimeInfo = (part: Part): { end?: number } | undefined => {
    if (isTextPart(part) || isReasoningPart(part)) {
        return part.time;
    }
    const candidate = part as Partial<{ time?: { end?: number } }>;
    return candidate.time;
};

const getToolDisplayName = (part: ToolPart): string => {
    if (part.tool) {
        return part.tool;
    }
    const candidate = part as ToolPart & Partial<{ name?: unknown }>;
    return typeof candidate.name === 'string' ? candidate.name : 'tool';
};

export const getActiveAssistantContext = (messages: Message[]): ActiveAssistantContext => {
    let assistantId: string | null = null;
    let parentId: string | null = null;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'assistant') continue;

        const candidate = message as Message & { parentID?: unknown };
        assistantId = message.id;
        parentId = typeof candidate.parentID === 'string' && candidate.parentID.trim().length > 0
            ? candidate.parentID
            : null;
        break;
    }

    if (!assistantId || !parentId) {
        return { assistantId, model: null };
    }

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user' || message.id !== parentId) continue;

        const candidate = message as Message & {
            model?: { providerID?: unknown; modelID?: unknown };
        };
        const providerId = typeof candidate.model?.providerID === 'string'
            ? candidate.model.providerID.trim()
            : '';
        const modelId = typeof candidate.model?.modelID === 'string'
            ? candidate.model.modelID.trim()
            : '';

        return {
            assistantId,
            model: providerId && modelId ? { providerId, modelId } : null,
        };
    }

    return { assistantId, model: null };
};

export function useAssistantStatus(): AssistantStatusSnapshot {
    // The status phrases are translated while the signature is built, so the
    // locale has to take part in the memo: switching language has to rebuild the
    // signature and re-render the status line.
    const { t, locale } = useI18n();
    // Inside the chat column, follow the session the timeline shows rather
    // than the live selection, so the status chip changes together with the
    // conversation instead of a commit ahead of it.
    const chatColumnSession = useChatColumnSession();
    const liveSessionId = useSessionUIStore((state) => state.currentSessionId);
    const liveSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
    const currentSessionId = chatColumnSession ? chatColumnSession.sessionId : liveSessionId;
    const currentSessionDirectory = chatColumnSession ? chatColumnSession.directory : liveSessionDirectory;

    const rawSessionMessages = useSessionMessages(
        currentSessionId ?? '',
        currentSessionDirectory ?? undefined,
    );

    const activeAssistant = React.useMemo(
        () => getActiveAssistantContext(rawSessionMessages),
        [rawSessionMessages],
    );
    const lastAssistantId = activeAssistant.assistantId;

    const lastAssistantStatusSignature = useDirectorySync(
        React.useCallback((state) => {
            const genericKey = `${currentSessionId ?? ''}:${lastAssistantId ?? ''}`;
            const parts = lastAssistantId ? (state.part[lastAssistantId] ?? EMPTY_PARTS) : EMPTY_PARTS;
            return encodeParsedStatus(createParsedStatus(parts, genericKey, t));
        }, [currentSessionId, lastAssistantId, locale]),
        currentSessionDirectory ?? undefined,
    );

    const sessionPermissionRequests = useSessionPermissions(currentSessionId ?? '', currentSessionDirectory ?? undefined);
    const sessionQuestionRequests = useSessionQuestions(currentSessionId ?? '', currentSessionDirectory ?? undefined);

    const sessionAbortRecord = useSessionUIStore(
        React.useCallback((state) => {
            if (!currentSessionId) {
                return null;
            }
            return state.sessionAbortFlags?.get(currentSessionId) ?? null;
        }, [currentSessionId])
    );

    const { phase: activityPhase, isWorking: isPhaseWorking } = useCurrentSessionActivity();

    const currentSessionStatus = useSessionStatus(currentSessionId ?? '', currentSessionDirectory ?? undefined);

    const sessionRetryAttempt = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; attempt?: number }).attempt
        : undefined;

    const sessionRetryNext = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; next?: number }).next
        : undefined;

    const parsedStatus = React.useMemo<ParsedStatusResult>(() => {
        return decodeParsedStatus(lastAssistantStatusSignature, t);
    }, [lastAssistantStatusSignature, t]);

    const abortState = React.useMemo(() => {
        const hasActiveAbort = Boolean(sessionAbortRecord && !sessionAbortRecord.acknowledged);
        return { wasAborted: hasActiveAbort, abortActive: hasActiveAbort };
    }, [sessionAbortRecord]);

    const baseWorking = React.useMemo<WorkingSummary>(() => {

        if (abortState.wasAborted) {
            return {
                ...DEFAULT_WORKING,
                wasAborted: true,
                abortActive: abortState.abortActive,
                activity: 'idle',
                hasWorkingContext: false,
                isWorking: false,
                isStreaming: false,
                isCooldown: false,
                statusText: null,
                canAbort: false,
                retryInfo: null,
            };
        }

        const isWorking = isPhaseWorking;
        const isStreaming = activityPhase === 'busy';
        const isCooldown = false;
        const isRetry = activityPhase === 'retry';

        let activity: AssistantActivity = 'idle';
        if (isWorking) {
            if (parsedStatus.activePartType === 'tool' || parsedStatus.activePartType === 'editing') {
                activity = 'tooling';
            } else {
                activity = isCooldown ? 'cooldown' : 'streaming';
            }
        }

        const retryInfo = isRetry
            ? { attempt: sessionRetryAttempt, next: sessionRetryNext }
            : null;

        return {
            activity,
            hasWorkingContext: isWorking,
            hasActiveTools: parsedStatus.activePartType === 'tool' || parsedStatus.activePartType === 'editing',
            isWorking,
            isStreaming,
            isCooldown,
            lifecyclePhase: isStreaming ? 'streaming' : isCooldown ? 'cooldown' : null,
            statusText: isWorking ? parsedStatus.statusText : null,
            isGenericStatus: isWorking ? parsedStatus.isGenericStatus : true,
            isWaitingForPermission: false,
            canAbort: isWorking,
            compactionDeadline: null,
            activePartType: isWorking ? parsedStatus.activePartType : undefined,
            activeToolName: isWorking ? parsedStatus.activeToolName : undefined,
            wasAborted: false,
            abortActive: false,
            lastCompletionId: null,
            isComplete: false,
            retryInfo,
        };
    }, [activityPhase, isPhaseWorking, parsedStatus, abortState, sessionRetryAttempt, sessionRetryNext]);

    const forming = React.useMemo<FormingSummary>(() => {
        const isActive = isPhaseWorking && parsedStatus.activePartType === 'text';
        return { isActive, characterCount: 0 };
    }, [isPhaseWorking, parsedStatus.activePartType]);

    const working = React.useMemo<WorkingSummary>(() => {
        if (baseWorking.wasAborted || baseWorking.abortActive) {
            return baseWorking;
        }

        const hasPendingPermission = sessionPermissionRequests.length > 0;
        const hasPendingQuestion = sessionQuestionRequests.length > 0;

        if (!hasPendingPermission && !hasPendingQuestion) {
            return baseWorking;
        }

        if (hasPendingQuestion) {
            return {
                ...baseWorking,
                statusText: null,
                isWorking: false,
                hasWorkingContext: false,
                hasActiveTools: false,
                canAbort: false,
                activePartType: undefined,
                activeToolName: undefined,
                retryInfo: null,
            };
        }

        return {
            ...baseWorking,
            statusText: 'waiting for permission',
            isWaitingForPermission: true,
            canAbort: false,
            retryInfo: null,
        };
    }, [baseWorking, sessionPermissionRequests, sessionQuestionRequests]);

    return {
        activeModel: activeAssistant.model,
        forming,
        working,
    };
}
