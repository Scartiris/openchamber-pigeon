# Device MCP Module Documentation

## Purpose

This module lets agents operate **registered Windows devices** the way a local
agent would: shell, files, and (via Windows-MCP) screen/UI actions. It is the
OpenChamber-side control plane for multi-device work on pigeoncore.

## Entrypoints and structure

- `packages/web/server/lib/devices/index.js` — composition root
  (`createDeviceRuntime`).
- `registry.js` — device records, connection candidates, approval mode, secrets
  store (SSH private key / Windows-MCP bearer). Secrets never leave the data dir
  and are never returned by API responses.
- `tokens.js` — agent-facing MCP bearer tokens (`oc_device_mcp_…`), hashed at
  rest.
- `transport.js` — prefers a reachable Tailscale address, falls back to loopback
  tunnel ports. Fails closed with `transport_unavailable`.
- `ssh.js` — system OpenSSH client against the resolved host (exec / list /
  read / write on Windows devices via PowerShell helpers).
- `windows-mcp.js` — JSON-RPC proxy to a Windows-MCP worker (`screenshot`,
  `click`, `type`, `get_elements`).
- `approval.js` — per-device modes: `deny` / `smart` (reads only in M1) /
  `auto`.
- `audit.js` — ring-buffer audit log under `<data>/devices/audit.json`.
- `tools.js` — fixed tool catalog + orchestration.
- `mcp.js` — Streamable HTTP MCP handler (`initialize`, `tools/list`,
  `tools/call`).
- `routes.js` — management REST + `POST /api/devices/mcp`.

## HTTP surface

| Route | Auth | Purpose |
|---|---|---|
| `GET/POST /api/devices` | UI session | List / enroll devices |
| `GET/PATCH/DELETE /api/devices/:id` | UI session | Read / update / remove |
| `POST /api/devices/:id/test` | UI session | Run one tool for verification |
| `GET /api/devices/audit` | UI session | Recent audit entries |
| `GET/POST /api/devices/mcp/tokens`, `DELETE .../:id` | UI session | Agent token lifecycle |
| `POST /api/devices/mcp` | `Bearer oc_device_mcp_…` | MCP endpoint for any agent |

UI session auth covers management routes via the shared `/api` middleware. The
MCP path is exempted only when the Authorization header carries the dedicated
device-MCP prefix; the handler still validates the token.

## Fixed MCP tools

`devices.list`, `devices.shell.exec`, `devices.fs.list`, `devices.fs.read`,
`devices.fs.write`, `devices.screen.capture`, `devices.ui.click`,
`devices.ui.type`, `devices.ui.elements`.

Tools do **not** change with online devices. Callers pass `device_id`.

## Invariants

- Failure is explicit: `device_not_found`, `device_offline` /
  `transport_unavailable`, `permission_denied`, `approval_required`,
  `capability_missing`, `upstream_error`. Never empty success on failure.
- Default approval for new devices is `smart` (not `auto`).
- SSH keys and Windows-MCP bearers live only in `<data>/devices/secrets.json`.
- The transport resolver probes before use; it does not assume connectivity.
- Device FS/SSH never falls through to the server-local `/api/fs` paths.

## Composition contract with `index.js` / feature routes

`feature-routes-runtime.js` constructs the runtime with `openchamberDataDir`,
`fsPromises`, `path`, `crypto`, `net`, `spawn`, `os`. Routes register before the
OpenCode catch-all proxy.

## M1 limits

- One Windows worker protocol (Windows-MCP tool names may need adjustment when
  the real worker is wired).
- `smart` mode has no async approval UI yet: writes return `approval_required`.
- Tunnel server (rathole/frp) is external; this module only consumes loopback
  ports recorded on the device record.

## One-click enrollment

Settings → 设备 → **一键注册** issues a short-lived single-use token
(`oc_enroll_…`, 15 minutes). The copyable line is:

```powershell
irm 'https://<host>/api/devices/join.ps1?t=<token>' | iex
```

