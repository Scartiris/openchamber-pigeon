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
import { getOutsideFileGrant } from '@/lib/outsideFileGrants';
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
  if (globalScope.DocsAPI?.DocEditor) {
    return Promise.resolve();
  }
  if (!docsApiPromise) {
    docsApiPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${documentServerUrl.replace(/\/+$/, '')}${DOCS_API_PATH}`;
      script.async = true;
      // A 200 that is not the API (a proxy or SPA fallback serving index.html
      // for an unknown path) would otherwise resolve the promise without
      // DocsAPI and every later retry would short-circuit on it.
      script.onload = () => {
        if ((window as unknown as DocsApiGlobal).DocsAPI?.DocEditor) {
          resolve();
          return;
        }
        docsApiPromise = null;
        reject(new Error('The document server API loaded but did not define DocsAPI'));
      };
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
  // Edit is an explicit mode: the server still mints view configs by default,
  // and only a workspace-scoped office file with a healthy document server can
  // flip this to true. Outside-grant files never leave view mode.
  const [editMode, setEditMode] = React.useState(false);
  const placeholderRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<{ destroyEditor?: () => void } | null>(null);
  const [placeholderId] = React.useState(() => {
    editorPlaceholderSeq += 1;
    return `oc-document-preview-${editorPlaceholderSeq}`;
  });
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
  const isOutsideWorkspace = Boolean(outsideFileGrant);

  // Only workspace office documents can flip into edit. The server enforces
  // the same rule; this just keeps the toolbar honest without a round trip.
  const canEdit = state.status === 'onlyoffice' && !isOutsideWorkspace;

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
            edit: editMode ? '1' : undefined,
            ...outsideWorkspaceQuery,
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
            editable?: boolean;
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
          // The server may refuse edit (outside grant, non-office, …) and still
          // return a view config. Trust the response, not the local flag.
          if (editMode && payload.editable !== true) {
            setEditMode(false);
          }
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
  }, [directory, filePath, outsideWorkspaceQuery, reloadNonce, themeVariant, editMode]);

  React.useEffect(() => {
    // Only the visible tab keeps an editor alive: hiding the panel (or the
    // surface) destroys it and showing it again recreates it, which keeps one
    // live editor's worth of memory on the document server instead of one per
    // open document. Creating an editor into a hidden 0-width placeholder is
    // also what makes it come back blank after the panel is reopened.
    if (state.status !== 'onlyoffice' || !visible) {
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

        editorRef.current = new DocEditor(placeholderId, state.editorConfig);
      } catch (error) {
        // Swallowing this silently leaves the user with a generic failure and
        // nothing in the console to diagnose the document server with.
        console.warn('Failed to start the document editor:', error);
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
  }, [placeholderId, state, visible]);

  const isPdf = state.status === 'pdf';
  // The download action has to work for every state, including the error card
  // that exists precisely to offer the original when the preview cannot render.
  const assetReady = useRuntimeAssetReady(state.status !== 'loading');

  const pdfSrc = React.useMemo(() => {
    if (!isPdf || !assetReady) return '';
    return getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', {
      path: filePath,
      directory: directory ?? undefined,
      ...outsideWorkspaceQuery,
    });
  }, [assetReady, directory, filePath, isPdf, outsideWorkspaceQuery]);

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

  const [isFullscreen, setIsFullscreen] = React.useState(false);
  React.useEffect(() => {
    const handleChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

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
          {canEdit ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => setEditMode((value) => !value)}
              title={editMode ? t('documentPreview.actions.stopEditing') : t('documentPreview.actions.edit')}
              aria-label={editMode ? t('documentPreview.actions.stopEditing') : t('documentPreview.actions.edit')}
            >
              <Icon name={editMode ? 'eye' : 'edit'} className="h-3.5 w-3.5" />
              <span className="ml-1 typography-micro">
                {editMode ? t('documentPreview.actions.stopEditing') : t('documentPreview.actions.edit')}
              </span>
            </Button>
          ) : null}
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
          id={placeholderId}
          className={cn(
            'absolute inset-0 h-full w-full',
            state.status === 'onlyoffice' && visible ? 'block' : 'hidden',
          )}
        />
      </div>
    </div>
  );
};
