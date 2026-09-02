# -*- coding: utf-8 -*-
"""SAM 分割端到端验证：加载两个引擎并各跑一次真实推理。"""
import json
import time
import urllib.request

BASE = "http://127.0.0.1:8020/api"


def call(p: str, method: str = "GET", body: dict | None = None, timeout: float = 900):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + p, method=method, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def wait_ready(engine: str, timeout_s: int = 600) -> bool:
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        st = call("/tools/segment/status")["engines"].get(engine, {})
        if st.get("status") == "ready":
            print(f"  {engine} ready  ({time.time()-t0:.0f}s)")
            return True
        if st.get("status") == "error":
            print(f"  {engine} ERROR: {st.get('detail')}")
            return False
        time.sleep(3)
    print(f"  {engine} 超时")
    return False


# 找一张测试图：局部照片（伏羲女娲）
stone = call("/stones")[0]
part = next(a for g in stone["groups"] if g["key"] == "photo_part" for a in g["assets"])
full = next(a for g in stone["groups"] if g["key"] == "photo" for a in g["assets"] if "2025" in a["filename"])
print("测试图(点选):", part["filename"], "| 测试图(文本):", part["filename"])

print()
print("== 1. worker/权重状态 ==")
st = call("/tools/segment/status")
print("  worker:", st["worker"]["available"], "| python:", st["worker"]["python"])
for k, v in st["weights"].items():
    print(f"  {k}: exists={v['exists']} bytes={v['bytes']:,}")

print()
print("== 2. MobileSAM 点选分割 ==")
call("/tools/segment/load/mobilesam", "POST")
if wait_ready("mobilesam", 300):
    t0 = time.time()
    r = call("/tools/segment/point", "POST", {
        "asset_id": part["id"],
        "points": [[0.5, 0.45]],
        "labels": [1],
    })
    dt = time.time() - t0
    if r.get("ok"):
        n = len(r.get("polygons", []))
        pts = sum(len(p) for p in r.get("polygons", []))
        print(f"  OK 掩膜多边形 {n} 个 / 顶点 {pts}，score={r.get('score'):.3f}，耗时 {dt:.1f}s")
    else:
        print("  FAIL:", r)

print()
print("== 3. SAM3 文本概念分割（GPU，首次加载较久） ==")
call("/tools/segment/load/sam3", "POST")
if wait_ready("sam3", 900):
    st = call("/tools/segment/status")
    print("  设备:", st["worker"].get("gpu") or "cpu")
    t0 = time.time()
    r = call("/tools/segment/text", "POST", {
        "asset_id": part["id"], "prompt": "person", "threshold": 0.4, "max_results": 10,
    })
    dt = time.time() - t0
    if r.get("ok"):
        dets = r.get("detections", [])
        print(f"  OK prompt='person' 检出 {len(dets)} 个目标，耗时 {dt:.1f}s")
        for d in dets[:5]:
            print(f"     score={d['score']:.3f} 顶点数={len(d['polygon'])}")
    else:
        print("  FAIL:", r)

print()
print("完成")