- `GET /api/devices/join.ps1?t=` — public while the token is unspent; serves a
  PowerShell script that generates/reuses an SSH key, best-effort authorizes it
  (including `administrators_authorized_keys` when elevated), probes Tailscale,
  **silently installs Windows-MCP with login autostart** (scheduled task when
  elevated, Startup-folder fallback otherwise), writes a BOM-free
  `~/.windows-mcp/config.toml` (auth_key + bind), health-checks it, then calls
  enroll.
- `POST /api/devices/enroll` — public with `Authorization: Bearer oc_enroll_…`;
  creates **one** device and spends the token.
- `GET/POST/DELETE /api/devices/enroll/tokens` — UI-session management.

Manual enrollment remains available for advanced cases.

### Manual steps

1. On the Windows machine, enable OpenSSH Server and start Windows-MCP with
   HTTP transport + a bearer key (listen on a tunnel/Tailscale-reachable port).
2. In OpenChamber Settings → 设备: create a device, set Tailscale host or
   tunnel ports, paste SSH private key and Windows-MCP bearer (stored only in
   `<data>/devices/secrets.json`).
3. Generate an agent MCP token on the same page.
4. Point any MCP client at `POST /api/devices/mcp` with
   `Authorization: Bearer oc_device_mcp_…`.

Example initialize/tools/call smoke (after token issue):

```bash
curl -sS -X POST "$OPENCHAMBER/api/devices/mcp" \
  -H "Authorization: Bearer $DEVICE_MCP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Tests

`devices.test.js` covers registry secret redaction, tokens, approval matrix,
transport preference/fail-closed, tool orchestration, and the MCP handler.

## Validation performed (2026-09-16)

- `bun run test -- server/lib/devices/devices.test.js` → **13 passed** (includes
  enroll token single-use/expiry and join script embedding)
- One-click e2e: create enroll token → fetch `join.ps1` without UI auth →
  `POST /api/devices/enroll` creates device → reuse 401 → join after spend 401.
- Module import smoke: `createDeviceRuntime`, `registerDeviceRoutes` load.
- Live HTTP e2e on isolated instance (`127.0.0.1:3021`, own data dir):
  - Login + create MCP token + register 本机 (admin@127.0.0.1:22, tunnel sshPort 22)
  - MCP `initialize` / `tools/list` / `devices.list` with `oc_device_mcp_` bearer (auth bypass works)
  - Invalid bearer → 401
  - `smart` → `approval_required` on shell.exec; `deny` → `permission_denied` on fs.list
  - Secrets never echoed in public device view
  - Transport probes 127.0.0.1:22; SSH client runs and returns structured
    `ssh_failed` (Permission denied) — not empty success
- Fixed during live verification:
  - `Number(null) === 0` corrupting `mcpPort` → `asFiniteNumber` now treats null/'' as fallback
  - Bun default `os` has no `promises` → temp SSH key uses `fsPromises.mkdtemp`
  - Channel failures were wrapped as tool `ok:true` → now `isError` with `ssh_failed`/etc.
  - Windows OpenSSH rejects `%TEMP%` key ACLs → protect inheritance and grant
    Read only to the process identity via PowerShell `Set-Acl`
- **本机 e2e 已通过**（隔离实例，设备 id 为一次性本地记录，未入库）：
  - shell: `whoami` / `hostname` / `echo` → exit 0
  - files: list Desktop / read sample system file / write + readback
  - screen: `devices.screen.capture` 返回真实 PNG，MCP image part 透传
  - ui: click / type 经 worker 打到本机
  - MCP token 鉴权、审批三档、审计、密钥不回显均通过
- **Windows-MCP（CursorTouch）实测通过**（uv + Python 3.14，`streamable-http`
  + `--auth-key`）：
  - 工具对齐：`Screenshot` / `Snapshot` / `Click` / `Type`（含 `Mcp-Session-Id` 握手）
  - 经 OpenChamber `/api/devices/mcp`：shell 回显、截屏 PNG image part、
    点击、Type 坐标、Snapshot 树
- e2e worker（兼容 mock）仅作早期链路验证；生产以 Windows-MCP 为准。
- 本机 e2e 脚本与密钥放在 gitignore 的 scratch 目录，**不入库**。
