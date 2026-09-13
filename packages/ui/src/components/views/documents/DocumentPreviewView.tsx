import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  acquireRuntimeUrlAuthToken,
  refreshRuntimeUrlAuthToken,
  subscribeRuntimeUrlAuthToken,
} from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { getOutsideFileGrant } from '@/lib/outsideFileGrants';

/**
 * Document preview surface (Word / Excel / PowerPoint / PDF) hosted in the
 * right-hand context panel.
 *
 * Every document is rendered by the browser's own PDF viewer in an iframe:
 * PDFs straight from `/api/fs/raw`, office formats from `/api/doc-preview/pdf`,
 * which streams a PDF converted server-side by the LibreOffice sidecar.
 *
 * The conversion is requested first (`/api/doc-preview/convert`) and awaited, so
 * a slow or failed conversion shows as a loading state and an error card rather
 * than leaving an iframe to render whatever the route answered with. The iframe
 * URL is only built once that call succeeded.
 */

type PreviewConfigPayload = {
  available?: boolean;
  kind?: string;
  converted?: boolean;
  reason?: string;
};

type PreviewState =
  | { status: 'loading' }
  | { status: 'converting' }
  | { status: 'pdf'; converted: boolean }
  | { status: 'error'; reason: PreviewErrorReason };

type PreviewErrorReason =
  | 'not-configured'
  | 'disabled'
  | 'converter-unavailable'
  | 'too-large'
  | 'unsupported'
  | 'failed';

const readErrorReason = (status: number, payload: { reason?: string } | null): PreviewErrorReason => {
  if (payload?.reason === 'not-configured') return 'not-configured';
  if (payload?.reason === 'disabled') return 'disabled';
  if (payload?.reason === 'converter-unavailable') return 'converter-unavailable';
  if (payload?.reason === 'too-large' || status === 413) return 'too-large';
  if (status === 415) return 'unsupported';
  // A conversion that failed or timed out is not a configuration problem and
  // not a missing file: it is this document, and the card says so.
  return 'failed';
};

/**
 * Asset URLs (an iframe cannot carry an Authorization header) need the runtime
 * URL token minted first — the same mechanism the file viewer and markdown image
 * previews use. `/api/doc-preview/pdf` is on the server's URL-token allowlist
 * precisely so this works.
 */
const useRuntimeAssetReady = (enabled: boolean): boolean => {
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    if (!enabled) {
      setReady(false);
      return;
    }

    let cancelled = false;
    const apiBaseUrl = getRuntimeApiBaseUrl();
    const release = acquireRuntimeUrlAuthToken(apiBaseUrl);

    void refreshRuntimeUrlAuthToken(apiBaseUrl)
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });

    const unsubscribe = subscribeRuntimeUrlAuthToken(() => {
      if (!cancelled) setReady(true);
    });

    return () => {
      cancelled = true;
      release();
      unsubscribe();
    };
  }, [enabled]);

  return ready;
};

export type DocumentPreviewViewProps = {
  filePath: string;
  directory?: string | null;
};

