from pathlib import Path
import re

ROOT = Path(r"T:\openchamber-pigeon\packages\ui\src\lib\i18n\messages")
LOCALES = ["en", "zh-CN", "zh-TW", "de", "fr", "es", "ja", "ko", "pl", "pt-BR", "uk", "tr"]
ROWS = [
    (
        "guests.host.notGranted",
        "The user has not allowed this capability for the extension.",
        "用户尚未允许该扩展使用此能力。",
        "使用者尚未允許該擴充使用此能力。",
        "Der Benutzer hat dieser Erweiterung diese Funktion nicht erlaubt.",
        "L’utilisateur n’a pas autorisé cette capacité pour l’extension.",
        "El usuario no ha permitido esta capacidad para la extensión.",
        "ユーザーはこの拡張機能にその機能を許可していません.",
        "사용자가 이 확장에 해당 기능을 허용하지 않았습니다.",
        "Użytkownik nie zezwolił na tę funkcję dla rozszerzenia.",
        "O usuário não permitiu este recurso para a extensão.",
        "Користувач не дозволив цю можливість для розширення.",
        "Kullanıcı bu uzantı için bu yeteneğe izin vermedi.",
    ),
    (
        "guests.host.extensionUnavailable",
        "Extension is unavailable.",
        "扩展不可用。",
        "擴充無法使用。",
        "Erweiterung ist nicht verfügbar.",
        "L’extension n’est pas disponible.",
        "La extensión no está disponible.",
        "拡張機能を利用できません。",
        "확장을 사용할 수 없습니다.",
        "Rozszerzenie jest niedostępne.",
        "A extensão está indisponível.",
        "Розширення недоступне.",
        "Uzantı kullanılamıyor.",
    ),
    (
        "guests.host.extensionDisabled",
        "This extension is disabled in Settings → Extensions.",
        "该扩展已在「设置 → 扩展」中禁用。",
        "該擴充已在「設定 → 擴充」中停用。",
        "Diese Erweiterung ist unter Einstellungen → Erweiterungen deaktiviert.",
        "Cette extension est désactivée dans Paramètres → Extensions.",
        "Esta extensión está desactivada en Ajustes → Extensiones.",
        "この拡張機能は「設定 → 拡張」で無効化されています。",
        "이 확장은 설정 → 확장에서 비활성화되어 있습니다.",
        "To rozszerzenie jest wyłączone w Ustawienia → Rozszerzenia.",
        "Esta extensão está desativada em Configurações → Extensões.",
        "Це розширення вимкнено в Налаштування → Розширення.",
        "Bu uzantı Ayarlar → Uzantılar’da devre dışı.",
    ),
    (
        "guests.host.requestFailed",
        "Request failed.",
        "请求失败。",
        "請求失敗。",
        "Anfrage fehlgeschlagen.",
        "La requête a échoué.",
        "La solicitud falló.",
        "リクエストに失敗しました.",
        "요청 실패.",
        "Żądanie nie powiodło się.",
        "A solicitação falhou.",
        "Запит не вдався.",
        "İstek başarısız.",
    ),
    (
        "guests.host.noProject",
        "No project is open.",
        "当前没有打开的项目。",
        "目前沒有開啟的專案。",
        "Kein Projekt ist geöffnet.",
        "Aucun projet n’est ouvert.",
        "No hay ningún proyecto abierto.",
        "開いているプロジェクトがありません.",
        "열린 프로젝트가 없습니다.",
        "Brak otwartego projektu.",
        "Nenhum projeto está aberto.",
        "Немає відкритого проєкту.",
        "Açık proje yok.",
    ),
    (
        "guests.host.operationFailed",
        "Extension operation failed.",
        "扩展操作失败。",
        "擴充操作失敗。",
        "Erweiterungsvorgang fehlgeschlagen.",
        "L’opération de l’extension a échoué.",
        "Falló la operación de la extensión.",
        "拡張機能の操作に失敗しました.",
        "확장 작업 실패.",
        "Operacja rozszerzenia nie powiodła się.",
        "A operação da extensão falhou.",
        "Операцію розширення не виконано.",
        "Uzantı işlemi başarısız.",
    ),
    (
        "guests.service.noService",
        "No service is available for this extension.",
        "该扩展没有可用的本地服务。",
        "該擴充沒有可用的本機服務。",
        "Für diese Erweiterung ist kein Dienst verfügbar.",
        "Aucun service n’est disponible pour cette extension.",
        "No hay servicio disponible para esta extensión.",
        "この拡張機能で利用可能なサービスがありません.",
        "이 확장에 사용 가능한 서비스가 없습니다.",
        "Brak dostępnego serwisu dla tego rozszerzenia.",
        "Nenhum serviço disponível para esta extensão.",
        "Немає доступного сервісу для цього розширення.",
        "Bu uzantı için kullanılabilir hizmet yok.",
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
        entry = f"  {ts_string(key)}: {ts_string(row[1 + index])},\n"
        match = re.search(r"\n\} as const;", text)
        if not match:
            candidates = list(re.finditer(r"\n(\} as const;|\};)", text))
            if not candidates:
                raise SystemExit(path)
            match = candidates[-1]
        text = text[: match.start() + 1] + entry + text[match.start() + 1 :]
        added += 1
    if added:
        path.write_text(text, encoding="utf-8")
    return added


def main() -> None:
    total = 0
    for i, locale in enumerate(LOCALES):
        total += inject(ROOT / f"{locale}.ts", ROWS, i)
    print("added", total)


if __name__ == "__main__":
    main()
