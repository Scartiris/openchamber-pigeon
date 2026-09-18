from pathlib import Path
import re
root = Path(r"T:\openchamber-pigeon\packages\ui\src\lib\i18n\messages")
pat = re.compile(r"^\s*(['\"])([^'\"]+)\1\s*:")
for name in ["en.ts", "zh-CN.ts", "en.settings.ts", "zh-CN.settings.ts"]:
    text = (root / name).read_text(encoding="utf-8")
    keys = pat.findall(text)
    print(f"{name}: {len(keys)} keys")
# rough non-test hardcoded English in components (not exhaustive)
comp = Path(r"T:\openchamber-pigeon\packages\ui\src\components")
english_rx = re.compile(
    r"(toast\.(?:error|success|info|warning)\(\s*[`'\"]([A-Z][^`'\"]{8,})|>(?:[A-Z][a-z]+ ){1,4}(?:failed|Failed|Error|Loading|Please |Select |Enter )|placeholder=\"[A-Z][a-z]+ )"
)
hits = []
for path in comp.rglob("*"):
    if path.suffix not in {".ts", ".tsx"} or ".test." in path.name or "fixture" in path.name:
        continue
    text = path.read_text(encoding="utf-8", errors="ignore")
    for m in english_rx.finditer(text):
        snippet = m.group(0).replace("\n", " ")[:100]
        hits.append(f"{path.relative_to(comp)}: {snippet}")
print("non-test english-ish hits:", len(hits))
for h in hits[:40]:
    print(h)
