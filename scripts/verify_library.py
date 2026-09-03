# -*- coding: utf-8 -*-
"""文献库端到端验证：扫描入库 -> 页图 -> 启动 OCR 作业并轮询 -> 页详情（文段 / 插图）-> 检索 -> 校订与版本冲突。

用法：python scripts/verify_library.py [--engine mineru|ndl] [--pages 16,17] [--backend hybrid-auto-engine] [--doc DOC-001]
默认对第一部文献的第 16 页跑 OCR。需要后端已启动。
"""
import json
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
BASE = "http://127.0.0.1:8020/api"


def arg(name, default=None):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return default


def call(p, method="GET", body=None, expect_error=False, raw=False):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + p, method=method, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    try:
        r = urllib.request.urlopen(req, timeout=600)
        return r.read() if raw else json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = json.loads(e.read().decode("utf-8")).get("detail", "")
        if expect_error:
            return {"__error__": e.code, "detail": detail}
        raise RuntimeError(f"{method} {p} -> {e.code}: {detail}")


engine = arg("--engine")
pages = [int(x) for x in arg("--pages", "16").split(",")]
backend = arg("--backend", "")
code = arg("--doc")

print("1) 扫描与文献列表")
print("   scan:", call("/library/scan", "POST"))
docs = call("/library/documents")
d = next((x for x in docs if x["code"] == code), docs[0] if docs else None)
if not d:
    sys.exit("库中没有文献：把 PDF 放入 assets/library/ 后重试")
print(f"   {d['code']} {d['title']} · {d['page_count']} 页 · 文字层={d['has_text_layer']} · 已 OCR {d['pages_done']} 页")

print("2) 页图")
pl = call(f"/library/documents/{d['id']}/pages?offset={pages[0] - 1}&limit=1")[0]
img = call(f"/library/pages/{pl['id']}/image", raw=True)
print(f"   p{pl['page_no']} 浏览页图 {len(img) // 1024} KB")

print(f"3) OCR 作业：engine={engine or '按文献体例'} pages={pages} backend={backend or '默认'}")
st = call("/library/ocr/status")
print("   workers:", [(w["engine"], w["available"], w["alive"]) for w in st["workers"]])
job = call(f"/library/documents/{d['id']}/ocr", "POST", {"engine": engine, "pages": pages, "redo": True, "backend": backend})
print("   started:", job["message"], "total", job["total"])
t0 = time.time()
while True:
    time.sleep(2)
    j = call("/library/ocr/status")["job"]
    print(f"\r   {j['done']}/{j['total']} err={j['errors']} {j['message']:<40}", end="", flush=True)
    if not j["running"]:
        break
print(f"\n   用时 {time.time() - t0:.0f}s")

print("4) 页详情")
for pn in pages:
    pd = call(f"/library/documents/{d['id']}/pages/{pn}")
    kinds = {}
    for s in pd["segments"]:
        kinds[s["kind"]] = kinds.get(s["kind"], 0) + 1
    print(f"   p{pn} status={pd['status']} engine={pd['engine']} segments={kinds} figures={len(pd['figures'])} stats={pd['stats']}")
    if pd["error"]:
        print("   error:", pd["error"][:300])
    for s in pd["segments"][:8]:
        print(f"     [{s['kind']:<11}] {s['text'][:60].replace(chr(10), ' ')}")
    for f in pd["figures"]:
        print(f"     [figure     ] {f['label']!r} {f['caption'][:50]!r} image={f['has_image']}")

print("5) 检索")
pd = call(f"/library/documents/{d['id']}/pages/{pages[0]}")
seg = next((s for s in pd["segments"] if len(s["text"]) >= 6 and s["kind"] in ("text", "title", "line")), None)
if seg:
    q = seg["text"][:4].strip()
    r = call(f"/library/search?q={urllib.request.quote(q)}&document_id={d['id']}")
    hits = r["hits"]
    print(f"   q={q!r} -> 共 {r['total']} 命中 · {len(r['facets'])} 本；首条：p{hits[0]['page_no']} {hits[0]['snippet'][:60]!r}" if hits else f"   q={q!r} -> 0 命中")
    allr = call(f"/library/search?q={urllib.request.quote(q)}&limit=3&offset=0")
    print(f"   全库：共 {allr['total']} 命中，本页 {len(allr['hits'])} 条，分面 {[(f['document_code'], f['count']) for f in allr['facets']]}")
    print("6) 校订与版本冲突")
    r = call(f"/library/segments/{seg['id']}", "PATCH", {"text_edit": seg["text"] + "（校）", "review_status": "reviewed", "base_revision": seg["revision"]})
    print(f"   revision {seg['revision']} -> {r['revision']}, review={r['review_status']}")
    c = call(f"/library/segments/{seg['id']}", "PATCH", {"text_edit": "x", "base_revision": seg["revision"]}, expect_error=True)
    print("   旧版本再保存 ->", c.get("__error__"), c.get("detail", "")[:30])
    call(f"/library/segments/{seg['id']}", "PATCH", {"text_edit": "", "review_status": "machine"})
print("完成")
