# -*- coding: utf-8 -*-
"""直接驱动 OCR 工作进程做冒烟测试（不经过后端）。

用法：
    python scripts/ocr_worker_smoke.py ndl    <页图或PDF> [页号]
    python scripts/ocr_worker_smoke.py mineru <PDF> [起页] [止页] [--backend hybrid-auto-engine|vlm-auto-engine|pipeline]
解释器与引擎目录按 app/config.py 的默认值（ml/ocr/*-venv、ml/ocr/ndlkotenocr-lite），可用环境变量覆盖。
"""
import json
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
from app.config import settings  # noqa: E402

engine = sys.argv[1]
target = sys.argv[2]
backend = ""
if "--backend" in sys.argv:
    backend = sys.argv[sys.argv.index("--backend") + 1]
argv = [a for a in sys.argv[3:] if not a.startswith("--") and a != backend]
cands = settings.ocr_python_candidates if engine == "mineru" else settings.ndl_python_candidates
py = next((p for p in cands if p and Path(p).exists()), None)
if not py:
    sys.exit(f"找不到 {engine} 环境的 python：{cands}")
out_dir = settings.library_data_dir / "smoke" / engine
out_dir.mkdir(parents=True, exist_ok=True)
worker = ROOT / "server" / "app" / "ocr_worker.py"
proc = subprocess.Popen([py, "-X", "utf8", str(worker), "--engine", engine, "--ndl-root", str(settings.ndl_root),
                         "--models-dir", str(settings.mineru_models_dir)],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(out_dir / "worker.log", "a", encoding="utf-8"),
                        text=True, encoding="utf-8", bufsize=1)


def call(payload: dict) -> dict:
    t0 = time.perf_counter()
    proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    r = json.loads(line) if line.strip() else {"ok": False, "error": "no output"}
    r["_elapsed"] = round(time.perf_counter() - t0, 2)
    return r


boot = json.loads(proc.stdout.readline())
print("boot:", {k: v for k, v in boot.items() if k != "trace"})
if not boot.get("ok"):
    print(boot.get("trace", ""))
    sys.exit(1)

if engine == "ndl":
    img = target
    if target.lower().endswith(".pdf"):
        page_no = int(argv[0]) if argv else 1
        img = str(out_dir / f"p{page_no:04d}.png")
        print("render:", call({"cmd": "render", "pdf": target, "page_no": page_no, "dpi": settings.ocr_dpi, "out": img}))
    r = call({"cmd": "ocr_image", "image": img})
    print(f"ok={r.get('ok')} elapsed={r['_elapsed']}s blocks={len(r.get('blocks', []))} vertical={r.get('extra', {}).get('vertical_ratio')}")
    print((r.get("text") or r.get("error") or "")[:600])
else:
    start = int(argv[0]) if argv else 1
    end = int(argv[1]) if len(argv) > 1 else start
    r = call({"cmd": "ocr_pages", "pdf": target, "pages": list(range(start, end + 1)), "out_dir": str(out_dir),
              "backend": backend, "lang": "ch"})
    print(f"ok={r.get('ok')} elapsed={r['_elapsed']}s")
    if not r.get("ok"):
        print(r.get("error"))
    for k, pg in sorted((r.get("pages") or {}).items(), key=lambda kv: int(kv[0])):
        kinds = {}
        for b in pg["blocks"]:
            kinds[b["kind"]] = kinds.get(b["kind"], 0) + 1
        print(f"-- p{k}: blocks={kinds} figures={len(pg['figures'])} sec/page={pg['seconds']}")
        for b in pg["blocks"][:6]:
            print(f"   [{b['kind']:<8}] {b['text'][:70].replace(chr(10), ' ')}")
        for f in pg["figures"]:
            print(f"   [figure ] label={f['label']!r} caption={f['caption'][:50]!r} img={Path(f['image_path']).name if f['image_path'] else '-'}")
call({"cmd": "shutdown"})
proc.wait(timeout=10)
