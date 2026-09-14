import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n, getCurrentIntlLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useTokenUsageStore } from '@/stores/useTokenUsageStore';
import type { TokenUsageSnapshot, TokenUsageWindow } from '@/lib/tokenUsage/aggregate';

const PERIODS = ['today', 'last7Days', 'last30Days'] as const;
type Period = (typeof PERIODS)[number];

const formatCompactTokens = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  return new Intl.NumberFormat(getCurrentIntlLocale(), {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
};

const formatFullTokens = (value: number): string =>
  new Intl.NumberFormat(getCurrentIntlLocale()).format(Math.round(value));

const formatPercent = (value: number): string =>
  new Intl.NumberFormat(getCurrentIntlLocale(), {
    maximumFractionDigits: 1,
  }).format(value);

const HEADER_BUTTON_CLASS =
  'app-region-no-drag inline-flex h-8 items-center justify-center gap-1 rounded-md px-2 typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:bg-interactive-hover transition-colors';

type StatRowProps = {
  label: string;
  value: string;
};

const StatRow: React.FC<StatRowProps> = ({ label, value }) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="typography-ui-label text-muted-foreground">{label}</span>
    <span className="typography-ui-label font-medium tabular-nums text-foreground">{value}</span>
  </div>
);

type ModelBreakdownProps = {
  window: TokenUsageWindow;
};

