# -*- coding: utf-8 -*-
"""验证手动切换主图（切走再切回，不留痕）。"""
import json
import urllib.request

BASE = "http://127.0.0.1:8020/api"


def call(p, method="GET", body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + p, method=method, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    return json.loads(urllib.request.urlopen(req, timeout=60).read().decode("utf-8"))


def masters():
    s = call("/stones")[0]
    return s, [(a["id"], a["filename"]) for g in s["groups"] for a in g["assets"]
               if (a.get("extra") or {}).get("is_master")]


s, m0 = masters()
print("当前主图:", m0)
photos = next(g for g in s["groups"] if g["key"] == "photo")["assets"]
other = next(a for a in photos if not (a.get("extra") or {}).get("is_master"))
orig_id = m0[0][0]

r = call(f"/stones/{s['id']}/master/{other['id']}", "POST")
print("切换到", other["filename"], "->", r["ok"], "|", r["message"])
_, m1 = masters()
print("切换后主图:", m1)

r2 = call(f"/stones/{s['id']}/master/{orig_id}", "POST")
print("切回原主图 ->", r2["ok"], "|", r2["message"])
_, m2 = masters()
print("最终主图:", m2)
assert len(m2) == 1 and m2[0][0] == orig_id, "主图未正确复原"
print("验证通过，主图唯一且已复原")
