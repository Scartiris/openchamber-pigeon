import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { useI18n } from '@/lib/i18n';
import { openVikingApi } from '@/lib/openviking/client';
import {
  OPENVIKING_SCOPE_META,
  type OpenVikingScope,
} from '@/components/sections/openviking/scope';
import { useOpenVikingStore } from '@/stores/useOpenVikingStore';

/**
 * 记忆 / 知识库的「浏览」页：照文件浏览器 —— 左边是 `viking://` 树（在
 * `OpenVikingTreeSidebar` 里），右边是选中条目的内容或目录概览。
 *
 * **当前是只读的。** OpenViking 本身有 `write`/`edit`/`forget`，
 * 但浏览页先只读：先确认树与内容读得对，写操作（含误删无回收站）留到下一轮。
 *
 * 目录的概览走 `GET /content/overview`（OpenViking 自己生成的摘要）。
 * 注意这条路依赖 VLM 槽位配了模型 —— 没配时它回的是
 * `[Directory overview is not generated]` 这类占位串，界面照实显示，
 * 不假装有内容。
 */
interface OpenVikingBrowsePageProps {
  scope: OpenVikingScope;
}

const DirectoryPane: React.FC<{ uri: string; name: string; childCount: number }> = ({
  uri,
  name,
  childCount,
}) => {
  const { t } = useI18n();
  const [overview, setOverview] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setOverview(null);
    openVikingApi
      .overview(uri)
      .then((text) => {
        if (!cancelled) setOverview(text);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Icon name="folder" className="h-4 w-4 text-muted-foreground" />
          <h2 className="typography-ui-header font-medium text-foreground">{name}</h2>
        </div>
        <div className="typography-meta text-muted-foreground">
          {t('settings.openviking.browse.childCount', { count: childCount })}
        </div>
        <code className="typography-micro block break-all text-muted-foreground/70">{uri}</code>
      </div>

      <div className="space-y-1.5">
        <div className="typography-ui-label text-foreground">
          {t('settings.openviking.browse.overview')}
        </div>
        {loading && (
          <div className="typography-meta text-muted-foreground">
            {t('settings.openviking.browse.loading')}
          </div>
        )}
        {!loading && failed && (
          <div className="typography-meta text-muted-foreground">
            {t('settings.openviking.browse.overviewFailed')}
          </div>
        )}
        {!loading && !failed && (
          <pre className="whitespace-pre-wrap break-words font-sans typography-meta text-muted-foreground">
            {overview?.trim() || t('settings.openviking.browse.overviewEmpty')}
          </pre>
        )}
      </div>
    </div>
  );
};

export const OpenVikingBrowsePage: React.FC<OpenVikingBrowsePageProps> = ({ scope }) => {
  const { t } = useI18n();
  const meta = OPENVIKING_SCOPE_META[scope];

  const selectedNode = useOpenVikingStore((state) => state.selectedNode);
  const content = useOpenVikingStore((state) => state.content);
  const contentLoading = useOpenVikingStore((state) => state.contentLoading);
  const contentError = useOpenVikingStore((state) => state.contentError);
  const status = useOpenVikingStore((state) => state.status);
  const refresh = useOpenVikingStore((state) => state.refresh);

  const headerEnd = (
    <Button variant="outline" size="sm" onClick={() => void refresh()}>
      {t('settings.openviking.browse.refresh')}
    </Button>
  );

  const shell = (children: React.ReactNode): React.ReactElement => (
    <SettingsPageLayout
      title={t(meta.browseTitleKey)}
      description={t(meta.browseDescriptionKey)}
      showSaveStatus={false}
      headerEnd={headerEnd}
    >
      {children}
    </SettingsPageLayout>
  );

  if (status && !status.enabled) {
    return shell(
      <div className="typography-meta text-muted-foreground">
        {t('settings.openviking.notConfigured.long')}
      </div>,
    );
  }

  if (!selectedNode) {
    return shell(
      <div className="typography-meta text-muted-foreground">
        {t('settings.openviking.browse.pickHint')}
      </div>,
    );
  }

  if (selectedNode.isDir) {
    return shell(
      <DirectoryPane
        uri={selectedNode.uri}
        name={selectedNode.name}
        childCount={selectedNode.children.length}
      />,
    );
  }

  return shell(
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Icon name="file-text" className="h-4 w-4 text-muted-foreground" />
          <h2 className="typography-ui-header font-medium text-foreground">
            {selectedNode.name}
          </h2>
        </div>
        <code className="typography-micro block break-all text-muted-foreground/70">
          {selectedNode.uri}
        </code>
      </div>

      {contentLoading && (
        <div className="typography-meta text-muted-foreground">
          {t('settings.openviking.browse.loading')}
        </div>
      )}

      {!contentLoading && contentError && (
        <div className="typography-meta text-muted-foreground">
          {t('settings.openviking.browse.readFailed')}
        </div>
      )}

      {!contentLoading && !contentError && (
        <pre className="whitespace-pre-wrap break-words rounded-md border p-3 typography-meta text-foreground"
          style={{ borderColor: 'var(--interactive-border)' }}
        >
          {content ?? ''}
        </pre>
      )}
    </div>,
  );
};

export default OpenVikingBrowsePage;
