# ASCII only. Replace mojibake-damaged CSS comment lines with English ones.
import pathlib
import re

p = pathlib.Path(__file__).resolve().parents[1] / "web" / "src" / "styles.css"
lines = p.read_text(encoding="utf-8").splitlines()

section_names = iter([
    "layout: 3-column shell",
    "stone tree",
    "tool panel",
    "center viewport",
    "info panel",
    "annotation panel",
    "misc",
    "section",
    "section",
])

out = []
for i, line in enumerate(lines):
    if re.search(r"\?{3,}", line) and "/*" in line:
        if i == 0:
            out.append("/* StoneLab - paper/ink/stone/zhu palette, 3-column research bench */")
        else:
            out.append(f"/* ---------------- {next(section_names)} ---------------- */")
    else:
        out.append(line)

p.write_text("\n".join(out) + "\n", encoding="utf-8")
print("css comments repaired")
