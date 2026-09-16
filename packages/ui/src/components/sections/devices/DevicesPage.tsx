import React from 'react';

import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
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
const APPROVAL_LABELS = {
  deny: '禁止操作',
  smart: '智能审批',
  auto: '全自动',
} as const satisfies { [K in ApprovalMode]: string };

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
  const [devices, setDevices] = React.useState<DevicePublicView[]>([]);
  const [audit, setAudit] = React.useState<AuditEntry[]>([]);
  const [tokens, setTokens] = React.useState<TokenView[]>([]);
  const [issuedToken, setIssuedToken] = React.useState<string | null>(null);
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
      const [devicesRes, auditRes, tokensRes] = await Promise.all([
        runtimeFetch('/api/devices'),
        runtimeFetch('/api/devices/audit?limit=20'),
        runtimeFetch('/api/devices/mcp/tokens'),
      ]);
      if (!devicesRes.ok) throw new Error(`设备列表 HTTP ${devicesRes.status}`);
      setDevices(parseDevicesPayload(await readJson(devicesRes)));
      if (auditRes.ok) setAudit(parseAuditPayload(await readJson(auditRes)));
      if (tokensRes.ok) setTokens(parseTokensPayload(await readJson(tokensRes)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const enroll = async () => {
    if (!draftName.trim()) {
      setError('请填写设备名称');
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
        throw new Error(payload || `登记失败 HTTP ${response.status}`);
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
      if (!response.ok) throw new Error(`更新审批档失败 HTTP ${response.status}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = async (id: string) => {
    if (!window.confirm('确定删除这台登记设备？')) return;
    setBusy(true);
    try {
      const response = await runtimeFetch(`/api/devices/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`删除失败 HTTP ${response.status}`);
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
      if (!response.ok) throw new Error(`创建 token 失败 HTTP ${response.status}`);
      setIssuedToken(parseIssuedToken(await readJson(response)));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPageLayout title="设备" description="登记 Windows 设备，供 agent 通过 MCP 操作 shell / 文件 / 屏幕。">
      {error ? (
        <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm">{error}</div>
      ) : null}

      <section className="mb-8 space-y-3">
        <h2 className="text-sm font-semibold">已登记设备</h2>
        {devices.length === 0 ? (
          <p className="text-sm opacity-70">还没有设备。在下方登记第一台 Windows 机器。</p>
        ) : (
          <div className="space-y-2">
            {devices.map((device) => (
              <div key={device.id} className="rounded-md border border-border/60 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{device.name}</span>
                  <span className="opacity-60">{device.id}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{device.status}</span>
                  {device.capabilities.shell ? <span className="text-xs opacity-70">shell</span> : null}
                  {device.capabilities.files ? <span className="text-xs opacity-70">files</span> : null}
                  {device.capabilities.screen ? <span className="text-xs opacity-70">screen</span> : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <label className="text-xs opacity-70" htmlFor={`approval-${device.id}`}>审批</label>
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
                      <option key={mode} value={mode}>{APPROVAL_LABELS[mode]}</option>
                    ))}
                  </select>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void removeDevice(device.id)}>
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mb-8 space-y-3">
        <h2 className="text-sm font-semibold">登记新设备</h2>
        <div className="grid gap-2 md:grid-cols-2">
          <input className="rounded border border-border/60 bg-background px-2 py-1.5 text-sm" placeholder="名称，例如 施工机" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
          <input className="rounded border border-border/60 bg-background px-2 py-1.5 text-sm" placeholder="Tailscale IP（可选）" value={draftHost} onChange={(e) => setDraftHost(e.target.value)} />
          <input className="rounded border border-border/60 bg-background px-2 py-1.5 text-sm" placeholder="SSH 端口（默认 22）" value={draftSshPort} onChange={(e) => setDraftSshPort(e.target.value)} />
          <input className="rounded border border-border/60 bg-background px-2 py-1.5 text-sm" placeholder="Windows-MCP 端口（可选，隧道出口）" value={draftMcpPort} onChange={(e) => setDraftMcpPort(e.target.value)} />
          <input className="rounded border border-border/60 bg-background px-2 py-1.5 text-sm" placeholder="SSH 用户" value={draftUser} onChange={(e) => setDraftUser(e.target.value)} />
          <input className="rounded border border-border/60 bg-background px-2 py-1.5 text-sm" placeholder="Windows-MCP Bearer（可选）" value={draftMcpBearer} onChange={(e) => setDraftMcpBearer(e.target.value)} />
          <textarea className="rounded border border-border/60 bg-background px-2 py-1.5 text-sm md:col-span-2" rows={3} placeholder="SSH 私钥（可选，仅存服务器 data dir）" value={draftSshKey} onChange={(e) => setDraftSshKey(e.target.value)} />
        </div>
        <Button size="sm" disabled={busy} onClick={() => void enroll()}>登记设备</Button>
      </section>

      <section className="mb-8 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Agent MCP Token</h2>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void createAgentToken()}>生成 token</Button>
        </div>
        {issuedToken ? (
          <div className="rounded-md border border-border/60 p-3 text-xs">
            <div className="mb-1 opacity-70">请立即复制，关闭后不再显示：</div>
            <code className="block break-all">{issuedToken}</code>
            <div className="mt-2 opacity-70">MCP 端点：POST /api/devices/mcp（Authorization: Bearer &lt;token&gt;）</div>
          </div>
        ) : null}
        <ul className="space-y-1 text-xs opacity-80">
          {tokens.map((token) => (
            <li key={token.id}>{token.label} · 创建于 {token.createdAt}</li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">最近审计</h2>
        {audit.length === 0 ? (
          <p className="text-sm opacity-70">暂无记录。</p>
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
