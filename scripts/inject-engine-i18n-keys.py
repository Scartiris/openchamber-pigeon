#!/usr/bin/env python3
"""把「引擎一览」那 8 个 i18n 键注入**全部 12 个语言**的 settings 词典。

为什么要脚本而不是手改：`messages/*.ts` 的类型是 `Record<I18nKey, string>` ——
**任何一个语言缺一个键，type-check 就红**（不是"少翻一条"，是编译不过）。
所以加键必须一次加全，脚本比手改 12 个文件可靠。

沿用本仓既有做法（scripts/inject-pigeon-i18n-keys.py 系列）：插在锚点行之后。
锚点是 `settings.openchamber.about.field.openCodeVersion`（12 个语言都有）。

用法：python3 scripts/inject-engine-i18n-keys.py [--check]
  --check  只报告"哪些语言缺哪些键"，不写文件
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MESSAGES = ROOT / "packages" / "ui" / "src" / "lib" / "i18n" / "messages"
ANCHOR = "settings.openchamber.about.field.openCodeVersion"

# 能力 id（sessions / streaming …）刻意**不翻译**：它们是契约词表，译了反而对不上文档。
KEYS = [
    "settings.openchamber.about.engine.field.active",
    "settings.openchamber.about.engine.field.registered",
    "settings.openchamber.about.engine.field.probe",
    "settings.openchamber.about.engine.state.none",
    "settings.openchamber.about.engine.state.unreadable",
    "settings.openchamber.about.engine.state.noCapabilities",
    "settings.openchamber.about.engine.state.cannotChat",
    "settings.openchamber.about.engine.state.warnings",
]

# locale -> 8 条译文（顺序与 KEYS 一致）
T: dict[str, list[str]] = {
    "en": [
        "Active engine", "Registered engines", "Engine probe",
        "none registered", "engine list unavailable", "no capabilities declared",
        "Missing {{caps}} — cannot serve the chat stream", "{{count}} registry warning(s)",
    ],
    "zh-CN": [
        "当前引擎", "已注册的引擎", "引擎探活",
        "一个也没注册", "读不到引擎列表", "没有声明任何能力",
        "缺少 {{caps}} —— 无法进入聊天流", "注册表有 {{count}} 条警告",
    ],
    "zh-TW": [
        "目前引擎", "已註冊的引擎", "引擎探測",
        "一個也沒註冊", "讀不到引擎清單", "沒有宣告任何能力",
        "缺少 {{caps}} —— 無法進入聊天流", "註冊表有 {{count}} 條警告",
    ],
    "de": [
        "Aktive Engine", "Registrierte Engines", "Engine-Prüfung",
        "keine registriert", "Engine-Liste nicht verfügbar", "keine Fähigkeiten deklariert",
        "{{caps}} fehlt — kein Chat-Stream möglich", "{{count}} Registrierungswarnung(en)",
    ],
    "es": [
        "Motor activo", "Motores registrados", "Sondeo del motor",
        "ninguno registrado", "lista de motores no disponible", "sin capacidades declaradas",
        "Falta {{caps}} — no puede servir el chat", "{{count}} aviso(s) del registro",
    ],
    "fr": [
        "Moteur actif", "Moteurs enregistrés", "Sonde du moteur",
        "aucun enregistré", "liste des moteurs indisponible", "aucune capacité déclarée",
        "{{caps}} manquant — flux de chat indisponible", "{{count}} avertissement(s) du registre",
    ],
    "ja": [
        "使用中のエンジン", "登録済みエンジン", "エンジン疎通確認",
        "未登録", "エンジン一覧を取得できません", "能力が宣言されていません",
        "{{caps}} が不足 — チャットを提供できません", "登録に関する警告 {{count}} 件",
    ],
    "ko": [
        "현재 엔진", "등록된 엔진", "엔진 상태 확인",
        "등록 없음", "엔진 목록을 읽을 수 없음", "선언된 기능 없음",
        "{{caps}} 누락 — 채팅 스트림 제공 불가", "레지스트리 경고 {{count}}건",
    ],
    "pl": [
        "Aktywny silnik", "Zarejestrowane silniki", "Sonda silnika",
        "brak zarejestrowanych", "lista silników niedostępna", "brak zadeklarowanych możliwości",
        "Brak {{caps}} — nie obsłuży czatu", "{{count}} ostrzeżeń rejestru",
    ],
    "pt-BR": [
        "Motor ativo", "Motores registrados", "Sondagem do motor",
        "nenhum registrado", "lista de motores indisponível", "sem capacidades declaradas",
        "Falta {{caps}} — não pode servir o chat", "{{count}} aviso(s) do registro",
    ],
    "tr": [
        "Etkin motor", "Kayıtlı motorlar", "Motor yoklaması",
        "kayıtlı yok", "motor listesi yok", "yetenek bildirilmemiş",
        "{{caps}} eksik — sohbet akışı sunulamaz", "{{count}} kayıt uyarısı",
    ],
    "uk": [
        "Активний рушій", "Зареєстровані рушії", "Перевірка рушія",
        "жодного", "список рушіїв недоступний", "можливості не оголошено",
        "Відсутні {{caps}} — чат недоступний", "{{count}} попереджень реєстру",
    ],
}

CHECK = "--check" in sys.argv


def main() -> int:
    missing_locales = [loc for loc in T if not (MESSAGES / f"{loc}.settings.ts").exists()]
    if missing_locales:
        print(f"找不到这些语言的 settings 文件：{missing_locales}")
        return 1

    problems: list[str] = []
    written: list[str] = []

    for loc, values in sorted(T.items()):
        path = MESSAGES / f"{loc}.settings.ts"
        text = path.read_text(encoding="utf-8")
        absent = [k for k in KEYS if f"'{k}'" not in text]
        if not absent:
            continue
        if len(absent) != len(KEYS):
            problems.append(f"{loc}: 只缺 {len(absent)}/{len(KEYS)} 条（半个状态，需要人看）")
            continue
        if CHECK:
            problems.append(f"{loc}: 缺全部 {len(KEYS)} 条")
            continue

        lines = text.split("\n")
        anchor_idx = next((i for i, line in enumerate(lines) if ANCHOR in line), None)
        if anchor_idx is None:
            problems.append(f"{loc}: 找不到锚点 {ANCHOR}")
            continue
        indent = lines[anchor_idx][: len(lines[anchor_idx]) - len(lines[anchor_idx].lstrip())]
        injected = [
            f"{indent}// 引擎一览（M4 注册表的用户可见面）。能力 id 刻意不翻译：它们是契约词表，译了反而对不上文档。"
        ] + [f"{indent}'{key}': {_ts(value)}," for key, value in zip(KEYS, values)]
        lines[anchor_idx + 1 : anchor_idx + 1] = injected
        path.write_text("\n".join(lines), encoding="utf-8")
        written.append(loc)

    if problems:
        print("需要处理：")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"已注入：{', '.join(written) if written else '（都齐了，无需改动）'}")
    return 0


def _ts(value: str) -> str:
    """按 TS 单引号字符串转义（本仓词典一律单引号）。"""
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


if __name__ == "__main__":
    raise SystemExit(main())
