from pathlib import Path
import re

ROOT = Path(r"T:\openchamber-pigeon\packages\ui\src\lib\i18n\messages")
LOCALES = ["en", "zh-CN", "zh-TW", "de", "fr", "es", "ja", "ko", "pl", "pt-BR", "uk", "tr"]
ROWS = [
    (
        "serverMessage.opencode.configReloaded",
        "Configuration reloaded successfully. Refreshing interface…",
        "配置重新加载成功。正在刷新界面…",
        "設定重新載入成功。正在重新整理介面…",
        "Konfiguration erfolgreich neu geladen. Oberfläche wird aktualisiert…",
        "Configuration rechargée avec succès. Actualisation de l’interface…",
        "Configuración recargada correctamente. Actualizando la interfaz…",
        "設定を再読み込みしました。画面を更新しています…",
        "구성을 다시 불러왔습니다. 인터페이스를 새로 고치는 중…",
        "Konfiguracja ponownie załadowana. Odświeżanie interfejsu…",
        "Configuração recarregada com sucesso. Atualizando a interface…",
        "Конфігурацію перезавантажено. Оновлення інтерфейсу…",
        "Yapılandırma yeniden yüklendi. Arayüz yenileniyor…",
    ),
    (
        "serverMessage.opencode.manualRestart",
        "Saved to disk. Restart the connected OpenCode server to apply the changes.",
        "已保存到磁盘。请重启已连接的 OpenCode 服务器以应用更改。",
        "已儲存到磁碟。請重新啟動已連線的 OpenCode 伺服器以套用變更。",
        "Auf Datenträger gespeichert. Starten Sie den verbundenen OpenCode-Server neu, um die Änderungen anzuwenden.",
        "Enregistré sur le disque. Redémarrez le serveur OpenCode connecté pour appliquer les modifications.",
        "Guardado en disco. Reinicia el servidor OpenCode conectado para aplicar los cambios.",
        "ディスクに保存しました。接続中の OpenCode サーバーを再起動して変更を適用してください.",
        "디스크에 저장되었습니다. 연결된 OpenCode 서버를 다시 시작하여 변경 사항을 적용하세요.",
        "Zapisano na dysku. Uruchom ponownie podłączony serwer OpenCode, aby zastosować zmiany.",
        "Salvo no disco. Reinicie o servidor OpenCode conectado para aplicar as alterações.",
        "Збережено на диску. Перезапустіть підключений сервер OpenCode, щоб застосувати зміни.",
        "Diske kaydedildi. Değişiklikleri uygulamak için bağlı OpenCode sunucusunu yeniden başlatın.",
    ),
    (
        "serverMessage.session.interruptedByRestart",
        "Interrupted by OpenCode restart",
        "因 OpenCode 重启而中断",
        "因 OpenCode 重新啟動而中斷",
        "Durch OpenCode-Neustart unterbrochen",
        "Interrompu par le redémarrage d’OpenCode",
        "Interrumpido por el reinicio de OpenCode",
        "OpenCode の再起動により中断されました",
        "OpenCode 다시 시작으로 인해 중단됨",
        "Przerwane przez ponowne uruchomienie OpenCode",
        "Interrompido pelo reinício do OpenCode",
        "Перервано через перезапуск OpenCode",
        "OpenCode yeniden başlatılması nedeniyle kesildi",
    ),
    (
        "serverMessage.session.interruptedByRestartDetail",
        "The running turn was interrupted when OpenCode restarted.",
        "当前回合在 OpenCode 重启时被中断。",
        "目前回合在 OpenCode 重新啟動時被中斷。",
        "Der laufende Durchlauf wurde beim OpenCode-Neustart unterbrochen.",
        "Le tour en cours a été interrompu lors du redémarrage d’OpenCode.",
        "El turno en ejecución se interrumpió al reiniciar OpenCode.",
        "実行中のターンは OpenCode の再起動時に中断されました.",
        "실행 중이던 턴이 OpenCode 다시 시작으로 인해 중단되었습니다.",
        "Trwająca tura została przerwana przy ponownym uruchomieniu OpenCode.",
        "O turno em execução foi interrompido quando o OpenCode reiniciou.",
        "Поточний хід перервано під час перезапуску OpenCode.",
        "Çalışan tur, OpenCode yeniden başlatılırken kesildi.",
    ),
    (
        "serverMessage.opencode.restartToApply",
        "Saved. Restart OpenCode to apply.",
        "已保存。请重启 OpenCode 以应用。",
        "已儲存。請重新啟動 OpenCode 以套用。",
        "Gespeichert. Starten Sie OpenCode neu, um anzuwenden.",
        "Enregistré. Redémarrez OpenCode pour appliquer.",
        "Guardado. Reinicia OpenCode para aplicar.",
        "保存しました。適用するには OpenCode を再起動してください.",
        "저장되었습니다. 적용하려면 OpenCode를 다시 시작하세요.",
        "Zapisano. Uruchom ponownie OpenCode, aby zastosować.",
        "Salvo. Reinicie o OpenCode para aplicar.",
        "Збережено. Перезапустіть OpenCode, щоб застосувати.",
        "Kaydedildi. Uygulamak için OpenCode’yu yeniden başlatın.",
    ),
    (
        "serverMessage.opencode.noSkillsInstalled",
        "No skills were installed",
        "没有安装任何技能",
        "沒有安裝任何技能",
        "Es wurden keine Skills installiert",
        "Aucune compétence n’a été installée",
        "No se instaló ninguna skill",
        "スキルはインストールされませんでした",
        "설치된 기술이 없습니다",
        "Nie zainstalowano żadnych umiejętności",
        "Nenhuma habilidade foi instalada",
        "Навички не встановлено",
        "Hiçbir beceri yüklenmedi",
    ),
    (
        "gitView.toast.removeRemoteFailed",
        "Failed to remove remote {name}",
        "移除远程 {name} 失败",
        "移除遠端 {name} 失敗",
        "Remote {name} konnte nicht entfernt werden",
        "Échec de la suppression du dépôt distant {name}",
        "No se pudo quitar el remoto {name}",
        "リモート {name} の削除に失敗しました",
        "원격 {name} 제거 실패",
        "Nie udało się usunąć zdalnego {name}",
        "Falha ao remover o remoto {name}",
        "Не вдалося видалити віддалений {name}",
        "Uzak {name} kaldırılamadı",
    ),
    (
        "gitView.toast.upstreamSetFailed",
        "Failed to set upstream",
        "设置上游失败",
        "設定上游失敗",
        "Upstream konnte nicht gesetzt werden",
        "Échec de la définition de l’amont",
        "No se pudo configurar el upstream",
        "アップストリームの設定に失敗しました",
        "업스트림 설정 실패",
        "Nie udało się ustawić upstream",
        "Falha ao definir upstream",
        "Не вдалося налаштувати upstream",
        "Upstream ayarlanamadı",
    ),
    (
        "gitView.toast.mergeFailed",
        "Failed to merge {branch}",
        "合并 {branch} 失败",
        "合併 {branch} 失敗",
        "Zusammenführen von {branch} fehlgeschlagen",
        "Échec de la fusion de {branch}",
        "No se pudo fusionar {branch}",
        "{branch} のマージに失敗しました",
        "{branch} 병합 실패",
        "Scalanie {branch} nie powiodło się",
        "Falha ao mesclar {branch}",
        "Не вдалося злити {branch}",
        "{branch} birleştirilemedi",
    ),
    (
        "gitView.toast.rebaseFailed",
        "Failed to rebase onto {branch}",
        "变基到 {branch} 失敗",
        "變基到 {branch} 失敗",
        "Rebase auf {branch} fehlgeschlagen",
        "Échec du rebase sur {branch}",
        "No se pudo hacer rebase sobre {branch}",
        "{branch} へのリベースに失敗しました",
        "{branch}으로 리베이스 실패",
        "Rebase na {branch} nie powiódł się",
        "Falha ao fazer rebase em {branch}",
        "Не вдалося rebase на {branch}",
        "{branch} üzerine rebase yapılamadı",
    ),
    (
        "contextSidebar.message.userLabel",
        "User:",
        "用户：",
        "使用者：",
        "Benutzer:",
        "Utilisateur :",
        "Usuario:",
        "ユーザー：",
        "사용자:",
        "Użytkownik:",
        "Usuário:",
        "Користувач:",
        "Kullanıcı:",
    ),
    (
        "artifacts.toast.collectFailed",
        "Failed to collect this file as an artifact",
        "无法将此文件收集为制品",
        "無法將此檔案收集為成品",
        "Datei konnte nicht als Artefakt gesammelt werden",
        "Impossible de collecter ce fichier en artefact",
        "No se pudo recoplar este archivo como artefacto",
        "このファイルを成果物として収集できませんでした",
        "이 파일을 아티팩트로 수집하지 못했습니다",
        "Nie udało się zebrać tego pliku jako artefaktu",
        "Falha ao coletar este arquivo como artefato",
        "Не вдалося зібрати цей файл як артефакт",
        "Bu dosya yapıt olarak toplanamadı",
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
                raise SystemExit(f"no close {path}")
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
