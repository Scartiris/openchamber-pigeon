import React from 'react';

import { OpenVikingBrowsePage } from '@/components/sections/openviking/OpenVikingBrowsePage';
import { useOpenVikingStore } from '@/stores/useOpenVikingStore';

/**
 * 知识库 · 浏览：`viking://resources` 下的文件树 + 内容。
 *
 * # 与记忆页共用右边栏组件与 store，只有作用域不同。
 */
export const KnowledgePage: React.FC = () => {
  const setScope = useOpenVikingStore((state) => state.setScope);
  const refresh = useOpenVikingStore((state) => state.refresh);
  const loadStatus = useOpenVikingStore((state) => state.loadStatus);

  React.useEffect(() => {
    void loadStatus();
    setScope('knowledge');
    void refresh();
    // 只在挂载时执行；切换作用域由 setScope 自己触发刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <OpenVikingBrowsePage scope="knowledge" />;
};

export default KnowledgePage;
