# -*- coding: utf-8 -*-
"""Restore cached MinerU OCR to physical pages, without model inference.

Default is a read-only preview. --apply creates a consistent SQLite backup,
then updates only completed MinerU pages with verified cached middle output.
Manual work is reconciled by content/position, never by shifted segment seq.
Run while the OCR queue is idle. Raw engine output is never changed.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
from app.config import settings
from app.db import SessionLocal
from app.models import Document, Page
from app.ocr_normalize import NORMALIZATION_VERSION, normalize_mineru_output
from app.services.library import _store_page


def assert_idle() -> None:
    try:
        with urllib.request.urlopen(f"http://{settings.host}:{settings.port}/api/library/ocr/status", timeout=5) as r:
            status = json.load(r)
        if status.get("job", {}).get("running"):
            raise RuntimeError("OCR 作业仍在运行，请待作业结束后修复缓存")
    except urllib.error.URLError as exc:
        # A stopped local backend is fine; unexpected HTTP failures are not.
        if isinstance(exc, urllib.error.HTTPError):
            raise RuntimeError("无法确认 OCR 作业状态") from exc


def build_plan(db) -> tuple[list, dict]:
    docs = {d.id: d for d in db.query(Document).all()}
    candidates = {}
    for path in settings.library_data_dir.glob("doc*/ocr/mineru/p*/**/*_middle.json"):
        rel = path.relative_to(settings.library_data_dir)
        doc_id = int(rel.parts[0][3:])
        match = re.fullmatch(r"p(\d+)-(\d+)", rel.parts[3])
        if doc_id not in docs or not match:
            continue
        start, end = map(int, match.groups())
        if start < 1 or end > docs[doc_id].page_count:
            continue
        for page_no in range(start, end + 1):
            candidates.setdefault((doc_id, page_no), []).append((path.stat().st_mtime, path, start, end))
    plan, missing, cache = [], [], {}
    per_doc = {}
    for page in db.query(Page).filter(Page.status == "done", Page.engine.like("mineru/%")).all():
        if (page.stats or {}).get("ocr_normalization", {}).get("normalization") == NORMALIZATION_VERSION:
            continue
        # A failed later attempt must not replace a successful page's original result.
        choices = [c for c in candidates.get((page.document_id, page.page_no), [])
                   if page.ocr_at is None or c[0] <= page.ocr_at.timestamp() + 2]
        if not choices:
            missing.append({"document": docs[page.document_id].code, "page": page.page_no})
            continue
        _, path, start, end = max(choices, key=lambda c: c[0])
        if path not in cache:
            cache[path] = normalize_mineru_output(json.loads(path.read_text(encoding="utf-8")),
                                                  list(range(start, end + 1)), path.parent, page.engine)
        res = dict(cache[path][str(page.page_no)])
        res["seconds"] = (page.stats or {}).get("seconds")
        res["engine"] = page.engine
        for figure in res["figures"]:
            if figure["image_path"] and not Path(figure["image_path"]).is_file():
                raise RuntimeError(f"原始插图缺失：{figure['image_path']}")
        deleted = res["extra"]["merged_away_blocks"]
        code = docs[page.document_id].code
        summary = per_doc.setdefault(code, {"pages": 0, "restored_blocks": 0, "restored_pages": []})
        summary["pages"] += 1
        summary["restored_blocks"] += deleted
        if deleted:
            summary["restored_pages"].append(page.page_no)
        plan.append((docs[page.document_id], page.page_no, res))
    report = {"normalization": NORMALIZATION_VERSION, "planned_pages": len(plan),
              "restored_blocks": sum(v["restored_blocks"] for v in per_doc.values()),
              "by_document": per_doc, "missing_cache": missing}
    return plan, report


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    assert_idle()
    with SessionLocal() as db:
        if db.query(Page).filter(Page.status == "running").count():
            raise RuntimeError("仍有运行中页面，暂不修复")
        plan, report = build_plan(db)
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
        if not args.apply or not plan:
            return
        assert_idle()
        repair_dir = settings.library_data_dir / "repairs" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        repair_dir.mkdir(parents=True)
        backup = repair_dir / "stonelab.before-physical-pages.db"
        with sqlite3.connect(str(settings.db_path)) as src, sqlite3.connect(str(backup)) as dst:
            src.backup(dst)
        report.update({"backup": str(backup), "applied_pages": 0, "retained_review": []})
        try:
            for document, page_no, res in plan:
                _store_page(db, document, page_no, res, "mineru")
                report["applied_pages"] += 1
                page = db.query(Page).filter_by(document_id=document.id, page_no=page_no).one()
                if (page.stats or {}).get("retained_review"):
                    report["retained_review"].append({"document": document.code, "page": page_no,
                                                       **page.stats["retained_review"]})
                if report["applied_pages"] % 100 == 0:
                    print(f"Restored {report['applied_pages']}/{len(plan)} pages", flush=True)
        finally:
            report["finished_at"] = datetime.now().isoformat(timespec="seconds")
            report_path = repair_dir / "report.json"
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"Backup: {backup}\nReport: {report_path}", flush=True)


if __name__ == "__main__":
    main()
