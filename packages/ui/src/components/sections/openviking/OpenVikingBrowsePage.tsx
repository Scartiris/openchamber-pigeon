import React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { openVikingApi } from '@/lib/openviking/client';
import {
  OPENVIKING_SCOPE_META,
  type OpenVikingScope,
} from '@/components/sections/openviking/scope';
import {
  resolveCreateParent,
  useOpenVikingStore,
  validateCreateName,
  type TreeNode,
} from '@/stores/useOpenVikingStore';

/**
 * 记忆 / 知识库的「浏览」页：照文件浏览器 —— 左边是 `viking://` 树（在
 * `OpenVikingTreeSidebar` 里），右边是选中条目的内容或目录概览。
 *
 * 写能力：编辑正文（整文件 replace）、在目录下新建、删除（二次确认）。
 * 删除没有回收站 —— 确认框必须写明。派生文件（.abstract.md / .overview.md）
 * 在树里已隐藏，也不会进入编辑路径。
 *
 * 目录的概览走 `GET /content/overview`（OpenViking 自己生成的摘要）。
 * 注意这条路依赖 LLM 槽位配了模型 —— 没配时它回的是
 * `[Directory overview is not generated]` 这类占位串，界面照实显示，
 * 不假装有内容。
 */
interface OpenVikingBrowsePageProps {
  scope: OpenVikingScope;
}

const reportWriteFailure = (
  error: Error,
  fallbackKey: Parameters<ReturnType<typeof useI18n>['t']>[0],
  t: ReturnType<typeof useI18n>['t'],
): void => {
  toast.error(t(fallbackKey), { description: error.message });
};

