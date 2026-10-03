#!/usr/bin/env python3
"""给 12 个语言文件补上 `settings.page.engine.title`（新增的「引擎」设置页标题）。

为什么要脚本：i18n 的消息表是 `Record<I18nKey, string>`，**任何语言缺一个键就过不了 type-check**
（这是仓库的既有门禁）。所以加一个键必须 12 个语言一起加。
幂等：已经有的语言跳过。
"""
import pathlib
import re
import sys

MESSAGES = pathlib.Path(__file__).resolve().parents[1] / "packages/ui/src/lib/i18n/messages"

# 每种语言的标题。没有现成译法时按该语言的惯例写，别留英文占位。
TITLES = {
    "en": "Engine",
    "zh-CN": "引擎",
    "zh-TW": "引擎",
    "de": "Engine",
    "es": "Motor",
    "fr": "Moteur",
    "ja": "エンジン",
    "ko": "엔진",
    "pl": "Silnik",
    "pt-BR": "Motor",
    "tr": "Motor",
    "uk": "Рушій",
}

# 每个语言插到哪一行后面（放在 about 后面，与 metadata 的分组顺序一致）
# ⚠️ 引号有两种：多数文件用单引号，但 es / pt-BR / uk 用**双引号** ——
#    第一版只认单引号，这三个语言就被判成"没找到锚点"（差点漏掉 3/12）。
ANCHORS = ("'settings.page.about.title'", '"settings.page.about.title"')

added, skipped, missing_anchor = [], [], []

for lang, title in TITLES.items():
    path = MESSAGES / f"{lang}.settings.ts"
    if not path.exists():
        missing_anchor.append(f"{lang}（文件不存在）")
        continue
    text = path.read_text(encoding="utf-8")
    if "'settings.page.engine.title'" in text or '"settings.page.engine.title"' in text:
        skipped.append(lang)
        continue
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if any(anchor in line for anchor in ANCHORS):
            indent = re.match(r"\s*", line).group(0)
            # 跟随该文件自己的引号风格
            quote = '"' if '"settings.page.about.title"' in line else "'"
            lines.insert(i + 1, f"{indent}{quote}settings.page.engine.title{quote}: {quote}{title}{quote},")
            break
    else:
        missing_anchor.append(lang)
        continue
    path.write_text("\n".join(lines), encoding="utf-8")
    added.append(lang)

print(f"新增：{len(added)} 个语言 → {', '.join(added) if added else '（无）'}")
print(f"已有跳过：{len(skipped)} 个 → {', '.join(skipped) if skipped else '（无）'}")
if missing_anchor:
    print(f"⚠️ 没找到锚点：{', '.join(missing_anchor)}", file=sys.stderr)
    sys.exit(1)
print("OK")
