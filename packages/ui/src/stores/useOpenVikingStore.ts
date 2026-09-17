import { create } from 'zustand';

import {
  OpenVikingError,
  openVikingApi,
  type OpenVikingEntry,
  type OpenVikingStatus,
} from '@/lib/openviking/client';

/**
 * 记忆 / 知识库浏览页的共享状态。
 *
 * ## 为什么两个页面共用同一个 store
 *
 * 记忆与知识库在 OpenViking 里是同一套 `viking://` 文件系统的两个**根作用域**
 * （`viking://user/<user>/memories` 与 `viking://resources`），浏览行为完全一样。
 * 差异只有根 URI 与文案，所以由 `scope` 参数化，而不是复制两份逻辑。
 *
 * ## 为什么树在浏览器侧组装
 *
 * OpenViking 的 `GET /fs/tree?uri=<root>` 一次返回该根下的**全部后代**（扁平列表，
 * 每项带 `rel_path`），而 `GET /fs/ls` 只回一层。做一个"照文件浏览器"的左边栏
 * 需要父子关系，所以一次取全树、在浏览器侧按 `rel_path` 建索引 ——
 * 展开/折叠是纯本地操作，不再打网络。这样也避免了"每展开一层就发一次请求"
 * 在深层目录下变成几十次往返。
 */

export type OpenVikingScope = 'memory' | 'knowledge';

const SCOPE_LABEL: Record<OpenVikingScope, string> = {
  memory: 'memories',
  knowledge: 'resources',
};

/**
 * OpenViking 会为每个目录自动生成 `.abstract.md`（摘要）与 `.overview.md`（概览），
 * 它们是**派生文件**而不是用户内容。浏览页要像文件浏览器一样只显示真实条目，
 * 所以默认隐藏；目录的摘要改在右侧内容区以"目录信息"的形式呈现。
 */
export const DERIVED_FILE_NAMES = new Set(['.abstract.md', '.overview.md']);

export const isDerivedEntry = (entry: OpenVikingEntry): boolean => {
  if (entry.isDir) return false;
  const name = entry.rel_path?.split('/').pop() ?? '';
  return DERIVED_FILE_NAMES.has(name);
};

export interface TreeNode {
  /** 完整 viking:// URI */
  uri: string;
  /** 相对根的名字，用于显示 */
  name: string;
  isDir: boolean;
  size: number;
  modTime?: string;
  children: TreeNode[];
}

/**
 * 把扁平的 `rel_path` 列表组装成树。
 *
 * 只保留出现在列表里的节点：`fs/tree` 返回的目录本身也在列表里（`isDir: true`），
 * 所以不需要凭路径凭空造父节点 —— 造出来的父节点会缺少 modTime 等元数据，
 * 而且在权限受限（只返回部分子树）时会出现"点开是空的"幽灵目录。
 */
export const buildTree = (entries: readonly OpenVikingEntry[]): TreeNode[] => {
  const visible = entries.filter((entry) => !isDerivedEntry(entry));
  const byPath = new Map<string, TreeNode>();

  for (const entry of visible) {
    const path = entry.rel_path ?? entry.uri;
    byPath.set(path, {
      uri: entry.uri,
      name: path.split('/').pop() || path,
      isDir: entry.isDir,
      size: entry.size,
      modTime: entry.modTime,
      children: [],
    });
  }

  const roots: TreeNode[] = [];
  for (const [path, node] of byPath) {
    const slash = path.lastIndexOf('/');
    if (slash < 0) {
      roots.push(node);
      continue;
    }
    const parent = byPath.get(path.slice(0, slash));
    if (parent) {
      parent.children.push(node);
    } else {
      // 父节点不在返回集里 —— 当成根显示，而不是丢掉（丢条目比多显示更糟）
      roots.push(node);
    }
  }

  const sortNodes = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => {
      // 目录在前，然后按名字；与文件浏览器惯例一致
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);

  return roots;
};

export interface LoadError {
  message: string;
  /** 反代没配 —— 界面要给"去配置"的提示，而不是当故障 */
  notConfigured: boolean;
}

/** 写操作失败：调用方据此 toast，不静默吞掉 */
export class OpenVikingWriteError extends Error {
  readonly notConfigured: boolean;
  /** invalid_name 时 UI 应映射到本地化校验文案，而不是原样展示 message */
  readonly code: 'invalid_name' | 'write_failed';

  constructor(
    message: string,
    options?: { notConfigured?: boolean; code?: 'invalid_name' | 'write_failed' },
  ) {
    super(message);
    this.name = 'OpenVikingWriteError';
    this.notConfigured = options?.notConfigured ?? false;
    this.code = options?.code ?? 'write_failed';
  }
}

