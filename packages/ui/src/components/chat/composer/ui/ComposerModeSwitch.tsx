/**
 * The composer's mode switch: 施工 / 计划 / 聊天, shown as the current mode's name
 * on the left and a small slider on the right.
 *
 * The switch is a view of the session's agent, not a second source of truth: it
 * reads its position from the session's effective agent and choosing a stop writes
 * through `setAgent` — the same path the model controls use, including the model
 * that belongs to the agent and the per-session persistence. The two special agents
 * are kept out of the agent lists (`lib/composerModes.ts`), so this is the only way
 * to reach them.
 *
 * Desktop only. On mobile the composer's own agent button (`MobileAgentButton`)
 * stays the agent control, because the footer has to remain thumb-sized; the plan
 * surfaces themselves follow the gate on every runtime.
 */

import React from 'react';

import { SegmentedSlider } from '@/components/ui/segmented-slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useComposerMode } from '@/hooks/useComposerMode';
import type { ComposerMode } from '@/lib/composerModes';
import { type I18nKey, useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** Left to right, as the user reads them. */
const MODES: readonly ComposerMode[] = ['build', 'plan', 'chat'];

const LABEL_KEY = {
  build: 'chat.composerMode.build',
  plan: 'chat.composerMode.plan',
  chat: 'chat.composerMode.chat',
} satisfies Record<ComposerMode, I18nKey>;

const DESCRIPTION_KEY = {
  build: 'chat.composerMode.buildDescription',
  plan: 'chat.composerMode.planDescription',
  chat: 'chat.composerMode.chatDescription',
} satisfies Record<ComposerMode, I18nKey>;

type ComposerModeSwitchProps = {
  sessionId: string | null;
};

export const ComposerModeSwitch = React.memo(function ComposerModeSwitch(props: ComposerModeSwitchProps) {
  const { sessionId } = props;
  const { t } = useI18n();
  const { mode, availability, ownsCurrentSession, selectMode } = useComposerMode(sessionId);

  // An embedded chat column addresses another session; `setAgent` would persist
  // the choice against the session the app is showing.
  if (!ownsCurrentSession) return null;

  const currentLabel = t(LABEL_KEY[mode]);
  const currentDescription = availability[mode]
    ? t(DESCRIPTION_KEY[mode])
    : t('chat.composerMode.unavailable', { mode: currentLabel });

  return (
    <div className="flex items-center gap-x-2" data-composer-mode-switch="true">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'typography-ui-label select-none',
              mode === 'build' ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {currentLabel}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>
          {currentDescription}
        </TooltipContent>
      </Tooltip>
      <SegmentedSlider
        ariaLabel={t('chat.composerMode.label')}
        value={mode}
        onChange={selectMode}
        options={MODES.map((candidate) => ({
          value: candidate,
          label: availability[candidate]
            ? `${t(LABEL_KEY[candidate])} — ${t(DESCRIPTION_KEY[candidate])}`
            : t('chat.composerMode.unavailable', { mode: t(LABEL_KEY[candidate]) }),
          disabled: !availability[candidate],
        }))}
        // 3 stops × 20px = a 60px track: one thumb wide enough to read as a
        // position, small enough to sit in the footer next to the label.
        thumbClassName="h-4 w-5"
        trackClassName="h-5"
      />
    </div>
  );
});
