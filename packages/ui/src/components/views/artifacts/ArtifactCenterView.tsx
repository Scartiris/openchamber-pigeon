import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import {
  ArtifactApiError,
  fetchVersionContent,
  labelVersion,
  listArtifacts,
  listVersions,
  pullVersion,
  restoreVersion,
  uncollectArtifact,
  type ArtifactRecord,
  type ArtifactVersion,
} from '@/lib/artifacts/client';

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatWhen = (ms: number): string => {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
};

/**
 * Independent Artifact Center page (same surface-page pattern as Archive).
 * Left: artifact list. Right: detail + version timeline.
 */
export function ArtifactCenterView(): React.ReactNode {
  const { t } = useI18n();
  const open = useUIStore((state) => state.isArtifactCenterPageOpen);
  const setOpen = useUIStore((state) => state.setArtifactCenterOpen);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

  const [artifacts, setArtifacts] = React.useState<ArtifactRecord[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [versions, setVersions] = React.useState<ArtifactVersion[]>([]);
  const [query, setQuery] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [labelDrafts, setLabelDrafts] = React.useState<Record<string, string>>({});
  const [busyVersionId, setBusyVersionId] = React.useState<string | null>(null);

  const selected = React.useMemo(
    () => artifacts.find((artifact) => artifact.id === selectedId) ?? null,
    [artifacts, selectedId],
  );

  const reload = React.useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const list = await listArtifacts();
      setArtifacts(list);
      setSelectedId((current) => {
        if (current && list.some((artifact) => artifact.id === current)) return current;
        return list[0]?.id ?? null;
      });
    } catch (err) {
      // Failure is not an empty list.
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setArtifacts([]);
    } finally {
      setLoading(false);
    }
  }, [open]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  React.useEffect(() => {
    if (!open || !selectedId) {
      setVersions([]);
      return;
    }
    let cancelled = false;
    void listVersions(selectedId)
      .then((list) => {
        if (!cancelled) setVersions(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setVersions([]);
          toast.error(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedId]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return artifacts;
    return artifacts.filter((artifact) =>
      [artifact.title, artifact.sourcePath, artifact.directory]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [artifacts, query]);

  const onLabel = React.useCallback(
    async (version: ArtifactVersion) => {
      if (!selected) return;
      const label = (labelDrafts[version.id] ?? '').trim();
      try {
        await labelVersion(selected.id, version.id, label);
        setVersions(await listVersions(selected.id));
        setLabelDrafts((drafts) => {
          const next = { ...drafts };
          delete next[version.id];
          return next;
        });
        toast.success(label ? t('artifacts.toast.labelSaved') : t('artifacts.toast.labelCleared'));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [labelDrafts, selected, t],
  );

  const onRestore = React.useCallback(
    async (version: ArtifactVersion) => {
      if (!selected) return;
      setBusyVersionId(version.id);
      try {
        await restoreVersion(selected.id, version.id, false);
        setVersions(await listVersions(selected.id));
        await reload();
        toast.success(t('artifacts.toast.restored'));
      } catch (err) {
        if (err instanceof ArtifactApiError && err.code === 'source_dirty') {
          const force = window.confirm(t('artifacts.restore.dirtyConfirm'));
          if (force) {
            try {
              await restoreVersion(selected.id, version.id, true);
              setVersions(await listVersions(selected.id));
              await reload();
              toast.success(t('artifacts.toast.restored'));
            } catch (forceErr) {
              toast.error(forceErr instanceof Error ? forceErr.message : String(forceErr));
            }
          }
        } else {
          toast.error(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setBusyVersionId(null);
      }
    },
    [reload, selected, t],
  );

  const onPull = React.useCallback(
    async (version: ArtifactVersion) => {
      if (!selected) return;
      setBusyVersionId(version.id);
      try {
        await pullVersion(selected.id, version.id);
        setVersions(await listVersions(selected.id));
        toast.success(t('artifacts.toast.pulled'));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyVersionId(null);
      }
    },
    [selected, t],
  );

  const onPreview = React.useCallback(
    async (version: ArtifactVersion) => {
      if (!selected) return;
      try {
        const blob = await fetchVersionContent(selected.id, version.id);
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener,noreferrer');
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [selected],
  );

  const onUncollect = React.useCallback(async () => {
    if (!selected) return;
    try {
      await uncollectArtifact(selected.id, false);
      setSelectedId(null);
      await reload();
      toast.success(t('artifacts.toast.uncollected'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [reload, selected, t]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        <div className="flex w-72 flex-shrink-0 flex-col border-r border-border/50">
          <div className="space-y-2 border-b border-border/50 p-3">
            <div className="typography-ui-header font-semibold text-foreground">
              {t('artifacts.page.title')}
            </div>
            <div className="relative">
              <Icon
                name="search"
                className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('artifacts.list.searchPlaceholder')}
                className="h-8 w-full rounded-md border border-border bg-transparent pl-8 pr-3 typography-ui-label text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {loading ? (
              <div className="px-2 py-3 typography-ui-label text-muted-foreground">
                {t('artifacts.list.loading')}
              </div>
            ) : error ? (
              <div className="space-y-2 px-2 py-3">
                <div className="typography-ui-label text-destructive">{error}</div>
                <Button variant="outline" size="xs" onClick={() => void reload()}>
                  {t('artifacts.list.retry')}
                </Button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-2 py-3 typography-ui-label text-muted-foreground">
                {t('artifacts.list.empty')}
              </div>
            ) : (
              filtered.map((artifact) => (
                <button
                  key={artifact.id}
                  type="button"
                  onClick={() => setSelectedId(artifact.id)}
                  className={cn(
                    'flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left typography-ui-label transition-colors',
                    artifact.id === selectedId
                      ? 'bg-interactive-selection text-foreground'
                      : 'text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground',
                  )}
                >
                  <span className="truncate">{artifact.title}</span>
                  <span className="truncate typography-micro text-muted-foreground/70">
                    {artifact.status === 'missing'
                      ? t('artifacts.list.missing')
                      : formatDirectoryName(artifact.directory, homeDirectory) || artifact.sourcePath}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {!selected ? (
            <div className="flex h-full items-center justify-center typography-ui-label text-muted-foreground">
              {t('artifacts.detail.selectHint')}
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3 border-b border-border/50 px-6 py-4">
                <div className="min-w-0">
                  <div className="typography-ui-header font-semibold text-foreground truncate">
                    {selected.title}
                  </div>
                  <div className="mt-1 truncate typography-micro text-muted-foreground">
                    {selected.sourcePath}
                  </div>
                  <div className="mt-1 typography-micro text-muted-foreground">
                    {t('artifacts.detail.meta', {
                      size: formatBytes(selected.sizeBytes),
                      when: formatWhen(selected.updatedAt),
                    })}
                    {selected.status === 'missing' ? ` · ${t('artifacts.list.missing')}` : ''}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => void onUncollect()}>
                  {t('artifacts.actions.uncollect')}
                </Button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
                <div className="mb-3 flex items-center gap-2">
                  <div className="typography-ui-label font-medium text-foreground">
                    {t('artifacts.versions.title')}
                  </div>
                  <span className="typography-micro text-muted-foreground">
                    {t('artifacts.versions.count', { count: versions.length })}
                  </span>
                </div>

                <ol className="space-y-2">
                  {versions.map((version) => (
                    <li
                      key={version.id}
                      className="rounded-lg border border-border/60 bg-card/40 px-3 py-2.5"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="typography-ui-label text-foreground">
                          {formatWhen(version.createdAt)}
                        </span>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 typography-micro',
                            version.tier === 'hot'
                              ? 'bg-primary/15 text-primary'
                              : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {version.tier === 'hot'
                            ? t('artifacts.versions.tierHot')
                            : version.tier === 'cold'
                              ? t('artifacts.versions.tierCold')
                              : t('artifacts.versions.tierRestoring')}
                        </span>
                        {version.label ? (
                          <span className="rounded-full bg-interactive-selection px-2 py-0.5 typography-micro text-foreground">
                            {version.label}
                          </span>
                        ) : null}
                        <span className="typography-micro text-muted-foreground">
                          {formatBytes(version.sizeBytes)}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={version.tier !== 'hot' || busyVersionId === version.id}
                          onClick={() => void onPreview(version)}
                        >
                          {t('artifacts.actions.preview')}
                        </Button>
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={busyVersionId === version.id}
                          onClick={() => void onRestore(version)}
                        >
                          {t('artifacts.actions.restore')}
                        </Button>
                        {version.tier === 'cold' ? (
                          <Button
                            variant="secondary"
                            size="xs"
                            disabled={busyVersionId === version.id}
                            onClick={() => void onPull(version)}
                          >
                            {t('artifacts.actions.pull')}
                          </Button>
                        ) : null}
                        <input
                          value={labelDrafts[version.id] ?? version.label ?? ''}
                          onChange={(event) =>
                            setLabelDrafts((drafts) => ({
                              ...drafts,
                              [version.id]: event.target.value,
                            }))
                          }
                          placeholder={t('artifacts.versions.labelPlaceholder')}
                          className="h-7 w-40 rounded-md border border-border bg-transparent px-2 typography-micro text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        />
                        <Button variant="ghost" size="xs" onClick={() => void onLabel(version)}>
                          {t('artifacts.actions.saveLabel')}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
