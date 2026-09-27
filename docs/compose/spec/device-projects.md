---
feature: device-projects
status: delivered
updated: 2026-09-21
branch: feature/device-projects
commits: bdeff4385..(uncommitted working tree)
---

# 设备节点项目 · 服务器工作台选用端上本地目录为项目

## Report

**What was built** — 服务器工作台「添加项目」对话框新增**设备节点**来源：列出已登记且具备 files 能力的 Windows 节点，经 `devices.fs.list` 浏览远程目录，确认后写入宿主机 sshfs 注册表（`device-mounts.json`），等待 `mount/ready` 后把**挂载 POSIX 路径**注册为普通项目，并带上 `ProjectEntry.device` 绑定。挂载由 pigeoncore 上的 `oc-device-mounts`（systemd timer）用节点 SSH 密钥执行；`/mnt/oc-devices` bind 进容器后，文件树 / git / 搜索 / 终端 / worktree 与本地项目同权。侧栏设备项目显示健康徽标，不可用时可「重新挂载」。

**Verification** — `bun test packages/web/server/lib/devices/ packages/ui/src/lib/deviceProjects.test.ts packages/ui/src/stores/useProjectsStore.test.ts packages/ui/src/lib/i18n/messages.test.ts packages/web/server/lib/opencode/settings-normalization-runtime.test.js`：**91 pass / 0 fail**。`bun run type-check:ui` / `type-check:web`：**exit 0**。`bunx oxlint` 新文件 **0 错**。评审两轮：首轮 3 critical（设置 schema 剥 `device` / 未等挂载就绪 / remount 写坏 remoteRoot）+ 复审 quick-add 旁路，**均已修**。真机 sshfs 验收清单在 `T:\pigeoncore\ops\host\README-DEVICE-MOUNTS.md`，**全部待测**。

**Journey log** — ① 只改服务端 `sanitizeProjects` 不够：客户端 `settings/parsers.ts` 的 zod `projectEntrySchema` 同样会剥未知字段（#3552 同类）；② 宿主机 timer 挂载是异步的，`ensure` 只记意图，必须 `waitForDeviceMountReady` 再 `addProject`；③ `addProject` 有两条入口（finalize / quick-add），只堵一条会被绕过；④ remount 的 `remoteRoot` 绝不能回退成 `remotePath`（ensure 会 upsert 注册表）。

## [S1] Problem

鸽子核心上的 OpenChamber 工作台目前只能把**服务器本地路径**注册成项目：添加项目走 `DirectoryExplorerDialog` → `/api/fs/list`，会话、文件树、git、搜索、终端都以该路径为工作目录。多端系统（`packages/web/server/lib/devices`）已经能让 agent 通过 `devices.fs.*` / `devices.shell.exec` 操作登记的 Windows 节点，但那只是**工具面**：

1. 添加项目对话框看不见设备磁盘，无法把节点上的文件夹选成项目；
2. 即便强行把 Windows 路径写进 `settings.json`，容器里也没有这个路径——文件树为空、终端 `cd` 不进去、git/搜索全挂；
3. 用户期望的是**完整本地体验**：选中后与服务器本地项目无差别（文件树、diff、git 面板、搜索、终端、worktree 全可用）。

## [S2] Design

### 2.1 已定决策（Grill 2026-09-21）

| # | 决策 | 选择 |
|---|---|---|
| D1 | 访问架构 | **系统级挂载**（路径成为真实 POSIX 路径，而非虚拟 device:// 项目） |
| D2 | 第一期体验 | **完整本地体验**（文件树 / diff / git / 搜索 / 终端 / worktree） |
| D3 | 挂载位置 | **宿主机 sshfs + bind 进容器**（容器无特权、无需 FUSE） |
| D4 | 离线策略 | **自动重挂**；挂载不可用时项目仍可见并标「不可用」 |
| D5 | 挂载粒度 | **每设备一个挂载根**；项目是根下子路径 |
| D6 | UI 入口 | **扩展 `DirectoryExplorerDialog`**（来源切换：本机 / 设备节点） |

### 2.2 架构总览

```text
┌─ Windows 节点（多端已登记） ──────────────────────────────────┐
│  OpenSSH Server (SFTP)     Tailscale 优先 / 反向隧道兜底        │
│  选定挂载根，如 C:/Users/<user> 或用户配置的共享根              │
└───────────────────────┬──────────────────────────────────────┘
                        │ sshfs（宿主机）
                        ▼
┌─ pigeoncore 宿主机 ──────────────────────────────────────────┐
│  /mnt/oc-devices/<deviceSlug>/          ← 设备挂载根           │
│  /mnt/oc-devices/<deviceSlug>/<rel>/    ← 项目子路径           │
│  oc-device-mounts.service + timer      ← 声明式挂载 / 自动重挂 │
│  共享：OpenChamber data dir 里的 device-mounts.json            │
└───────────────────────┬──────────────────────────────────────┘
                        │ docker bind（/mnt/oc-devices 原样进容器）
                        ▼
┌─ openchamber 容器 ───────────────────────────────────────────┐
│  同一 POSIX 路径 = 普通项目路径                                 │
│  /api/fs · git · 搜索 · 终端 · worktree 无需改道                │
│  DirectoryExplorerDialog：设备来源浏览 → 确保挂载 → addProject │
└──────────────────────────────────────────────────────────────┘
```

