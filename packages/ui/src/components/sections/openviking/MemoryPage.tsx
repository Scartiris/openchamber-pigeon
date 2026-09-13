import React from 'react';

import { OpenVikingBrowsePage } from '@/components/sections/openviking/OpenVikingBrowsePage';
import { useOpenVikingStore } from '@/stores/useOpenVikingStore';

/**
 * 记忆 · 浏览：`viking://user/<user>/memories` 下的文件树 + 内容。
 *
 * 左边栏由 `SettingsView.renderPageSidebar` 挂 `OpenVikingTreeSidebar`，
 * 这里只负责把 store 切到 `memory` 作用域并拉数据 ——
 * 左右两栏读同一份 store，所以不需要在两栏之间传 props。
 */
export const MemoryPage: React.FC = () => {
  const setScope = useOpenVikingStore((state) => state.setScope);
  const refresh = useOpenVikingStore((state) => state.refresh);
  const loadStatus = useOpenVikingStore((state) => state.loadStatus);

  React.useEffect(() => {
    void loadStatus();
    setScope('memory');
    void refresh();
    // 只在挂载时执行；切换作用域由 setScope 自己触发刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <OpenVikingBrowsePage scope="memory" />;
};

export default MemoryPage;
