import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * store 的行为测试：点击一个文件之后，状态必须真的走到"已选中 + 正文已加载"。
 *
 * 这一层是实机截图逼出来的 —— 浏览器里点了 profile.md，树的选中态与右栏
 * 都没变，而 buildTree 的逻辑测试是全绿的，所以问题只能在"点击 → store 更新"
 * 这一段。纯逻辑测试（只测 buildTree）覆盖不到它。
 */

const readMock = mock(async (uri: string) => `content of ${uri}`);
const writeMock = mock(async (uri: string, content: string, mode: 'replace' | 'create') => ({
  written_bytes: content.length, uri, mode,
}));
const removeMock = mock(async (uri: string) => ({ uri }));
const treeMock = mock(async () => [
  { uri: 'viking://user/pcadmin/memories/profile.md', size: 215, isDir: false, rel_path: 'profile.md' },
  { uri: 'viking://user/pcadmin/memories/identity.md', size: 439, isDir: false, rel_path: 'identity.md' },
]);
const lsMock = mock(async (uri: string) => {
  if (uri === 'viking://') {
    return [{ uri: 'viking://user', size: 0, isDir: true }];
  }
  return [{ uri: 'viking://user/pcadmin', size: 0, isDir: true }];
});

mock.module('@/lib/openviking/client', () => ({
  OpenVikingError: class OpenVikingError extends Error {
    status = 500; code: string | null = null; notConfigured = false;
  },
  // 必须把真实模块导出的名字都补上。`bun test` 同一次运行里多个测试文件共享模块注册表，
  // 只 mock 用到的几个会让**别的测试文件**导入剩余的导出时报
  // "Export named 'X' not found"（本轮 client.test.ts 就被这条坑到了）。
  // 仓库的 run-isolated-tests 会把每个文件单独起进程，正常不会串；但补全成本为零，更稳。
  readProxyStatus: async () => ({ enabled: true, upstream: null, hasApiKey: true }),
  openVikingApi: {
    proxyStatus: async () => ({ enabled: true, upstream: 'http://openviking:1933', hasApiKey: true }),
    ls: lsMock,
    tree: treeMock,
    read: readMock,
    write: writeMock,
    remove: removeMock,
  },
}));

const { useOpenVikingStore, buildTree, resolveCreateParent } = await import('@/stores/useOpenVikingStore');

const reset = () => {
  useOpenVikingStore.setState({
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
  });
};

