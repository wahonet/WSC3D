# -*- coding: utf-8 -*-
"""照片分割效果对照：整图 vs 切块 vs 预处理（同一张图、同一提示词），并测预处理图接口。

用法：python scripts/bench_photo_seg.py [--engine sam3|sam3.1] [--prompt person] [--asset ID]
默认取库中第一块石头的第一张局部照片（照片而非拓片，正是识别效果差的场景）。
"""
import argparse
import json
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8020/api"


def call(p, method="GET", body=None, timeout=900):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + p, method=method, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def wait_ready(engine, timeout_s=900):
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        st = call("/tools/segment/status")["engines"].get(engine, {})
        if st.get("status") == "ready":
            return True
        if st.get("status") == "error":
            print("  ERROR:", st.get("detail"))
            return False
        time.sleep(3)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default="sam3")
    ap.add_argument("--prompt", default="person")
    ap.add_argument("--asset", type=int, default=0)
    ap.add_argument("--threshold", type=float, default=0.1)
    a = ap.parse_args()

    if a.asset:
        asset_id = a.asset
    else:
        stone = call("/stones")[0]
        parts = [x for g in stone["groups"] if g["key"] == "photo_part" for x in g["assets"]]
        photos = [x for g in stone["groups"] if g["key"] == "photo" for x in g["assets"]]
        pick = (parts or photos)[0]
        asset_id = pick["id"]
        print(f"测试图: {pick['filename']} ({pick['width']}x{pick['height']})")

    print("预处理图接口:")
    for mode in ("enhance", "rubbing"):
        t0 = time.time()
        try:
            req = urllib.request.Request(f"{BASE}/assets/{asset_id}/preprocessed?mode={mode}")
            with urllib.request.urlopen(req, timeout=300) as r:
                n = len(r.read())
            print(f"  {mode:8} {n/1024:.0f} KB  {time.time()-t0:.1f}s")
        except urllib.error.HTTPError as e:
            print(f"  {mode:8} HTTP {e.code}: {e.read().decode('utf-8')[:120]}")

    print(f"加载 {a.engine} …")
    call(f"/tools/segment/load/{a.engine}", "POST")
    if not wait_ready(a.engine):
        return 1

    configs = [
        ("整图 · 原图", dict(preprocess="none", tiling="none")),
        ("整图 · 增强", dict(preprocess="enhance", tiling="none")),
        ("整图 · 仿拓片", dict(preprocess="rubbing", tiling="none")),
        ("切块2560 · 原图", dict(preprocess="none", tiling="preview")),
        ("切块2560 · 增强", dict(preprocess="enhance", tiling="preview")),
        ("切块2560 · 仿拓片", dict(preprocess="rubbing", tiling="preview")),
        ("切块5120 · 原图", dict(preprocess="none", tiling="hires")),
        ("切块5120 · 增强", dict(preprocess="enhance", tiling="hires")),
    ]
    print(f"\n提示词 '{a.prompt}'，阈值 {a.threshold}")
    print(f"{'配置':16} {'检出':>4} {'切块':>4} {'最高分':>6} {'最低分':>6} {'耗时':>6}")
    for name, cfg in configs:
        t0 = time.time()
        r = call("/tools/segment/text", "POST", {
            "asset_id": asset_id, "prompt": a.prompt, "engine": a.engine,
            "threshold": a.threshold, "max_results": 60, **cfg})
        dt = time.time() - t0
        if not r.get("ok"):
            print(f"{name:16} FAIL {r.get('error')}")
            continue
        d = r["detections"]
        hi = max((x["score"] for x in d), default=0)
        lo = min((x["score"] for x in d), default=0)
        print(f"{name:16} {len(d):>4} {r.get('tiles', 1):>4} {hi:>6.2f} {lo:>6.2f} {dt:>5.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
