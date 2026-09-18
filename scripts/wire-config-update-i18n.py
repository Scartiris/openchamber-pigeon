from pathlib import Path
import re

MAP = {
    'Creating command configuration…': ('configUpdate.creatingCommand', False),
    'Updating command configuration…': ('configUpdate.updatingCommand', False),
    'Deleting command configuration…': ('configUpdate.deletingCommand', False),
    'Creating skill...': ('configUpdate.creatingSkill', False),
    'Updating skill...': ('configUpdate.updatingSkill', False),
    'Renaming skill...': ('configUpdate.renamingSkill', False),
    'Deleting skill...': ('configUpdate.deletingSkill', False),
    "Installing skills…": ('configUpdate.installingSkills', False),
    'Installing skills…': ('configUpdate.installingSkills', False),
    'Creating MCP server configuration…': ('configUpdate.creatingMcp', False),
    'Updating MCP server configuration…': ('configUpdate.updatingMcp', False),
    'Deleting MCP server configuration…': ('configUpdate.deletingMcp', False),
    'Creating agent configuration…': ('configUpdate.creatingAgent', False),
    'Updating agent configuration…': ('configUpdate.updatingAgent', False),
    'Deleting agent configuration…': ('configUpdate.deletingAgent', False),
    'Reloading OpenCode configuration…': ('configUpdate.reloadingOpenCode', False),
}

FILES = [
    Path(r'T:\openchamber-pigeon\packages\ui\src\stores\useCommandsStore.ts'),
    Path(r'T:\openchamber-pigeon\packages\ui\src\stores\useSkillsStore.ts'),
    Path(r'T:\openchamber-pigeon\packages\ui\src\stores\useSkillsCatalogStore.ts'),
    Path(r'T:\openchamber-pigeon\packages\ui\src\stores\useMcpConfigStore.ts'),
    Path(r'T:\openchamber-pigeon\packages\ui\src\stores\useAgentsStore.ts'),
]

IMPORT = "import { formatMessage, useI18nStore } from '@/lib/i18n';\n"

def resolve_expr(key: str) -> str:
    return f"formatMessage(useI18nStore.getState().dictionary, '{key}')"

for path in FILES:
    text = path.read_text(encoding='utf-8')
    if "from '@/lib/i18n'" not in text and 'from "@/lib/i18n"' not in text:
        # insert after first import
        m = re.search(r'^import .*?;\n', text, re.M)
        if not m:
            raise SystemExit(f'no import in {path}')
        text = text[:m.end()] + IMPORT + text[m.end():]
    changed = 0
    for raw, (key, _) in MAP.items():
        # startConfigUpdate('...') or startConfigUpdate("...")
        for quote in ('"', "'"):
            needle = f"startConfigUpdate({quote}{raw}{quote})"
            if needle in text:
                text = text.replace(needle, f"startConfigUpdate({resolve_expr(key)})")
                changed += 1
    # options?.message || "Reloading..."
    text = text.replace(
        'options?.message || "Reloading OpenCode configuration…"',
        f'options?.message || {resolve_expr("configUpdate.reloadingOpenCode")}',
    )
    text = text.replace(
        "options?.message || 'Reloading OpenCode configuration…'",
        f'options?.message || {resolve_expr("configUpdate.reloadingOpenCode")}',
    )
    path.write_text(text, encoding='utf-8')
    print(path.name, 'changed', changed)
