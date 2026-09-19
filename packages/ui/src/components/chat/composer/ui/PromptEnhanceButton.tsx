/**
 * One-click prompt enhancement, in the composer's own footer row.
 *
 * The button owns no state: it reports a press and reflects the two facts the
 * composer knows — whether there is a draft worth rewriting, and whether a
 * rewrite is already running. `usePromptEnhance` owns the request, the
 * replacement and the toasts.
 *
 * It stays visible while the composer is empty, disabled rather than hidden:
 * a control that appears only once you have typed explains itself to nobody.
 * Both footer layouts carry it — desktop in its toggle row, mobile beside the
 * microphone — and BTW hides it with the rest of the composer's own actions,
 * because the rewrite follows the main session's model.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type PromptEnhanceButtonProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    /** There is a draft to rewrite and the composer is editable. */
    canEnhance: boolean;
    isEnhancing: boolean;
    onEnhance: () => void;
    withTooltip?: boolean;
};

export const PromptEnhanceButton = React.memo(function PromptEnhanceButton(props: PromptEnhanceButtonProps) {
    const { footerIconButtonClass, iconSizeClass, canEnhance, isEnhancing, onEnhance, withTooltip = false } = props;
    const { t } = useI18n();

    const label = isEnhancing ? t('chat.promptEnhance.busy') : t('chat.promptEnhance.action');
    const interactive = canEnhance && !isEnhancing;

    const control = (
        <button
            type="button"
            data-prompt-enhance="true"
            className={cn(
                footerIconButtonClass,
                'rounded-md',
                interactive
                    ? 'text-foreground hover:bg-[var(--interactive-hover)]/40'
                    : 'text-muted-foreground',
            )}
            // The rewrite replaces the composer's text, so the caret has to stay
            // in the composer across the press (same guard as the other footer
            // toggles, and it keeps the soft keyboard up on touch devices).
            onMouseDown={(event) => {
                event.preventDefault();
            }}
            onPointerDownCapture={(event) => {
                if (event.pointerType === 'touch') {
                    event.preventDefault();
                }
            }}
            onClick={onEnhance}
            disabled={!interactive}
            aria-label={label}
            aria-busy={isEnhancing}
        >
            <Icon
                name={isEnhancing ? 'loader-4' : 'sparkling'}
                className={cn(iconSizeClass, isEnhancing && 'animate-spin')}
            />
        </button>
    );

    if (!withTooltip) {
        return control;
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                {control}
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                {label}
            </TooltipContent>
        </Tooltip>
    );
});
