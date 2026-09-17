---
feature: openviking-edit
status: delivered
updated: 2026-09-16
branch: 记忆知识库
commits: a878b83f8..WORKTREE  # uncommitted on 记忆知识库; fill SHA at commit
---

# OpenViking Browse Edit

## Report

**What was built** — 记忆浏览 / 知识库浏览（共用 `OpenVikingBrowsePage`）支持编辑正文、在目录下新建文件、删除文件。写走 `POST /api/v1/content/write`，删走 `DELETE /api/v1/fs?uri=`。删除二次确认并标明无回收站。新建拒绝 `/` `\` `.` `..` 与派生文件名。`commitEdit` 捕获 URI，迟到写回不会污染切换后的文件或抹掉新草稿。入口仅在浏览页，不碰 agent-memory / 项目上下文。

**Verification** —
- `bun run type-check:ui` PASS
- `bun test src/lib/openviking/client.test.ts` 20/20 PASS
- `bun test src/stores/useOpenVikingStore.test.ts` 13/13 PASS（含保存中切换竞态、非法文件名）
- `bunx eslint` 三个改动源文件 clean
- `bun run lint:ui` 仅既有无关文件失败（PRE-EXISTING：ChatBackdrop / ArtifactCenterView 等）

**Journey log** —
1. Worktree 创建被 hook 拦下；在已专用分支 `记忆知识库` 上施工（非 main）。
2. 评审 C1：空选中时 Create 对话框未挂载 → 对话框移入 `shell()` 常驻。
3. 评审 C2：`commitEdit` 与 `select` 竞态 → 捕获 URI，成功回写仅在仍选中该 URI 时应用。
4. 复审残留：迟到写入 else 分支会清掉 B 的新草稿 → 仅在仍持有编辑会话时改状态。
5. HTTP 无精确片段 edit；整文件 `mode: replace` 足够本轮。

## [S1] Problem

OpenViking 记忆浏览与知识库浏览是只读的。用户能看，但不能在 OpenChamber 里改正写坏的记忆、补知识库笔记，或删掉过时条目。浏览页注释已预留「写操作留到下一轮」。

## [S2] Design

在两页共用的 `OpenVikingBrowsePage` 上补齐写能力：编辑已有文件、在当前目录新建文件、删除（二次确认，无回收站）。不改 OpenViking 反代——写请求继续走 `/api/openviking/**` 同源反代。

### API（OpenViking HTTP）

| 操作 | 端点 | Body / Query |
|---|---|---|
| 写/覆盖/新建 | `POST /api/v1/content/write` | `{ uri, content, mode: 'replace'\|'create' }` |
| 删除 | `DELETE /api/v1/fs` | `?uri=...&recursive=false` |

`mode: 'replace'` 创建或覆盖；`mode: 'create'` 已存在则失败。本轮编辑保存用 `replace`，新建用 `create`。删除只对文件；目录删除不做（误删整棵子树代价过高）。

### Client（`packages/ui/src/lib/openviking/client.ts`）

- `write(uri, content, mode)` → 信封解析，与现有 `read` 一致。
- `remove(uri)` → 同上。

### Store（`useOpenVikingStore`）

- `saveContent` 合入 `commitEdit`：写成功且仍选中该 URI 时更新本地 `content`；切换走后不改编辑态。
- `createEntry(parentUri, name, content)`：`validateCreateName` 先拒非法名；`mode: 'create'`；成功后 `refresh()` 树并选中新 URI。
- `removeEntry(uri)`：删除成功后清掉若正选中的是它，再 `refresh()`。
- 编辑态：`editing` / `draft`；`beginEdit` / `updateDraft` / `cancelEdit` / `commitEdit`。切节点即丢弃草稿。

### UI（`OpenVikingBrowsePage`）

- 文件头：编辑、删除。编辑进入 Textarea + 保存/取消；保存显式点击。
- 新建入口在 header（与目录页）。对话框常驻 `shell()`，空选中也能开。
- 删除：共享 `Dialog` 确认，文案写明不可恢复。
- 派生文件不可编辑/删除；新建亦拒绝派生名。

### 失败行为

- 写/删失败：toast + 保留草稿/当前内容。
- 未配置：与现有只读路径相同的提示。

## [S3] Out of Scope

- 重命名、移动、复制（`/fs/mv` `/fs/cp`）。
- 目录创建与目录递归删除 UI。
- 项目上下文面板里的 agent-memory 编辑（已有能力，与 OpenViking 是另一存储）。
- pigeon-brain iframe 管理界面改造。
- 精确片段编辑 API（HTTP 仅有整文件 write）。
- runtime endpoint 切换时重置 OpenViking store（既有缺口，见评审 O5）。

## Tasks

- [x] T1: client `write`/`remove` + 端点接线测试 — acceptance: 能 POST write、DELETE fs，错误走 `OpenVikingError` (covers: S2)
- [x] T2: store 写路径（commitEdit/create/remove + 编辑态） — acceptance: 单测覆盖成功后本地 content/树/选中态与竞态 (covers: S2; depends: T1)
- [x] T3: BrowsePage 编辑/新建/删除 UI + 删除确认 — acceptance: 文件可改可删，目录下可新建，确认框写明无回收站 (covers: S2; depends: T2)
- [x] T4: 全部 locale 的 openviking.browse 编辑文案 — acceptance: 无英文占位，zh-CN 可读 (covers: S2; depends: T3)
- [x] T5: focused tests + type-check:ui + lint:ui — acceptance: 命令全绿（package lint 既有失败除外） (covers: S2; depends: T3, T4)
