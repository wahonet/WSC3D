# -*- coding: utf-8 -*-
"""验证三个分割引擎（重点 sam3.1）都能经 API 真实出掩膜。"""
import json
import time
import urllib.request

BASE = "http://127.0.0.1:8020/api"


def call(p, method="GET", body=None, timeout=900):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + p, method=method, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def wait_ready(engine, timeout_s=600):
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        st = call("/tools/segment/status")["engines"].get(engine, {})
        if st.get("status") == "ready":
            print(f"  {engine} ready ({time.time()-t0:.0f}s) - {st.get('detail','')[:80]}")
            return True
        if st.get("status") == "error":
            print(f"  {engine} ERROR: {st.get('detail')}")
            return False
        time.sleep(3)
    return False


stone = call("/stones")[0]
part = next(a for g in stone["groups"] if g["key"] == "photo_part" for a in g["assets"])
print("测试图:", part["filename"])
print("权重:", {k: v["exists"] for k, v in call("/tools/segment/status")["weights"].items()})

print()
print("== sam3.1 文本分割 ==")
call("/tools/segment/load/sam3.1", "POST")
if wait_ready("sam3.1"):
    t0 = time.time()
    r = call("/tools/segment/text", "POST", {
        "asset_id": part["id"], "prompt": "person", "engine": "sam3.1",
        "threshold": 0.4, "max_results": 10})
    if r.get("ok"):
        d = r["detections"]
        print(f"  OK 检出 {len(d)} 个，scores={[round(x['score'],3) for x in d]}，耗时 {time.time()-t0:.1f}s")
    else:
        print("  FAIL:", r)

print()
print("== sam3 文本分割（对照） ==")
call("/tools/segment/load/sam3", "POST")
if wait_ready("sam3"):
    r = call("/tools/segment/text", "POST", {
        "asset_id": part["id"], "prompt": "person", "engine": "sam3",
        "threshold": 0.4, "max_results": 10})
    d = r.get("detections", [])
    print(f"  OK 检出 {len(d)} 个，scores={[round(x['score'],3) for x in d]}")

print()
print("== mobilesam 点选 ==")
call("/tools/segment/load/mobilesam", "POST")
if wait_ready("mobilesam"):
    r = call("/tools/segment/point", "POST", {
        "asset_id": part["id"], "points": [[0.5, 0.45]], "labels": [1]})
    print(f"  OK 多边形 {len(r.get('polygons',[]))} 个，score={r.get('score'):.3f}")

print()
print("完成")
