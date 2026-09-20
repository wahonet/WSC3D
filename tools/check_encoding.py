# ASCII only. Fix GBK-written files to UTF-8, normalize CRLF -> LF (repo policy: .gitattributes eol=lf),
# and detect mojibake question-mark damage.
import ast
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXTS = {".py", ".ts", ".tsx", ".css", ".html", ".json", ".md", ".txt"}
SKIP_DIRS = {"node_modules", "ml", "data", ".git", "dist", "assets"}

fixed, eol, suspicious = [], [], []
for p in ROOT.rglob("*"):
    if not p.is_file() or p.suffix.lower() not in EXTS:
        continue
    if SKIP_DIRS & set(p.parts):
        continue
    raw = p.read_bytes()
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        raw = raw.decode("gbk").encode("utf-8")
        p.write_bytes(raw)
        fixed.append(str(p.relative_to(ROOT)))
    if b"\r\n" in raw:
        p.write_bytes(raw.replace(b"\r\n", b"\n"))
        eol.append(str(p.relative_to(ROOT)))
    t = p.read_text(encoding="utf-8")
    if p.suffix == ".py":
        ast.parse(t)
    # three or more consecutive question marks = likely destroyed CJK text
    for m in re.finditer(r"\?{3,}", t):
        s = max(0, m.start() - 20)
        suspicious.append((str(p.relative_to(ROOT)), t[s:m.end() + 8].replace("\n", " ")))

print("fixed:", fixed if fixed else "none")
print("crlf->lf:", eol if eol else "none")
if suspicious:
    print("SUSPICIOUS question-mark runs:")
    for f, ctx in suspicious[:20]:
        print("  ", f, "...", ctx)
    sys.exit(1)
print("mojibake check: clean")
