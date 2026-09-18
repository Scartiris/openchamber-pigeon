/**
 * Plan mode as a switch, in the composer's own footer row.
 *
 * The switch is a view of the session's agent, not a second source of truth:
 * it reads its position from the session's effective agent and a click writes
 * through `setAgent` — the same path the model controls use, including the
 * model that belongs to the agent and the per-session persistence. Turning it
 * off returns to the agent this session used before plan mode.
 *
 * Desktop only. On mobile the composer's own agent button (`MobileAgentButton`)
 * stays the single agent control, because the footer has to remain thumb-sized;
 * the plan-mode surfaces themselves follow the gate on every runtime.
 */

import React from 'react';

import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePlanModeSwitch } from '@/hooks/usePlanModeSwitch';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type PlanModeSwitchButtonProps = {
  sessionId: string | null;
  withTooltip?: boolean;
};

export const PlanModeSwitchButton = React.memo(function PlanModeSwitchButton(props: PlanModeSwitchButtonProps) {
  const { sessionId, withTooltip = false } = props;
  const { t } = useI18n();
  const { enabled, available, ownsCurrentSession, onToggle } = usePlanModeSwitch(sessionId);

  // An embedded chat column addresses another session; `setAgent` would persist
  // the choice against the session the app is showing.
  if (!ownsCurrentSession) return null;

  const label = t('chat.planMode.label');
  const ariaLabel = enabled ? t('chat.planMode.disable') : t('chat.planMode.enable');
  const description = available ? t('chat.planMode.description') : t('chat.planMode.unavailable');

  const control = (
    <div className="flex items-center gap-x-1.5" data-plan-mode-switch="true">
      <Switch
        id="oc-plan-mode-switch"
        checked={enabled}
        disabled={!available}
        onCheckedChange={() => onToggle()}
        aria-label={ariaLabel}
        // Base UI marks a disabled switch with `data-disabled`, which the
        // shared primitive's `disabled:` variants do not match; without this
        // an unavailable switch still reads as clickable.
        className="data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
      />
      <label
        htmlFor="oc-plan-mode-switch"
        className={cn(
          'typography-ui-label select-none',
          enabled ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {label}
      </label>
    </div>
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
        {description}
      </TooltipContent>
    </Tooltip>
  );
});