const DirectoryPane: React.FC<{
  uri: string;
  name: string;
  childCount: number;
  onCreate: () => void;
}> = ({ uri, name, childCount, onCreate }) => {
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
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Icon name="folder" className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h2 className="typography-ui-header font-medium text-foreground">{name}</h2>
          </div>
          <Button variant="outline" size="sm" onClick={onCreate}>
            {t('settings.openviking.browse.create')}
          </Button>
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

const CreateEntryDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentUri: string | null;
}> = ({ open, onOpenChange, parentUri }) => {
  const { t } = useI18n();
  const createEntry = useOpenVikingStore((state) => state.createEntry);
  const [name, setName] = React.useState('');
  const [content, setContent] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const nameIssue = name.length > 0 ? validateCreateName(name) : null;
  const nameValid = validateCreateName(name) === null;

  React.useEffect(() => {
    if (open) {
      setName('');
      setContent('');
      setSaving(false);
    }
  }, [open]);

  const submit = async (): Promise<void> => {
    if (!parentUri || !nameValid || saving) return;
    setSaving(true);
    try {
      await createEntry(parentUri, name, content);
      onOpenChange(false);
    } catch (error) {
      setSaving(false);
      if (error instanceof Error) {
        reportWriteFailure(error, 'settings.openviking.browse.createFailed', t);
      } else {
        toast.error(t('settings.openviking.browse.createFailed'));
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="max-w-md gap-4">
        <DialogHeader>
          <DialogTitle>{t('settings.openviking.browse.createTitle')}</DialogTitle>
          <DialogDescription>
            {parentUri
              ? t('settings.openviking.browse.createDescription', { parent: parentUri })
              : t('settings.openviking.browse.createNoParent')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('settings.openviking.browse.createNamePlaceholder')}
            aria-label={t('settings.openviking.browse.createNameLabel')}
            aria-invalid={nameIssue ? true : undefined}
            disabled={saving}
          />
          {nameIssue && (
            <p className="typography-meta text-[var(--status-error)]">
              {t('settings.openviking.browse.createInvalidName')}
            </p>
          )}
          <Textarea
            simple
            rows={8}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={t('settings.openviking.browse.createContentPlaceholder')}
            aria-label={t('settings.openviking.browse.createContentLabel')}
            disabled={saving}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('settings.openviking.browse.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={saving || !nameValid || !parentUri}
          >
            {saving ? t('settings.openviking.browse.saving') : t('settings.openviking.browse.createSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const DeleteEntryDialog: React.FC<{
  node: TreeNode | null;
  onOpenChange: (node: TreeNode | null) => void;
}> = ({ node, onOpenChange }) => {
  const { t } = useI18n();
  const removeEntry = useOpenVikingStore((state) => state.removeEntry);
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    if (!node) setDeleting(false);
  }, [node]);

  const confirm = async (): Promise<void> => {
    if (!node || deleting) return;
    setDeleting(true);
    try {
      await removeEntry(node.uri);
      onOpenChange(null);
    } catch (error) {
      setDeleting(false);
      if (error instanceof Error) {
        reportWriteFailure(error, 'settings.openviking.browse.deleteFailed', t);
      } else {
        toast.error(t('settings.openviking.browse.deleteFailed'));
      }
    }
  };

  return (
    <Dialog open={Boolean(node)} onOpenChange={(open) => { if (!open && !deleting) onOpenChange(null); }}>
      <DialogContent className="max-w-sm gap-4">
        <DialogHeader>
          <DialogTitle>{t('settings.openviking.browse.deleteTitle')}</DialogTitle>
          <DialogDescription>
            {t('settings.openviking.browse.deleteDescription', { name: node?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 typography-meta text-destructive">
          {t('settings.openviking.browse.deleteNoRecycle')}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(null)} disabled={deleting}>
            {t('settings.openviking.browse.cancel')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void confirm()}
            disabled={deleting}
          >
            {deleting ? t('settings.openviking.browse.deleting') : t('settings.openviking.browse.deleteConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const FilePane: React.FC<{ node: TreeNode }> = ({ node }) => {
  const { t } = useI18n();
  const content = useOpenVikingStore((state) => state.content);
  const contentLoading = useOpenVikingStore((state) => state.contentLoading);
  const contentError = useOpenVikingStore((state) => state.contentError);
  const editing = useOpenVikingStore((state) => state.editing);
  const draft = useOpenVikingStore((state) => state.draft);
  const saving = useOpenVikingStore((state) => state.saving);
  const beginEdit = useOpenVikingStore((state) => state.beginEdit);
  const updateDraft = useOpenVikingStore((state) => state.updateDraft);
  const cancelEdit = useOpenVikingStore((state) => state.cancelEdit);
  const commitEdit = useOpenVikingStore((state) => state.commitEdit);
  const [pendingDelete, setPendingDelete] = React.useState(false);

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Icon name="file-text" className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h2 className="typography-ui-header min-w-0 truncate font-medium text-foreground">
              {node.name}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {editing ? (
              <>
                <Button variant="outline" size="sm" onClick={cancelEdit} disabled={saving}>
                  {t('settings.openviking.browse.cancel')}
                </Button>
                <Button size="sm" onClick={() => void commitEdit().catch((error: Error) => {
                  reportWriteFailure(error, 'settings.openviking.browse.saveFailed', t);
                })} disabled={saving}>
                  {saving ? t('settings.openviking.browse.saving') : t('settings.openviking.browse.save')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={beginEdit}
                  disabled={contentLoading || Boolean(contentError) || content === null}
                >
                  {t('settings.openviking.browse.edit')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setPendingDelete(true)}>
                  {t('settings.openviking.browse.delete')}
                </Button>
              </>
            )}
          </div>
        </div>
        <code className="typography-micro block break-all text-muted-foreground/70">
          {node.uri}
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

      {!contentLoading && !contentError && editing && (
        <Textarea
          simple
          rows={Math.min(28, Math.max(8, draft.split('\n').length + 2))}
          value={draft}
          onChange={(event) => updateDraft(event.target.value)}
          aria-label={t('settings.openviking.browse.editBody')}
          className="min-h-[12rem] w-full resize-y whitespace-pre-wrap break-words"
        />
      )}

      {!contentLoading && !contentError && !editing && (
        <pre className="whitespace-pre-wrap break-words rounded-md border p-3 typography-meta text-foreground"
          style={{ borderColor: 'var(--interactive-border)' }}
        >
          {content ?? ''}
        </pre>
      )}

      <DeleteEntryDialog
        node={pendingDelete ? node : null}
        onOpenChange={(next) => setPendingDelete(Boolean(next))}
      />
    </div>
  );
};

export const OpenVikingBrowsePage: React.FC<OpenVikingBrowsePageProps> = ({ scope }) => {
  const { t } = useI18n();
  const meta = OPENVIKING_SCOPE_META[scope];

  const selectedNode = useOpenVikingStore((state) => state.selectedNode);
  const status = useOpenVikingStore((state) => state.status);
  const baseUri = useOpenVikingStore((state) => state.baseUri);
  const refresh = useOpenVikingStore((state) => state.refresh);
  const [createOpen, setCreateOpen] = React.useState(false);

  const parentUri = resolveCreateParent({ selectedNode, baseUri });

  const headerEnd = (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setCreateOpen(true)}
        disabled={status !== null && !status.enabled}
      >
        {t('settings.openviking.browse.create')}
      </Button>
      <Button variant="outline" size="sm" onClick={() => void refresh()}>
        {t('settings.openviking.browse.refresh')}
      </Button>
    </div>
  );

  const shell = (children: React.ReactNode): React.ReactElement => (
    <SettingsPageLayout
      title={t(meta.browseTitleKey)}
      description={t(meta.browseDescriptionKey)}
      showSaveStatus={false}
      headerEnd={headerEnd}
    >
      {children}
      {/* 永远挂着：空选中/未配置分支也会打开新建对话框，不能只在选中节点时才渲染 */}
      <CreateEntryDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        parentUri={parentUri}
      />
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

  return shell(
    selectedNode.isDir ? (
      <DirectoryPane
        uri={selectedNode.uri}
        name={selectedNode.name}
        childCount={selectedNode.children.length}
        onCreate={() => setCreateOpen(true)}
      />
    ) : (
      <FilePane node={selectedNode} />
    ),
  );
};

export default OpenVikingBrowsePage;
