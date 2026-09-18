import React from 'react';

import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

type ApprovalMode = 'deny' | 'smart' | 'auto';

/** Boundary JSON value after `response.json()` — only this shape is accepted. */
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface DevicePublicView {
  id: string;
  name: string;
  platform: string;
  status: string;
  capabilities: { shell: boolean; files: boolean; screen: boolean };
  approval: ApprovalMode;
  auth: { sshUser: string; hasSshKey: boolean; hasMcpBearer: boolean };
  lastSeenAt: string | null;
}

interface AuditEntry {
  ts: string;
  deviceId: string | null;
  tool: string | null;
  actor: string | null;
  decision: string;
  durationMs: number | null;
  error: string | null;
}

interface TokenView {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const APPROVAL_MODES = ['deny', 'smart', 'auto'] as const;
const APPROVAL_KEYS = {
  deny: 'settings.devices.approval.deny',
  smart: 'settings.devices.approval.smart',
  auto: 'settings.devices.approval.auto',
} as const satisfies { [K in ApprovalMode]: 'settings.devices.approval.deny' | 'settings.devices.approval.smart' | 'settings.devices.approval.auto' };

const isApprovalMode = (value: string): value is ApprovalMode =>
  value === 'deny' || value === 'smart' || value === 'auto';

const jsonTag = (value: JsonValue | undefined | unknown): string =>
  Object.prototype.toString.call(value);

const asObject = (value: JsonValue): { [key: string]: JsonValue } | null => {
  if (jsonTag(value) !== '[object Object]') return null;
  // SAFETY: tag was '[object Object]' on a JsonValue, so the object arm holds.
  return value as { [key: string]: JsonValue };
};

const asText = (value: JsonValue | undefined, fallback = ''): string => {
  const tag = jsonTag(value);
  if (tag === '[object String]') return String(value);
  if (tag === '[object Number]' || tag === '[object Boolean]') return String(value);
  return fallback;
};

const asOptionalText = (value: JsonValue | undefined): string | null => {
  if (jsonTag(value) !== '[object String]') return null;
  return String(value);
};

const asCount = (value: JsonValue | undefined): number | null => {
  if (jsonTag(value) !== '[object Number]') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const parseDevicesPayload = (value: JsonValue): DevicePublicView[] => {
  const root = asObject(value);
  const devices = root && Array.isArray(root.devices) ? root.devices : [];
  const out: DevicePublicView[] = [];
  for (const item of devices) {
    const record = asObject(item);
    if (!record) continue;
    const id = asText(record.id);
    if (!id) continue;
    const capabilities = asObject(record.capabilities) || {};
    const auth = asObject(record.auth) || {};
    const approvalRaw = asText(record.approval, 'smart');
    out.push({
      id,
      name: asText(record.name, id),
      platform: asText(record.platform, 'windows'),
      status: asText(record.status, 'unknown'),
      capabilities: {
        shell: capabilities.shell !== false,
        files: capabilities.files !== false,
        screen: capabilities.screen === true,
      },
      approval: isApprovalMode(approvalRaw) ? approvalRaw : 'smart',
      auth: {
        sshUser: asText(auth.sshUser, 'agent'),
        hasSshKey: auth.hasSshKey === true,
        hasMcpBearer: auth.hasMcpBearer === true,
      },
      lastSeenAt: asOptionalText(record.lastSeenAt),
    });
  }
  return out;
};

const parseAuditPayload = (value: JsonValue): AuditEntry[] => {
  const root = asObject(value);
  const entries = root && Array.isArray(root.entries) ? root.entries : [];
  const out: AuditEntry[] = [];
  for (const item of entries) {
    const record = asObject(item);
    if (!record) continue;
    out.push({
      ts: asText(record.ts),
      deviceId: asOptionalText(record.deviceId),
      tool: asOptionalText(record.tool),
      actor: asOptionalText(record.actor),
      decision: asText(record.decision, 'unknown'),
      durationMs: asCount(record.durationMs),
      error: asOptionalText(record.error),
    });
  }
  return out;
};

const parseTokensPayload = (value: JsonValue): TokenView[] => {
  const root = asObject(value);
  const tokens = root && Array.isArray(root.tokens) ? root.tokens : [];
  const out: TokenView[] = [];
  for (const item of tokens) {
    const record = asObject(item);
    if (!record) continue;
    out.push({
      id: asText(record.id),
      label: asText(record.label, 'token'),
      createdAt: asText(record.createdAt),
      lastUsedAt: asOptionalText(record.lastUsedAt),
    });
  }
  return out;
};

const parseErrorPayload = (value: JsonValue | null): string | null => {
  if (value === null) return null;
  const record = asObject(value);
  if (!record) return null;
  return asOptionalText(record.error);
};

const parseIssuedToken = (value: JsonValue): string | null => {
  const root = asObject(value);
  const token = root ? asObject(root.token) : null;
  if (!token) return null;
  return asOptionalText(token.token);
};

interface EnrollTokenView {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
}

const parseEnrollTokensPayload = (value: JsonValue): EnrollTokenView[] => {
  const root = asObject(value);
  const tokens = root && Array.isArray(root.tokens) ? root.tokens : [];
  const out: EnrollTokenView[] = [];
  for (const item of tokens) {
    const record = asObject(item);
    if (!record) continue;
    out.push({
      id: asText(record.id),
      label: asText(record.label, 'enroll'),
      createdAt: asText(record.createdAt),
      expiresAt: asText(record.expiresAt),
    });
  }
  return out;
};

interface DeviceHealthView {
  id: string;
  name: string;
  online: boolean;
  latencyMs: number | null;
  transport: string | null;
  sshOk: boolean;
  mcpOk: boolean;
  checkedAt: string;
}

interface DeviceStatusSnapshot {
  checkedAt: string;
  onlineCount: number;
  total: number;
  devices: DeviceHealthView[];
}

const parseStatusPayload = (value: JsonValue): DeviceStatusSnapshot | null => {
  const root = asObject(value);
  if (!root) return null;
  const list = Array.isArray(root.devices) ? root.devices : [];
  const devices: DeviceHealthView[] = [];
  for (const item of list) {
    const record = asObject(item);
    if (!record) continue;
    const id = asText(record.id);
    if (!id) continue;
    const ssh = asObject(record.ssh) || {};
    const mcp = asObject(record.mcp) || {};
    devices.push({
      id,
      name: asText(record.name, id),
      online: record.online === true,
      latencyMs: asCount(record.latencyMs),
      transport: asOptionalText(record.transport),
      sshOk: ssh.ok === true,
      mcpOk: mcp.ok === true,
      checkedAt: asText(record.checkedAt),
    });
  }
  return {
    checkedAt: asText(root.checkedAt),
    onlineCount: asCount(root.onlineCount) ?? 0,
    total: asCount(root.total) ?? devices.length,
    devices,
  };
};

const joinCommandFor = (token: string): string => {
  const origin = globalThis.location?.origin || '';
  return `irm '${origin}/api/devices/join.ps1?t=${token}' | iex`;
};

const readJson = async (response: Response): Promise<JsonValue> => {
  const payload: unknown = await response.json();
  const tag = Object.prototype.toString.call(payload);
  if (tag === '[object Null]' || tag === '[object Undefined]') return null;
  if (tag === '[object Array]' || tag === '[object Object]') {
    // SAFETY: JSON parse roots are array/object records when the tag says so.
    return payload as JsonValue;
  }
  if (tag === '[object String]' || tag === '[object Number]' || tag === '[object Boolean]') {
    // SAFETY: JSON primitives keep their primitive tag after parse.
    return payload as JsonValue;
  }
  return null;
};

export const DevicesPage: React.FC = () => {
  const { t } = useI18n();
  const [devices, setDevices] = React.useState<DevicePublicView[]>([]);
  const [audit, setAudit] = React.useState<AuditEntry[]>([]);
  const [tokens, setTokens] = React.useState<TokenView[]>([]);
  const [issuedToken, setIssuedToken] = React.useState<string | null>(null);
  const [enrollTokens, setEnrollTokens] = React.useState<EnrollTokenView[]>([]);
  const [issuedEnroll, setIssuedEnroll] = React.useState<{ token: string; expiresAt: string } | null>(null);
  const [status, setStatus] = React.useState<DeviceStatusSnapshot | null>(null);
  const [statusBusy, setStatusBusy] = React.useState(false);
  const [statusError, setStatusError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [draftName, setDraftName] = React.useState('');
  const [draftHost, setDraftHost] = React.useState('');
  const [draftSshPort, setDraftSshPort] = React.useState('22');
  const [draftMcpPort, setDraftMcpPort] = React.useState('');
  const [draftUser, setDraftUser] = React.useState('agent');
  const [draftSshKey, setDraftSshKey] = React.useState('');
  const [draftMcpBearer, setDraftMcpBearer] = React.useState('');

  const refresh = React.useCallback(async () => {
    try {
      const [devicesRes, auditRes, tokensRes, enrollRes] = await Promise.all([
        runtimeFetch('/api/devices'),
        runtimeFetch('/api/devices/audit?limit=20'),
        runtimeFetch('/api/devices/mcp/tokens'),
        runtimeFetch('/api/devices/enroll/tokens'),
      ]);
      if (!devicesRes.ok) throw new Error(t('settings.devices.error.loadDevices', { status: devicesRes.status }));
      setDevices(parseDevicesPayload(await readJson(devicesRes)));
      if (auditRes.ok) setAudit(parseAuditPayload(await readJson(auditRes)));
      if (tokensRes.ok) setTokens(parseTokensPayload(await readJson(tokensRes)));
      if (enrollRes.ok) setEnrollTokens(parseEnrollTokensPayload(await readJson(enrollRes)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [t]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshStatus = React.useCallback(async () => {
    setStatusBusy(true);
    setStatusError(null);
    try {
      const response = await runtimeFetch('/api/devices/status');
      if (!response.ok) throw new Error(t('settings.devices.error.statusProbe', { status: response.status }));
      setStatus(parseStatusPayload(await readJson(response)));
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatusBusy(false);
    }
  }, [t]);

  React.useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const healthById = React.useMemo(() => {
    const map = new Map<string, DeviceHealthView>();
    for (const entry of status?.devices || []) {
      map.set(entry.id, entry);
    }
    return map;
  }, [status]);

  const enroll = async () => {
    if (!draftName.trim()) {
      setError(t('settings.devices.error.nameRequired'));
      return;
    }
    setBusy(true);
    try {
      const sshPort = Number(draftSshPort) || 22;
      const mcpPort = draftMcpPort.trim() ? Number(draftMcpPort) : null;
      const tunnel = { sshPort, mcpPort };
      const connection = draftHost.trim()
        ? {
          tailscale: { host: draftHost.trim(), sshPort, mcpPort },
          tunnel,
        }
        : { tunnel };

      const body = {
        name: draftName.trim(),
        capabilities: { shell: true, files: true, screen: mcpPort !== null },
        connection,
        auth: { sshUser: draftUser.trim() || 'agent' },
        approval: 'smart' as const,
        sshPrivateKey: draftSshKey.trim() ? draftSshKey : undefined,
        mcpBearer: draftMcpBearer.trim() ? draftMcpBearer : undefined,
      };

      const response = await runtimeFetch('/api/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = parseErrorPayload(await readJson(response).catch(() => null));
        throw new Error(payload || t('settings.devices.error.enrollFailed', { status: response.status }));
      }
      setDraftName('');
      setDraftHost('');
      setDraftSshKey('');
      setDraftMcpBearer('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const setApproval = async (id: string, approval: ApprovalMode) => {
    setBusy(true);
    try {
      const response = await runtimeFetch(`/api/devices/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approval }),
      });
      if (!response.ok) throw new Error(t('settings.devices.error.approvalFailed', { status: response.status }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = async (id: string) => {
    if (!window.confirm(t('settings.devices.dialog.deleteConfirm'))) return;
    setBusy(true);
    try {
      const response = await runtimeFetch(`/api/devices/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(t('settings.devices.error.deleteFailed', { status: response.status }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createAgentToken = async () => {
    setBusy(true);
    try {
      const response = await runtimeFetch('/api/devices/mcp/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'device-agent' }),
      });
      if (!response.ok) throw new Error(t('settings.devices.error.createTokenFailed', { status: response.status }));
      setIssuedToken(parseIssuedToken(await readJson(response)));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createEnrollToken = async () => {
    setBusy(true);
    try {
      const response = await runtimeFetch('/api/devices/enroll/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'one-click-join' }),
      });
      if (!response.ok) throw new Error(t('settings.devices.error.createEnrollFailed', { status: response.status }));
      const payload = asObject(await readJson(response));
      const token = payload ? asObject(payload.token) : null;
      const plaintext = token ? asOptionalText(token.token) : null;
      const expiresAt = token ? asText(token.expiresAt) : '';
      if (!plaintext) throw new Error(t('settings.devices.error.enrollTokenMissing'));
      setIssuedEnroll({ token: plaintext, expiresAt });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError(t('settings.devices.toast.copyFailed'));
    }
  };

  return (
    <SettingsPageLayout title={t('settings.page.devices.title')} description={t('settings.page.devices.description')}>
      {error ? (
        <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm">{error}</div>
      ) : null}

      <section className="mb-8 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">{t('settings.devices.section.registered')}</h2>
            {status ? (
              <p className="text-xs opacity-70">
                {t('settings.devices.status.onlineCount', { online: status.onlineCount, total: status.total })}
                {status.checkedAt ? ` · ${t('settings.devices.status.probedAt', { time: status.checkedAt })}` : ''}
              </p>
            ) : (
              <p className="text-xs opacity-70">{t('settings.devices.status.probing')}</p>
            )}
          </div>
          <Button variant="outline" size="sm" disabled={statusBusy} onClick={() => void refreshStatus()}>
            {statusBusy ? t('settings.devices.actions.probing') : t('settings.devices.actions.refresh')}
          </Button>
        </div>
        {statusError ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
            {t('settings.devices.status.probeFailed', { error: statusError })}
          </div>
        ) : null}
        {devices.length === 0 ? (
          <p className="text-sm opacity-70">{t('settings.devices.empty')}</p>
        ) : (
          <div className="space-y-2">
            {devices.map((device) => {
              const health = healthById.get(device.id);
              const online = health ? health.online : device.status === 'online';
              return (
                <div key={device.id} className="rounded-md border border-border/60 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      aria-label={online ? t('settings.devices.status.online') : t('settings.devices.status.offline')}
                      className={
                        online
                          ? 'inline-block h-2 w-2 rounded-full bg-emerald-500'
                          : 'inline-block h-2 w-2 rounded-full bg-zinc-400'
                      }
                    />
                    <span className="font-medium">{device.name}</span>
                    <span className="opacity-60">{device.id}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {online ? t('settings.devices.status.online') : t('settings.devices.status.offline')}
                    </span>
                    {health?.latencyMs != null ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums">
                        {health.latencyMs} ms
                      </span>
                    ) : null}
                    {health?.transport ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{health.transport}</span>
                    ) : null}
                    {health ? (
                      <span className="text-xs opacity-70">
                        SSH {health.sshOk ? '✓' : '✗'}
                        {' · '}
                        MCP {health.mcpOk ? '✓' : '✗'}
                      </span>
                    ) : (
                      <span className="text-xs opacity-50">{device.status}</span>
                    )}
                    {device.capabilities.shell ? <span className="text-xs opacity-70">shell</span> : null}
                    {device.capabilities.files ? <span className="text-xs opacity-70">files</span> : null}
                    {device.capabilities.screen ? <span className="text-xs opacity-70">screen</span> : null}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="text-xs opacity-70" htmlFor={`approval-${device.id}`}>{t('settings.devices.actions.approval')}</label>
                    <select
                      id={`approval-${device.id}`}
                      className="rounded border border-border/60 bg-background px-2 py-1 text-xs"
                      value={device.approval}
                      disabled={busy}
                      onChange={(event) => {
                        const next = event.target.value;
                        if (isApprovalMode(next)) void setApproval(device.id, next);
                      }}
                    >
                      {APPROVAL_MODES.map((mode) => (
                        <option key={mode} value={mode}>{t(APPROVAL_KEYS[mode])}</option>
                      ))}
                    </select>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void removeDevice(device.id)}>
                      {t('settings.devices.actions.delete')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="mb-8 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">{t('settings.devices.enroll.title')}</h2>
            <p className="text-xs opacity-70">{t('settings.devices.enroll.description')}</p>
          </div>
          <Button size="sm" disabled={busy} onClick={() => void createEnrollToken()}>{t('settings.devices.enroll.generate')}</Button>
        </div>
        {issuedEnroll ? (
          <div className="rounded-md border border-border/60 p-3 text-xs space-y-2">
            <div className="opacity-70">{t('settings.devices.enroll.copyToTarget', { expiresAt: issuedEnroll.expiresAt })}</div>
            <code className="block break-all select-all rounded bg-muted px-2 py-1.5">
              {joinCommandFor(issuedEnroll.token)}
            </code>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => void copyText(joinCommandFor(issuedEnroll.token))}>
                {t('settings.devices.enroll.copyCommand')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void copyText(issuedEnroll.token)}>
                {t('settings.devices.enroll.copyCodeOnly')}
              </Button>
            </div>
            <div className="opacity-70">
              {t('settings.devices.enroll.scriptHelp')}
            </div>
          </div>
        ) : (
          <p className="text-sm opacity-70">{t('settings.devices.enroll.hint')}</p>
        )}
        {enrollTokens.length > 0 ? (
          <ul className="space-y-1 text-xs opacity-80">
            {enrollTokens.map((token) => (
              <li key={token.id}>{t('settings.devices.enroll.tokenItem', { label: token.label, expiresAt: token.expiresAt })}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="mb-8 space-y-3">
        <h2 className="text-sm font-semibold">{t('settings.devices.form.manual')}</h2>
        <div className="grid gap-2 md:grid-cols-2">
          <input className="rounded border border-border/60 bg-background px-2 py-1.5 text-sm" placeholder={t('settings.devices.form.namePlaceholder')} value={draftName} onChange={(e) => setDraftName(e.target.value)} />
          <input className="rounded border border-border/60 bg-background px-2 py-1.5 text-sm" placeholder={t('settings.devices.form.hostPlaceholder')} value={draftHost} onChange={(e) => setDraftHost(e.target.value)} />
          <input className="rounded border border-border/60 bg-background px-2 py-1.5 text-sm" placeholder={t('settings.devices.form.sshPortPlaceholder')} value={draftSshPort} onChange={(e) => setDraftSshPort(e.target.value)} />
          <input className="rounded border border-border/60 bg-background px-2 py-1.5 text-sm" placeholder={t('settings.devices.form.mcpPortPlaceholder')} value={draftMcpPort} onChange={(e) => setDraftMcpPort(e.target.value)} />
          <input className="rounded border border-border/60 bg-background px-2 py-1.5 text-sm" placeholder={t('settings.devices.form.sshUserPlaceholder')} value={draftUser} onChange={(e) => setDraftUser(e.target.value)} />
          <input className="rounded border border-border/60 bg-background px-2 py-1.5 text-sm" placeholder={t('settings.devices.form.mcpBearerPlaceholder')} value={draftMcpBearer} onChange={(e) => setDraftMcpBearer(e.target.value)} />
          <textarea className="rounded border border-border/60 bg-background px-2 py-1.5 text-sm md:col-span-2" rows={3} placeholder={t('settings.devices.form.sshKeyPlaceholder')} value={draftSshKey} onChange={(e) => setDraftSshKey(e.target.value)} />
        </div>
        <Button size="sm" disabled={busy} onClick={() => void enroll()}>{t('settings.devices.actions.enroll')}</Button>
      </section>

      <section className="mb-8 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('settings.devices.section.agentMcpToken')}</h2>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void createAgentToken()}>{t('settings.devices.actions.createToken')}</Button>
        </div>
        {issuedToken ? (
          <div className="rounded-md border border-border/60 p-3 text-xs">
            <div className="mb-1 opacity-70">{t('settings.devices.token.copyOnce')}</div>
            <code className="block break-all">{issuedToken}</code>
            <div className="mt-2 opacity-70">{t('settings.devices.token.endpointHint')}</div>
          </div>
        ) : null}
        <ul className="space-y-1 text-xs opacity-80">
          {tokens.map((token) => (
            <li key={token.id}>{token.label} · {t('settings.devices.token.createdAt', { time: token.createdAt })}</li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t('settings.devices.section.audit')}</h2>
        {audit.length === 0 ? (
          <p className="text-sm opacity-70">{t('settings.devices.audit.empty')}</p>
        ) : (
          <ul className="space-y-1 text-xs opacity-80">
            {audit.map((entry, index) => (
              <li key={`${entry.ts}-${index}`}>
                {entry.ts} · {entry.tool} · {entry.deviceId || '—'} · {entry.decision}
                {entry.error ? ` · ${entry.error}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </SettingsPageLayout>
  );
};

export default DevicesPage;