/**
 * 新建条目文件名校验。与 `SidebarFilesTree` 一致：禁止路径分隔与 `.` / `..`；
 * 派生文件名（.abstract.md / .overview.md）在树里隐藏，写了也看不见。
 */
export const validateCreateName = (name: string): string | null => {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (trimmed === '.' || trimmed === '..') return 'invalid';
  if (trimmed.includes('/') || trimmed.includes('\\')) return 'invalid';
  if (DERIVED_FILE_NAMES.has(trimmed)) return 'derived';
  return null;
};

interface OpenVikingState {
  scope: OpenVikingScope;
  status: OpenVikingStatus | null;
  statusError: string | null;

  roots: TreeNode[];
  baseUri: string | null;
  loading: boolean;
  error: LoadError | null;

  /** 选中文件的 URI；目录选中时不设此值 */
  selectedUri: string | null;
  selectedNode: TreeNode | null;

  content: string | null;
  contentLoading: boolean;
  contentError: LoadError | null;

  expanded: Record<string, boolean>;

  /** 正文是否处于编辑态；草稿只在编辑期间存在 */
  editing: boolean;
  draft: string;
  saving: boolean;

  setScope: (scope: OpenVikingScope) => void;
  refresh: () => Promise<void>;
  loadStatus: () => Promise<void>;
  select: (node: TreeNode) => void;
  toggleExpanded: (uri: string) => void;

  beginEdit: () => void;
  updateDraft: (text: string) => void;
  cancelEdit: () => void;
  /** 保存当前编辑中的文件；成功退出编辑并更新本地正文 */
  commitEdit: () => Promise<void>;
  /** 在 parentUri 下新建文件（mode=create）；成功后刷新树并选中 */
  createEntry: (parentUri: string, name: string, content: string) => Promise<string>;
  /** 删除文件；若正选中它则清选中，再刷新树 */
  removeEntry: (uri: string) => Promise<void>;
}

const toLoadError = (error: unknown): LoadError => {
  if (error instanceof OpenVikingError) {
    return { message: error.message, notConfigured: error.notConfigured };
  }
  return { message: error instanceof Error ? error.message : String(error), notConfigured: false };
};

