# -*- coding: utf-8 -*-
"""SQLite 轻量迁移：create_all 不会修改已存在的表，这里用 ALTER 为旧库补列。

每条规则：(表名, 列名, DDL)。幂等，可反复执行。
补列之后运行少量数据迁移（DATA_FIXES），同样幂等。
"""
from __future__ import annotations

import logging

from sqlalchemy import Engine, text

log = logging.getLogger("stonelab.migrate")

RULES: list[tuple[str, str, str]] = [
    ("stones", "carving", "VARCHAR(128) DEFAULT ''"),
    ("annotations", "desc_start", "INTEGER"),
    ("annotations", "desc_end", "INTEGER"),
    ("annotations", "desc_text", "TEXT DEFAULT ''"),
    ("annotations", "desc_source", "VARCHAR(32) DEFAULT 'description'"),
    ("annotations", "updated_at", "DATETIME"),
    # 结构树（阶段 1）
    ("annotations", "parent_id", "INTEGER"),
    ("annotations", "level", "VARCHAR(16) DEFAULT ''"),
    ("annotations", "category", "VARCHAR(32) DEFAULT ''"),
    ("annotations", "seq", "INTEGER"),
    ("annotations", "review_status", "VARCHAR(16) DEFAULT 'reviewed'"),
    ("annotations", "quality", "VARCHAR(8) DEFAULT ''"),
    ("annotations", "geometry_intent", "VARCHAR(24) DEFAULT ''"),
    ("annotations", "semantics", "JSON"),
]

# (键, 说明, SQL)：每条只执行一次（记录在 schema_fixes 表），之后人工修改不会被重复覆盖
DATA_FIXES: list[tuple[str, str, str]] = [
    ("2026-09-structure-candidates", "历史机器候选标为 candidate",
     "UPDATE annotations SET review_status='candidate' "
     "WHERE tool='segment' AND note LIKE 'machine_proposal%' "
     "AND (desc_text IS NULL OR desc_text='')"),
]

# 无条件的空值兜底：只碰 NULL，重复执行无副作用
NULL_FIXES: list[str] = [
    "UPDATE annotations SET semantics='{}' WHERE semantics IS NULL",
    "UPDATE annotations SET review_status='reviewed' WHERE review_status IS NULL OR review_status=''",
    "UPDATE annotations SET level='' WHERE level IS NULL",
    "UPDATE annotations SET category='' WHERE category IS NULL",
    "UPDATE annotations SET quality='' WHERE quality IS NULL",
    "UPDATE annotations SET geometry_intent='' WHERE geometry_intent IS NULL",
]


def migrate(engine: Engine) -> list[str]:
    applied: list[str] = []
    with engine.connect() as conn:
        cols_cache: dict[str, set[str]] = {}
        for table, col, ddl in RULES:
            if table not in cols_cache:
                rows = conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
                cols_cache[table] = {r[1] for r in rows}
            if col in cols_cache[table]:
                continue
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}"))
            cols_cache[table].add(col)
            applied.append(f"{table}.{col}")

        conn.execute(text("CREATE TABLE IF NOT EXISTS schema_fixes (key VARCHAR(64) PRIMARY KEY, applied_at DATETIME)"))
        done = {r[0] for r in conn.execute(text("SELECT key FROM schema_fixes")).fetchall()}
        for key, desc, sql in DATA_FIXES:
            if key in done:
                continue
            n = conn.execute(text(sql)).rowcount
            conn.execute(text("INSERT INTO schema_fixes (key, applied_at) VALUES (:k, CURRENT_TIMESTAMP)"), {"k": key})
            applied.append(f"{desc} x{n}")
        for sql in NULL_FIXES:
            conn.execute(text(sql))
        conn.commit()
    if applied:
        log.info("migrated: %s", ", ".join(applied))
    return applied
