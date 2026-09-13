import React from 'react';

import { Button } from '@/components/ui/button';
import {
  SettingsFieldRow,
  SettingsSection,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { openVikingApi } from '@/lib/openviking/client';
import {
  OPENVIKING_SCOPE_META,
  type OpenVikingScope,
} from '@/components/sections/openviking/scope';
import { useOpenVikingStore } from '@/stores/useOpenVikingStore';

/**
 * 记忆 / 知识库的「设置」页。
 *
 * ## 为什么这一页基本是只读的
 *
 * OpenViking 把"记忆怎么自动提交"的策略放在**每个会话**上
 * （`auto_commit_policy`：`pending_token_threshold` / `message_count_threshold` /
 * `idle_timeout_seconds`，经 `PATCH /sessions/{id}/config` 改），
 * **没有全局开关**。而工作台面板并不知道用户会在哪个会话里聊什么，
 * 硬做一个"全局阈值"输入框只会是个改不动任何东西的假开关。
 *
 * 所以这一页照实呈现**运行时就绪状态**与**作用域位置** ——
 * 都是用户排查"记忆怎么没生效"时真正要看的，且每一项都有实测来源。
 * 有真实写接口的开关（如知识库 watch 的暂停/恢复）以后再加，
 * 不放没接线的假控件。
 */

const StatusRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <SettingsFieldRow label={label} alignEnd={false}>
    <span className="typography-ui-label break-all text-foreground">{value}</span>
  </SettingsFieldRow>
);

interface OpenVikingSettingsPageProps {
  scope: OpenVikingScope;
}

export const OpenVikingSettingsPage: React.FC<OpenVikingSettingsPageProps> = ({ scope }) => {
  const { t } = useI18n();
  const meta = OPENVIKING_SCOPE_META[scope];

  const status = useOpenVikingStore((state) => state.status);
  const loadStatus = useOpenVikingStore((state) => state.loadStatus);

  const [health, setHealth] = React.useState<{
    version: string;
    accountId?: string;
    userId?: string;
  } | null>(null);
  const [ready, setReady] = React.useState<string | null>(null);
  const [probeError, setProbeError] = React.useState(false);
  const [probing, setProbing] = React.useState(false);

  const probe = React.useCallback(async () => {
    setProbing(true);
    setProbeError(false);
    setHealth(null);
    setReady(null);
    try {
      const healthResult = await openVikingApi.health();
      setHealth({
        version: healthResult.version,
        accountId: healthResult.account_id,
        userId: healthResult.user_id,
      });
      const readyResult = await openVikingApi.ready();
      setReady(readyResult.status);
    } catch {
      setProbeError(true);
    } finally {
      setProbing(false);
    }
  }, []);

  React.useEffect(() => {
    if (!status) {
      void loadStatus();
      return;
    }
    if (status.enabled) void probe();
  }, [status, loadStatus, probe]);

  const unknown = t('settings.openviking.settings.unknown');
  const headerEnd = (
    <Button
      variant="outline"
      size="sm"
      disabled={probing || !status?.enabled}
      onClick={() => void probe()}
    >
      {t('settings.openviking.settings.recheck')}
    </Button>
  );

  const shell = (children: React.ReactNode): React.ReactElement => (
    <SettingsPageLayout
      title={t(meta.settingsTitleKey)}
      description={t(meta.settingsDescriptionKey)}
      showSaveStatus={false}
      headerEnd={headerEnd}
    >
      {children}
    </SettingsPageLayout>
  );

  if (!status) {
    return shell(<div className={SETTINGS_HELPER_CLASS}>{t('settings.openviking.browse.loading')}</div>);
  }

  if (!status.enabled) {
    return shell(
      <SettingsSection title={t('settings.openviking.settings.connection')} divider={false}>
        <div className={cn(SETTINGS_HELPER_CLASS, 'space-y-2')}>
          <p>{t('settings.openviking.notConfigured.long')}</p>
          <p>
            {t('settings.openviking.settings.envHint')}{' '}
            <code className="rounded bg-muted px-1">OPENVIKING_URL</code>{' '}
            <code className="rounded bg-muted px-1">OPENVIKING_API_KEY</code>
          </p>
        </div>
      </SettingsSection>,
    );
  }

  const readyLabel = ready
    ?? (probeError ? t('settings.openviking.settings.unreachable') : unknown);

  return shell(
    <>
      <SettingsSection title={t('settings.openviking.settings.connection')} divider={false}>
        <StatusRow
          label={t('settings.openviking.settings.upstream')}
          value={status.upstream ?? unknown}
        />
        <StatusRow
          label={t('settings.openviking.settings.version')}
          value={health?.version ?? (probing ? t('settings.openviking.browse.loading') : unknown)}
        />
        <StatusRow label={t('settings.openviking.settings.ready')} value={readyLabel} />
        {health && (health.accountId || health.userId) ? (
          <StatusRow
            label={t('settings.openviking.settings.identity')}
            value={[health.accountId, health.userId].filter(Boolean).join(' / ')}
          />
        ) : null}
        {probeError ? (
          <div className={SETTINGS_HELPER_CLASS}>
            {t('settings.openviking.settings.probeFailed')}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t('settings.openviking.settings.storage')}>
        <StatusRow label={t('settings.openviking.settings.scope')} value={meta.scopeUri} />
        <div className={SETTINGS_HELPER_CLASS}>
          {t('settings.openviking.settings.readOnlyNote')}
        </div>
      </SettingsSection>
    </>,
  );
};

export default OpenVikingSettingsPage;
