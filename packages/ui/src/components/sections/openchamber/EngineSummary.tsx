import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useI18n } from '@/lib/i18n';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { useEnginesStore } from '@/stores/useEnginesStore';
import { missingForChat } from '@/lib/engines/capabilities';
import { SETTINGS_FIELD_LABEL_CLASS } from '@/components/sections/shared/SettingsSection';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * 「引擎」一览（挂在"关于"页里）。
 *
 * 这是 M4 那套注册表的**用户可见面**：加一个引擎 = 往 `engines/` 丢一个 json（+ 起一个适配器），
 * 这里就能看到它 —— 不用重建镜像、不用改应用代码。
 *
 * 三个刻意的取舍：
 *   · **显示能力 id 原文**（`sessions` / `streaming` …）而不是翻译过的漂亮词：
 *     能力是**契约词表**，翻译过反而对不上文档；缺什么就一眼看得出。
 *   · **探活显示"探的是谁的地址"**：`source=host` 意味着这个引擎没写自己的地址，
 *     探活结果反映的是宿主那一个引擎 —— 看到它就该警觉（多引擎并存时会分不清谁在应答）。
 *   · **读不到就说读不到**：引擎端点挂了不该让这一页崩，也不该静默显示空列表。
 */
export const EngineSummary: React.FC = () => {
  const { t } = useI18n();
  const { engines, activeId, activeReason, probe, registry, error, switching, load, setActiveEngine } = useEnginesStore(
    useShallow((state) => ({
      engines: state.engines,
      activeId: state.activeId,
      activeReason: state.activeReason,
      probe: state.probe,
      registry: state.registry,
      error: state.error,
      switching: state.switching,
      load: state.load,
      setActiveEngine: state.setActiveEngine,
    })),
  );

  React.useEffect(() => {
    void load();
  }, [load]);

  const active = engines.find((engine) => engine.id === activeId) ?? null;
  // t() 的键是字面量联合类型（I18nKey），所以这里显式标出来 —— 传 string 会被类型系统挡下
  const label = (key: I18nKey, values?: I18nParams) => (values ? t(key, values) : t(key));

  /**
   * 切引擎。
   *
   * 成功后**整页重载**：切换换掉的是整个数据视图（会话列表、事件流、模型/智能体…
   * 全都属于那个引擎），只刷新引擎那一段会让界面处在"半新半旧"的状态 ——
   * 那正是这次要消灭的困惑。重载最不容易误解。
   */
  const handleSwitch = React.useCallback(async (engineId: string) => {
    const result = await setActiveEngine(engineId);
    if (!result.ok) return; // 失败已经进了 store.error，下面会显示出来
    window.location.reload();
  }, [setActiveEngine]);

  return (
    <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
      <div className="flex flex-col @xl:flex-row @xl:items-start justify-between gap-4 px-4 py-3">
        <div className="flex min-w-0 flex-col">
          <span className={SETTINGS_FIELD_LABEL_CLASS}>{label('settings.openchamber.about.engine.field.active')}</span>
          <span className="typography-meta text-muted-foreground font-mono">
            {active ? active.id : label('settings.openchamber.about.state.unknown')}
            {active && activeReason ? ` (${activeReason})` : ''}
          </span>
          {active && (
            <span className="typography-meta text-muted-foreground font-mono break-all">
              {active.capabilities.join(' · ') || label('settings.openchamber.about.engine.state.noCapabilities')}
            </span>
          )}
          {active && !active.canServeChat && (
            <span className="typography-meta text-muted-foreground">
              {label('settings.openchamber.about.engine.state.cannotChat', { caps: missingForChat(active.capabilities).join('、') })}
            </span>
          )}

          {/* 切换器：能进聊天流的引擎才可选（缺 sessions/streaming 的选了也用不了） */}
          {engines.length > 0 && (
            <div className="mt-2 flex min-w-0 flex-col gap-1">
              <Select
                value={activeId ?? undefined}
                onValueChange={(value) => void handleSwitch(value)}
                disabled={switching}
              >
                <SelectTrigger size="sm" className="w-full @xl:w-[16rem]" aria-label={label('settings.openchamber.about.engine.action.switch')}>
                  <SelectValue placeholder={switching
                    ? label('settings.openchamber.about.engine.state.switching')
                    : label('settings.openchamber.about.engine.state.none')} />
                </SelectTrigger>
                <SelectContent fitContent portalToBody>
                  <SelectGroup>
                    {engines.map((engine) => (
                      <SelectItem
                        key={engine.id}
                        value={engine.id}
                        disabled={!engine.canServeChat}
                        className="w-auto whitespace-nowrap"
                      >
                        {engine.canServeChat
                          ? engine.id
                          : `${engine.id} ${label('settings.openchamber.about.engine.state.cannotServeChatOption')}`}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <span className="typography-meta text-muted-foreground">
                {switching
                  ? label('settings.openchamber.about.engine.state.switching')
                  : label('settings.openchamber.about.engine.hint.sessionListChanges')}
              </span>
              {error && (
                <span className="typography-meta text-[var(--status-error)]">
                  {label('settings.openchamber.about.engine.error.switchFailed', { error })}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col">
          <span className={SETTINGS_FIELD_LABEL_CLASS}>{label('settings.openchamber.about.engine.field.registered')}</span>
          <span className="typography-meta text-muted-foreground font-mono">
            {error
              ? label('settings.openchamber.about.engine.state.unreadable')
              : engines.length > 0
                ? engines.map((engine) => engine.id).join(' · ')
                : label('settings.openchamber.about.engine.state.none')}
          </span>
          {registry?.warnings && registry.warnings.length > 0 && (
            <span className="typography-meta text-muted-foreground">
              {label('settings.openchamber.about.engine.state.warnings', { count: registry.warnings.length })}
            </span>
          )}
        </div>

        <div className="flex min-w-0 flex-col">
          <span className={SETTINGS_FIELD_LABEL_CLASS}>{label('settings.openchamber.about.engine.field.probe')}</span>
          <span className="typography-meta text-muted-foreground font-mono break-all">
            {probe
              ? `${probe.ok ? 'ok' : 'failed'}${probe.version ? ` · ${probe.version}` : ''}${probe.source ? ` · ${probe.source}` : ''}`
              : label('settings.openchamber.about.state.unknown')}
          </span>
          {probe?.baseUrl && (
            <span className="typography-meta text-muted-foreground font-mono break-all">{probe.baseUrl}</span>
          )}
          {probe?.error && (
            <span className="typography-meta text-muted-foreground break-all">{probe.error}</span>
          )}
        </div>
      </div>
    </div>
  );
};
