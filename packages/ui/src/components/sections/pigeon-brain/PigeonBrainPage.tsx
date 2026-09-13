import React from 'react';

import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * 「记忆库」设置页：把 pigeon-brain 的管理界面内嵌进来。
 *
 * ## 为什么是 iframe，而不是用 React 重写一遍
 *
 * brain 的管理界面是**它自己的产品**（无框架、无构建、零依赖的静态页面），
 * 有 6 个页签、几百行交互逻辑。用 React 重写等于**把同一份界面维护两遍**，
 * 而且两边一定会漂移 —— 这是最典型的"看起来集成得更深、实际上多了一个真源"。
 *
 * iframe 的代价是样式不完全融入，换来的是：**brain 改界面，这里自动跟着变**。
 *
 * ## 为什么走同源反代路径
 *
 * brain 只绑在服务器的 127.0.0.1 与 docker 网络里（刻意的，见它自己的 ADR-0002）。
 * 浏览器够不到 `brain:3210`，所以由 OpenChamber 服务器代取：
 * `/api/pigeon-brain/**` → `http://brain:3210/**`。好处是没有 CORS、
 * 不新增端口、不新增暴露面 —— 这条链路的信任边界就是工作台自己的登录。
 *
 * brain 界面用相对路径引用资源、从自身 script 地址推导 API 基数，
 * 所以同一份产物挂在 `/api/pigeon-brain/ui/` 下也能正常工作。
 */

const PREFIX = '/api/pigeon-brain';
const EMBED_SRC = `${PREFIX}/ui/`;

interface PigeonBrainStatus {
  enabled: boolean;
  upstream: string | null;
}

export const PigeonBrainPage: React.FC = () => {
  const [status, setStatus] = React.useState<PigeonBrainStatus | null>(null);
  const [statusError, setStatusError] = React.useState<string | null>(null);
  // 每次点"重新加载"就换一个 key，逼 iframe 真的重建（改 src 不一定重载）
  const [reloadToken, setReloadToken] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    runtimeFetch(`${PREFIX}/status`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as PigeonBrainStatus;
        if (!cancelled) setStatus(data);
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatusError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const header = (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setReloadToken((value) => value + 1)}
        disabled={!status?.enabled}
      >
        重新加载
      </Button>
      <Button variant="outline" size="sm" asChild disabled={!status?.enabled}>
        <a href={EMBED_SRC} target="_blank" rel="noreferrer">
          在新标签打开
        </a>
      </Button>
    </div>
  );

  if (statusError) {
    return (
      <SettingsPageLayout title="记忆库" description="长期记忆与知识库的管理界面。">
        <div className="text-sm text-muted-foreground">
          读不到状态（{statusError}）。工作台服务器可能没起来。
        </div>
      </SettingsPageLayout>
    );
  }

  if (!status) {
    return (
      <SettingsPageLayout title="记忆库" description="长期记忆与知识库的管理界面。">
        <div className="text-sm text-muted-foreground">正在检查…</div>
      </SettingsPageLayout>
    );
  }

  if (!status.enabled) {
    return (
      <SettingsPageLayout title="记忆库" description="长期记忆与知识库的管理界面。">
        <div className="space-y-2 text-sm text-muted-foreground">
          <div>这台工作台没有配置记忆库。</div>
          <div>
            在容器的环境变量里设 <code className="rounded bg-muted px-1">PIGEON_BRAIN_URL</code>
            （例如 <code className="rounded bg-muted px-1">http://brain:3210</code>）后重启即可。
            没配时这条链路整段不挂载，工作台其余部分不受影响。
          </div>
        </div>
      </SettingsPageLayout>
    );
  }

  return (
    <SettingsPageLayout
      title="记忆库"
      description="长期记忆与知识库的管理界面。"
      headerEnd={header}
      // 这页内容要占满，不要设置页默认的 840px 收窄
      className="max-w-none"
      outerClassName="h-full"
    >
      <iframe
        key={reloadToken}
        src={EMBED_SRC}
        title="pigeon-brain 管理界面"
        className="h-[calc(100vh-220px)] min-h-[520px] w-full rounded-lg border border-border bg-background"
        // 只允许同源脚本；brain 界面本身不引外部资源
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      />
    </SettingsPageLayout>
  );
};

export default PigeonBrainPage;
