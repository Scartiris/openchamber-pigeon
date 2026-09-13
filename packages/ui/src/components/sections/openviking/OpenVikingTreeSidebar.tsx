import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  OPENVIKING_SCOPE_META,
  type OpenVikingScope,
} from '@/components/sections/openviking/scope';
import { useOpenVikingStore, type TreeNode } from '@/stores/useOpenVikingStore';

interface OpenVikingTreeSidebarProps {
  scope: OpenVikingScope;
  onItemSelect?: () => void;
}

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const TreeRow: React.FC<{
  node: TreeNode;
  depth: number;
  onItemSelect?: () => void;
}> = ({ node, depth, onItemSelect }) => {
  const expanded = useOpenVikingStore((state) => Boolean(state.expanded[node.uri]));
  const selected = useOpenVikingStore((state) => state.selectedUri === node.uri);
  const toggleExpanded = useOpenVikingStore((state) => state.toggleExpanded);
  const select = useOpenVikingStore((state) => state.select);

  const hasChildren = node.isDir && node.children.length > 0;

  const handleClick = (): void => {
    if (node.isDir) {
      if (hasChildren) toggleExpanded(node.uri);
      select(node);
    } else {
      select(node);
    }
    onItemSelect?.();
  };

  return (
    <>
      <div
        className={cn(
          'group flex items-center gap-1 rounded-md py-0.5 pr-1.5 transition-all duration-200',
          selected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
        )}
        // 缩进用 padding，不用嵌套 DOM —— 深目录下嵌套会让整行被父级挤压
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <button
          type="button"
          onClick={handleClick}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          title={node.uri}
        >
          {node.isDir && hasChildren ? (
            <Icon
              name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            />
          ) : (
            <span className="w-3.5 shrink-0" aria-hidden="true" />
          )}
          <Icon
            name={node.isDir ? 'folder' : 'file-text'}
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          />
          <span className="typography-ui-label min-w-0 flex-1 truncate font-normal text-foreground">
            {node.name}
          </span>
          {!node.isDir && (
            <span className="typography-micro shrink-0 text-muted-foreground/60">
              {formatSize(node.size)}
            </span>
          )}
        </button>
      </div>

      {node.isDir && expanded && hasChildren && (
        <>
          {node.children.map((child) => (
            <TreeRow
              key={child.uri}
              node={child}
              depth={depth + 1}
              onItemSelect={onItemSelect}
            />
          ))}
        </>
      )}
    </>
  );
};

/**
 * 记忆 / 知识库浏览页的左边栏：一棵 `viking://` 文件树。
 *
 * 契约与其它 split 页一致：`{ scope, onItemSelect? }`，选中态在 store 里，
 * 右侧内容区读同一份 store。`onItemSelect` 只在移动端有意义
 * （选完自动翻到内容页），桌面端由 `SettingsView` 传空。
 */
export const OpenVikingTreeSidebar: React.FC<OpenVikingTreeSidebarProps> = ({
  scope,
  onItemSelect,
}) => {
  const { t } = useI18n();
  const roots = useOpenVikingStore((state) => state.roots);
  const loading = useOpenVikingStore((state) => state.loading);
  const error = useOpenVikingStore((state) => state.error);
  const status = useOpenVikingStore((state) => state.status);

  const meta = OPENVIKING_SCOPE_META[scope];
  const header = (
    <div className="border-b px-3 pb-3 pt-4" style={{ borderColor: 'var(--interactive-border)' }}>
      <h2 className="typography-ui-header font-medium text-foreground">
        {t(meta.sidebarTitleKey)}
      </h2>
      <p className="typography-meta mt-1 text-muted-foreground">
        {t(meta.sidebarDescriptionKey)}
      </p>
    </div>
  );

  if (status && !status.enabled) {
    return (
      <SettingsSidebarLayout header={header}>
        <div className="px-1 py-2 typography-meta text-muted-foreground">
          {t('settings.openviking.notConfigured.short')}
        </div>
      </SettingsSidebarLayout>
    );
  }

  return (
    <SettingsSidebarLayout header={header}>
      {loading && (
        <div className="px-1 py-2 typography-meta text-muted-foreground">
          {t('settings.openviking.browse.loading')}
        </div>
      )}

      {!loading && error && (
        <div className="px-1 py-2 typography-meta text-muted-foreground">
          {error.notConfigured
            ? t('settings.openviking.notConfigured.short')
            : t('settings.openviking.browse.loadFailed')}
        </div>
      )}

      {!loading && !error && roots.length === 0 && (
        <div className="px-1 py-2 typography-meta text-muted-foreground">
          {t(meta.emptyKey)}
        </div>
      )}

      {!loading &&
        !error &&
        roots.map((node) => (
          <TreeRow key={node.uri} node={node} depth={0} onItemSelect={onItemSelect} />
        ))}
    </SettingsSidebarLayout>
  );
};

export default OpenVikingTreeSidebar;
