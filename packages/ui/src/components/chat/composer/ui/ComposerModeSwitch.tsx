/**
 * The composer's mode switch: 施工 / 计划 / 聊天, one position each.
 *
 * The switch is a view of the session's agent, not a second source of truth: it
 * reads its position from the session's effective agent and a click writes through
 * `setAgent` — the same path the model controls use, including the model that
 * belongs to the agent and the per-session persistence. The two special agents are
 * kept out of the agent lists (`lib/composerModes.ts`), so this is the only way to
 * reach them.
 *
 * Desktop only. On mobile the composer's own agent button (`MobileAgentButton`)
 * stays the agent control, because the footer has to remain thumb-sized; the plan
 * surfaces themselves follow the gate on every runtime.
 */

import React from 'react';

import { Button } from '@/components/ui/button';
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

  return (
    <div
      role="group"
      aria-label={t('chat.composerMode.label')}
      className="flex items-center gap-x-0.5 rounded-full border border-border/60 p-0.5"
      data-composer-mode-switch="true"
    >
      {MODES.map((candidate) => {
        const active = candidate === mode;
        const available = availability[candidate];
        const label = t(LABEL_KEY[candidate]);

        return (
          <Tooltip key={candidate}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="chip"
                size="xs"
                // Kept focusable and hoverable when unavailable so the tooltip can
                // explain why; the click is a no-op either way.
                aria-disabled={!available}
                aria-pressed={active}
                onClick={() => selectMode(candidate)}
                className={cn('border-transparent', !available && 'opacity-40')}
              >
                {label}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
              {available
                ? t(DESCRIPTION_KEY[candidate])
                : t('chat.composerMode.unavailable', { mode: label })}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
});
