from pathlib import Path
import re

ROOT = Path(r"T:\openchamber-pigeon\packages\ui\src\lib\i18n\messages")
LOCALES = ["en", "zh-CN", "zh-TW", "de", "fr", "es", "ja", "ko", "pl", "pt-BR", "uk", "tr"]
# key -> 12 translations
ROWS = [
    (
        "settings.page.home.title",
        "Settings",
        "设置",
        "設定",
        "Einstellungen",
        "Paramètres",
        "Ajustes",
        "設定",
        "설정",
        "Ustawienia",
        "Configurações",
        "Налаштування",
        "Ayarlar",
    ),
    (
        "settings.page.home.description",
        "Search and jump to common pages.",
        "搜索并跳转到常用页面。",
        "搜尋並跳至常用頁面。",
        "Suchen und zu häufig genutzten Seiten springen.",
        "Recherchez et accédez aux pages courantes.",
        "Busca y salta a las páginas habituales.",
        "よく使うページを検索して移動します。",
        "자주 사용하는 페이지를 검색하고 이동합니다.",
        "Szukaj i przechodź do popularnych stron.",
        "Pesquise e vá para páginas comuns.",
        "Шукайте й переходьте до поширених сторінок.",
        "Sık kullanılan sayfaları arayın ve atlayın.",
    ),
    (
        "chat.toolOutputDialog.taskFields.task",
        "Task:",
        "任务：",
        "任務：",
        "Aufgabe:",
        "Tâche :",
        "Tarea:",
        "タスク：",
        "작업:",
        "Zadanie:",
        "Tarefa:",
        "Завдання:",
        "Görev:",
    ),
    (
        "chat.toolOutputDialog.taskFields.agentType",
        "Agent Type:",
        "智能体类型：",
        "智慧體類型：",
        "Agententyp:",
        "Type d’agent :",
        "Tipo de agente:",
        "エージェント種別：",
        "에이전트 유형:",
        "Typ agenta:",
        "Tipo de agente:",
        "Тип агента:",
        "Ajan türü:",
    ),
    (
        "chat.toolOutputDialog.taskFields.instructions",
        "Instructions:",
        "指令：",
        "指令：",
        "Anweisungen:",
        "Instructions :",
        "Instrucciones:",
        "指示：",
        "지시:",
        "Instrukcje:",
        "Instruções:",
        "Інструкції:",
        "Talimatlar:",
    ),
]


def ts_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def inject(path: Path, rows, index: int) -> int:
    text = path.read_text(encoding="utf-8")
    added = 0
    for row in rows:
        key = row[0]
        if f"'{key}'" in text:
            continue
        value = row[1 + index]
        entry = f"  {ts_string(key)}: {ts_string(value)},\n"
        match = re.search(r"\n\} as const;", text)
        if not match:
            candidates = list(re.finditer(r"\n(\} as const;|\};)", text))
            if not candidates:
                raise SystemExit(f"no close in {path}")
            match = candidates[-1]
        text = text[: match.start() + 1] + entry + text[match.start() + 1 :]
        added += 1
    if added:
        path.write_text(text, encoding="utf-8")
    return added


def main() -> None:
    total = 0
    chat_rows = [r for r in ROWS if r[0].startswith("chat.")]
    settings_rows = [r for r in ROWS if r[0].startswith("settings.")]
    for i, locale in enumerate(LOCALES):
        total += inject(ROOT / f"{locale}.settings.ts", settings_rows, i)
        total += inject(ROOT / f"{locale}.ts", chat_rows, i)
    print("added", total)


if __name__ == "__main__":
    main()