export const DocumentPreviewView: React.FC<DocumentPreviewViewProps> = ({
  filePath,
  directory,
}) => {
  const { t } = useI18n();

  const [state, setState] = React.useState<PreviewState>({ status: 'loading' });
  const [reloadNonce, setReloadNonce] = React.useState(0);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  // Documents outside the workspace are readable only with a short-lived grant
  // that whoever opened this tab has already minted (the markdown link handler
  // on desktop calls ensureOutsideFileGrantForDesktop first). The grant lives in
  // a path-keyed cache, so it is read here instead of being threaded through the
  // context-panel tab. Re-read on reload, because grants expire.
  const outsideFileGrant = React.useMemo(
    () => getOutsideFileGrant(filePath),
    [filePath, reloadNonce],
  );
  const outsideWorkspaceQuery = React.useMemo(
    () => (outsideFileGrant ? { allowOutsideWorkspace: 'true', outsideFileGrant } : {}),
    [outsideFileGrant],
  );

  React.useEffect(() => {
    if (!filePath) {
      setState({ status: 'error', reason: 'failed' });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    void (async () => {
      try {
        const query = {
          path: filePath,
          directory: directory ?? undefined,
          ...outsideWorkspaceQuery,
        };

        const response = await runtimeFetch('/api/doc-preview/config', { query, cache: 'no-store' });
        const payload = await response.json().catch(() => null) as PreviewConfigPayload | null;
        if (cancelled) return;

        if (!response.ok || !payload?.available || payload.kind !== 'pdf') {
          setState({
            status: 'error',
            reason: response.ok && payload?.available
              ? 'failed'
              : readErrorReason(response.status, payload),
          });
          return;
        }

        if (!payload.converted) {
          setState({ status: 'pdf', converted: false });
          return;
        }

        setState({ status: 'converting' });
        const renderResponse = await runtimeFetch('/api/doc-preview/convert', {
          query,
          cache: 'no-store',
        });
        const renderPayload = await renderResponse.json().catch(() => null) as PreviewConfigPayload | null;
        if (cancelled) return;

        if (!renderResponse.ok || !renderPayload?.available) {
          setState({ status: 'error', reason: readErrorReason(renderResponse.status, renderPayload) });
          return;
        }

        setState({ status: 'pdf', converted: true });
      } catch {
        if (!cancelled) {
          setState({ status: 'error', reason: 'failed' });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [directory, filePath, outsideWorkspaceQuery, reloadNonce]);

  const isPdf = state.status === 'pdf';
  const isConverted = isPdf && state.converted;
  // The download action has to work for every state, including the error card
  // that exists precisely to offer the original when the preview cannot render.
  const assetReady = useRuntimeAssetReady(state.status !== 'loading');

  const pdfSrc = React.useMemo(() => {
    if (!isPdf || !assetReady) return '';
    return getRuntimeUrlResolver().authenticatedAsset(
      isConverted ? '/api/doc-preview/pdf' : '/api/fs/raw',
      {
        path: filePath,
        directory: directory ?? undefined,
        ...outsideWorkspaceQuery,
      },
    );
  }, [assetReady, directory, filePath, isConverted, isPdf, outsideWorkspaceQuery]);

  const downloadUrl = React.useMemo(() => {
    if (!assetReady) return '';
    return getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', {
      path: filePath,
      directory: directory ?? undefined,
      download: 'true',
      ...outsideWorkspaceQuery,
    });
  }, [assetReady, directory, filePath, outsideWorkspaceQuery]);

  const fileName = React.useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath]);

  const errorDescription = React.useMemo(() => {
    if (state.status !== 'error') return '';
    if (state.reason === 'not-configured' || state.reason === 'disabled') {
      return t('documentPreview.error.notConfigured');
    }
    if (state.reason === 'converter-unavailable') {
      return t('documentPreview.error.unavailable');
    }
    if (state.reason === 'too-large') {
      return t('documentPreview.error.tooLarge');
    }
    if (state.reason === 'unsupported') {
      return t('documentPreview.error.unsupported');
    }
    return t('documentPreview.error.failed');
  }, [state, t]);

  const [isFullscreen, setIsFullscreen] = React.useState(false);
  React.useEffect(() => {
    const handleChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  const handleToggleFullscreen = React.useCallback(() => {
    const element = contentRef.current;
    if (!element) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void element.requestFullscreen?.().catch(() => undefined);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--surface-background)]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <FileTypeIcon filePath={filePath} className="h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 flex-1 truncate typography-micro text-foreground" title={filePath}>
          {fileName}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={!downloadUrl}
            onClick={() => {
              if (!downloadUrl) return;
              window.location.assign(downloadUrl);
            }}
            title={t('documentPreview.actions.download')}
            aria-label={t('documentPreview.actions.download')}
          >
            <Icon name="download" className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setReloadNonce((value) => value + 1)}
            title={t('documentPreview.actions.reload')}
            aria-label={t('documentPreview.actions.reload')}
          >
            <Icon name="restart" className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={handleToggleFullscreen}
            title={isFullscreen ? t('documentPreview.actions.exitFullscreen') : t('documentPreview.actions.fullscreen')}
            aria-label={isFullscreen ? t('documentPreview.actions.exitFullscreen') : t('documentPreview.actions.fullscreen')}
          >
            <Icon name="fullscreen" className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div ref={contentRef} className="relative min-h-0 flex-1">
        {state.status === 'loading' || state.status === 'converting' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <Icon name="loader" className="h-6 w-6 animate-spin text-muted-foreground" />
            <div className="typography-micro text-muted-foreground">
              {state.status === 'converting'
                ? t('documentPreview.state.converting')
                : t('documentPreview.state.loading')}
            </div>
          </div>
        ) : null}

        {state.status === 'error' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <Icon name="error-warning" className="h-10 w-10 text-muted-foreground/60" />
            <div className="typography-ui-header text-foreground">{errorDescription}</div>
            {downloadUrl ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => window.location.assign(downloadUrl)}
              >
                <Icon name="download" className="mr-1.5 h-3.5 w-3.5" />
                {t('documentPreview.actions.download')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {isPdf ? (
          pdfSrc ? (
            <iframe
              key={pdfSrc}
              src={pdfSrc}
              title={fileName}
              className="h-full w-full border-0"
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Icon name="loader" className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )
        ) : null}
      </div>
    </div>
  );
};
