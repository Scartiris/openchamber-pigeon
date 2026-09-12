import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Button } from '@/components/ui/button';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  acquireRuntimeUrlAuthToken,
  refreshRuntimeUrlAuthToken,
  subscribeRuntimeUrlAuthToken,
} from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';

/**
 * Document preview surface (Word / Excel / PowerPoint / PDF) hosted in the
 * right-hand context panel.
 *
 * Office formats are rendered by the OnlyOffice document server: the server
 * route `/api/doc-preview/config` resolves the file inside the active
 * workspace, mints a short-lived capability URL for the document server and
 * returns a signed editor configuration. The editor itself lives in an iframe
 * owned by the document server, so this component only loads `api.js` once and
 * creates/destroys the editor instance.
 *
 * PDFs never touch the document server — the browser renders them directly from
 * the authenticated `/api/fs/raw` endpoint.
 *
 * Only the active tab is mounted by the context panel, so switching tabs tears
 * down the previous editor instead of keeping one live editor per open document.
 */

type OnlyOfficeConfig = {
  document: { fileType: string; key: string; title: string; url: string };
  documentType: string;
  editorConfig: Record<string, unknown>;
  token?: string;
  width?: string;
  height?: string;
};

type PreviewState =
  | { status: 'loading' }
  | { status: 'pdf' }
  | { status: 'onlyoffice'; documentServerUrl: string; editorConfig: OnlyOfficeConfig }
  | { status: 'error'; reason: PreviewErrorReason };

type PreviewErrorReason =
  | 'not-configured'
  | 'disabled'
  | 'document-server-unavailable'
  | 'too-large'
  | 'unsupported'
  | 'failed';

type DocsApiGlobal = {
  DocsAPI?: {
    DocEditor: new (
      placeholder: string | HTMLElement,
      config: OnlyOfficeConfig,
    ) => { destroyEditor?: () => void };
  };
};

const DOCS_API_PATH = '/web-apps/apps/api/documents/api.js';

let docsApiPromise: Promise<void> | null = null;
let editorPlaceholderSeq = 0;

