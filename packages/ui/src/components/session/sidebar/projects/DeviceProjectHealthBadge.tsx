import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { ensureDeviceMount, readDeviceMount, type DeviceMountHealthState, type DeviceMountPayload } from '@/lib/deviceProjects';
import { cn } from '@/lib/utils';

type Props = {
  deviceId: string;
  remotePath: string;
  compact?: boolean;
};

/**
 * Badge for a host-mounted device project: shows mount health and offers remount.
 * Health is `ready` | `mounting` | `disabled` | `absent`.
 */
export const DeviceProjectHealthBadge: React.FC<Props> = ({
  deviceId,
  remotePath,
  compact = false,
}) => {
  const { t } = useI18n();
  const [health, setHealth] = React.useState<DeviceMountHealthState | null>(null);
  const [lastPayload, setLastPayload] = React.useState<DeviceMountPayload | null>(null);
  const [isRemounting, setIsRemounting] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const payload = await readDeviceMount(deviceId);
      setLastPayload(payload);
      setHealth(payload.health.state);
    } catch {
      setHealth('mounting');
    }
  }, [deviceId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRemount = React.useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (isRemounting) return;
    setIsRemounting(true);
    try {
      // Never invent remoteRoot from remotePath: ensure upserts the registry
      // with remoteRoot, so a project subpath would clobber the mount root.
      const remoteRoot = lastPayload?.mount?.remoteRoot || lastPayload?.health.remoteRoot;
      if (!remoteRoot) {
        await refresh();
        return;
      }
      await ensureDeviceMount(deviceId, { remoteRoot, remotePath });
      await refresh();
    } catch {
      setHealth('mounting');
    } finally {
      setIsRemounting(false);
    }
  }, [deviceId, isRemounting, lastPayload, refresh, remotePath]);

  const unavailable = health === 'mounting' || health === 'absent' || health === 'disabled';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 typography-micro',
        unavailable ? 'bg-status-error/15 text-status-error' : 'bg-interactive-hover/40 text-muted-foreground',
      )}
      data-device-project-health={health || 'unknown'}
      title={t('projects.device.badge')}
    >
      <Icon name="computer" className="h-3 w-3" />
      {!compact ? <span>{t('projects.device.badge')}</span> : null}
      {unavailable ? (
        <>
          <span>{t('projects.device.unavailable')}</span>
          <Button
            variant="ghost"
            size="xs"
            className="h-4 px-1 typography-micro"
            disabled={isRemounting}
            onClick={(event) => void handleRemount(event)}
          >
            {isRemounting ? t('projects.device.remounting') : t('projects.device.remount')}
          </Button>
        </>
      ) : null}
    </span>
  );
};