**核心收益**：挂载一旦成立，OpenChamber 现有 FS/git/搜索/终端/会话栈**几乎零改动**即可获得完整本地体验。应用层只补「选目录、确保挂载、注册项目、标不可用」四件事。

### 2.3 路径模型

| 侧 | 形状 | 例 |
|---|---|---|
| 设备远程根 | Windows 路径，归一为 `C:/Users/<user>` | `C:/Users/alice` |
| SFTP 路径 | Windows OpenSSH 常见 `/C:/Users/alice`（实现时以 `devices.fs.list` 实测为准，不硬编码假设） | `/C:/Users/alice` |
| 宿主机挂载点 | `/mnt/oc-devices/<deviceSlug>/` | `/mnt/oc-devices/dev_7299…/` |
| 项目路径 | 挂载点 + 相对段（POSIX） | `/mnt/oc-devices/dev_7299…/proj/foo` |

规则：

- `deviceSlug` 取设备 `id`（稳定），目录名不含用户可控字符。
- 远程相对段：反斜杠→`/`，去掉盘符前缀，禁止 `..`，禁止绝对段逃逸挂载根（`path.resolve` 后必须仍在 mountRoot 下）。
- `ProjectEntry.path` **就是**容器内 POSIX 挂载路径；不引入 `device://` 假路径。

### 2.4 挂载注册表（声明式，宿主机执行）

OpenChamber data dir（宿主机已 bind）写入：

```json
{
  "version": 1,
  "mounts": [
    {
      "deviceId": "dev_7299d5997226fcbf",
      "slug": "dev_7299d5997226fcbf",
      "remoteRoot": "C:/Users/alice",
      "mountRoot": "/mnt/oc-devices/dev_7299d5997226fcbf",
      "ssh": { "host": "100.x.x.x", "port": 22, "user": "alice" },
      "keyRef": "devices/secrets.json#ssh",
      "enabled": true,
      "updatedAt": "2026-09-21T12:00:00+08:00"
    }
  ]
}
```

- **写方**：OpenChamber API（用户在添加项目时确认挂载根）。
- **读方**：宿主机 `oc-device-mounts.service`（systemd，周期 ensure；`sshfs` + `fusermount -u`）。
- **密钥**：首期读 `<data>/devices/secrets.json` 的 SSH 私钥（与 device-mcp 同一密钥库），由 mount 脚本在宿主机只读打开；**不进 git、不进日志**。若 data dir 权限不允许 root 以外读取，ops 层用 `oc-device-mounts` 专用副本（0600 root）同步，写在 ops 文档里。
- **重挂**：timer 每 30–60s 检查 `mountpoint -q` + 对 mountRoot 做一次 `stat`；失败则 `fusermount -u` 后重挂。设备离线时挂载变为 stale → 项目标不可用；恢复后自动重挂。

### 2.5 compose / 挂载进容器

`ops/openchamber/docker-compose.pigeon.yaml` 增加：

```yaml
volumes:
  - /mnt/oc-devices:/mnt/oc-devices:rslave
```

宿主机 `/mnt/oc-devices` 需 `rshared`（或至少保证子挂载事件对 bind 可见）。**属于部署变更**，随 ops 提交，不在本 fork 里改生产 compose。

### 2.6 应用层契约

#### 2.6.1 设备浏览（挂载前）

复用 `toolRuntime.callTool('devices.fs.list', { device_id, path })`，或经等价 REST 包装。目录选择对话框「设备」页签：

1. 列出 `capabilities.files === true` 的设备（离线可显示但禁用）；
2. 浏览起点：设备设置的 `mountRoot` 对应远程根；未配置时默认 `devices.fs.list` 能列出的合理起点（`C:/Users/<sshUser>` 或盘符列表）；
3. 浏览与现有 BrowseRow 交互一致（进入 / 上级 / 路径输入 / 显示隐藏）。

#### 2.6.2 挂载 API（OpenChamber 服务端）

| 路由 | 语义 |
|---|---|
| `GET /api/devices/:id/mount` | 读当前挂载注册项 + 宿主机健康（mountRoot 是否可 stat） |
| `PUT /api/devices/:id/mount` | 写注册表（remoteRoot / enabled）；**不**在容器内执行 sshfs |
| `POST /api/devices/:id/mount/ensure` | 写注册表后标记期望挂载；返回当前健康。真正 mount 由宿主机 timer 完成（秒级延迟可接受） |
| `DELETE /api/devices/:id/mount` | 禁用并要求卸载（写 `enabled:false`） |

健康语义（服务端 `stat(mountRoot)`）：

- `ready`：可读目录；
- `mounting`：已注册且 enabled，但 mountRoot 还不是目录（宿主机 timer 待挂/挂载失效）；
- `disabled`：注册项 `enabled=false`；
- `absent`：无注册项。

