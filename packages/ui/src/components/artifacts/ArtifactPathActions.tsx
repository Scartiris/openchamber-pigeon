import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useArtifactPathStatus } from '@/lib/artifacts/useArtifactPath';
import type { ArtifactRecord } from '@/lib/artifacts/client';

type Variant = 'compact' | 'card' | 'row';

export type ArtifactPathActionsProps = {
  path: string;
  directory?: string | null;
  variant?: Variant;
  title?: string;
  className?: string;
  showPath?: boolean;
  size?: 'xs' | 'sm';
  onCollected?: (artifact: ArtifactRecord, created: boolean) => void | Promise<void>;
};

/**
 * Shared collect / version-status chrome for chat delivery cards, toolbars,
 * and the candidate inbox. Collect is primary when the path is not yet in the
 * center; already-collected paths show version status and open the center.
 */
export function ArtifactPathActions({
  path,
  directory,
  variant = 'compact',
  title,
  className,
  showPath = false,
  size = 'xs',
  onCollected,
}: ArtifactPathActionsProps): React.ReactNode {
  const { t } = useI18n();
  const { artifact, versionCount, collect, loading } = useArtifactPathStatus(path, { directory });
  const [busy, setBusy] = React.useState(false);
  const openCenter = useUIStore((state) => state.setArtifactCenterOpen);
  const fileName = React.useMemo(() => path.split(/[/\\]/).pop() || path, [path]);

  const onCollect = React.useCallback(async () => {
    setBusy(true);
    try {
      const result = await collect();
      toast.success(
        result.created
          ? t('artifacts.toast.collected')
          : t('artifacts.toast.alreadyCollected'),
      );
      await onCollected?.(result.artifact, result.created);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [collect, onCollected, t]);

  const collected = Boolean(artifact);
  const versionLabel = !collected
    ? t('artifacts.status.notCollected')
    : versionCount === null || versionCount === undefined
      ? t('artifacts.status.collected')
      : t('artifacts.status.collectedVersions', { count: versionCount });

  const collectButton = (
    <Button
      type="button"
      variant={variant === 'card' ? 'default' : 'outline'}
      size={size}
      disabled={busy || loading}
      onClick={() => void onCollect()}
      className={cn(variant === 'card' && 'h-7 gap-1 px-2')}
    >
      <Icon name="inbox-archive" className="size-3.5" />
      {t('artifacts.actions.collect')}
    </Button>
  );

  const openCenterButton = (
    <Button
      type="button"
      variant="secondary"
      size={size}
      onClick={() => openCenter(true)}
      className={cn(variant === 'card' && 'h-7 gap-1 px-2')}
    >
      <Icon name="stack" className="size-3.5" />
      {variant === 'card' ? t('artifacts.actions.openCenter') : versionLabel}
    </Button>
  );

  if (variant === 'card') {
    return (
      <div
        className={cn(
          'mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-[var(--surface-elevated)] px-2.5 py-2',
          className,
        )}
      >
        <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-primary/10 text-primary">
          <Icon name="stack" className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <FileTypeIcon filePath={path} className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate typography-ui-label text-foreground">{title ?? fileName}</span>
          </div>
          {showPath ? (
            <div className="truncate typography-micro text-muted-foreground" title={path}>
              {path}
            </div>
          ) : null}
          <div className="typography-micro text-muted-foreground">{versionLabel}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {collected ? openCenterButton : collectButton}
        </div>
      </div>
    );
  }

  if (variant === 'row') {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <FileTypeIcon filePath={path} className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate typography-ui-label text-foreground">{title ?? fileName}</span>
          </div>
          <div className="truncate typography-micro text-muted-foreground">{versionLabel}</div>
        </div>
        {collected ? openCenterButton : collectButton}
      </div>
    );
  }

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      {collected ? (
        <Button
          type="button"
          variant="secondary"
          size={size}
          onClick={() => openCenter(true)}
          title={t('artifacts.actions.openCenter')}
        >
          <Icon name="stack" className="size-3.5" />
          <span className="hidden sm:inline">{versionLabel}</span>
          <span className="sm:hidden">{t('artifacts.actions.openCenterShort')}</span>
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size={size}
          disabled={busy || loading}
          onClick={() => void onCollect()}
          title={t('artifacts.actions.collect')}
          aria-label={t('artifacts.actions.collect')}
        >
          <Icon name="inbox-archive" className="size-3.5" />
          <span className="hidden sm:inline">{t('artifacts.actions.collect')}</span>
        </Button>
      )}
    </div>
  );
}
