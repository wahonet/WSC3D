# -*- coding: utf-8 -*-
"""清空标注：删除全部结构节点与测量记录（及其概念挂接），保留对齐记录与坐标链。

用法：python scripts/reset_annotations.py [--all] [--yes]
    --all   连对齐记录也删除（坐标链仍保留在 assets.extra 中）
    --yes   不再交互确认
先停后端再运行更稳妥；运行前会自动把数据库备份到 server/data/stonelab.backup-<时间>.db。
"""
import shutil
import sqlite3
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "server" / "data" / "stonelab.db"
ALL = "--all" in sys.argv
YES = "--yes" in sys.argv

if not DB.exists():
    sys.exit(f"数据库不存在：{DB}")
con = sqlite3.connect(DB)
cur = con.cursor()
cond = "" if ALL else "WHERE tool != 'align'"
n = cur.execute(f"SELECT count(*) FROM annotations {cond}").fetchone()[0]
n_align = cur.execute("SELECT count(*) FROM annotations WHERE tool='align'").fetchone()[0]
print(f"将删除 {n} 条标注（{'含' if ALL else '不含'}对齐记录，对齐记录共 {n_align} 条）")
if n == 0:
    sys.exit("无需清空")
if not YES and input("确认？输入 yes 继续：").strip().lower() != "yes":
    sys.exit("已取消")

bak = DB.with_name(f"stonelab.backup-{time.strftime('%Y%m%d-%H%M%S')}.db")
shutil.copy2(DB, bak)
ids = [r[0] for r in cur.execute(f"SELECT id FROM annotations {cond}").fetchall()]
q = ",".join("?" * len(ids))
cur.execute(f"DELETE FROM annotation_concepts WHERE annotation_id IN ({q})", ids)
cur.execute(f"DELETE FROM annotations WHERE id IN ({q})", ids)
con.commit()
left = cur.execute("SELECT count(*) FROM annotations").fetchone()[0]
print(f"已删除 {len(ids)} 条，剩余 {left} 条；备份：{bak.name}")
