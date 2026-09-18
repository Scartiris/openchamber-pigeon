from pathlib import Path
import re

plugin = Path(r"T:\openchamber-pigeon\packages\web\server\lib\opencode\plugin-routes.js")
text = plugin.read_text(encoding="utf-8")
# completePluginMutation(res, '...', '...', () => { ... });
text2, n = re.subn(
    r"await completePluginMutation\(res, ('(?:[^']+)'), ('(?:[^']+)'), (\(\) => \{)",
    r"await completePluginMutation(res, \1, \2, \3",
    text,
)
# Add req as 5th argument: change `});` that closes completePluginMutation calls is hard.
# Instead append req before the closing of each call by rewriting function to take req via closure - easier: change signature order to completePluginMutation(req, res, ...)
text2 = text2.replace(
    "const completePluginMutation = async (res, operation, _noun, applyChange, req) => {",
    "const completePluginMutation = async (req, res, operation, _noun, applyChange) => {",
)
text2 = re.sub(
    r"await completePluginMutation\(res, ",
    "await completePluginMutation(req, res, ",
    text2,
)
plugin.write_text(text2, encoding="utf-8")
print("plugin patched", n)

entity = Path(r"T:\openchamber-pigeon\packages\web\server\lib\opencode\config-entity-routes.js")
text = entity.read_text(encoding="utf-8")
text = text.replace(
    "const completeMcpMutation = async (res, action, name, applyChange, req) => {",
    "const completeMcpMutation = async (req, res, action, name, applyChange) => {",
)
text = text.replace("await completeMcpMutation(res, ", "await completeMcpMutation(req, res, ")

replacements = [
    (
        "buildDeferredRestartResponse(\n        `Agent ${agentName} created successfully. Restart OpenCode to apply.`,\n      )",
        "buildDeferredRestartResponse(\n        serverMessage(req, 'server.opencode.agent.createdDeferred', { name: agentName }),\n      )",
    ),
    (
        "buildDeferredRestartResponse(\n        `Agent ${agentName} updated successfully. Restart OpenCode to apply.`,\n      )",
        "buildDeferredRestartResponse(\n        serverMessage(req, 'server.opencode.agent.updatedDeferred', { name: agentName }),\n      )",
    ),
    (
        "buildDeferredRestartResponse(\n        `Agent ${agentName} deleted successfully. Restart OpenCode to apply.`,\n      )",
        "buildDeferredRestartResponse(\n        serverMessage(req, 'server.opencode.agent.deletedDeferred', { name: agentName }),\n      )",
    ),
    (
        "buildDeferredRestartResponse(\n        `Command ${commandName} created successfully. Restart OpenCode to apply.`,\n      )",
        "buildDeferredRestartResponse(\n        serverMessage(req, 'server.opencode.command.createdDeferred', { name: commandName }),\n      )",
    ),
    (
        "buildDeferredRestartResponse(\n        `Command ${commandName} updated successfully. Restart OpenCode to apply.`,\n      )",
        "buildDeferredRestartResponse(\n        serverMessage(req, 'server.opencode.command.updatedDeferred', { name: commandName }),\n      )",
    ),
    (
        "buildDeferredRestartResponse(\n        `Command ${commandName} deleted successfully. Restart OpenCode to apply.`,\n      )",
        "buildDeferredRestartResponse(\n        serverMessage(req, 'server.opencode.command.deletedDeferred', { name: commandName }),\n      )",
    ),
]
for old, new in replacements:
    if old not in text:
        print("MISS", old[:60])
    text = text.replace(old, new)
entity.write_text(text, encoding="utf-8")
print("entity done")

# session-runtime
sr = Path(r"T:\openchamber-pigeon\packages\web\server\lib\opencode\session-runtime.js")
text = sr.read_text(encoding="utf-8")
if "from '../server-html/page-copy.js'" not in text:
    # insert after first import block - find first line starting with import
    lines = text.splitlines(True)
    for i, line in enumerate(lines):
        if line.startswith("import "):
            last_import = i
    # find last consecutive import at top
    last_import = 0
    for i, line in enumerate(lines[:40]):
        if line.startswith("import "):
            last_import = i
    lines.insert(last_import + 1, "import { serverMessage } from '../server-html/page-copy.js';\n")
    text = "".join(lines)
text = text.replace(
    "message: 'Interrupted by OpenCode restart',",
    "message: serverMessage(undefined, 'server.session.interruptedByRestart'),",
)
text = text.replace(
    "'The running turn was interrupted when OpenCode restarted.'",
    "serverMessage(undefined, 'server.session.interruptedByRestartDetail')",
)
sr.write_text(text, encoding="utf-8")
print("session-runtime done")
