import React from 'react';

import { OpenVikingSettingsPage } from '@/components/sections/openviking/OpenVikingSettingsPage';

/** 知识库 · 设置 */
export const KnowledgeSettingsPage: React.FC = () => (
  <OpenVikingSettingsPage scope="knowledge" />
);

export default KnowledgeSettingsPage;
