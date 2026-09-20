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

import type { IconName } from '@/components/icon/icons';
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

/**
 * What each position does, in one glyph — the slider has no room for words, so
 * these are the only thing marking the positions the thumb is *not* on.
 * The names follow the ones this codebase already uses for these ideas: `hammer`
 * for build (`lib/projectActions.ts`), `file-text` for a plan document
 * (`ContextPanel`), `chat-4` for a plain conversation.
 *
 * Each name is its own `IconName` constant rather than a literal inside the map
 * because the sprite generator scans that shape (and `: Record<…IconName…>`) for
 * icon literals — a bare `satisfies Record<…, IconName>` record is invisible to
 * it, so an icon referenced *only* here would silently vanish from a regenerated
 * sprite and render as a blank `<use>`. The `satisfies` on the map itself keeps
 * the compiler checking that every mode has an entry.
 */
const BUILD_MODE_ICON: IconName = 'hammer';
const PLAN_MODE_ICON: IconName = 'file-text';
const CHAT_MODE_ICON: IconName = 'chat-4';

const MODE_ICON = {
  build: BUILD_MODE_ICON,
  plan: PLAN_MODE_ICON,
  chat: CHAT_MODE_ICON,
} satisfies Record<ComposerMode, IconName>;

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
          icon: MODE_ICON[candidate],
          label: availability[candidate]
            ? `${t(LABEL_KEY[candidate])} — ${t(DESCRIPTION_KEY[candidate])}`
            : t('chat.composerMode.unavailable', { mode: t(LABEL_KEY[candidate]) }),
          disabled: !availability[candidate],
        }))}
        // Sized to the footer's own controls, which are `h-6 w-6` buttons with
        // `h-[18px] w-[18px]` icons (`ChatInput.tsx`). Anything smaller read as a
        // shrunken control next to them — the glyphs were legible in isolation
        // and too small in place, which is the only place that counts.
        // One stop is 24×24, so the track is 3 stops + 2px padding + 1px border
        // on each side = 78×30px: wider than before, but still narrower than the
        // three footer buttons it sits beside, and every stop keeps a real hit
        // area. The thumb takes its size from the stop, so it can never overflow
        // onto the controls next to it.
        // 30px cannot grow the footer row: that row is `flex items-center` with no
        // fixed height, and its other group already holds the model control's `h-8`
        // trigger (`ModelControls.tsx`), so the row is 32px with or without us.
        stopClassName="h-6 w-6"
        className="h-[30px]"
        // The same 18px the footer's other icons use, so the switch reads as one
        // of them rather than as a smaller cousin.
        iconClassName="h-[18px] w-[18px]"
      />
    </div>
  );
});