describe('OpenViking browse store', () => {
  beforeEach(() => {
    reset();
    readMock.mockClear();
    treeMock.mockClear();
    writeMock.mockClear();
    removeMock.mockClear();
  });

  test('refresh 会把树装进 store，并把第一层目录默认展开', async () => {
    await useOpenVikingStore.getState().refresh();
    const state = useOpenVikingStore.getState();
    expect(state.error).toBeNull();
    expect(state.baseUri).toBe('viking://user/pcadmin/memories');
    expect(state.roots.map((n) => n.name)).toEqual(['identity.md', 'profile.md']);
    expect(treeMock).toHaveBeenCalledTimes(1);
  });

  test('★ 点击文件必须真的选中它并去读正文（实机截图发现这里没生效）', async () => {
    await useOpenVikingStore.getState().refresh();
    const file = useOpenVikingStore.getState().roots.find((n) => n.name === 'profile.md');
    expect(file).toBeDefined();

    useOpenVikingStore.getState().select(file!);

    // 选中态要**同步**生效（不能等异步）
    expect(useOpenVikingStore.getState().selectedUri).toBe('viking://user/pcadmin/memories/profile.md');
    expect(useOpenVikingStore.getState().selectedNode?.name).toBe('profile.md');

    // 正文是异步来的
    await new Promise((r) => setTimeout(r, 10));
    expect(readMock).toHaveBeenCalledTimes(1);
    expect(readMock).toHaveBeenCalledWith('viking://user/pcadmin/memories/profile.md');
    const after = useOpenVikingStore.getState();
    expect(after.contentLoading).toBe(false);
    expect(after.content).toBe('content of viking://user/pcadmin/memories/profile.md');
    expect(after.contentError).toBeNull();
  });

  test('读失败时进入 contentError，而不是永远 loading', async () => {
    await useOpenVikingStore.getState().refresh();
    readMock.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const file = useOpenVikingStore.getState().roots.find((n) => n.name === 'profile.md');
    useOpenVikingStore.getState().select(file!);
    await new Promise((r) => setTimeout(r, 10));
    const st = useOpenVikingStore.getState();
    expect(st.contentLoading).toBe(false);
    expect(st.contentError?.message).toBe('boom');
  });

  test('点目录不读正文，只切换展开', async () => {
    useOpenVikingStore.setState({
      roots: buildTree([
        { uri: 'viking://user/pcadmin/memories/preferences', size: 0, isDir: true, rel_path: 'preferences' },
        { uri: 'viking://user/pcadmin/memories/preferences/语言偏好.md', size: 214, isDir: false, rel_path: 'preferences/语言偏好.md' },
      ]),
    });
    const dir = useOpenVikingStore.getState().roots[0];
    expect(dir.isDir).toBe(true);
    useOpenVikingStore.getState().select(dir);
    await new Promise((r) => setTimeout(r, 10));
    expect(readMock).not.toHaveBeenCalled();
    expect(useOpenVikingStore.getState().selectedUri).toBe('viking://user/pcadmin/memories/preferences');
  });

  test('toggleExpanded 翻转展开态', () => {
    const uri = 'viking://user/pcadmin/memories/preferences';
    expect(useOpenVikingStore.getState().expanded[uri]).toBeUndefined();
    useOpenVikingStore.getState().toggleExpanded(uri);
    expect(useOpenVikingStore.getState().expanded[uri]).toBe(true);
    useOpenVikingStore.getState().toggleExpanded(uri);
    expect(useOpenVikingStore.getState().expanded[uri]).toBe(false);
  });

  test('loadStatus 把代理状态记下来', async () => {
    await useOpenVikingStore.getState().loadStatus();
    expect(useOpenVikingStore.getState().status).toEqual({
      enabled: true, upstream: 'http://openviking:1933', hasApiKey: true,
    });
  });

  test('★ commitEdit 写回后更新本地正文并退出编辑', async () => {
    await useOpenVikingStore.getState().refresh();
    const file = useOpenVikingStore.getState().roots.find((n) => n.name === 'profile.md')!;
    useOpenVikingStore.getState().select(file);
    await new Promise((r) => setTimeout(r, 10));

    useOpenVikingStore.getState().beginEdit();
    expect(useOpenVikingStore.getState().editing).toBe(true);
    expect(useOpenVikingStore.getState().draft).toContain('profile.md');

    useOpenVikingStore.getState().updateDraft('改过的正文');
    await useOpenVikingStore.getState().commitEdit();

    expect(writeMock).toHaveBeenCalledWith(file.uri, '改过的正文', 'replace');
    const after = useOpenVikingStore.getState();
    expect(after.editing).toBe(false);
    expect(after.content).toBe('改过的正文');
    expect(after.saving).toBe(false);
  });

  test('写失败时抛错并保持编辑态，草稿不丢', async () => {
    await useOpenVikingStore.getState().refresh();
    const file = useOpenVikingStore.getState().roots.find((n) => n.name === 'profile.md')!;
    useOpenVikingStore.getState().select(file);
    await new Promise((r) => setTimeout(r, 10));
    useOpenVikingStore.getState().beginEdit();
    useOpenVikingStore.getState().updateDraft('未保存');
    writeMock.mockImplementationOnce(async () => {
      throw new Error('upstream 500');
    });
    await expect(useOpenVikingStore.getState().commitEdit()).rejects.toThrow('upstream 500');
    const after = useOpenVikingStore.getState();
    expect(after.editing).toBe(true);
    expect(after.draft).toBe('未保存');
    expect(after.saving).toBe(false);
  });

  test('★ 保存中切换文件：迟到的写成功不能把 A 的草稿涂到 B 上', async () => {
    await useOpenVikingStore.getState().refresh();
    const fileA = useOpenVikingStore.getState().roots.find((n) => n.name === 'profile.md')!;
    const fileB = useOpenVikingStore.getState().roots.find((n) => n.name === 'identity.md')!;
    useOpenVikingStore.getState().select(fileA);
    await new Promise((r) => setTimeout(r, 10));
    useOpenVikingStore.getState().beginEdit();
    useOpenVikingStore.getState().updateDraft('A 的草稿');

    // 让 write 挂起，期间用户点到 B
    let resolveWrite: (() => void) | undefined;
    writeMock.mockImplementationOnce(async (uri: string, content: string, mode: 'replace' | 'create') => {
      await new Promise<void>((resolve) => { resolveWrite = resolve; });
      return { written_bytes: content.length, uri, mode };
    });
    const commitPromise = useOpenVikingStore.getState().commitEdit();
    useOpenVikingStore.getState().select(fileB);
    await new Promise((r) => setTimeout(r, 10));
    expect(useOpenVikingStore.getState().selectedUri).toBe(fileB.uri);
    expect(useOpenVikingStore.getState().content).toBe(`content of ${fileB.uri}`);

    // B 上另开编辑；A 的写回迟到时不能抹掉 B 的草稿
    useOpenVikingStore.getState().beginEdit();
    useOpenVikingStore.getState().updateDraft('B 的新草稿');

    resolveWrite?.();
    await commitPromise;
    const after = useOpenVikingStore.getState();
    expect(after.selectedUri).toBe(fileB.uri);
    expect(after.content).toBe(`content of ${fileB.uri}`);
    expect(after.editing).toBe(true);
    expect(after.draft).toBe('B 的新草稿');
    expect(after.saving).toBe(false);
  });

  test('createEntry 拒绝路径片段与派生文件名', async () => {
    await expect(useOpenVikingStore.getState().createEntry('viking://a', 'foo/bar.md', 'x'))
      .rejects
      .toThrow(/invalid file name/);
    await expect(useOpenVikingStore.getState().createEntry('viking://a', '..', 'x'))
      .rejects
      .toThrow(/invalid file name/);
    await expect(useOpenVikingStore.getState().createEntry('viking://a', '.abstract.md', 'x'))
      .rejects
      .toThrow(/invalid file name/);
    expect(writeMock).not.toHaveBeenCalled();
  });

  test('createEntry 用 mode=create 写入并刷新选中', async () => {
    await useOpenVikingStore.getState().refresh();
    treeMock.mockImplementationOnce(async () => [
      { uri: 'viking://user/pcadmin/memories/profile.md', size: 215, isDir: false, rel_path: 'profile.md' },
      { uri: 'viking://user/pcadmin/memories/note.md', size: 8, isDir: false, rel_path: 'note.md' },
    ]);
    const uri = await useOpenVikingStore.getState().createEntry(
      'viking://user/pcadmin/memories',
      'note.md',
      'hello',
    );
    expect(writeMock).toHaveBeenCalledWith('viking://user/pcadmin/memories/note.md', 'hello', 'create');
    expect(uri).toBe('viking://user/pcadmin/memories/note.md');
    await new Promise((r) => setTimeout(r, 10));
    expect(useOpenVikingStore.getState().selectedUri).toBe(uri);
  });

  test('removeEntry 删掉选中项时清选中并刷新', async () => {
    await useOpenVikingStore.getState().refresh();
    const file = useOpenVikingStore.getState().roots.find((n) => n.name === 'profile.md')!;
    useOpenVikingStore.getState().select(file);
    await new Promise((r) => setTimeout(r, 10));
    treeMock.mockImplementationOnce(async () => [
      { uri: 'viking://user/pcadmin/memories/identity.md', size: 439, isDir: false, rel_path: 'identity.md' },
    ]);
    await useOpenVikingStore.getState().removeEntry(file.uri);
    expect(removeMock).toHaveBeenCalledWith(file.uri);
    const after = useOpenVikingStore.getState();
    expect(after.selectedUri).toBeNull();
    expect(after.content).toBeNull();
    expect(after.roots.map((n) => n.name)).toEqual(['identity.md']);
  });

  test('resolveCreateParent：选中目录/文件/空选各有默认父目录', () => {
    expect(resolveCreateParent({
      selectedNode: { uri: 'viking://a/dir', name: 'dir', isDir: true, size: 0, children: [] },
      baseUri: 'viking://a',
    })).toBe('viking://a/dir');
    expect(resolveCreateParent({
      selectedNode: { uri: 'viking://a/dir/file.md', name: 'file.md', isDir: false, size: 1, children: [] },
      baseUri: 'viking://a',
    })).toBe('viking://a/dir');
    expect(resolveCreateParent({
      selectedNode: null,
      baseUri: 'viking://a/',
    })).toBe('viking://a');
  });
});
