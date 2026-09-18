from pathlib import Path

ROOT = Path(r"T:\openchamber-pigeon\packages\ui\src\lib\i18n\messages")
REQUIRED = [
    "settings.page.devices.title",
    "settings.page.pigeonBrain.description",
    "settings.devices.approval.deny",
    "settings.mcp.oauth.callback.working",
    "settings.remoteInstances.page.forward.localTarget",
    "sessions.sidebar.session.fork.toast.forkedFrom",
    "header.sessions.untitled",
    "agentManager.view.toast.creatingGroup",
]
for locale in ["en", "zh-CN", "zh-TW", "de", "fr", "es", "ja", "ko", "pl", "pt-BR", "uk", "tr"]:
    settings = (ROOT / f"{locale}.settings.ts").read_text(encoding="utf-8")
    main = (ROOT / f"{locale}.ts").read_text(encoding="utf-8")
    missing = []
    for key in REQUIRED:
        token = f"'{key}'"
        if token not in settings and token not in main:
            missing.append(key)
    print(locale, "OK" if not missing else f"MISSING {missing}")