const loadDocsApi = (documentServerUrl: string): Promise<void> => {
  const globalScope = window as unknown as DocsApiGlobal;
  if (globalScope.DocsAPI) {
    return Promise.resolve();
  }
  if (!docsApiPromise) {
    docsApiPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${documentServerUrl.replace(/\/+$/, '')}${DOCS_API_PATH}`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        docsApiPromise = null;
        reject(new Error('Failed to load the document server API'));
      };
      document.head.appendChild(script);
    });
  }
  return docsApiPromise;
};

const readErrorReason = (status: number, payload: { reason?: string } | null): PreviewErrorReason => {
  if (payload?.reason === 'not-configured') return 'not-configured';
  if (payload?.reason === 'disabled') return 'disabled';
  if (payload?.reason === 'document-server-unavailable') return 'document-server-unavailable';
  if (status === 413) return 'too-large';
  if (status === 415) return 'unsupported';
  return 'failed';
};

/**
 * Asset URLs (`/api/fs/raw` in an iframe) cannot carry an Authorization header,
 * so the runtime URL token has to be minted first — same mechanism the file
 * viewer and markdown image previews use.
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
  visible?: boolean;
};

export const DocumentPreviewView: React.FC<DocumentPreviewViewProps> = ({
  filePath,
  directory,
  visible = true,
}) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const themeVariant = currentTheme?.metadata?.variant === 'dark' ? 'dark' : 'light';

  const [state, setState] = React.useState<PreviewState>({ status: 'loading' });
  const [reloadNonce, setReloadNonce] = React.useState(0);
  const placeholderRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<{ destroyEditor?: () => void } | null>(null);
  const placeholderIdRef = React.useRef('');
  if (!placeholderIdRef.current) {
    editorPlaceholderSeq += 1;
    placeholderIdRef.current = `oc-document-preview-${editorPlaceholderSeq}`;
  }

  React.useEffect(() => {
    if (!filePath) {
      setState({ status: 'error', reason: 'failed' });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    void (async () => {
      try {
        const response = await runtimeFetch('/api/doc-preview/config', {
          query: {
            path: filePath,
            directory: directory ?? undefined,
            theme: themeVariant,
          },
          cache: 'no-store',
        });

        const payload = await response.json().catch(() => null) as
          | {
            available?: boolean;
            kind?: string;
            reason?: string;
            documentServerUrl?: string;
            editorConfig?: OnlyOfficeConfig;
          }
          | null;

        if (cancelled) return;

        if (!response.ok || !payload?.available) {
          setState({ status: 'error', reason: readErrorReason(response.status, payload) });
          return;
        }

        if (payload.kind === 'pdf') {
          setState({ status: 'pdf' });
          return;
        }

        if (payload.kind === 'onlyoffice' && payload.documentServerUrl && payload.editorConfig) {
          setState({
            status: 'onlyoffice',
            documentServerUrl: payload.documentServerUrl,
            editorConfig: payload.editorConfig,
          });
          return;
        }

        setState({ status: 'error', reason: 'failed' });
      } catch {
        if (!cancelled) {
          setState({ status: 'error', reason: 'failed' });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [directory, filePath, reloadNonce, themeVariant]);

  React.useEffect(() => {
    if (state.status !== 'onlyoffice') {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        await loadDocsApi(state.documentServerUrl);
        if (cancelled) return;

        const globalScope = window as unknown as DocsApiGlobal;
        const DocEditor = globalScope.DocsAPI?.DocEditor;
        if (!DocEditor) {
          setState({ status: 'error', reason: 'failed' });
          return;
        }

        editorRef.current = new DocEditor(placeholderIdRef.current, state.editorConfig);
      } catch {
        if (!cancelled) {
          setState({ status: 'error', reason: 'failed' });
        }
      }
    })();

    return () => {
      cancelled = true;
      try {
        editorRef.current?.destroyEditor?.();
      } catch {
        // The editor may already be gone (document server restart, tab close).
      }
      editorRef.current = null;
    };
  }, [state]);

  const isPdf = state.status === 'pdf';
  const assetReady = useRuntimeAssetReady(isPdf);

  const pdfSrc = React.useMemo(() => {
    if (!isPdf || !assetReady) return '';
    return getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', {
      path: filePath,
      directory: directory ?? undefined,
    });
  }, [assetReady, directory, filePath, isPdf]);

  const downloadUrl = React.useMemo(() => {
    if (!assetReady) return '';
    return getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', {
      path: filePath,
      directory: directory ?? undefined,
      download: 'true',
    });
  }, [assetReady, directory, filePath]);

  const fileName = React.useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath]);

  const errorDescription = React.useMemo(() => {
    if (state.status !== 'error') return '';
    if (state.reason === 'not-configured' || state.reason === 'disabled') {
      return t('documentPreview.error.notConfigured');
    }
    if (state.reason === 'document-server-unavailable') {
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

  const handleToggleFullscreen = React.useCallback(() => {
    const element = placeholderRef.current?.parentElement ?? placeholderRef.current;
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
            title={document.fullscreenElement ? t('documentPreview.actions.exitFullscreen') : t('documentPreview.actions.fullscreen')}
            aria-label={document.fullscreenElement ? t('documentPreview.actions.exitFullscreen') : t('documentPreview.actions.fullscreen')}
          >
            <Icon name="fullscreen" className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {state.status === 'loading' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <Icon name="loader" className="h-6 w-6 animate-spin text-muted-foreground" />
            <div className="typography-micro text-muted-foreground">{t('documentPreview.state.loading')}</div>
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

        <div
          ref={placeholderRef}
          id={placeholderIdRef.current}
          className={cn(
            'absolute inset-0 h-full w-full',
            state.status === 'onlyoffice' && visible ? 'block' : 'hidden',
          )}
        />
      </div>
    </div>
  );
};
