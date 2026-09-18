import React from 'react';
import { Button } from '@/components/ui/button';
import { useMcpStore } from '@/stores/useMcpStore';
import { parseMcpOAuthCallbackContext, parseMcpOAuthCallbackStateKey } from '@/components/sections/mcp/mcpOAuth';
import { MCP_OAUTH_ORIGIN_DESKTOP } from '@/components/sections/mcp/startMcpAuthorization';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { SETTINGS_PAGE_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Handing control back after the browser finished the authorization.
 *
 * This page always runs in a browser, but the flow may have been started from
 * the desktop shell — a different surface entirely. Sending that user to `/`
 * would raise a second copy of the interface in a tab while the real app sits
 * behind it, so the desktop case is returned through its own protocol, which
 * focuses the running window.
 */
const returnToApp = (startedFromDesktop: boolean): void => {
  if (typeof window === 'undefined') return;
  if (startedFromDesktop) {
    window.location.href = 'openchamber://focus/mcp-auth';
    return;
  }
  window.location.replace('/');
};

const parseQueryParam = (params: URLSearchParams, key: string): string | null => {
  const value = params.get(key);
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
};

type McpOauthMessageKey =
  | 'settings.mcp.oauth.callback.working'
  | 'settings.mcp.oauth.callback.success'
  | 'settings.mcp.oauth.callback.browserUnavailable'
  | 'settings.mcp.oauth.callback.sessionExpired'
  | 'settings.mcp.oauth.callback.missingCode'
  | 'settings.mcp.oauth.callback.sessionUnavailable'
  | 'settings.mcp.oauth.callback.completeFailed';

export const McpOAuthCallbackPage: React.FC = () => {
  const completeAuth = useMcpStore((state) => state.completeAuth);
  const { t } = useI18n();
  const [status, setStatus] = React.useState<'working' | 'success' | 'error'>('working');
  const [returnToDesktop, setReturnToDesktop] = React.useState(false);
  const [messageKey, setMessageKey] = React.useState<McpOauthMessageKey | null>('settings.mcp.oauth.callback.working');
  const [rawMessage, setRawMessage] = React.useState<string | null>(null);

  const title =
    status === 'working'
      ? t('settings.mcp.oauth.callback.titles.working')
      : status === 'success'
        ? t('settings.mcp.oauth.callback.titles.success')
        : t('settings.mcp.oauth.callback.titles.error');
  const message = rawMessage ?? (messageKey ? t(messageKey) : t('settings.mcp.oauth.callback.completeFailed'));

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      setStatus('error');
      setMessageKey('settings.mcp.oauth.callback.browserUnavailable');
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const code = parseQueryParam(params, 'code');
    const callbackContext = parseMcpOAuthCallbackContext(params);
    const callbackStateKey = parseMcpOAuthCallbackStateKey(params);
    const error = parseQueryParam(params, 'error');
    const errorDescription = parseQueryParam(params, 'error_description');

    if (error) {
      if (callbackStateKey) {
        void runtimeFetch(`/api/mcp/auth/pending?state=${encodeURIComponent(callbackStateKey)}`, { method: 'DELETE' }).catch(() => undefined);
      }
      setStatus('error');
      setRawMessage(errorDescription ?? error);
      return;
    }

    void (async () => {
      try {
        if (!code) {
          setMessageKey('settings.mcp.oauth.callback.missingCode');
          throw new Error('missing-code');
        }

        let pendingContext = callbackContext;
        let startedFromDesktop = false;
        // Always consulted, even when the state already carries the server:
        // the origin lives only here, and it decides where the user is sent
        // back to.
        if (callbackStateKey) {
          const response = await runtimeFetch(`/api/mcp/auth/pending?state=${encodeURIComponent(callbackStateKey)}`);
          if (response.ok) {
            const payload = await response.json().catch(() => null) as {
              name?: string;
              directory?: string | null;
              origin?: string | null;
            } | null;
            startedFromDesktop = payload?.origin === MCP_OAUTH_ORIGIN_DESKTOP;
            setReturnToDesktop(startedFromDesktop);
            if (!pendingContext && payload?.name?.trim()) {
              pendingContext = {
                name: payload.name.trim(),
                directory: typeof payload.directory === 'string' && payload.directory.trim() ? payload.directory.trim() : null,
              };
            }
          }
        }

        if (!pendingContext?.name) {
          setMessageKey('settings.mcp.oauth.callback.sessionUnavailable');
          throw new Error('session-unavailable');
        }

        await completeAuth(pendingContext.name, code, pendingContext.directory);
        if (callbackStateKey) {
          await runtimeFetch(`/api/mcp/auth/pending?state=${encodeURIComponent(callbackStateKey)}`, { method: 'DELETE' }).catch(() => undefined);
        }
        setStatus('success');
        setMessageKey('settings.mcp.oauth.callback.success');
        setRawMessage(null);
        // Attempted straight away: the user's attention is in a browser tab,
        // and the app they were working in is behind it. The button below
        // stays as the fallback for a browser that blocks the protocol jump.
        if (startedFromDesktop) {
          returnToApp(true);
        }
      } catch (authError) {
        if (callbackStateKey) {
          await runtimeFetch(`/api/mcp/auth/pending?state=${encodeURIComponent(callbackStateKey)}`, { method: 'DELETE' }).catch(() => undefined);
        }
        setStatus('error');
        const raw = authError instanceof Error ? authError.message : '';
        if (raw === 'missing-code' || raw === 'session-unavailable') {
          setRawMessage(null);
        } else if (/oauth state required/i.test(raw)) {
          setMessageKey('settings.mcp.oauth.callback.sessionExpired');
          setRawMessage(null);
        } else {
          setMessageKey('settings.mcp.oauth.callback.completeFailed');
          setRawMessage(raw || null);
        }
      }
    })();
  }, [completeAuth]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-foreground">
      <div className="w-full max-w-xl rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-8 shadow-sm">
        <div className="space-y-3 text-center">
          <h1 className={SETTINGS_PAGE_TITLE_CLASS}>{title}</h1>
          <p
            className={cn(
              'typography-body',
              status === 'error'
                ? 'text-[var(--status-error)]'
                : status === 'success'
                  ? 'text-[var(--status-success)]'
                  : 'text-[var(--status-info)]',
            )}
          >
            {message}
          </p>
        </div>

        {status !== 'working' && (
          <div className="mt-8 flex justify-center">
            <Button
              type="button"
              onClick={() => returnToApp(returnToDesktop)}
            >
              {t('settings.mcp.oauth.callback.return')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
