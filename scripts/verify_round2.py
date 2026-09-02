# -*- coding: utf-8 -*-
"""第二轮整改验证脚本（可重复运行）"""
import json
import pathlib
import urllib.request

BASE = "http://127.0.0.1:8020/api"


def call(p: str, method: str = "GET"):
    r = urllib.request.urlopen(urllib.request.Request(BASE + p, method=method))
    return json.loads(r.read().decode("utf-8"))


print("scan:", call("/scan", "POST"))
s = call("/stones")[0]
print()
print("分组结构:")
for g in s["groups"]:
    print(f"  [{g['label']}] {len(g['assets'])} 项")
    for a in g["assets"]:
        print(f"      {a['kind']:11} {a['filename']:26} {a['width']}x{a['height']}  {a['bytes']:,}")
print()

p2024 = [a for g in s["groups"] for a in g["assets"] if "2024" in a["filename"]][0]
ok = (p2024["width"], p2024["height"], p2024["bytes"]) == (5255, 6816, 215447844)
print(f"2024新文件入库: {p2024['width']}x{p2024['height']}  {p2024['bytes']:,}B  "
      f"{'与实际文件一致' if ok else '!! 不一致'}")

pv = pathlib.Path(__file__).resolve().parents[1] / "server" / "data" / "previews"
print("预览缓存文件数:", len(list(pv.glob("*.jpg"))), "（2024旧预览应已被作废删除）")
print()
print("load sam3.1:", call("/tools/segment/load/sam3.1", "POST"))
print("load sam3  :", call("/tools/segment/load/sam3", "POST"))
