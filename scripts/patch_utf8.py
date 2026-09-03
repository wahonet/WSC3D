# ASCII only. Apply exact-string edits to a UTF-8 source file from a JSON spec.
# Usage: python scripts/patch_utf8.py spec.json
# spec: {"file": "server/app/x.py", "edits": [{"old": "...", "new": "..."}]}
# The spec file may be UTF-8 or GBK (editor-written); the target is always read/written as UTF-8.
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def read_any(p: pathlib.Path) -> str:
    raw = p.read_bytes()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("gbk")


def main() -> int:
    spec = json.loads(read_any(pathlib.Path(sys.argv[1])))
    target = ROOT / spec["file"]
    text = target.read_text(encoding="utf-8")
    for i, e in enumerate(spec["edits"]):
        n = text.count(e["old"])
        if n != 1 and not e.get("all"):
            print(f"edit {i}: expected exactly 1 occurrence, found {n}")
            return 1
        text = text.replace(e["old"], e["new"])
    target.write_text(text, encoding="utf-8", newline="\n")
    print(f"patched {spec['file']}: {len(spec['edits'])} edit(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
