# -*- coding: utf-8 -*-
"""SQLite 轻量迁移：create_all 不会修改已存在的表，这里用 ALTER 为旧库补列。

每条规则：(表名, 列名, DDL)。幂等，可反复执行。
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
        conn.commit()
    if applied:
        log.info("migrated columns: %s", ", ".join(applied))
    return applied
