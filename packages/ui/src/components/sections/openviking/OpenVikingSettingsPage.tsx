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
  /** 各自独立记录失败，不用一个 flag 混着 —— 否则 /health 成了也会显示"连不上" */
  const [healthFailed, setHealthFailed] = React.useState(false);
  const [readyFailed, setReadyFailed] = React.useState(false);
  const [probing, setProbing] = React.useState(false);

  /**
   * 两个探测**各自独立**。
   *
   * 早先版本把 `/health` 与 `/ready` 串在一个 try 里，任一失败就 `catch` 成
   * "连不上" —— 实测出现过 `/health` 已经 200 拿到版本号、却因为 `/ready` 在这条
   * 链路上超时而整块显示「版本 未知 / 就绪状态 连不上」，**对用户是假的**。
   *
   * `/ready` 本身每次都会**真探一次 embedding provider**（服务器侧实测稳定 ~0.42s，
   * 比 /health 的 5ms 慢两个数量级），所以它是最容易在慢链路上超时的一环；
   * 它失败只该影响"就绪状态"那一行，不该抹掉已经拿到的版本与身份。
   */
  const probe = React.useCallback(async () => {
    setProbing(true);
    setHealthFailed(false);
    setReadyFailed(false);
    setHealth(null);
    setReady(null);

    const [healthOutcome, readyOutcome] = await Promise.allSettled([
      openVikingApi.health(),
      openVikingApi.ready(),
    ]);

    if (healthOutcome.status === 'fulfilled') {
      setHealth({
        version: healthOutcome.value.version,
        accountId: healthOutcome.value.account_id,
        userId: healthOutcome.value.user_id,
      });
    } else {
      setHealthFailed(true);
    }

    if (readyOutcome.status === 'fulfilled') {
      setReady(readyOutcome.value.status);
    } else {
      setReadyFailed(true);
    }

    setProbing(false);
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

  // 就绪状态单独成判：`/ready` 会真探 embedding（慢两个数量级），
  // 它失败只影响这一行，不动已经拿到的版本与身份。
  const readyLabel = ready
    ?? (readyFailed
      ? t('settings.openviking.settings.readyUnavailable')
      : (probing ? t('settings.openviking.browse.loading') : unknown));

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
        {healthFailed ? (
          <div className={SETTINGS_HELPER_CLASS}>
            {t('settings.openviking.settings.healthFailed')}
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
