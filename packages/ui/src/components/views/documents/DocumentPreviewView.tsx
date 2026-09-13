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
  /** Editor lifecycle callbacks; added by this surface, not by the server. */
  events?: DocEditorEvents;
};

/** Editor lifecycle events the surface listens to (added just before creation). */
type DocEditorEvents = {
  onDocumentStateChange?: (event: { data?: boolean }) => void;
  onError?: (event: { data?: unknown }) => void;
};

type PreviewState =
  | { status: 'loading' }
  | { status: 'pdf' }
  | {
    status: 'onlyoffice';
    documentServerUrl: string;
    editorConfig: OnlyOfficeConfig;
    mode: DocumentMode;
    editable: boolean;
  }
  | { status: 'error'; reason: PreviewErrorReason };

type DocumentMode = 'view' | 'edit';

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
  // Editing is opt-in: the surface opens read-only and only asks the server for
  // an editable configuration when the user switches.
  const [requestedMode, setRequestedMode] = React.useState<DocumentMode>('view');
  const [dirty, setDirty] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const placeholderRef = React.useRef<HTMLDivElement | null>(null);
  // The document server's api.js expects a pristine container: handing a second
  // DocEditor the node of a destroyed one makes it fail (it keeps its own state on
  // the element). A fresh id per configuration — used as the React key as well, so
  // React really creates a new node instead of reusing this one — gives every
  // editor instance, including the reload after switching view/edit, its own.
  const placeholderId = React.useMemo(() => {
    editorPlaceholderSeq += 1;
    return `oc-document-preview-${editorPlaceholderSeq}`;
  }, [state]);
  const editorRef = React.useRef<{ destroyEditor?: () => void } | null>(null);
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
        const response = await runtimeFetch('/api/doc-preview/config', {
          query: {
            path: filePath,
            directory: directory ?? undefined,
            theme: themeVariant,
            ...(requestedMode === 'edit' ? { edit: '1' } : {}),
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
            mode?: string;
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
          setState({
            status: 'onlyoffice',
            documentServerUrl: payload.documentServerUrl,
            editorConfig: payload.editorConfig,
            mode: payload.mode === 'edit' ? 'edit' : 'view',
            editable: payload.editable === true,
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
  }, [directory, filePath, outsideWorkspaceQuery, reloadNonce, requestedMode, themeVariant]);

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
    setDirty(false);
    setSavedAt(null);

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

        // The document server calls these back in the page; they are the only
        // signal the surface gets about the editing state. `data === true` means
        // there are changes the server has not stored yet, `false` that the last
        // save went through — which is exactly when the callback has written the
        // file back.
        const events: DocEditorEvents = {
          onDocumentStateChange: (event) => {
            if (cancelled) return;
            const modified = event?.data === true;
            setDirty(modified);
            if (!modified) {
              setSavedAt(Date.now());
            }
          },
          onError: (event) => {
            console.warn('Document editor reported an error:', event?.data);
          },
        };

        editorRef.current = new DocEditor(placeholderId, { ...state.editorConfig, events });
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

  const onlyOfficeState = state.status === 'onlyoffice' ? state : null;
  const currentMode: DocumentMode = onlyOfficeState?.mode ?? 'view';
  const canEdit = onlyOfficeState?.editable === true;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--surface-background)]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <FileTypeIcon filePath={filePath} className="h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 flex-1 truncate typography-micro text-foreground" title={filePath}>
          {fileName}
        </div>
        {onlyOfficeState ? (
          <div className="shrink-0 typography-micro text-muted-foreground">
            {dirty
              ? t('documentPreview.state.unsaved')
              : savedAt
                ? t('documentPreview.state.saved')
                : null}
          </div>
        ) : null}
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant={currentMode === 'edit' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 px-2"
            disabled={!canEdit}
            onClick={() => setRequestedMode((mode) => (mode === 'edit' ? 'view' : 'edit'))}
            title={canEdit
              ? (currentMode === 'edit' ? t('documentPreview.actions.view') : t('documentPreview.actions.edit'))
              : t('documentPreview.error.editUnsupported')}
            aria-label={canEdit
              ? (currentMode === 'edit' ? t('documentPreview.actions.view') : t('documentPreview.actions.edit'))
              : t('documentPreview.error.editUnsupported')}
          >
            <Icon name={currentMode === 'edit' ? 'eye' : 'edit'} className="mr-1 h-3.5 w-3.5" />
            <span className="typography-micro">
              {currentMode === 'edit' ? t('documentPreview.actions.view') : t('documentPreview.actions.edit')}
            </span>
          </Button>
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
          key={placeholderId}
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
