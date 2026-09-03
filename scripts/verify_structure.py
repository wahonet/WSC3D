# -*- coding: utf-8 -*-
"""结构树（阶段 1）端到端验证：
概念词表 / 骨架预览 / 建节点 + 释文关联 / 挂接几何 / 父级建议与自动归类 / 批量处置 / 候选并入 / 删除上挂。
用后自动清理本脚本创建的数据。用法：先启动后端，再 python scripts/verify_structure.py [--keep] [--preview-only]
"""
import json
import sys
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
BASE = "http://127.0.0.1:8020/api"
KEEP = "--keep" in sys.argv
PREVIEW_ONLY = "--preview-only" in sys.argv


def call(p, method="GET", body=None, expect_error=False):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + p, method=method, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=60).read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = json.loads(e.read().decode("utf-8")).get("detail", "")
        if expect_error:
            return {"__error__": e.code, "detail": detail}
        raise RuntimeError(f"{method} {p} -> {e.code}: {detail}")


s = call("/stones")[0]
sid = s["id"]
master = next(a for g in s["groups"] for a in g["assets"] if a.get("is_master"))
created: list[int] = []

print("1) 概念词表 / 分类骨架")
tax = call("/concepts/taxonomy")
concepts = call("/concepts")
print(f"   分类 {len(tax['categories'])} · 概念 {len(concepts)} · 层级 {list(tax['levels'])[:4]}…")

print("2) 骨架预览（从释文解析）")
prev = call(f"/stones/{sid}/structure/skeleton")
items = prev["items"]
by_level: dict[str, int] = {}
for it in items:
    by_level[it["level"]] = by_level.get(it["level"], 0) + 1
print(f"   共 {len(items)} 项：{by_level}；已存在 {sum(1 for i in items if i['exists'])} 项")
parent = {it["key"]: it for it in items}
for it in items:
    depth = 0
    k = it["parent_key"]
    while k:
        depth += 1
        k = parent[k]["parent_key"] if k in parent else None
    flag = " [已存在]" if it["exists"] else ""
    link = f" ?释文[{it['desc_start']},{it['desc_end']}]" if it.get("desc_start") is not None else ""
    tr = f" 录文:{it['transcription'][:14]}" if it.get("transcription") else ""
    print(f"   {'  ' * depth}{it['level']:<11} {it['label']}{flag}{link}{tr}")
if PREVIEW_ONLY:
    sys.exit(0)

print("3) 按预览建节点（只取 第 3 层 场景/榜题 与 整石/层 做测试）")
pick = [it for it in items if it["key"] == "W" or it["key"] == "L3"
        or (it["parent_key"] == "L3" and it["level"] == "scene")]
scene_keys = {it["key"] for it in pick if it["level"] == "scene"}
pick += [it for it in items if it["parent_key"] in scene_keys and it["level"] == "inscription"]
r = call(f"/stones/{sid}/structure/skeleton", "POST", {"items": pick, "asset_id": master["id"]})
created += [a["id"] for a in r["annotations"]]
print(f"   创建 {r['created']} · 释文关联 {r['linked']} · 跳过关联 {len(r['skipped_links'])}")
for a in r["annotations"]:
    print(f"   #{a['id']} {a['level']:<11} {a['label']:<22} parent={a['parent_id']} seq={a['seq']} "
          f"concepts={a['concept_ids']} linked={'是' if a['desc_text'] else '否'}")
layer3 = next(a for a in r["annotations"] if a["level"] == "layer")
scenes = [a for a in r["annotations"] if a["level"] == "scene"]
whole = next(a for a in r["annotations"] if a["level"] == "whole")

print("4) 给骨架节点挂接几何（PATCH geometry）")
a = call(f"/annotations/{layer3['id']}", "PATCH",
         {"asset_id": master["id"], "atype": "rect", "geometry": {"x": 0.05, "y": 0.42, "w": 0.9, "h": 0.14}})
print(f"   层节点 atype={a['atype']} asset={a['asset_id']}")
call(f"/annotations/{whole['id']}", "PATCH",
     {"asset_id": master["id"], "atype": "rect", "geometry": {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}})
