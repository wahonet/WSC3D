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
    # 数字主键可能在删除后复用，研究引用需另外核对来源的持久身份。
    ("documents", "reference_identity", "VARCHAR(32)"),
    ("doc_pages", "reference_identity", "VARCHAR(32)"),
    ("segments", "reference_identity", "VARCHAR(32)"),
    ("figures", "reference_identity", "VARCHAR(32)"),
    ("annotation_references", "document_identity", "VARCHAR(32)"),
    ("annotation_references", "page_identity", "VARCHAR(32)"),
    ("annotation_references", "source_identity", "VARCHAR(32)"),
]

# (键, 说明, SQL)：每条只执行一次（记录在 schema_fixes 表），之后人工修改不会被重复覆盖
DATA_FIXES: list[tuple[str, str, str]] = [
    ("2026-09-structure-candidates", "历史机器候选标为 candidate",
     "UPDATE annotations SET review_status='candidate' "
     "WHERE tool='segment' AND note LIKE 'machine_proposal%' "
     "AND (desc_text IS NULL OR desc_text='')"),
    ("2026-09-annotation-references", "将既有单条释文关联迁移为引用",
     "INSERT INTO annotation_references "
     "(annotation_id, kind, desc_source, desc_start, desc_end, text, figure_label, created_at) "
     "SELECT a.id, 'description', COALESCE(a.desc_source, 'description'), a.desc_start, a.desc_end, "
     "a.desc_text, '', CURRENT_TIMESTAMP FROM annotations a "
     "WHERE a.desc_start IS NOT NULL AND a.desc_end IS NOT NULL AND COALESCE(a.desc_text, '') != '' "
     "AND NOT EXISTS (SELECT 1 FROM annotation_references r WHERE r.annotation_id=a.id "
     "AND r.kind='description' AND r.desc_source=COALESCE(a.desc_source, 'description') "
     "AND r.desc_start=a.desc_start AND r.desc_end=a.desc_end AND r.text=a.desc_text)"),
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
    # 除应用启动的 create_all 外，也支持单独调用迁移入口。
    from .models import AnnotationReference
    AnnotationReference.__table__.create(engine, checkfirst=True)
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

        # 文段全文检索（FTS5 trigram：两字以上子串即可命中；内容与 segments 表由服务代码同步）
        for table in ("documents", "doc_pages", "segments", "figures"):
            conn.execute(text(f"UPDATE {table} SET reference_identity=lower(hex(randomblob(16))) "
                              "WHERE reference_identity IS NULL OR reference_identity=''"))
        # 不用现存数字 ID 给历史引用补身份：来源可能早已删除且 ID 已复用。
        # 无身份的引用仍保留快照，序列化时标记来源不可验证。
        conn.execute(text(
            "CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5("
            "text, segment_id UNINDEXED, document_id UNINDEXED, page_no UNINDEXED, tokenize='trigram')"))
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
