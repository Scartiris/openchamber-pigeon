import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import {
  disconnectDrive,
  getDriveStatus,
  startDriveAuth,
  type DriveStatus,
} from '@/lib/artifacts/client';

/** Settings → Integrations row for Google Drive cold tier. */
export const GoogleDriveIntegration: React.FC = () => {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<DriveStatus | null>(null);
  const [loading, setLoading] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await getDriveStatus());
    } catch {
      // Unconfigured server is a valid empty-ish state for this row.
      setStatus({ configured: false, connected: false, expiresAt: null });
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const statusLabel = !status?.configured
    ? t('settings.integrations.googleDrive.status.notConfigured')
    : status.connected
      ? t('settings.integrations.googleDrive.status.connected')
      : t('settings.integrations.googleDrive.status.notConnected');

  const onConnect = React.useCallback(async () => {
    setLoading(true);
    try {
      const { authorizeUrl } = await startDriveAuth();
      window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
      toast.success(t('settings.integrations.googleDrive.toast.authOpened'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const onDisconnect = React.useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await disconnectDrive());
      toast.success(t('settings.integrations.googleDrive.toast.disconnected'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [t]);

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
      data-settings-item="integrations.google-drive"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="typography-ui-label font-medium text-foreground">
            {t('settings.integrations.googleDrive.title')}
          </div>
          <div className="typography-micro text-muted-foreground">
            {t('settings.integrations.googleDrive.description')}
          </div>
          <div className="mt-1 typography-micro text-muted-foreground">{statusLabel}</div>
        </div>
        <div className="flex items-center gap-2">
          {status?.connected ? (
            <Button variant="outline" size="sm" disabled={loading} onClick={() => void onDisconnect()}>
              {t('settings.integrations.googleDrive.actions.disconnect')}
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              disabled={loading || status?.configured === false}
              onClick={() => void onConnect()}
            >
              {t('settings.integrations.googleDrive.actions.connect')}
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
            {t('settings.integrations.googleDrive.actions.refresh')}
          </Button>
        </div>
      </div>
    </div>
  );
};
