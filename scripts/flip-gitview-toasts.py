from pathlib import Path
import re

path = Path(r"T:\openchamber-pigeon\packages\ui\src\components\views\GitView.tsx")
text = path.read_text(encoding="utf-8")

# Pattern A:
#   const message = err instanceof Error ? err.message : t('KEY'...);
#   toast.error(message);
# -> toast.error(t('KEY'...), { description: err instanceof Error ? err.message : undefined });

pattern_a = re.compile(
    r"const message =\s*err instanceof Error\s*\?\s*err\.message\s*:\s*(t\((?:[^;]*?)\));\s*"
    r"toast\.error\(message\);",
    re.MULTILINE | re.DOTALL,
)

def repl_a(match: re.Match[str]) -> str:
    call = re.sub(r"\s+", " ", match.group(1)).strip()
    return (
        f"toast.error({call}, {{\n"
        f"        description: err instanceof Error ? err.message : undefined,\n"
        f"      }});"
    )

text2, n_a = pattern_a.subn(repl_a, text)

# Pattern B:
#   const message = err instanceof Error ? err.message : `Failed to abort ${conflictOperation}`;
#   toast.error(message);
pattern_b = re.compile(
    r"const message = err instanceof Error \? err\.message : `Failed to abort \$\{conflictOperation\}`;\s*"
    r"toast\.error\(message\);",
    re.MULTILINE,
)
text2, n_b = pattern_b.subn(
    "toast.error(t('gitView.toast.abortOperationFailed'), {\n"
    "        description: err instanceof Error ? err.message : undefined,\n"
    "      });",
    text2,
)

# Pattern C (sync catch with multi-line message assignment ending in toast.error(message);)
pattern_c = re.compile(
    r"const message =\s*\n\s*err instanceof Error\s*\n\s*\?\s*err\.message\s*\n\s*: (t\((?:[^;]*?)\));\s*"
    r"toast\.error\(message\);",
    re.MULTILINE | re.DOTALL,
)

def repl_c(match: re.Match[str]) -> str:
    call = re.sub(r"\s+", " ", match.group(1)).strip()
    return (
        f"toast.error({call}, {{\n"
        f"        description: err instanceof Error ? err.message : undefined,\n"
        f"      }});"
    )

text2, n_c = pattern_c.subn(repl_c, text2)

path.write_text(text2, encoding="utf-8")
print(f"replaced a={n_a} b={n_b} c={n_c}")
