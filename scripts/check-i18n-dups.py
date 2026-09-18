from collections import Counter
from pathlib import Path
import re

ROOT = Path(r"T:\openchamber-pigeon\packages\ui\src\lib\i18n\messages")
ENTRY = re.compile(r"^(\s*)(['\"])([^'\"]+)\2(\s*:\s*)(.+)$")

for name in [
    "en.ts",
    "en.settings.ts",
    "zh-CN.ts",
    "zh-CN.settings.ts",
    "de.settings.ts",
]:
    path = ROOT / name
    keys = []
    for line in path.read_text(encoding="utf-8").splitlines():
        match = ENTRY.match(line)
        if match:
            keys.append(match.group(3))
    counts = Counter(keys)
    dups = [(key, count) for key, count in counts.items() if count > 1]
    print(name, "keys", len(keys), "dups", len(dups))
    for key, count in dups[:12]:
        print(" ", count, key)