export const useOpenVikingStore = create<OpenVikingState>((set, get) => ({
  scope: 'memory',
  status: null,
  statusError: null,
  roots: [],
  baseUri: null,
  loading: false,
  error: null,
  selectedUri: null,
  selectedNode: null,
  content: null,
  contentLoading: false,
  contentError: null,
  expanded: {},
  editing: false,
  draft: '',
  saving: false,

  setScope: (scope) => {
    if (get().scope === scope) return;
    set({
      scope,
      roots: [],
      baseUri: null,
      error: null,
      selectedUri: null,
      selectedNode: null,
      content: null,
      contentError: null,
      expanded: {},
      editing: false,
      draft: '',
      saving: false,
    });
    void get().refresh();
  },

  loadStatus: async () => {
    try {
      const status = await openVikingApi.proxyStatus();
      set({ status, statusError: null });
    } catch (error) {
      set({ statusError: error instanceof Error ? error.message : String(error) });
    }
  },

  refresh: async () => {
    const { scope } = get();
    set({ loading: true, error: null });
    try {
      // 记忆按用户分作用域，先问根拿到本用户的 memories 前缀，避免把 user id 写死
      const base = await resolveScopeBase(scope);
      const entries = await openVikingApi.tree(base);
      set({ roots: buildTree(entries), baseUri: base, loading: false, error: null });
      // 第一层默认展开，否则用户看到一个空列表还得逐级点开
      const expanded: Record<string, boolean> = {};
      for (const node of buildTree(entries)) {
        if (node.isDir) expanded[node.uri] = true;
      }
      set({ expanded });
    } catch (error) {
      set({ loading: false, error: toLoadError(error), roots: [], baseUri: null });
    }
  },

  select: (node) => {
    set({
      selectedNode: node,
      selectedUri: node.uri,
      editing: false,
      draft: '',
      saving: false,
    });
    if (node.isDir) {
      set({ content: null, contentError: null, contentLoading: false });
      return;
    }
    set({ contentLoading: true, contentError: null, content: null });
    void openVikingApi
      .read(node.uri)
      .then((text) => set({ content: text, contentLoading: false }))
      .catch((error: unknown) => set({ contentError: toLoadError(error), contentLoading: false }));
  },

  toggleExpanded: (uri) => {
    set((state) => ({ expanded: { ...state.expanded, [uri]: !state.expanded[uri] } }));
  },

  beginEdit: () => {
    const { content, contentLoading, contentError, selectedNode, selectedUri } = get();
    if (contentLoading || contentError || !selectedNode || selectedNode.isDir || !selectedUri) return;
    set({ editing: true, draft: content ?? '' });
  },

  updateDraft: (text) => {
    if (!get().editing) return;
    set({ draft: text });
  },

  cancelEdit: () => {
    set({ editing: false, draft: '', saving: false });
  },

  commitEdit: async () => {
    const { selectedUri, draft, editing, saving } = get();
    if (!editing || !selectedUri || saving) return;
    // 捕获本次写入目标：树在 saving 期间仍可点。迟到的成功/失败回写只能改
    // 仍属于这次编辑会话的状态；用户已切走时 select() 已清 editing/draft/saving，
    // 再 set 会抹掉新文件上正在进行的编辑。
    const uri = selectedUri;
    const text = draft;
    set({ saving: true });
    try {
      await openVikingApi.write(uri, text, 'replace');
      if (get().selectedUri === uri) {
        set({ content: text, editing: false, draft: '', saving: false });
      }
      // 树上的 size 会过期，但整树重拉会打断阅读；留给用户主动 Refresh。
    } catch (error) {
      if (get().selectedUri === uri) {
        set({ saving: false });
      }
      throw new OpenVikingWriteError(
        error instanceof Error ? error.message : String(error),
        {
          notConfigured: error instanceof OpenVikingError && error.notConfigured,
        },
      );
    }
  },

  createEntry: async (parentUri, name, content) => {
    const invalid = validateCreateName(name);
    if (invalid) {
      throw new OpenVikingWriteError(`invalid file name: ${invalid}`, { code: 'invalid_name' });
    }
    const trimmed = name.trim();
    const parent = parentUri.replace(/\/+$/, '');
    const uri = `${parent}/${trimmed}`;
    try {
      await openVikingApi.write(uri, content, 'create');
    } catch (error) {
      throw new OpenVikingWriteError(
        error instanceof Error ? error.message : String(error),
        {
          notConfigured: error instanceof OpenVikingError && error.notConfigured,
        },
      );
    }
    await get().refresh();
    // 展开父目录，否则新文件藏在折叠里
    set((state) => ({ expanded: { ...state.expanded, [parentUri]: true, [parent]: true } }));
    const found = findNodeByUri(get().roots, uri);
    if (found) get().select(found);
    return uri;
  },

  removeEntry: async (uri) => {
    try {
      await openVikingApi.remove(uri);
    } catch (error) {
      throw new OpenVikingWriteError(
        error instanceof Error ? error.message : String(error),
        {
          notConfigured: error instanceof OpenVikingError && error.notConfigured,
        },
      );
    }
    if (get().selectedUri === uri) {
      set({
        selectedUri: null,
        selectedNode: null,
        content: null,
        contentError: null,
        contentLoading: false,
        editing: false,
        draft: '',
        saving: false,
      });
    }
    await get().refresh();
  },
}));

const findNodeByUri = (nodes: readonly TreeNode[], uri: string): TreeNode | null => {
  for (const node of nodes) {
    if (node.uri === uri) return node;
    const hit = findNodeByUri(node.children, uri);
    if (hit) return hit;
  }
  return null;
};

/**
 * 解析某个作用域的根 URI。
 *
 * 记忆在 `viking://user/<user>/memories` 下 —— `<user>` 是当前 API key 的身份，
 * 前端拿不到也不该猜，所以从 `GET /fs/ls?uri=viking://user` 实际列一次再取。
 * 知识库固定在 `viking://resources`。
 */
export const resolveScopeBase = async (scope: OpenVikingScope): Promise<string> => {
  if (scope === 'knowledge') return 'viking://resources';

  const scopes = await openVikingApi.ls('viking://');
  const userScope = scopes.find((entry) => entry.uri.replace(/\/+$/, '').endsWith('/user'));
  if (!userScope) {
    throw new Error('OpenViking 里没有 user 作用域');
  }
  const users = await openVikingApi.ls(userScope.uri);
  const firstUser = users.find((entry) => entry.isDir);
  if (!firstUser) {
    throw new Error('OpenViking 里还没有用户目录');
  }
  return `${firstUser.uri.replace(/\/+$/, '')}/${SCOPE_LABEL.memory}`;
};

/** 新建条目的默认父目录：选中目录自身，否则选中文件的父目录，否则作用域根 */
export const resolveCreateParent = (state: {
  selectedNode: TreeNode | null;
  baseUri: string | null;
}): string | null => {
  if (state.selectedNode?.isDir) return state.selectedNode.uri.replace(/\/+$/, '');
  if (state.selectedNode && !state.selectedNode.isDir) {
    const slash = state.selectedNode.uri.lastIndexOf('/');
    if (slash > 'viking://'.length) return state.selectedNode.uri.slice(0, slash);
  }
  return state.baseUri?.replace(/\/+$/, '') ?? null;
};
