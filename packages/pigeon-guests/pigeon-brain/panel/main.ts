import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountBanner, mountButton, mountSpinner } from '@openchamber/sdk/ui';

/**
 * Rail / full-screen shell for pigeon-brain.
 *
 * The real management UI is brain's own static app, same-origin reverse-proxied
 * at `/api/pigeon-brain/ui/`. This guest only mounts that page so the workbench
 * can surface it from the rail without rewriting brain in React.
 */

const UI_PATH = '/api/pigeon-brain/ui/';
const STATUS_PATH = '/api/pigeon-brain/status';

type BrainStatus = {
  enabled: boolean;
  upstream: string | null;
};

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing root');

let mounted = false;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const readStatus = async (): Promise<BrainStatus | null> => {
  const response = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } });
  if (!response.ok) return null;
  const body = (await response.json()) as Partial<BrainStatus>;
  if (typeof body.enabled !== 'boolean') return null;
  return { enabled: body.enabled, upstream: typeof body.upstream === 'string' ? body.upstream : null };
};

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (mounted) return;
  mounted = true;

  root.replaceChildren();

  const toolbar = el('div');
  toolbar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border, rgba(127,127,127,.25));';
  const title = el('div', undefined, '记忆库');
  title.style.cssText = 'font:600 13px/1.2 system-ui,sans-serif;';
  const statusLabel = el('div', undefined, '检查中…');
  statusLabel.style.cssText = 'font:400 12px/1.2 system-ui,sans-serif;opacity:.7;';
  const spacer = el('div');
  spacer.style.flex = '1';
  const openExternal = mountButton(toolbar, {
    label: '新标签打开',
    variant: 'outline',
    onClick: () => {
      void host.openUrl(UI_PATH);
    },
  });
  toolbar.append(title, statusLabel, spacer, openExternal);

  const body = el('div');
  body.style.cssText = 'flex:1;min-height:0;position:relative;';

  const notice = el('div');
  notice.style.cssText = 'padding:16px;display:none;';

  const spinnerSlot = el('div');
  spinnerSlot.style.cssText = 'padding:24px;';
  const spinner = mountSpinner(spinnerSlot, { label: '正在连接记忆库…' });

  const frame = document.createElement('iframe');
  frame.title = 'pigeon-brain';
  frame.src = UI_PATH;
  frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;display:none;';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');

  body.append(spinnerSlot, notice, frame);
  root.append(toolbar, body);

  const showNotice = (titleText: string, bodyText: string, tone: 'info' | 'warning' | 'error') => {
    notice.replaceChildren();
    notice.style.display = 'block';
    spinnerSlot.hidden = true;
    frame.style.display = 'none';
    openExternal.update({ disabled: true });
    mountBanner(notice, { title: titleText, body: bodyText, tone });
    statusLabel.textContent = tone === 'error' ? '不可用' : tone === 'warning' ? '未配置' : titleText;
  };

  void (async () => {
    try {
      const status = await readStatus();
      if (!status) {
        showNotice(
          '无法读取记忆库状态',
          'OpenChamber 服务器没有返回可用的 /api/pigeon-brain/status。检查服务是否启动，或到 设置 → 记忆库 查看。',
          'error',
        );
        return;
      }
      if (!status.enabled) {
        showNotice(
          '未配置记忆库',
          '在 OpenChamber 服务器上设置 PIGEON_BRAIN_URL 后，这里会直接打开 pigeon-brain 管理界面。',
          'warning',
        );
        return;
      }
      statusLabel.textContent = status.upstream ? `已连接 · ${status.upstream}` : '已连接';
      spinnerSlot.hidden = true;
      notice.style.display = 'none';
      frame.style.display = 'block';
      openExternal.update({ disabled: false });
    } catch (error) {
      showNotice(
        '记忆库状态检查失败',
        error instanceof Error ? error.message : String(error),
        'error',
      );
    }
  })();
});
