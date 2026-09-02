# -*- coding: utf-8 -*-
"""研究模块端到端验证：字段编辑 / 图文关联 / 重叠拒绝 / 简介锁定保护。"""
import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8020/api"


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
        raise RuntimeError(f"{e.code}: {detail}")


s = call("/stones")[0]
sid = s["id"]
master = next(a for g in s["groups"] for a in g["assets"] if (a.get("extra") or {}).get("is_master"))

print("1) 字段编辑（材质/刻法 数据修正）")
inf = call(f"/stones/{sid}", "PATCH", {"material": "石质", "carving": "减地平面线刻（凸面线刻）"})
print("   material:", inf["material"], "| carving:", inf["carving"])

print("2) 建测试标注并关联简介文字")
desc = inf["description"]
target = "卷云纹"
st = desc.find(target)
assert st >= 0
anno = call("/annotations", "POST", {
    "stone_id": sid, "asset_id": master["id"], "tool": "annotate", "atype": "rect",
    "geometry": {"x": 0.3, "y": 0.05, "w": 0.1, "h": 0.06}, "label": "研究测试"})
a2 = call(f"/annotations/{anno['id']}", "PATCH",
          {"desc_start": st, "desc_end": st + len(target), "desc_text": target})
print(f"   关联区间 [{a2['desc_start']},{a2['desc_end']}] = '{a2['desc_text']}' | note='{a2['note']}'")

print("3) 重叠拒绝")
anno2 = call("/annotations", "POST", {
    "stone_id": sid, "asset_id": master["id"], "tool": "annotate", "atype": "point",
    "geometry": {"p": [0.5, 0.5]}, "label": "重叠测试"})
r = call(f"/annotations/{anno2['id']}", "PATCH",
         {"desc_start": st + 1, "desc_end": st + 4, "desc_text": desc[st + 1:st + 4]},
         expect_error=True)
print("   预期409 ->", r.get("__error__"), "|", r.get("detail", "")[:40])

print("4) 简介保护：删除已关联文字应被拒绝")
bad_desc = desc.replace(target, "", 1)
r = call(f"/stones/{sid}", "PATCH", {"description": bad_desc}, expect_error=True)
print("   预期409 ->", r.get("__error__"), "|", r.get("detail", "")[:50])

print("5) 简介保护：改动其他部分应自动重定位偏移")
new_desc = "【测试前缀】" + desc
inf2 = call(f"/stones/{sid}", "PATCH", {"description": new_desc})
a3 = [x for x in call(f"/stones/{sid}/annotations") if x["id"] == anno["id"]][0]
ok = inf2["description"][a3["desc_start"]:a3["desc_end"]] == target
print(f"   新偏移 [{a3['desc_start']},{a3['desc_end']}] 指向 '{inf2['description'][a3['desc_start']:a3['desc_end']]}' ->",
      "正确" if ok else "!! 错误")

print("6) 取消关联 + 还原数据")
call(f"/annotations/{anno['id']}", "PATCH", {"clear_link": True})
call(f"/stones/{sid}", "PATCH", {"description": desc})
call(f"/annotations/{anno['id']}", "DELETE")
call(f"/annotations/{anno2['id']}", "DELETE")
inf3 = call(f"/stones/{sid}")
print("   简介已还原:", inf3["description"][:16], "| 标注数:", inf3["annotation_count"])
print("完成")
