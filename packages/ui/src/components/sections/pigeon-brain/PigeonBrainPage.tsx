import React from 'react';

import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * 「记忆库」设置页：把 pigeon-brain 的管理界面内嵌进来。
 *
 * iframe 说明见模块注释历史：brain 是独立产品，这里只做同源反代入口。
 */

const PREFIX = '/api/pigeon-brain';
const EMBED_SRC = `${PREFIX}/ui/`;

interface PigeonBrainStatus {
  enabled: boolean;
  upstream: string | null;
}

type PigeonBrainStatusPayload = Record<string, unknown>;

const isRecord = (value: unknown): value is PigeonBrainStatusPayload =>
  Object.prototype.toString.call(value) === '[object Object]';

const parsePigeonBrainStatus = (payload: unknown): PigeonBrainStatus | null => {
  // SAFETY: tag check above established an object record shape at the JSON boundary.
  if (!isRecord(payload)) return null;
  const enabled = payload.enabled === true;
  const upstreamRaw = payload.upstream;
  const upstream = typeof upstreamRaw === 'string' && upstreamRaw.trim().length > 0
    ? upstreamRaw.trim()
    : null;
  return { enabled, upstream };
};

export const PigeonBrainPage: React.FC = () => {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<PigeonBrainStatus | null>(null);
  const [statusError, setStatusError] = React.useState<string | null>(null);
  // 每次点"重新加载"就换一个 key，逼 iframe 真的重建（改 src 不一定重载）
  const [reloadToken, setReloadToken] = React.useState(0);

  const pageTitle = t('settings.page.pigeonBrain.title');
  const pageDescription = t('settings.page.pigeonBrain.description');

  React.useEffect(() => {
    let cancelled = false;
    runtimeFetch(`${PREFIX}/status`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = parsePigeonBrainStatus(await response.json());
        if (!data) throw new Error('invalid-status-payload');
        if (!cancelled) setStatus(data);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const detail = error instanceof Error && error.message !== 'invalid-status-payload'
            ? error.message
            : 'HTTP';
          setStatusError(detail);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const header = (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setReloadToken((value) => value + 1)}
      >
        {t('settings.pigeonBrain.actions.reload')}
      </Button>
      {/*
        注意 `asChild` 时**不能靠 disabled 挡住点击** —— 那个 prop 会落到 <a> 上，
        而 <a> 没有 disabled 语义。这里的做法是：未配置时整个 header 根本不渲染
        （见下面的提前 return），所以不需要 disabled。
      */}
      <Button variant="outline" size="sm" asChild>
        <a href={EMBED_SRC} target="_blank" rel="noopener noreferrer">
          {t('settings.pigeonBrain.actions.openInNewTab')}
        </a>
      </Button>
    </div>
  );

  if (statusError) {
    return (
      <SettingsPageLayout title={pageTitle} description={pageDescription}>
        <div className="text-sm text-muted-foreground">
          {t('settings.pigeonBrain.status.error', { error: statusError })}
        </div>
      </SettingsPageLayout>
    );
  }

  if (!status) {
    return (
      <SettingsPageLayout title={pageTitle} description={pageDescription}>
        <div className="text-sm text-muted-foreground">{t('settings.pigeonBrain.status.checking')}</div>
      </SettingsPageLayout>
    );
  }

  if (!status.enabled) {
    return (
      <SettingsPageLayout title={pageTitle} description={pageDescription}>
        <div className="space-y-2 text-sm text-muted-foreground">
          <div>{t('settings.pigeonBrain.notConfigured.title')}</div>
          <div>{t('settings.pigeonBrain.notConfigured.help')}</div>
        </div>
      </SettingsPageLayout>
    );
  }

  return (
    <SettingsPageLayout
      title={pageTitle}
      description={pageDescription}
      headerEnd={header}
      // 这页内容要占满，不要设置页默认的 840px 收窄
      className="max-w-none"
      outerClassName="h-full"
    >
      <iframe
        key={reloadToken}
        src={EMBED_SRC}
        title={t('settings.pigeonBrain.iframeTitle')}
        className="h-[calc(100vh-220px)] min-h-[520px] w-full rounded-lg border border-border bg-background"
        // 只允许同源脚本；brain 界面本身不引外部资源
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      />
    </SettingsPageLayout>
  );
};

export default PigeonBrainPage;
