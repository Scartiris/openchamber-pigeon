---
feature: device-mcp
status: delivered
updated: 2026-09-16
branch: 多设备端点
commits:  # filled at delivery
---

# Device MCP · 多设备操作（agent 像本地一样读写/截屏登记设备）

## Report

**What was built** — OpenChamber 内嵌多设备控制面（M1）：`packages/web/server/lib/devices` 提供设备注册表（密钥只存 data dir、API 不回显）、Tailscale 优先/隧道兜底的连通解析、SSH shell/文件工具、Windows-MCP 截屏/点击/类型代理、固定工具集的 MCP 端点 `POST /api/devices/mcp`（`oc_device_mcp_` Bearer）、三档审批与审计环。设置页「设备」可登记设备、改审批档、生成 agent token、看最近审计。设计见上文 S2；模块文档 `packages/web/server/lib/devices/DOCUMENTATION.md`。

**Verification** — `bun run test -- server/lib/devices/devices.test.js`：**10 passed**。`bunx oxlint packages/web/server/lib/devices packages/ui/src/components/sections/devices`：**0 errors**。评审发现并已修复：`app.use('/api')` 内 MCP 鉴权豁免路径应为 `/devices/mcp`。**未验证**：真机 Windows SSH / Windows-MCP 端到端（本环境无已登记设备）；部署 pigeoncore 后需按 DOCUMENTATION 手工验收清单执行。

**Journey log** — 见文末。

## [S1] Problem

鸽子核心（pigeoncore）上的 OpenChamber 工作台目前只能让 agent 操作**服务器本机**的文件、终端，以及工作台自带的浏览器面板。用户的三台 Windows 机器（施工机 / 笔记本 / 龙虾中枢）各自在 NAT 后，agent 无法：

1. 登记并列出可用设备；
2. 像本地 agent 一样在设备上读写文件、执行命令；
3. 读取屏幕并做鼠标/键盘操作（computer use）；
4. 把同一套能力以 **MCP** 形式暴露给以后可能出现的其他 agent，而不是只绑死 OpenChamber 自定义工具。

历史调研（`T:\pigeoncore\remote-mcp\`，2026-09-12）已确认：单机 computer-use MCP 生态成熟，但「自托管 + 设备注册 + 反连 + 面向 MCP 的舰队控制面」是空白；该计划停留在文档，未施工。

## [S2] Design

### 2.1 已定决策（Grill 2026-09-16）

| # | 决策 | 选择 |
|---|---|---|
| D1 | 能力边界 | Shell + 文件 **且** 截屏/鼠标键盘 |
| D2 | 首批设备 | 自己的 3 台 Windows；**M1 只做 1 台**（施工机）闭环 |
| D3 | 落地形态 | OpenChamber 工作台能力（代码在 `openchamber-pigeon` fork） |
| D4 | 连通 | **Tailscale 优先，反向隧道兜底**（设备零入站） |
| D5 | 设备侧 GUI worker | **Windows-MCP**（UIA 优先 + 截图兜底，MIT，streamable HTTP + Bearer） |
| D6 | Agent 暴露面 | **OpenChamber 内嵌 MCP 端点**（Streamable HTTP + Bearer），固定工具集 + `device_id` |
| D7 | 审批 | 每设备三档：`deny` / `smart`（高危确认）/ `auto`（只记审计） |
| D8 | M1 验收 | 1 台设备：注册 + SSH 读写/执行 + 截图点击输入 + 设备列表/审计 + MCP 可调用 |

### 2.2 架构总览

```text
┌─ Windows 设备（M1: 施工机） ──────────────────────────────────┐
│  OpenSSH Server          → shell + files                     │
│  Windows-MCP (localhost) → screen / ui click/type/elements   │
│  Tailscale（优先直连） / 反向隧道客户端（兜底）                 │
│  登记客户端：join 脚本 → 向工作台注册能力与连接候选             │
└──────────────────────────────┬────────────────────────────────┘
                               │ 出站：TS 或 tunnel
                               ▼
