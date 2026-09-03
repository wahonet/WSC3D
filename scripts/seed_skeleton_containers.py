# -*- coding: utf-8 -*-
"""为一块石头创建结构骨架的"容器"部分：整石 / 花纹带 / 层 / 场景（不含人物与榜题，那些在界面里预览后创建）。
幂等：已存在同名节点的跳过。用法：python scripts/seed_skeleton_containers.py [石头编号，默认第一块]
"""
import json
import sys
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
BASE = "http://127.0.0.1:8020/api"


def call(p, method="GET", body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + p, method=method, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    return json.loads(urllib.request.urlopen(req, timeout=60).read().decode("utf-8"))


stones = call("/stones")
code = sys.argv[1] if len(sys.argv) > 1 else None
s = next((x for x in stones if x["code"] == code), stones[0]) if stones else None
if not s:
    sys.exit("库中没有石头")
prev = call(f"/stones/{s['id']}/structure/skeleton")
pick = [it for it in prev["items"] if it["level"] in ("whole", "band", "layer", "scene") and not it["exists"]]
if not pick:
    print(f"{s['name']}：容器节点已齐全，无需创建")
    sys.exit(0)
r = call(f"/stones/{s['id']}/structure/skeleton", "POST", {"items": pick, "asset_id": prev["asset_id"]})
print(f"{s['name']}：创建 {r['created']} 个容器节点，{r['linked']} 个已关联释文")
for a in r["annotations"]:
    print(f"   {a['level']:<6} {a['label']}{'  ?释文' if a['desc_text'] else ''}")
