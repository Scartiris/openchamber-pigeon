#!/usr/bin/env python3
"""把「引擎一览」的 i18n 键注入**全部 12 个语言**的 settings 词典。

为什么要脚本而不是手改：`messages/*.ts` 的类型是 `Record<I18nKey, string>` ——
**任何一个语言缺一个键，type-check 就红**（不是"少翻一条"，是编译不过）。
所以加键必须一次加全，脚本比手改 12 个文件可靠。

沿用本仓既有做法（scripts/inject-pigeon-i18n-keys.py 系列）：插在锚点行之后。
锚点是 `settings.openchamber.about.field.openCodeVersion`（12 个语言都有）。

**按"缺哪个补哪个"工作**（而不是"整批一起补"）：这样加第二批键时，
第一批已经在了也不会被判成"半个状态"。可反复跑。

用法：python3 scripts/inject-engine-i18n-keys.py [--check]
  --check  只报告"哪些语言缺哪些键"，不写文件
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MESSAGES = ROOT / "packages" / "ui" / "src" / "lib" / "i18n" / "messages"
ANCHOR = "settings.openchamber.about.field.openCodeVersion"

# locale -> {key: 译文}
# 能力 id（sessions / streaming …）刻意**不翻译**：它们是契约词表，译了反而对不上文档。
T: dict[str, dict[str, str]] = {
    "en": {
        "settings.openchamber.about.engine.field.active": "Active engine",
        "settings.openchamber.about.engine.field.registered": "Registered engines",
        "settings.openchamber.about.engine.field.probe": "Engine probe",
        "settings.openchamber.about.engine.state.none": "none registered",
        "settings.openchamber.about.engine.state.unreadable": "engine list unavailable",
        "settings.openchamber.about.engine.state.noCapabilities": "no capabilities declared",
        "settings.openchamber.about.engine.state.cannotChat": "Missing {{caps}} — cannot serve the chat stream",
        "settings.openchamber.about.engine.state.warnings": "{{count}} registry warning(s)",
        "settings.openchamber.about.engine.action.switch": "Switch engine",
        "settings.openchamber.about.engine.state.switching": "Switching…",
        "settings.openchamber.about.engine.state.cannotServeChatOption": "(cannot serve chat)",
        "settings.openchamber.about.engine.hint.sessionListChanges": "Switching replaces the whole session list — each engine keeps its own sessions, and the page reloads.",
        "settings.openchamber.about.engine.error.switchFailed": "Switch failed: {{error}}",
    },
    "zh-CN": {
        "settings.openchamber.about.engine.field.active": "当前引擎",
        "settings.openchamber.about.engine.field.registered": "已注册的引擎",
        "settings.openchamber.about.engine.field.probe": "引擎探活",
        "settings.openchamber.about.engine.state.none": "一个也没注册",
        "settings.openchamber.about.engine.state.unreadable": "读不到引擎列表",
        "settings.openchamber.about.engine.state.noCapabilities": "没有声明任何能力",
        "settings.openchamber.about.engine.state.cannotChat": "缺少 {{caps}} —— 无法进入聊天流",
        "settings.openchamber.about.engine.state.warnings": "注册表有 {{count}} 条警告",
        "settings.openchamber.about.engine.action.switch": "切换引擎",
        "settings.openchamber.about.engine.state.switching": "切换中…",
        "settings.openchamber.about.engine.state.cannotServeChatOption": "（不能进聊天流）",
        "settings.openchamber.about.engine.hint.sessionListChanges": "切换会换掉整个会话列表 —— 不同引擎有各自的会话，页面会重新加载。",
        "settings.openchamber.about.engine.error.switchFailed": "切换失败：{{error}}",
    },
    "zh-TW": {
        "settings.openchamber.about.engine.field.active": "目前引擎",
        "settings.openchamber.about.engine.field.registered": "已註冊的引擎",
        "settings.openchamber.about.engine.field.probe": "引擎探測",
        "settings.openchamber.about.engine.state.none": "一個也沒註冊",
        "settings.openchamber.about.engine.state.unreadable": "讀不到引擎清單",
        "settings.openchamber.about.engine.state.noCapabilities": "沒有宣告任何能力",
        "settings.openchamber.about.engine.state.cannotChat": "缺少 {{caps}} —— 無法進入聊天流",
        "settings.openchamber.about.engine.state.warnings": "註冊表有 {{count}} 條警告",
        "settings.openchamber.about.engine.action.switch": "切換引擎",
        "settings.openchamber.about.engine.state.switching": "切換中…",
        "settings.openchamber.about.engine.state.cannotServeChatOption": "（不能進聊天流）",
        "settings.openchamber.about.engine.hint.sessionListChanges": "切換會換掉整個會話清單 —— 不同引擎有各自的會話，頁面會重新載入。",
        "settings.openchamber.about.engine.error.switchFailed": "切換失敗：{{error}}",
    },
    "de": {
        "settings.openchamber.about.engine.field.active": "Aktive Engine",
        "settings.openchamber.about.engine.field.registered": "Registrierte Engines",
        "settings.openchamber.about.engine.field.probe": "Engine-Prüfung",
        "settings.openchamber.about.engine.state.none": "keine registriert",
        "settings.openchamber.about.engine.state.unreadable": "Engine-Liste nicht verfügbar",
        "settings.openchamber.about.engine.state.noCapabilities": "keine Fähigkeiten deklariert",
        "settings.openchamber.about.engine.state.cannotChat": "{{caps}} fehlt — kein Chat-Stream möglich",
        "settings.openchamber.about.engine.state.warnings": "{{count}} Registrierungswarnung(en)",
        "settings.openchamber.about.engine.action.switch": "Engine wechseln",
        "settings.openchamber.about.engine.state.switching": "Wird gewechselt…",
        "settings.openchamber.about.engine.state.cannotServeChatOption": "(kein Chat möglich)",
        "settings.openchamber.about.engine.hint.sessionListChanges": "Ein Wechsel ersetzt die gesamte Sitzungsliste — jede Engine hat eigene Sitzungen, die Seite wird neu geladen.",
        "settings.openchamber.about.engine.error.switchFailed": "Wechsel fehlgeschlagen: {{error}}",
    },
    "es": {
        "settings.openchamber.about.engine.field.active": "Motor activo",
        "settings.openchamber.about.engine.field.registered": "Motores registrados",
        "settings.openchamber.about.engine.field.probe": "Sondeo del motor",
        "settings.openchamber.about.engine.state.none": "ninguno registrado",
        "settings.openchamber.about.engine.state.unreadable": "lista de motores no disponible",
        "settings.openchamber.about.engine.state.noCapabilities": "sin capacidades declaradas",
        "settings.openchamber.about.engine.state.cannotChat": "Falta {{caps}} — no puede servir el chat",
        "settings.openchamber.about.engine.state.warnings": "{{count}} aviso(s) del registro",
        "settings.openchamber.about.engine.action.switch": "Cambiar motor",
        "settings.openchamber.about.engine.state.switching": "Cambiando…",
        "settings.openchamber.about.engine.state.cannotServeChatOption": "(no puede servir el chat)",
        "settings.openchamber.about.engine.hint.sessionListChanges": "El cambio reemplaza toda la lista de sesiones — cada motor tiene las suyas y la página se recargará.",
        "settings.openchamber.about.engine.error.switchFailed": "Error al cambiar: {{error}}",
    },
    "fr": {
        "settings.openchamber.about.engine.field.active": "Moteur actif",
        "settings.openchamber.about.engine.field.registered": "Moteurs enregistrés",
        "settings.openchamber.about.engine.field.probe": "Sonde du moteur",
        "settings.openchamber.about.engine.state.none": "aucun enregistré",
        "settings.openchamber.about.engine.state.unreadable": "liste des moteurs indisponible",
        "settings.openchamber.about.engine.state.noCapabilities": "aucune capacité déclarée",
        "settings.openchamber.about.engine.state.cannotChat": "{{caps}} manquant — flux de chat indisponible",
        "settings.openchamber.about.engine.state.warnings": "{{count}} avertissement(s) du registre",
        "settings.openchamber.about.engine.action.switch": "Changer de moteur",
        "settings.openchamber.about.engine.state.switching": "Changement…",
        "settings.openchamber.about.engine.state.cannotServeChatOption": "(chat indisponible)",
        "settings.openchamber.about.engine.hint.sessionListChanges": "Le changement remplace toute la liste des sessions — chaque moteur a les siennes, la page sera rechargée.",
        "settings.openchamber.about.engine.error.switchFailed": "Échec du changement : {{error}}",
    },
    "ja": {
        "settings.openchamber.about.engine.field.active": "使用中のエンジン",
        "settings.openchamber.about.engine.field.registered": "登録済みエンジン",
        "settings.openchamber.about.engine.field.probe": "エンジン疎通確認",
        "settings.openchamber.about.engine.state.none": "未登録",
        "settings.openchamber.about.engine.state.unreadable": "エンジン一覧を取得できません",
        "settings.openchamber.about.engine.state.noCapabilities": "能力が宣言されていません",
        "settings.openchamber.about.engine.state.cannotChat": "{{caps}} が不足 — チャットを提供できません",
        "settings.openchamber.about.engine.state.warnings": "登録に関する警告 {{count}} 件",
        "settings.openchamber.about.engine.action.switch": "エンジンを切り替え",
        "settings.openchamber.about.engine.state.switching": "切り替え中…",
        "settings.openchamber.about.engine.state.cannotServeChatOption": "（チャット不可）",
        "settings.openchamber.about.engine.hint.sessionListChanges": "切り替えるとセッション一覧が丸ごと入れ替わります（エンジンごとに別のセッション）。ページを再読み込みします。",
        "settings.openchamber.about.engine.error.switchFailed": "切り替えに失敗：{{error}}",
    },
    "ko": {
        "settings.openchamber.about.engine.field.active": "현재 엔진",
        "settings.openchamber.about.engine.field.registered": "등록된 엔진",
        "settings.openchamber.about.engine.field.probe": "엔진 상태 확인",
        "settings.openchamber.about.engine.state.none": "등록 없음",
        "settings.openchamber.about.engine.state.unreadable": "엔진 목록을 읽을 수 없음",
        "settings.openchamber.about.engine.state.noCapabilities": "선언된 기능 없음",
        "settings.openchamber.about.engine.state.cannotChat": "{{caps}} 누락 — 채팅 스트림 제공 불가",
        "settings.openchamber.about.engine.state.warnings": "레지스트리 경고 {{count}}건",
        "settings.openchamber.about.engine.action.switch": "엔진 전환",
        "settings.openchamber.about.engine.state.switching": "전환 중…",
        "settings.openchamber.about.engine.state.cannotServeChatOption": "(채팅 불가)",
        "settings.openchamber.about.engine.hint.sessionListChanges": "전환하면 세션 목록이 통째로 바뀝니다 — 엔진마다 세션이 따로 있으며 페이지가 다시 로드됩니다.",
        "settings.openchamber.about.engine.error.switchFailed": "전환 실패: {{error}}",
    },
    "pl": {
        "settings.openchamber.about.engine.field.active": "Aktywny silnik",
        "settings.openchamber.about.engine.field.registered": "Zarejestrowane silniki",
        "settings.openchamber.about.engine.field.probe": "Sonda silnika",
        "settings.openchamber.about.engine.state.none": "brak zarejestrowanych",
        "settings.openchamber.about.engine.state.unreadable": "lista silników niedostępna",
        "settings.openchamber.about.engine.state.noCapabilities": "brak zadeklarowanych możliwości",
        "settings.openchamber.about.engine.state.cannotChat": "Brak {{caps}} — nie obsłuży czatu",
        "settings.openchamber.about.engine.state.warnings": "{{count}} ostrzeżeń rejestru",
        "settings.openchamber.about.engine.action.switch": "Zmień silnik",
        "settings.openchamber.about.engine.state.switching": "Zmienianie…",
        "settings.openchamber.about.engine.state.cannotServeChatOption": "(brak obsługi czatu)",
        "settings.openchamber.about.engine.hint.sessionListChanges": "Zmiana zastępuje całą listę sesji — każdy silnik ma własne sesje, strona zostanie przeładowana.",
        "settings.openchamber.about.engine.error.switchFailed": "Zmiana nieudana: {{error}}",
    },
    "pt-BR": {
        "settings.openchamber.about.engine.field.active": "Motor ativo",
        "settings.openchamber.about.engine.field.registered": "Motores registrados",
        "settings.openchamber.about.engine.field.probe": "Sondagem do motor",
        "settings.openchamber.about.engine.state.none": "nenhum registrado",
        "settings.openchamber.about.engine.state.unreadable": "lista de motores indisponível",
        "settings.openchamber.about.engine.state.noCapabilities": "sem capacidades declaradas",
        "settings.openchamber.about.engine.state.cannotChat": "Falta {{caps}} — não pode servir o chat",
        "settings.openchamber.about.engine.state.warnings": "{{count}} aviso(s) do registro",
        "settings.openchamber.about.engine.action.switch": "Trocar motor",
        "settings.openchamber.about.engine.state.switching": "Trocando…",
        "settings.openchamber.about.engine.state.cannotServeChatOption": "(não pode servir o chat)",
        "settings.openchamber.about.engine.hint.sessionListChanges": "A troca substitui toda a lista de sessões — cada motor tem as suas, e a página será recarregada.",
        "settings.openchamber.about.engine.error.switchFailed": "Falha na troca: {{error}}",
    },
    "tr": {
        "settings.openchamber.about.engine.field.active": "Etkin motor",
        "settings.openchamber.about.engine.field.registered": "Kayıtlı motorlar",
        "settings.openchamber.about.engine.field.probe": "Motor yoklaması",
        "settings.openchamber.about.engine.state.none": "kayıtlı yok",
        "settings.openchamber.about.engine.state.unreadable": "motor listesi yok",
        "settings.openchamber.about.engine.state.noCapabilities": "yetenek bildirilmemiş",
        "settings.openchamber.about.engine.state.cannotChat": "{{caps}} eksik — sohbet akışı sunulamaz",
        "settings.openchamber.about.engine.state.warnings": "{{count}} kayıt uyarısı",
        "settings.openchamber.about.engine.action.switch": "Motoru değiştir",
        "settings.openchamber.about.engine.state.switching": "Değiştiriliyor…",
        "settings.openchamber.about.engine.state.cannotServeChatOption": "(sohbet sunulamaz)",
        "settings.openchamber.about.engine.hint.sessionListChanges": "Değiştirme tüm oturum listesini yeniler — her motorun kendi oturumları vardır ve sayfa yeniden yüklenir.",
        "settings.openchamber.about.engine.error.switchFailed": "Değiştirme başarısız: {{error}}",
    },
    "uk": {
        "settings.openchamber.about.engine.field.active": "Активний рушій",
        "settings.openchamber.about.engine.field.registered": "Зареєстровані рушії",
        "settings.openchamber.about.engine.field.probe": "Перевірка рушія",
        "settings.openchamber.about.engine.state.none": "жодного",
        "settings.openchamber.about.engine.state.unreadable": "список рушіїв недоступний",
        "settings.openchamber.about.engine.state.noCapabilities": "можливості не оголошено",
        "settings.openchamber.about.engine.state.cannotChat": "Відсутні {{caps}} — чат недоступний",
        "settings.openchamber.about.engine.state.warnings": "{{count}} попереджень реєстру",
        "settings.openchamber.about.engine.action.switch": "Змінити рушій",
        "settings.openchamber.about.engine.state.switching": "Зміна…",
        "settings.openchamber.about.engine.state.cannotServeChatOption": "(чат недоступний)",
        "settings.openchamber.about.engine.hint.sessionListChanges": "Зміна замінює весь список сеансів — у кожного рушія свої сеанси, сторінку буде перезавантажено.",
        "settings.openchamber.about.engine.error.switchFailed": "Не вдалося змінити: {{error}}",
    },
}

CHECK = "--check" in sys.argv


def ts_string(value: str) -> str:
    """按 TS 单引号字符串转义（本仓词典一律单引号）。"""
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def main() -> int:
    missing_files = [loc for loc in T if not (MESSAGES / f"{loc}.settings.ts").exists()]
    if missing_files:
        print(f"找不到这些语言的 settings 文件：{missing_files}")
        return 1

    written: list[str] = []
    problems: list[str] = []

    for loc, entries in sorted(T.items()):
        path = MESSAGES / f"{loc}.settings.ts"
        text = path.read_text(encoding="utf-8")
        absent = [key for key in entries if f"'{key}'" not in text]
        if not absent:
            continue
        if CHECK:
            problems.append(f"{loc}: 缺 {len(absent)} 条（{', '.join(absent[:3])}…）")
            continue

        lines = text.split("\n")
        anchor = next((i for i, line in enumerate(lines) if ANCHOR in line), None)
        if anchor is None:
            problems.append(f"{loc}: 找不到锚点 {ANCHOR}")
            continue
        indent = lines[anchor][: len(lines[anchor]) - len(lines[anchor].lstrip())]
        injected = [
            f"{indent}// 引擎一览（M4 注册表的用户可见面）。能力 id 刻意不翻译：它们是契约词表，译了反而对不上文档。"
        ] + [f"{indent}'{key}': {ts_string(entries[key])}," for key in absent]
        lines[anchor + 1 : anchor + 1] = injected
        path.write_text("\n".join(lines), encoding="utf-8")
        written.append(f"{loc}(+{len(absent)})")

    if problems:
        print("需要处理：")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"已注入：{', '.join(written) if written else '（都齐了，无需改动）'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
