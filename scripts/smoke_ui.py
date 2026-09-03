# -*- coding: utf-8 -*-
"""前端冒烟测试：用本机 Edge 无头渲染各页面，统计关键 DOM 标记并可截图。

用法：
    python scripts/smoke_ui.py                 # 走后端托管的 web/dist（http://127.0.0.1:8020/）
    python scripts/smoke_ui.py --dev           # 走 Vite 开发服务器（http://127.0.0.1:5173/）
    python scripts/smoke_ui.py --shots out/    # 同时把截图写到 out/ 目录
需要后端已启动。深链形式：#a=<资产id>&p=align|segment|annotate|library
"""
import argparse
import pathlib
import re
import subprocess
import sys
import urllib.parse
import urllib.request

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
MARKERS = [
    ("vp-bar name", r'class="name"'),
    ("osd canvas", r"openseadragon-canvas"),
    ("three canvas", r'three-host"><canvas'),
    ("svg hit shapes", r'class="hit"'),
    ("anno cards", r'class="anno(\s|")'),
    ("loading-mask", r"loading-mask"),
    ("toast error", r'class="toast error"'),
    ("text card", r'class="rcard"'),
    ("leaf", r'class="leaf'),
    ("tree rows", r'class="tn(\s|")'),
    ("node detail", r'class="ndetail"'),
    ("pipeline nav", r'class="pl-btn'),
    ("layer rows", r'class="layer-row"'),
    ("align panes", r'class="align-pane'),
    ("shape tools", r'class="tool shape'),
    ("shelf docs", r'class="shelf-doc'),
    ("page grid", r'class="pg'),
    ("segment cards", r'class="segc'),
    ("figure cards", r'class="figc"'),
    ("search hits", r'<span class="pg mono">'),
    ("search groups", r'class="sres-doc"'),
    ("marks", r"<mark>"),
]


def edge() -> str:
    for p in EDGE_CANDIDATES:
        if pathlib.Path(p).exists():
            return p
    sys.exit("未找到 Edge 浏览器")


def render(url: str, shot: pathlib.Path | None) -> str:
    # --do-not-de-elevate：管理员权限的终端里 Edge 会自动降权重启成脱离的进程，导致拿不到输出
    args = [edge(), "--headless=new", "--no-first-run", "--hide-scrollbars", "--do-not-de-elevate",
            "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
            "--virtual-time-budget=15000", "--window-size=1680,1000"]
    if shot:
        subprocess.run(args + [f"--screenshot={shot}", url], capture_output=True, timeout=180)
    out = subprocess.run(args + ["--dump-dom", url], capture_output=True, timeout=180)
    return out.stdout.decode("utf-8", errors="replace")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dev", action="store_true", help="使用 Vite 开发服务器 5173")
    ap.add_argument("--shots", default="", help="截图输出目录")
    ap.add_argument("--only", default="", help="只跑这些用例（逗号分隔，如 books,search）")
    a = ap.parse_args()
    base = "http://127.0.0.1:5173/" if a.dev else "http://127.0.0.1:8020/"

    stones = urllib.request.urlopen("http://127.0.0.1:8020/api/stones", timeout=30).read()
    import json
    stones = json.loads(stones)
    if not stones:
        sys.exit("库中没有石头，先扫描素材")
    st = stones[0]
    two_d = [x for g in st["groups"] if g["key"] != "model" for x in g["assets"]]
    model = [x for g in st["groups"] if g["key"] == "model" for x in g["assets"]]
    master = next((x for x in two_d if x["is_master"]), two_d[0] if two_d else None)

    cases = {"home": ""}
    if master:
        cases["home-2d"] = f"#a={master['id']}"
        cases["align"] = f"#a={master['id']}&p=align"
        cases["segment"] = f"#a={master['id']}&p=segment"
        cases["annotate"] = f"#a={master['id']}&p=annotate"
        cases["library"] = f"#a={master['id']}&p=library"
        cases["books"] = f"#a={master['id']}&p=library&lib=books&doc=1&pg=16"
        cases["search"] = f"#a={master['id']}&p=library&lib=books&doc=1&pg=16&q={urllib.parse.quote('西王母')}"
    if model:
        cases["model-3d"] = f"#a={model[0]['id']}"

    if a.only:
        keep = {k.strip() for k in a.only.split(",") if k.strip()}
        cases = {k: v for k, v in cases.items() if k in keep}
    shots_dir = pathlib.Path(a.shots) if a.shots else None
    if shots_dir:
        shots_dir.mkdir(parents=True, exist_ok=True)

    failed = False
    for name, frag in cases.items():
        html = render(base + frag, (shots_dir / f"{name}.png").resolve() if shots_dir else None)
        print(f"== {name}  ({len(html)} chars)")
        if 'id="root"></div>' in html or len(html) < 2000:
            print("   !! React 未渲染")
            failed = True
        for label, pat in MARKERS:
            n = len(re.findall(pat, html))
            if n:
                print(f"   {label:16} {n}")
            if label == "toast error" and n:
                failed = True
        for t in re.findall(r'class="toast [a-z]+"[^>]*>.*?<span>(.*?)</span>', html, re.S):
            print("   TOAST:", re.sub(r"<[^>]+>", "", t)[:160])
    print("完成" if not failed else "完成（有失败项）")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
