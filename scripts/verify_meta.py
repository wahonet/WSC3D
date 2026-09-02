# -*- coding: utf-8 -*-
"""验证权威释文入库与简介接口输出。"""
import json
import pathlib
import urllib.request

BASE = "http://127.0.0.1:8020/api"

mp = pathlib.Path(__file__).resolve().parents[1] / "assets" / "stones" / "WS-003_武梁祠西壁" / "meta.json"
meta = json.loads(mp.read_text(encoding="utf-8"))
print("meta.json 可解析，层数:", len(meta["layers"]))

r = json.loads(urllib.request.urlopen(
    urllib.request.Request(BASE + "/scan", method="POST"), timeout=120).read())
print("scan:", {k: v for k, v in r.items() if k != "masters_assigned"})

s = json.loads(urllib.request.urlopen(BASE + "/stones", timeout=10).read())[0]
info = json.loads(urllib.request.urlopen(f"{BASE}/stones/{s['id']}", timeout=10).read())
print("接口层数:", len(info["layers"]))
for l in info["layers"]:
    print(f"  L{l['seq']} {l['name']}: {len(l['summary'])} 字 | {l['summary'][:24]}...")
print("description:", info["description"][:52], "...")
l3 = info["layers"][2]["summary"]
l2 = info["layers"][1]["summary"]
print("关键字核验: 驩 =", "令亲有驩" in l3, "| 杭纲 =", "杭纲" in l3,
      "| 神祇 =", "神祇" in l3, "| 昌□□（意之） =", "昌□□（意之）" in l2,
      "| 〔制〕〔衣〕 =", "〔制〕〔衣〕裳" in l2)
