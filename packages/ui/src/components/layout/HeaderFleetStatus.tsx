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
import { useI18n, type I18nKey, type I18nParams } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useFleetStore } from '@/stores/useFleetStore';
import { updateDeviceApproval } from '@/lib/fleet/client';
import {
  EMPTY_VALUE,
  deviceErrorTextKey,
  formatBytes,
  formatCores,
  formatPercent,
  formatRate,
  formatUptime,
  severityDotClass,
  severityOfPercent,
  severityTextClass,
  shortSha,
  toAgeSeconds,
} from '@/lib/fleet/format';
import type { FleetDeviceRow, FleetHost, FleetSeverity } from '@/lib/fleet/types';

/**
 * Header chip for the fleet: the workbench host plus every registered device.
 *
 * Two rules this panel follows on purpose:
 *  - a missing reading renders as `—`, never as 0, and a stale one says how old
 *    it is — a monitoring surface that hides staleness is worse than none;
 *  - the host network column only exists when the server runs the
 *    `oc-host-metrics` helper, because a container cannot see the host's NICs.
 *    When it is absent the panel says so instead of drawing the container's own
 *    traffic as if it were the host's.
 */

const HEADER_BUTTON_CLASS = 'app-region-no-drag inline-flex h-8 items-center justify-center gap-1 rounded-md px-2 typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:bg-interactive-hover transition-colors';

const POLL_INTERVAL_MS = 30 * 1000;

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

const MeterBar: React.FC<{ percent: number | null; severity: FleetSeverity }> = ({ percent, severity }) => (
  <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
    <div
      className={cn('h-full rounded-full', severityDotClass(severity))}
      style={{ width: `${percent === null ? 0 : clampPercent(percent)}%` }}
    />
  </div>
);

const MetricLine: React.FC<{ label: string; value: React.ReactNode; tone?: string }> = ({ label, value, tone }) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="typography-meta shrink-0 text-muted-foreground">{label}</span>
    <span className={cn('truncate typography-ui-label font-medium tabular-nums', tone ?? 'text-foreground')}>{value}</span>
  </div>
);

