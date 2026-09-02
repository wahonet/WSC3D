# ASCII only. Inspect polygon coordinates returned by segment APIs.
import json
import urllib.request

BASE = "http://127.0.0.1:8020/api"


def call(p, method="GET", body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + p, method=method, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    return json.loads(urllib.request.urlopen(req, timeout=600).read().decode("utf-8"))


stone = call("/stones")[0]
part = next(a for g in stone["groups"] if g["key"] == "photo_part" for a in g["assets"])
print("asset:", part["id"], part["filename"], part["width"], "x", part["height"])

r = call("/tools/segment/text", "POST", {
    "asset_id": part["id"], "prompt": "person", "engine": "sam3.1",
    "threshold": 0.4, "max_results": 5})
print("ok:", r.get("ok"), "| size field:", r.get("size"))
for i, d in enumerate(r.get("detections", [])):
    poly = d["polygon"]
    us = [p[0] for p in poly]
    vs = [p[1] for p in poly]
    print(f"  det{i}: score={d['score']:.3f} pts={len(poly)} "
          f"u=[{min(us):.3f},{max(us):.3f}] v=[{min(vs):.3f},{max(vs):.3f}]")

r2 = call("/tools/segment/point", "POST", {
    "asset_id": part["id"], "points": [[0.5, 0.45]], "labels": [1]})
print("point ok:", r2.get("ok"), "| size:", r2.get("size"))
for i, poly in enumerate(r2.get("polygons", [])):
    us = [p[0] for p in poly]
    vs = [p[1] for p in poly]
    print(f"  poly{i}: pts={len(poly)} u=[{min(us):.3f},{max(us):.3f}] v=[{min(vs):.3f},{max(vs):.3f}]")