（实现与 UI 徽标把 `mounting` / `disabled` / `absent` 都当「不可用」展示并提供重挂。）

#### 2.6.3 项目绑定

`ProjectEntry` 增加可选字段（settings 归一化需放行，未知字段现状会剥掉则必须改 `settings-normalization`）：

```ts
device?: {
  id: string;          // 设备 id
  remotePath: string;  // 设备上原始 Windows 路径
  mountRoot: string;   // 宿主机挂载根
}
```

UI：

- 项目行徽标「设备·<名字>」；挂载 `unavailable` 时项目行显示不可用态（不从列表消失）；
- 不可用时会话仍可打开，但文件树/终端自然失败；提供「重新挂载」（调 `mount/ensure` + 刷新健康）。

#### 2.6.4 DirectoryExplorerDialog 扩展

- 顶栏来源分段：`本机` | `设备`。
- `设备` 模式：设备列表 → 远程目录树 →「添加项目」：
  1. 计算 `remotePath` 与相对段；
  2. `PUT/ensure` 挂载注册（首次配置 remoteRoot 时确认一次）；
  3. 等待 `ready`（短轮询，超时明确报错，不注册空路径）；
  4. `addProject(mountPath, { label })`，并写入 `device` 绑定。
- 本机模式行为不变（回归）。

### 2.7 完整本地体验的边界（不做什么也能成立）

挂载为真路径后，以下**不需要**专用代理：

- `/api/fs/*` 读写列目录、文件树、diff
- git 面板 / worktree（git 落在 sshfs 上，慢但正确）
- 搜索、终端 cwd、会话 directory

明确不在第一期：

- 设备侧 Windows 专用工具链（`devices.ui.*`）与项目模型的进一步耦合
- Linux 节点 fs 挂载（`devices.fs` 现状 Windows-only；文档已写）
- 跨设备复制/迁移项目
- 容器内 sshfs / SMB 双通道（SMB 留作后续吞吐选项）

### 2.8 错误行为

| 情况 | 行为 |
|---|---|
| 设备离线 | 浏览禁用；已有项目标不可用；ensure 返回 `device_offline` |
| 挂载超时 | 添加项目失败并提示；**不**写入半截 ProjectEntry |
| 路径逃逸 | 拒绝；审计一条 |
| 密钥缺失 | `permission_denied` 明确文案（去设置补密钥） |
| 挂载点被占用 | 视为已挂载（mountpoint 命中）；内容不一致不自动覆盖 |

### 2.9 测试边界

- 纯函数：Windows↔POSIX 相对路径、slug、逃逸拒绝。
- 路由：mount CRUD/ensure 健康语义（假 fs、假 devices）。
- UI：DirectoryExplorerDialog 来源切换、设备行选择后调用序列（mount ensure → addProject）、不可用徽标。
- 不把真实 sshfs / 真机 E2E 写进单测；真机验收清单进 ops 文档。

## [S3] Out of Scope

- 修改 device-mcp 工具集或审批模型
- SMB/CIFS、容器内 FUSE
- 移动端对话框的设备来源（桌面优先；移动端可后补同一 API）
- 把服务器本地项目「反向挂到」设备上
- 自动同步/镜像工作区

## Tasks

- [x] T1: ops — `oc-device-mounts` 服务（读注册表、sshfs ensure、自动重挂）+ compose bind `/mnt/oc-devices:rslave` + 安装说明 — acceptance: 宿主机 `mountpoint` 成功、容器内可 `stat` 同一路径、断网后 timer 能重挂 (covers: S2.2, S2.4, S2.5) — 代码在 `T:\pigeoncore\ops\host\`；真机挂载见 T7
- [x] T2: 路径模型纯函数 + 测试 — acceptance: 远程路径→挂载子路径双向用例与 `..` 逃逸拒绝均变异可红 (covers: S2.3)
- [x] T3: 服务端 mount 路由 + `ProjectEntry.device` 归一化放行 + 健康检测 — acceptance: 路由测试通过；带 `device` 的 settings 往返不丢字段 (covers: S2.6.2, S2.6.3)
- [x] T4: DirectoryExplorerDialog 设备来源（列表/浏览/添加全流程）— acceptance: ensure 后 `addProject` 收到 mount 路径且写入 device 绑定；本机来源回归不红 (covers: S2.6.1, S2.6.4; depends: T2, T3)
- [x] T5: 项目不可用徽标 +「重新挂载」— acceptance: mount 健康为 unavailable 时 UI 有态；点重挂会打 `mount/ensure` (covers: S2.6.3; depends: T3)
- [x] T6: i18n 12 语种补齐新增键 — acceptance: i18n 对齐测试通过 (depends: T4, T5)
- [ ] T7: 真机验收清单写入 ops（SSHFS 路径形态、密钥、rslave、断网重挂）并按清单在一台已登记节点上跑通 — acceptance: 清单每条有实测记录或明确「未测」 (covers: S2.4, S2.8; depends: T1) — 清单已写入 `T:\pigeoncore\ops\host\README-DEVICE-MOUNTS.md`（全部「待测」）