for i, sc in enumerate(scenes):
    call(f"/annotations/{sc['id']}", "PATCH",
         {"asset_id": master["id"], "atype": "rect",
          "geometry": {"x": 0.05 + i * 0.225, "y": 0.43, "w": 0.22, "h": 0.12}})

print("5) 新建人物框 auto_parent -> 应挂到第 2 个场景并推断为 figure")
fig = call("/annotations", "POST", {
    "stone_id": sid, "asset_id": master["id"], "tool": "annotate", "atype": "rect",
    "geometry": {"x": 0.30, "y": 0.46, "w": 0.06, "h": 0.06}, "label": "测试人物", "auto_parent": True})
created.append(fig["id"])
print(f"   parent={fig['parent_id']} (期望 {scenes[1]['id']}) level={fig['level']}")
sug = call(f"/annotations/{fig['id']}/parent-suggestions")
print("   建议：", [(x["label"], x["ratio"]) for x in sug])

print("6) 机器候选：批量转正 / 语义 / 概念 / 并入")
cands = [x for x in call(f"/stones/{sid}/annotations") if x["review_status"] == "candidate"]
print(f"   现有候选 {len(cands)} 条")
cand = call("/annotations", "POST", {
    "stone_id": sid, "asset_id": master["id"], "tool": "segment", "atype": "polygon",
    "geometry": {"points": [[0.31, 0.47], [0.34, 0.47], [0.34, 0.5], [0.31, 0.5]]},
    "label": "sam:test", "note": "machine_proposal score=0.5", "review_status": "candidate"})
created.append(cand["id"])
ghost = call("/annotations", "POST", {
    "stone_id": sid, "asset_id": master["id"], "tool": "annotate", "atype": "none", "geometry": {},
    "label": "测试骨架人物", "level": "figure", "parent_id": scenes[1]["id"]})
created.append(ghost["id"])
cid = next(c["id"] for c in concepts if c["name"] == "曾参")
g2 = call(f"/annotations/{ghost['id']}", "PATCH", {
    "concept_ids": [cid], "category": "figure-filial-son",
    "semantics": {"pre_iconographic": "一人冠服拱手右向跪。", "iconographic": "曾参（曾母投杼故事）。"}})
print(f"   骨架节点 concepts={g2['concept_ids']} sem={g2['semantics']['iconographic']}")
adopted = call(f"/annotations/{ghost['id']}/adopt", "POST", {"source_id": cand["id"]})
created.remove(cand["id"])
print(f"   并入后 atype={adopted['atype']} review={adopted['review_status']} 来源已删:",
      call(f"/annotations/{cand['id']}", "PATCH", {"label": "x"}, expect_error=True).get("__error__"))
b = call("/annotations/batch", "PATCH", {"items": [{"id": fig["id"], "review_status": "approved", "level": "figure"}]})
print(f"   批量：{b[0]['label']} -> {b[0]['review_status']}")

print("7) 自动归类（只处理孤儿）")
orphan = call("/annotations", "POST", {
    "stone_id": sid, "asset_id": master["id"], "tool": "annotate", "atype": "rect",
    "geometry": {"x": 0.52, "y": 0.45, "w": 0.05, "h": 0.05}, "label": "孤儿测试"})
created.append(orphan["id"])
ap = call(f"/stones/{sid}/structure/auto-parent", "POST", {"ids": [orphan["id"]], "only_orphans": True})
print(f"   assigned={ap['assigned']} {ap['details']}")

print("8) 成环拒绝 / 删除上挂")
r = call(f"/annotations/{scenes[1]['id']}", "PATCH", {"parent_id": fig["id"]}, expect_error=True)
print("   期望 422 ->", r.get("__error__"), r.get("detail", "")[:30])
call(f"/annotations/{scenes[1]['id']}", "DELETE")
created.remove(scenes[1]["id"])
fig2 = next(x for x in call(f"/stones/{sid}/annotations") if x["id"] == fig["id"])
print(f"   删除场景后人物 parent={fig2['parent_id']} (期望层 {layer3['id']})")

if KEEP:
    print("保留测试数据（--keep）")
else:
    call("/annotations/batch-delete", "POST", {"ids": created})
    n = len(call(f"/stones/{sid}/annotations"))
    print(f"9) 清理完成，石头标注数 {n}")
print("完成")
