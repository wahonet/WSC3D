"""Exercise real model weights through the new application's public API."""
import tempfile
import json
import os
import sys
import time
from pathlib import Path
import requests

sys.stdout.reconfigure(encoding="utf-8")
root = Path(__file__).resolve().parents[1]
round_name = sys.argv[1] if len(sys.argv) > 1 else "round2"
config = json.loads((root / 'config/project.json').read_text(encoding='utf-8'))
base = os.environ.get('WSC_TEST_URL', f"http://127.0.0.1:{config.get('port', 8030)}") + '/api/tools/segment'
output = Path(os.environ.get('WSC_SMOKE_OUTPUT', Path(tempfile.gettempdir()) / 'wsc-tests/model-runtime'))
output.mkdir(parents=True, exist_ok=True)
session = requests.Session()
session.post(base.removesuffix('/tools/segment') + '/workspace/login',
             json={'username':'admin','password':os.environ.get('WSC_WORKSPACE_PASSWORD','123456')},timeout=30).raise_for_status()
report = []
for engine in ["sam3", "sam3.1", "mobilesam"]:
    start = time.monotonic()
    response = session.post(f"{base}/load/{engine}", timeout=30)
    response.raise_for_status()
    print(json.dumps({"engine": engine, "load_requested": True}), flush=True)
    status = {}
    for attempt in range(100):
        status = session.get(base + "/status", timeout=30).json()
        state = status["engines"][engine]
        if state["status"] in {"ready", "error"}:
            break
        time.sleep(2)
    entry = {"engine": engine, "state": state, "load_seconds": round(time.monotonic()-start, 2), "worker": status["worker"], "cases": []}
    if state["status"] == "ready":
        cases = [("points", "/point", {"asset_id": 15, "points": [[0.4, 0.45], [0.05, 0.05]], "labels": [1, 0]})] if engine == "mobilesam" else [
            ("text", "/text", {"asset_id": 15, "engine": engine, "prompt": "person", "threshold": 0.1, "max_results": 5, "preprocess": "none", "invert": False, "tiling": "none"}),
        ]
        for name, route, body in cases:
            start = time.monotonic()
            try:
                result = session.post(base + route, json=body, timeout=240)
                result.raise_for_status()
                data = result.json()
                (output / f"{engine}-{name}-{round_name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                entry["cases"].append({"name": name, "ok": data.get("ok"), "detections": len(data.get("detections", [])), "polygons": len(data.get("polygons", [])), "error": data.get("error"), "seconds": round(time.monotonic()-start, 2)})
            except Exception as exc:
                entry["cases"].append({"name": name, "ok": False, "error": str(exc)})
    session.post(f"{base}/unload/{engine}", timeout=30).raise_for_status()
    report.append(entry)
    print(json.dumps(entry, ensure_ascii=False), flush=True)
    (output / f"sam-{round_name}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
if not all(r["state"]["status"] == "ready" and r["cases"] and all(c["ok"] for c in r["cases"]) for r in report):
    sys.exit(1)