const NetworkLines: React.FC<{ host: { network: FleetHost['network']; notes?: string[] }; unavailableLabel: string; hint?: string }> = ({ host, unavailableLabel, hint }) => {
  const interfaces = host.network?.interfaces ?? [];
  if (interfaces.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <MetricLine label="network" value={unavailableLabel} tone="text-muted-foreground" />
        {hint ? <p className="typography-micro text-muted-foreground">{hint}</p> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {interfaces.slice(0, 4).map((iface) => (
        <MetricLine
          key={iface.name}
          label={iface.name}
          value={`↓ ${formatRate(iface.rxBytesPerSec)} ↑ ${formatRate(iface.txBytesPerSec)}`}
        />
      ))}
    </div>
  );
};

const APPROVAL_MODES = ['deny', 'smart', 'auto'] as const;
type ApprovalMode = (typeof APPROVAL_MODES)[number];

const isApprovalMode = (value: string): value is ApprovalMode =>
  value === 'deny' || value === 'smart' || value === 'auto';

/** Reuses the settings page's labels so both surfaces name the modes identically. */
const APPROVAL_LABELS = {
  deny: 'settings.devices.approval.deny',
  smart: 'settings.devices.approval.smart',
  auto: 'settings.devices.approval.auto',
} as const satisfies Record<ApprovalMode, I18nKey>;

const CollapseToggle: React.FC<{
  expanded: boolean;
  label: string;
  onToggle: () => void;
  t: (key: I18nKey, params?: I18nParams) => string;
}> = ({ expanded, label, onToggle, t }) => (
  <button
    type="button"
    onClick={onToggle}
    aria-expanded={expanded}
    aria-label={expanded ? t('fleet.devices.collapse', { name: label }) : t('fleet.devices.expand', { name: label })}
    className="app-region-no-drag inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
  >
    <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-4" />
  </button>
);

const HostSection: React.FC<{
  host: FleetHost;
  expanded: boolean;
  onToggle: () => void;
  t: (key: I18nKey, params?: I18nParams) => string;
}> = ({ host, expanded, onToggle, t }) => {
  const memory = host.memory;
  const ageText = toAgeSeconds(host.ageMs);
  const networkUnavailable = host.notes.includes('network-unavailable') || !host.network;
  const worstDiskPercent = host.disks.reduce<number | null>((worst, disk) => (
    disk.usedPercent !== null && (worst === null || disk.usedPercent > worst) ? disk.usedPercent : worst
  ), null);
  // Collapsed still has to be informative: the headline carries the two numbers
  // people actually watch, or the reason there are none.
  const headline = memory
    ? `${t('fleet.metric.memory')} ${formatPercent(memory.usedPercent)} · ${t('fleet.metric.disk')} ${formatPercent(worstDiskPercent)}`
    : (host.error || t('fleet.header.tooltip.unavailable'));

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border/60 bg-[var(--surface-muted)] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CollapseToggle expanded={expanded} label={host.hostname || t('fleet.section.host')} onToggle={onToggle} t={t} />
          <Icon name="server" className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate typography-ui-label font-semibold text-foreground">
            {host.hostname || t('fleet.section.host')}
          </span>
          {host.platform ? (
            <span className="shrink-0 typography-micro text-muted-foreground">{host.platform}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {ageText !== null ? (
            <span className="typography-micro text-muted-foreground">
              {t('fleet.dialog.checkedAt', { seconds: ageText })}
            </span>
          ) : null}
          <span className={cn('size-2 rounded-full', severityDotClass(host.stale ? 'warn' : 'ok'))} />
        </div>
      </div>

      <p className={cn('truncate typography-micro', host.ok ? 'text-muted-foreground' : 'text-status-error')} title={headline}>
        {headline}
      </p>

      {expanded && !host.ok ? (
        <p className="typography-ui-label text-status-error">
          {host.error || t('fleet.header.tooltip.unavailable')}
        </p>
      ) : null}

      {expanded ? (
        <>
          {memory ? (
            <div className="flex flex-col gap-1.5">
              <MetricLine
                label={t('fleet.metric.memory')}
                value={memory.totalBytes === null
                  ? EMPTY_VALUE
                  : `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)} (${formatPercent(memory.usedPercent)})`}
                tone={severityTextClass(severityOfPercent(memory.usedPercent))}
              />
              <MeterBar percent={memory.usedPercent} severity={severityOfPercent(memory.usedPercent)} />
            </div>
          ) : null}

          {memory && (memory.swapTotalBytes ?? 0) > 0 ? (
            <div className="flex flex-col gap-1.5">
              <MetricLine
                label={t('fleet.metric.swap')}
                value={`${formatBytes(memory.swapUsedBytes)} / ${formatBytes(memory.swapTotalBytes)} (${formatPercent(memory.swapUsedPercent)})`}
                tone={severityTextClass(severityOfPercent(memory.swapUsedPercent))}
              />
              <MeterBar percent={memory.swapUsedPercent} severity={severityOfPercent(memory.swapUsedPercent)} />
            </div>
          ) : null}

          {host.disks.map((disk) => (
            <div key={`${disk.mount}-${disk.filesystem ?? ''}`} className="flex flex-col gap-1.5">
              <MetricLine
                label={`${t('fleet.metric.disk')} ${disk.mount}`}
                value={`${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)} (${formatPercent(disk.usedPercent)})`}
                tone={severityTextClass(severityOfPercent(disk.usedPercent))}
              />
              <MeterBar percent={disk.usedPercent} severity={severityOfPercent(disk.usedPercent)} />
            </div>
          ))}

          <NetworkLines
            host={host}
            unavailableLabel={t('fleet.metric.networkUnavailable')}
            hint={networkUnavailable ? t('fleet.hostHelper.hint') : undefined}
          />

          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {host.cpu ? (
              <MetricLine
                label={t('fleet.metric.load')}
                value={host.cpu.load1 === null
                  ? EMPTY_VALUE
                  : `${host.cpu.load1} / ${host.cpu.load5 ?? EMPTY_VALUE} / ${host.cpu.load15 ?? EMPTY_VALUE} · ${formatCores(host.cpu.count)}`}
              />
            ) : null}
            <MetricLine label={t('fleet.metric.uptime')} value={formatUptime(host.uptimeSec)} />
            {host.containersSummary ? (
              <MetricLine
                label={t('fleet.metric.containers')}
                value={`${host.containersSummary.healthy ?? EMPTY_VALUE}/${host.containersSummary.total ?? EMPTY_VALUE}`}
              />
            ) : null}
            {host.deploy?.sha ? (
              <MetricLine label="deploy" value={shortSha(host.deploy.sha) ?? EMPTY_VALUE} />
            ) : null}
          </div>

          {host.containers && host.containers.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {host.containers.map((container) => (
                <span
                  key={container.name}
                  title={container.image ?? undefined}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-1.5 py-0.5 typography-micro',
                    container.health && container.health !== 'healthy'
                      ? 'bg-status-warning/10 text-status-warning'
                      : 'bg-status-success/10 text-status-success',
                  )}
                >
                  <span className={cn('size-1.5 rounded-full', severityDotClass(container.health && container.health !== 'healthy' ? 'warn' : 'ok'))} />
                  {container.name}
                </span>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
};

const DeviceSection: React.FC<{
  row: FleetDeviceRow;
  expanded: boolean;
  approvalBusy: boolean;
  onToggle: () => void;
  onApprovalChange: (approval: ApprovalMode) => void;
  t: (key: I18nKey, params?: I18nParams) => string;
}> = ({ row, expanded, approvalBusy, onToggle, onApprovalChange, t }) => {
  const metrics = row.metrics;
  const ageText = toAgeSeconds(row.metricsAgeMs);
  const worstDiskPercent = metrics
    ? metrics.disks.reduce<number | null>((worst, disk) => (
      disk.usedPercent !== null && (worst === null || disk.usedPercent > worst) ? disk.usedPercent : worst
    ), null)
    : null;
  const headline = metrics
    ? `${t('fleet.metric.memory')} ${formatPercent(metrics.memory?.usedPercent ?? null)} · ${t('fleet.metric.disk')} ${formatPercent(worstDiskPercent)}`
    : t(deviceErrorTextKey(row.error?.code));

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border/60 bg-[var(--surface-muted)] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CollapseToggle expanded={expanded} label={row.name} onToggle={onToggle} t={t} />
          <span className={cn('size-2 shrink-0 rounded-full', severityDotClass(row.online ? 'ok' : 'error'))} />
          <span className="truncate typography-ui-label font-semibold text-foreground">{row.name}</span>
          <span className="shrink-0 typography-micro text-muted-foreground">{row.platform}</span>
          {row.transport ? (
            <span className="shrink-0 typography-micro text-muted-foreground">{row.transport}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 typography-micro text-muted-foreground">
          {row.latencyMs !== null ? <span>{t('fleet.metric.rtt', { ms: row.latencyMs })}</span> : null}
          {ageText !== null ? <span>{t('fleet.dialog.checkedAt', { seconds: ageText })}</span> : null}
          <span>{row.online ? t('fleet.status.online') : t('fleet.status.offline')}</span>
        </div>
      </div>

      <p
        className={cn('truncate typography-micro', metrics ? 'text-muted-foreground' : 'text-status-warning')}
        title={headline}
      >
        {headline}
      </p>

      {expanded ? (
        <>
          {!metrics ? (
            <div className="flex flex-col gap-1">
              <p className="typography-ui-label text-muted-foreground">
                {t(deviceErrorTextKey(row.error?.code))}
              </p>
              {row.error?.message ? (
                <p className="truncate typography-micro text-muted-foreground" title={row.error.message}>
                  {row.error.message}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              {metrics.memory ? (
                <div className="flex flex-col gap-1.5">
                  <MetricLine
                    label={t('fleet.metric.memory')}
                    value={`${formatBytes(metrics.memory.usedBytes)} / ${formatBytes(metrics.memory.totalBytes)} (${formatPercent(metrics.memory.usedPercent)})`}
                    tone={severityTextClass(severityOfPercent(metrics.memory.usedPercent))}
                  />
                  <MeterBar percent={metrics.memory.usedPercent} severity={severityOfPercent(metrics.memory.usedPercent)} />
                </div>
              ) : null}

              {metrics.disks.map((disk) => (
                <div key={`${disk.mount}-${disk.filesystem ?? ''}`} className="flex flex-col gap-1.5">
                  <MetricLine
                    label={`${t('fleet.metric.disk')} ${disk.mount}`}
                    value={`${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)} (${formatPercent(disk.usedPercent)})`}
                    tone={severityTextClass(severityOfPercent(disk.usedPercent))}
                  />
                  <MeterBar percent={disk.usedPercent} severity={severityOfPercent(disk.usedPercent)} />
                </div>
              ))}

              <NetworkLines host={{ network: metrics.network }} unavailableLabel={t('fleet.metric.networkUnavailable')} />

              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <MetricLine label={t('fleet.metric.uptime')} value={formatUptime(metrics.uptimeSec)} />
                {metrics.cpu ? <MetricLine label={t('fleet.metric.load')} value={formatCores(metrics.cpu.count)} /> : null}
              </div>
            </>
          )}

          {/* Approval is per device and lives with the device, not in a settings page. */}
          <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2">
            <label
              className="typography-micro text-muted-foreground"
              htmlFor={`fleet-approval-${row.id}`}
            >
              {t('settings.devices.actions.approval')}
            </label>
            <select
              id={`fleet-approval-${row.id}`}
              className="h-7 rounded-md border border-border bg-transparent px-2 typography-micro text-foreground disabled:opacity-50"
              value={row.approval}
              disabled={approvalBusy}
              onChange={(event) => {
                const next = event.target.value;
                if (isApprovalMode(next)) onApprovalChange(next);
              }}
            >
              {APPROVAL_MODES.map((mode) => (
                <option key={mode} value={mode}>{t(APPROVAL_LABELS[mode])}</option>
              ))}
            </select>
          </div>
        </>
      ) : null}
    </section>
  );
};

export const HeaderFleetStatus: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [hostExpanded, setHostExpanded] = React.useState(true);
  const [expandedDevices, setExpandedDevices] = React.useState<Record<string, boolean>>({});
  const [approvalBusyId, setApprovalBusyId] = React.useState<string | null>(null);
  const [approvalError, setApprovalError] = React.useState<string | null>(null);
  const snapshot = useFleetStore((state) => state.snapshot);
  const status = useFleetStore((state) => state.status);
  const error = useFleetStore((state) => state.error);
  const ensureLoaded = useFleetStore((state) => state.ensureLoaded);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);

  const toggleDevice = React.useCallback((id: string) => {
    setExpandedDevices((current) => ({ ...current, [id]: current[id] !== true }));
  }, []);

  const changeApproval = React.useCallback(async (id: string, approval: ApprovalMode) => {
    setApprovalBusyId(id);
    setApprovalError(null);
    try {
      await updateDeviceApproval(id, approval);
      await ensureLoaded({ force: true });
    } catch (failure) {
      setApprovalError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setApprovalBusyId(null);
    }
  }, [ensureLoaded]);

  React.useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  // Poll only while the tab is visible: a background tab must not keep probing
  // devices every 30 seconds.
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      if (globalThis.document?.visibilityState !== 'visible') return;
      void ensureLoaded();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [ensureLoaded]);

  React.useEffect(() => {
    if (!open) return;
    void ensureLoaded({ force: true });
  }, [open, ensureLoaded]);

  const summary = snapshot?.summary ?? null;
  const hostOk = summary?.hostOk ?? false;
  const devicesTotal = summary?.devicesTotal ?? 0;
  const devicesOnline = summary?.devicesOnline ?? 0;
  const loading = status === 'loading' && !snapshot;
  const chipText = loading
    ? '…'
    : hostOk
      ? `${formatPercent(summary?.hostMemPercent ?? null)} · ${formatPercent(summary?.hostDiskPercent ?? null)}`
      : EMPTY_VALUE;
  const severity: FleetSeverity = snapshot && !error
    ? snapshot.summary.severity
    : (error ? 'error' : 'ok');
  const hostStale = snapshot?.host.stale ?? false;

  const tooltipLines = React.useMemo(() => {
    if (error) return [t('fleet.error.load', { status: error.status ?? '?' })];
    if (!snapshot) return [t('fleet.header.tooltip.title')];
    const lines: string[] = [t('fleet.header.tooltip.title')];
    if (snapshot.host.ok) {
      lines.push(t('fleet.header.tooltip.host', {
        mem: formatPercent(summary?.hostMemPercent ?? null),
        disk: formatPercent(summary?.hostDiskPercent ?? null),
      }));
    } else {
      lines.push(t('fleet.header.tooltip.unavailable'));
    }
    if (devicesTotal > 0) {
      lines.push(t('fleet.header.tooltip.devices', { online: devicesOnline, total: devicesTotal }));
    }
    const ageText = toAgeSeconds(snapshot.host.ageMs);
    if (hostStale && ageText !== null) {
      lines.push(t('fleet.header.tooltip.stale', { seconds: ageText }));
    }
    return lines;
  }, [devicesOnline, devicesTotal, error, hostStale, snapshot, summary?.hostDiskPercent, summary?.hostMemPercent, t]);

  const openDeviceSettings = React.useCallback(() => {
    setOpen(false);
    setSettingsPage('devices');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage]);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-fleet-chip="true"
            className={cn(HEADER_BUTTON_CLASS, className)}
            aria-label={t('fleet.header.aria', {
              mem: formatPercent(summary?.hostMemPercent ?? null),
              disk: formatPercent(summary?.hostDiskPercent ?? null),
              online: devicesOnline,
              total: devicesTotal,
            })}
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
          >
            <Icon name="pulse" className={cn('h-[16px] w-[16px]', error ? 'text-status-error' : 'text-muted-foreground')} />
            <span className="tabular-nums">{chipText}</span>
            {devicesTotal > 0 ? (
              <span className="ml-0.5 inline-flex items-center gap-1 typography-micro text-muted-foreground">
                <span className={cn('size-1.5 rounded-full', severityDotClass(severity))} />
                <span className="tabular-nums">{devicesOnline}/{devicesTotal}</span>
              </span>
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <div className="flex flex-col gap-0.5">
            {tooltipLines.map((line) => <p key={line}>{line}</p>)}
          </div>
        </TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon name="pulse" className="size-4 text-muted-foreground" />
              {t('fleet.dialog.title')}
            </DialogTitle>
            <DialogDescription>{t('fleet.dialog.description')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-1">
            <span className={cn('typography-micro', error ? 'text-status-error' : 'text-muted-foreground')}>
              {error
                ? t(error.code === 'parse' ? 'fleet.error.parse' : 'fleet.error.load', { status: error.status ?? '?' })
                : snapshot?.checkedAt
                  ? t('fleet.dialog.checkedAt', { seconds: toAgeSeconds(snapshot.host.ageMs) ?? 0 })
                  : ''}
            </span>
            <div className="flex-1" />
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => { void ensureLoaded({ force: true }); }}
              disabled={status === 'loading'}
              aria-label={t('fleet.dialog.refresh')}
            >
              <Icon name="loader-4" className={cn('mr-1 size-3.5', status === 'loading' && 'animate-spin')} />
              {status === 'loading' ? t('fleet.dialog.refreshing') : t('fleet.dialog.refresh')}
            </Button>
          </div>

          <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pr-1">
            {snapshot ? (
              <HostSection
                host={snapshot.host}
                expanded={hostExpanded}
                onToggle={() => setHostExpanded((current) => !current)}
                t={t}
              />
            ) : null}

            <div className="flex items-center justify-between gap-2">
              <h3 className="typography-ui-label font-medium text-foreground">
                {t('fleet.section.devices')}
                {snapshot && snapshot.devices.total > 0
                  ? ` · ${snapshot.devices.onlineCount}/${snapshot.devices.total}`
                  : ''}
              </h3>
              <Button type="button" size="xs" variant="ghost" onClick={openDeviceSettings}>
                {t('fleet.devices.openSettings')}
              </Button>
            </div>

            {approvalError ? (
              <p className="typography-micro text-status-error">{approvalError}</p>
            ) : null}

            {snapshot && snapshot.devices.items.length > 0 ? (
              snapshot.devices.items.map((row) => (
                <DeviceSection
                  key={row.id}
                  row={row}
                  expanded={expandedDevices[row.id] === true}
                  approvalBusy={approvalBusyId === row.id}
                  onToggle={() => toggleDevice(row.id)}
                  onApprovalChange={(approval) => { void changeApproval(row.id, approval); }}
                  t={t}
                />
              ))
            ) : (
              <p className="typography-ui-label text-muted-foreground">{t('fleet.devices.empty')}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};