const ModelBreakdown: React.FC<ModelBreakdownProps> = ({ window }) => {
  const { t } = useI18n();

  if (window.models.length === 0) {
    return (
      <p className="typography-ui-label text-muted-foreground">
        {t('tokenUsage.dialog.empty')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {window.models.map((model) => {
        const inputProcessed = model.inputProcessed;
        const hitPercent = inputProcessed > 0
          ? Math.min(100, Math.max(0, (model.cacheRead / inputProcessed) * 100))
          : 0;
        const label = model.modelID === 'unknown' && model.providerID === 'unknown'
          ? t('tokenUsage.dialog.unknownModel')
          : `${model.providerID}/${model.modelID}`;
        return (
          <div key={model.key} className="rounded-lg border border-border/60 bg-[var(--surface-muted)] p-3">
            <div className="mb-2 flex items-start justify-between gap-2">
              <span className="truncate typography-ui-label font-medium text-foreground" title={label}>
                {label}
              </span>
              <span className="shrink-0 tabular-nums typography-ui-label font-medium text-foreground">
                {formatCompactTokens(model.total)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
              <StatRow label={t('tokenUsage.stats.input')} value={formatCompactTokens(model.input)} />
              <StatRow label={t('tokenUsage.stats.output')} value={formatCompactTokens(model.output)} />
              <StatRow label={t('tokenUsage.stats.reasoning')} value={formatCompactTokens(model.reasoning)} />
              <StatRow label={t('tokenUsage.stats.cacheRead')} value={formatCompactTokens(model.cacheRead)} />
              <StatRow label={t('tokenUsage.stats.cacheWrite')} value={formatCompactTokens(model.cacheWrite)} />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${inputProcessed > 0 ? Math.max(1, hitPercent) : 0}%` }}
                />
              </div>
              <span className="typography-meta tabular-nums text-muted-foreground">
                {t('tokenUsage.dialog.cacheHitValue', { percent: formatPercent(hitPercent) })}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};

type TokenUsageDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: TokenUsageSnapshot | null;
  period: Period;
  onPeriodChange: (period: Period) => void;
  error: string | null;
  onRefresh: () => void;
  refreshing: boolean;
};

const TokenUsageDialog: React.FC<TokenUsageDialogProps> = ({
  open,
  onOpenChange,
  snapshot,
  period,
  onPeriodChange,
  error,
  onRefresh,
  refreshing,
}) => {
  const { t } = useI18n();
  const window = snapshot?.[period] ?? null;
  const periodLabelKey = {
    today: 'tokenUsage.period.today',
    last7Days: 'tokenUsage.period.last7Days',
    last30Days: 'tokenUsage.period.last30Days',
  } as const;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-4">
        <DialogHeader>
          <DialogTitle>{t('tokenUsage.dialog.title')}</DialogTitle>
          <DialogDescription>{t('tokenUsage.dialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1">
          {PERIODS.map((entry) => (
            <Button
              key={entry}
              type="button"
              size="xs"
              variant="chip"
              aria-pressed={period === entry}
              onClick={() => onPeriodChange(entry)}
            >
              {t(periodLabelKey[entry])}
            </Button>
          ))}
          <div className="flex-1" />
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label={t('tokenUsage.dialog.refreshAria')}
          >
            <Icon name="loader-4" className={cn('mr-1 size-3.5', refreshing && 'animate-spin')} />
            {t('tokenUsage.dialog.refresh')}
          </Button>
        </div>

        {error ? (
          <p className="typography-ui-label text-status-error">{error}</p>
        ) : null}

        {window ? (
          <>
            <div className="rounded-lg border border-border/60 bg-[var(--surface-muted)] p-3">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <span className="typography-ui-label text-muted-foreground">
                  {t(periodLabelKey[period])}
                </span>
                <span className="text-lg font-semibold tabular-nums text-foreground">
                  {formatFullTokens(window.total)}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                <StatRow label={t('tokenUsage.stats.input')} value={formatFullTokens(window.input)} />
                <StatRow label={t('tokenUsage.stats.output')} value={formatFullTokens(window.output)} />
                <StatRow label={t('tokenUsage.stats.reasoning')} value={formatFullTokens(window.reasoning)} />
                <StatRow label={t('tokenUsage.stats.cacheRead')} value={formatFullTokens(window.cacheRead)} />
                <StatRow label={t('tokenUsage.stats.cacheWrite')} value={formatFullTokens(window.cacheWrite)} />
                <StatRow
                  label={t('tokenUsage.stats.cacheHit')}
                  value={window.hasCacheInput
                    ? `${formatPercent(window.cacheHitPercent)}%`
                    : '—'}
                />
                <StatRow
                  label={t('tokenUsage.stats.messages')}
                  value={formatFullTokens(window.messages)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="typography-ui-label font-medium text-foreground">
                {t('tokenUsage.dialog.byModel')}
              </h3>
              <ModelBreakdown window={window} />
            </div>

            {snapshot && snapshot.failedSessions > 0 ? (
              <p className="typography-meta text-muted-foreground">
                {t('tokenUsage.dialog.partial', {
                  failed: snapshot.failedSessions,
                  scanned: snapshot.scannedSessions,
                })}
              </p>
            ) : null}
          </>
        ) : (
          <p className="typography-ui-label text-muted-foreground">{t('tokenUsage.dialog.loading')}</p>
        )}
      </DialogContent>
    </Dialog>
  );
};

/**
 * Compact today's-token chip in the desktop header. Click opens the
 * today / 7-day / monthly breakdown by model and cache hit.
 */
export const HeaderTokenUsage: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [period, setPeriod] = React.useState<Period>('today');
  const snapshot = useTokenUsageStore((state) => state.snapshot);
  const status = useTokenUsageStore((state) => state.status);
  const error = useTokenUsageStore((state) => state.error);
  const ensureLoaded = useTokenUsageStore((state) => state.ensureLoaded);

  React.useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    void ensureLoaded({ force: true });
  }, [open, ensureLoaded]);

  const todayTotal = snapshot?.today.total ?? 0;
  const loading = status === 'loading' && !snapshot;
  const displayValue = loading
    ? '…'
    : formatCompactTokens(todayTotal);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(HEADER_BUTTON_CLASS, className)}
            aria-label={t('tokenUsage.header.aria')}
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
          >
            <Icon name="bar-chart-box" className="h-[16px] w-[16px] text-muted-foreground" />
            <span className="tabular-nums">{displayValue}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{t('tokenUsage.header.tooltip', { tokens: formatCompactTokens(todayTotal) })}</p>
        </TooltipContent>
      </Tooltip>
      <TokenUsageDialog
        open={open}
        onOpenChange={setOpen}
        snapshot={snapshot}
        period={period}
        onPeriodChange={setPeriod}
        error={error}
        onRefresh={() => {
          void ensureLoaded({ force: true });
        }}
        refreshing={status === 'loading'}
      />
    </>
  );
};
