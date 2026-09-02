# -*- coding: utf-8 -*-
"""统一对齐坐标系端到端验证（用后即清理测试数据）。

流程：扫描指派主图 -> 用一组合成同名点做 主图<->另一张 2D 图 对齐 ->
校验该图入链 -> 在主图上画一个矩形标注 -> 请求该图上的投影 ->
校验投影坐标与合成变换一致 -> 清理测试标注并复位坐标链。
"""
import json
import math
import pathlib
import sqlite3
import urllib.request

BASE = "http://127.0.0.1:8020/api"


def call(p, method="GET", body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + p, method=method, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    return json.loads(urllib.request.urlopen(req, timeout=300).read().decode("utf-8"))


print("1) 扫描（主图指派）")
r = call("/scan?warm=false", "POST")
print("   masters_assigned:", r.get("masters_assigned"))

st = call("/stones")[0]
two_d = [a for g in st["groups"] if g["key"] != "model" for a in g["assets"]]
master = next(a for a in two_d if (a.get("extra") or {}).get("is_master"))
# 选一张尚未入链的非主图 2D 资产作为右图
other = next(a for a in two_d if a["id"] != master["id"]
             and (a.get("extra") or {}).get("align_to_master") is None)
print(f"   主图: {master['filename']} ({master['width']}x{master['height']})")
print(f"   右图: {other['filename']} ({other['width']}x{other['height']})  已入链: "
      f"{(other.get('extra') or {}).get('align_to_master') is not None}")

# 2) 合成一组严格满足相似变换的同名点：T(右->左) s=2, theta=10deg, t=(300,150)
print("2) 合成对齐 主图(左) <- 右图(右)")
s, th = 2.0, math.radians(10.0)
tx, ty = 300.0, 150.0
c_, s_ = math.cos(th), math.sin(th)
pairsB = [(500, 600), (2500, 700), (2200, 4000), (700, 3800), (1500, 2200)]
pairs = []
for bx, by in pairsB:
    ax = s * (c_ * bx - s_ * by) + tx
    ay = s * (s_ * bx + c_ * by) + ty
    pairs.append({"a": [ax / master["width"], ay / master["height"]],
                  "b": [bx / other["width"], by / other["height"]]})
geom = {"target_asset_id": other["id"], "pairs": pairs,
        "s": s, "theta_deg": 10.0, "tx": tx, "ty": ty, "rmse_px": 0.0,
        "wl": master["width"], "hl": master["height"],
        "wr": other["width"], "hr": other["height"]}
rc = call("/align/commit", "POST", {"stone_id": st["id"], "left_asset_id": master["id"],
                                    "right_asset_id": other["id"], "geometry": geom})
align_anno_id = rc["annotation"]["id"]
print("   chain_updates:", rc["chain_updates"], "| warning:", rc.get("warning") or "-")

# 3) 主图上画一个矩形标注
print("3) 在主图上创建矩形标注 (0.4,0.4,0.1,0.05)")
anno = call("/annotations", "POST", {
    "stone_id": st["id"], "asset_id": master["id"], "tool": "annotate", "atype": "rect",
    "geometry": {"x": 0.4, "y": 0.4, "w": 0.1, "h": 0.05}, "label": "投影测试"})

# 4) 右图上取投影
print("4) 请求右图上的跨图投影")
pj = call(f"/assets/{other['id']}/projected")
items = pj.get("items", [])
print(f"   ok={pj['ok']} 投影条数={len(items)}")
target = next((i for i in items if i["id"] == anno["id"]), None)
ok_math = False
if target:
    pts = target["geometry"]["points"]
    # 独立验算第一个角点：主图norm -> 主图px -> T^{-1} -> 右图px -> norm
    axp, ayp = 0.4 * master["width"], 0.4 * master["height"]
    ux = (c_ * (axp - tx) + s_ * (ayp - ty)) / s
    uy = (-s_ * (axp - tx) + c_ * (ayp - ty)) / s
    exp = [ux / other["width"], uy / other["height"]]
    got = pts[0]
    err = math.hypot(got[0] - exp[0], got[1] - exp[1])
    ok_math = err < 1e-6
    print(f"   角点期望 {[round(v,4) for v in exp]} 实得 {[round(v,4) for v in got]}  误差 {err:.2e}")
    print("   投影数学:", "正确" if ok_math else "!! 偏差过大")
else:
    print("   !! 未找到投影条目")

# 5) 清理测试数据
print("5) 清理")
call(f"/annotations/{anno['id']}", "DELETE")
call(f"/annotations/{align_anno_id}", "DELETE")
db = pathlib.Path(__file__).resolve().parents[1] / "server" / "data" / "stonelab.db"
con = sqlite3.connect(db)
cur = con.execute("SELECT extra FROM assets WHERE id=?", (other["id"],))
extra = json.loads(cur.fetchone()[0] or "{}")
extra.pop("align_to_master", None)
con.execute("UPDATE assets SET extra=? WHERE id=?", (json.dumps(extra, ensure_ascii=False), other["id"]))
con.commit()
con.close()
print("   测试标注已删、右图坐标链已复位（正式对齐请在界面里做）")
print("完成" if ok_math else "完成（有失败项）")
raise SystemExit(0 if ok_math else 1)