┌─ pigeoncore OpenChamber（:3000 容器） ────────────────────────┐
│  Device Registry     设备、能力、连接候选、审批档、状态          │
│  Transport Resolver  TS 直连优先 → tunnel loopback 端口        │
│  Device Tools        exec / fs.* / screen.*（代理到设备侧）    │
│  MCP Endpoint        POST /api/devices/mcp（Bearer）           │
│  Approval + Audit    三档审批 + 操作审计日志                    │
│  UI 面板             设备列表、状态、审批档、最近操作            │
└──────────────────────────────────────────────────────────────┘
```

**归属**：应用层能力与 MCP 端点写在 fork（`packages/web` + 可选 `packages/ui`）；部署编排、隧道服务端配置、设备侧 join 脚本模板属于 pigeoncore 适配层（后续在 `T:\pigeoncore\ops`）。

### 2.3 设备注册表（persisted）

存放于 OpenChamber data dir（建议 `<data>/devices/registry.json`，单用户实例用 JSON 即可；若已有更合适的持久化惯例则对齐）。

```ts
type DeviceRecord = {
  id: string;                    // 稳定 id，如 dev_xxx
  name: string;                  // 用户可见名「施工机」
  platform: "windows";
  status: "online" | "offline" | "unknown";
  capabilities: {
    shell: boolean;
    files: boolean;
    screen: boolean;             // Windows-MCP 是否可达
  };
  connection: {
    // 连接候选，按优先级解析
    tailscale?: { host: string; sshPort?: number; mcpPort?: number };
    tunnel?: { sshPort: number; mcpPort: number }; // 服务器 loopback 出口
  };
  // 凭据只存服务器 data dir，不入 git、不进日志
  auth: {
    sshUser: string;
    // 私钥路径或引用，禁止写入 API 响应
    sshKeyRef: string;
    mcpBearerRef: string;        // Windows-MCP auth key 引用
  };
  approval: "deny" | "smart" | "auto";
  lastSeenAt?: string;
  enrolledAt: string;
};
```

**不变量**：

- API 列表/详情**永不返回**私钥、Bearer 原文；只返回 `capabilities`、连接是否可用、审批档。
- 设备离线不得伪装成「成功空结果」；工具调用返回明确的 `device_offline` / `transport_unavailable`。
- 单设备失败不影响其他设备的完整结果。

### 2.4 连通解析（Transport Resolver）

对每次工具调用：

1. 若 `connection.tailscale` 存在且健康检查通过 → 用 TS 地址连 SSH / Windows-MCP。
2. 否则若 `connection.tunnel` 端口在 loopback 可连 → 走隧道出口。
3. 否则失败：`transport_unavailable`，附已尝试候选（不含密钥）。

M1 可先实现 **SSH over 候选地址** 与 **HTTP 代理到 Windows-MCP**；隧道服务端（rathole/frp）不在本仓库实现，只要求登记后的端口/地址契约。Tailscale 探活可用 `ping`/TCP connect，不强制依赖 tailscale CLI 进容器。

### 2.5 内嵌 MCP 端点

- 路径：`POST /api/devices/mcp`（Streamable HTTP；与现有 OpenChamber route 注册方式一致，**注册在通用 OpenCode 代理之前**）。
- 鉴权：`Authorization: Bearer <device-mcp-token>`；令牌由工作台设置页/CLI 生成，仅存 hash（对齐 `client-auth` 的 bearer 模型，但**不要**复用 UI pairing 的 client token 语义——这是 **agent 专用令牌**）。
- 工具集固定，不按在线设备变化 `tools/list`（符合 MCP 规范；避免 token 爆炸）：

| Tool | 参数 | 行为 |
|---|---|---|
| `devices.list` | — | 返回 id/name/status/capabilities/approval |
| `devices.shell.exec` | `device_id`, `command`, `cwd?`, `timeout_ms?` | SSH 执行；stdout/stderr/exit_code |
| `devices.fs.list` | `device_id`, `path` | 列目录 |
| `devices.fs.read` | `device_id`, `path`, `encoding?` | 读文本（大文件截断说明） |
| `devices.fs.write` | `device_id`, `path`, `content`, `overwrite?` | 写文件 |
| `devices.screen.capture` | `device_id`, `format?` | 返回截图（base64 或文件引用，按实现成本选一并写清） |
| `devices.ui.click` | `device_id`, `x`, `y`, `button?` | 坐标点击（M1） |
| `devices.ui.type` | `device_id`, `text` | 键入文本（M1） |
| `devices.ui.elements` | `device_id`, `query?` | UIA/可访问性树摘要（若 Windows-MCP 支持则透传；否则 M1 可标记 unimplemented） |

长命令：M1 用服务端超时 + 同步返回；若单命令易超时，再引入 `job_id` + 轮询（不进 M1 除非验收需要）。

**错误形状**：工具结果含结构化 `error`（`device_not_found` / `device_offline` / `permission_denied` / `approval_required` / `transport_unavailable` / `upstream_error`），禁止把失败写成空成功。

### 2.6 审批档（per device）

| 档 | 读（list/read/capture/elements） | 写/exec/点击输入 |
|---|---|---|
| `deny` | 拒绝 | 拒绝 |
| `smart`（默认） | 放行 | 高危（写路径、exec、ui.*）→ `approval_required`；M1 可用「设置里记 allowlist 命令前缀/路径」或「本会话已确认」最小实现 |
| `auto` | 放行 | 放行，只写审计 |

M1 的 `smart` 不必做完整异步审批 UI；必须保证：**默认不是 auto**，且拒绝时审计可见。

### 2.7 审计

每次工具调用追加审计记录（data dir，轮转/上限可后置）：

- `ts`, `device_id`, `tool`, `actor`（mcp token id 或 session）, `decision`, `duration_ms`, `error?`
- **不记** 命令全文中的疑似密钥；M1 可对 `command`/`content` 做长度截断。

### 2.8 工作台 UI（最小）

设置或独立「设备」入口：

- 设备列表：名称、平台、状态、能力徽章、审批档选择器；
- 复制 MCP 端点与生成/重置 agent token；
- 最近 N 条审计（时间、设备、工具、结果）。

UI 走 `runtimeFetch('/api/devices...')`，不得硬编码 origin；web 为 M1 必做 surface，其他 runtime 明确「未支持」即可。

### 2.9 与现有模块的边界

| 现有模块 | 关系 |
|---|---|
| `lib/relay`（配对 UI 客户端） | **不复用**为设备舰队通道；那是 UI↔host 的 E2EE 隧道 |
| `lib/browser-control` / `openchamber_web` | 控制的是工作台自带浏览器，不是登记 Windows 设备 |
| `lib/agent-tool` | OpenChamber 自身会话/调度工具；Device MCP 是**独立 agent 面** |
| `lib/client-auth` | 令牌「只存 hash、Bearer 认证」模式可借鉴；设备 MCP token 仍是独立命名空间 |
| `lib/fs` / `lib/terminal` | 服务器本机能力；设备能力不得误走本机路径 |

### 2.10 安全不变量

- 设备零入站：SSH/Windows-MCP 只监听 tailnet 或 127.0.0.1，经隧道/Tailscale 被服务器访问。
- 隧道出口（若启用）只绑 `127.0.0.1`。
- MCP token 与 SSH 私钥、Windows-MCP Bearer 一律不进 git、不进日志、不进 API 响应。
- 权限在服务端强制，不依赖 UI 隐藏。
- 默认审批档 `smart`，禁止新设备默认 `auto`。

## [S3] Out of Scope

- 3 台设备的完整舰队运维与一键 join 脚本成品（M2；M1 可用手工登记 + 文档化步骤）。
- Linux/macOS 设备、Wayland 截屏。
- 异步 job 队列 / 断点续传 / 多 worker 并发同设备。
- 完整 OAuth 2.1 MCP 鉴权（静态 Bearer 足够 M1）。
- 代码签名、对外 SaaS、给别人装的合规托盘壳。
- 把 remote-mcp `plan.md` 的自研 Rust worker 做完（Windows-MCP 已覆盖 GUI）。
- 修改上游 `../opencode`；changelog 维护者流程（未要求不改 `changelog/`）。

## Tasks

- [x] T1: 设备注册表模型与 `/api/devices` CRUD（含不回显密钥） — acceptance: 可创建/列出/更新审批档/删除设备；响应无私钥与 Bearer 原文；有单测覆盖解析与拒绝回显 (covers: S2.3, S2.10)
- [x] T2: Transport Resolver（TS 优先 + tunnel 兜底 + 明确离线错误） — acceptance: 给定候选可解析出实际连接目标；双候选均不可用时返回 `transport_unavailable` 而非空成功 (covers: S2.4; depends: T1)
- [x] T3: SSH 通道工具（exec + fs.list/read/write） — acceptance: 对可达设备完成读写与命令；失败分类正确；不把服务器本机 FS 误当作设备 FS (covers: S2.5; depends: T2)
- [x] T4: Windows-MCP 代理（screen.capture + ui.click/type，elements 尽力） — acceptance: 截图可取回；点击/类型打到设备侧 worker；worker 不可达时错误可区分 (covers: S2.5, D5; depends: T2)
- [x] T5: 内嵌 MCP 端点 `/api/devices/mcp` + agent Bearer — acceptance: 标准 MCP 客户端可用 `devices.*` 工具完成 list/exec/capture；无效 token 401；tools/list 固定 (covers: S2.5, D6; depends: T3, T4)
- [x] T6: 审批三档 + 审计写入 — acceptance: `deny` 拒绝；`smart` 对写/exec/ui 返回 `approval_required` 或放行策略符合设计；`auto` 只记审计；审计含 decision 与 device_id (covers: S2.6, S2.7; depends: T5)
- [x] T7: 最小设备 UI（列表、审批档、token 生成、最近审计） — acceptance: web 下可完成 M1 操作闭环所需的人工步骤 (covers: S2.8; depends: T1, T6)
- [x] T8: 文档 + 验证清单（本地/服务器侧命令与预期输出） — acceptance: 文档写明手工登记步骤、MCP 配置示例、验收命令；实现后按清单跑通并在 Report 记录 (covers: S2.1, S2.10; depends: T5, T7)

## Journey log

- 2026-09-16: Grill 完成。工作区因隔离策略无法 `git worktree add`，落在已有分支 `多设备端点`；同工作区存在无关未提交改动（`FilesView.tsx`、walkthrough routes），实现时不得覆盖。
- 历史参照：`T:\pigeoncore\remote-mcp\{README,research,onboarding-plan,ready-made-stack,plan}.md` — 调研结论仍有效；实现路径已改为「OpenChamber 内嵌 + Windows-MCP」，不再走独立 Python 控制面 Phase 2。
- Reviewer 发现：`app.use('/api', mw)` 内 `req.path` 是挂载相对路径；MCP 鉴权豁免必须匹配 `/devices/mcp` 而不是 `/api/devices/mcp`。已修复。
- 本机 e2e 闭环全部通过。随后安装 **CursorTouch Windows-MCP**（Python 3.14 + uv，
  streamable-http + auth-key），把代理对齐到真实工具名与 `Mcp-Session-Id` 握手后复测：
  shell / Screenshot PNG / Click / Type(坐标) / Snapshot 均通过。
- MCP/鉴权豁免需要 HTTP 层测试；仅测 handler 抓不到中间件门禁错误。M1 先修路径，HTTP 测试可后续补。
