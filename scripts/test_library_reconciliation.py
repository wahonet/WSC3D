# -*- coding: utf-8 -*-
"""OCR 重建的隔离回归测试；不访问项目资料库，也不启动 OCR 工作进程。"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path


_temp = tempfile.TemporaryDirectory(prefix="stonelab-ocr-reconcile-")
os.environ["STONELAB_DATA"] = str(Path(_temp.name) / "data")
os.environ["STONELAB_LIBRARY"] = str(Path(_temp.name) / "library")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.db import Base
from app.models import Document, Figure, Page, Segment
from app.services.library import _store_page, patch_segment


def block(seq: int, txt: str, y: float, kind: str = "text") -> dict:
    return {"seq": seq, "kind": kind, "text": txt, "bbox": [0.1, y, 0.9, y + 0.1]}


class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, expire_on_commit=False)
        self.db.execute(text("CREATE VIRTUAL TABLE segments_fts USING fts5(text, segment_id UNINDEXED, document_id UNINDEXED, page_no UNINDEXED)"))
        self.doc = Document(code="TEST", title="隔离测试", relpath="test.pdf", sha256="", bytes=1, page_count=1)
        self.db.add(self.doc)
        self.db.flush()
        self.page = Page(document_id=self.doc.id, page_no=1)
        self.db.add(self.page)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def store(self, blocks: list[dict], figures: list[dict] | None = None):
        _store_page(self.db, self.doc, 1, {"blocks": blocks, "figures": figures or [], "text": "ignored stale aggregate"}, "mineru")
        self.db.expire_all()
        return list(self.page.segments)

    def fts(self):
        return dict(self.db.execute(text("SELECT segment_id, text FROM segments_fts")).all())

    def test_inserting_first_block_preserves_identity_and_all_human_fields(self):
        old = self.store([block(0, "这一段有待人工校订的武梁祠文字。", 0.3), block(1, "下面这一段无需校订。", 0.6)])
        corrected_id, untouched_id = old[0].id, old[1].id
        patch_segment(self.db, old[0], "经过校订的第一段。", "caption", "reviewed", "核对原刊", 0)
        revision = old[0].revision
        rows = self.store([block(0, "此前漏识的页首正文。", 0.1), block(1, "这一段有待人工校订的武梁祠文字。", 0.3), block(2, "下面这一段无需校订。", 0.6)])
        self.assertEqual([s.id for s in rows[1:]], [corrected_id, untouched_id])
        self.assertNotIn(rows[0].id, [corrected_id, untouched_id])
        self.assertEqual(rows[0].text_edit, "")
        self.assertEqual((rows[1].text_edit, rows[1].kind, rows[1].review_status, rows[1].note, rows[1].revision),
                         ("经过校订的第一段。", "caption", "reviewed", "核对原刊", revision))
        self.assertEqual(self.fts()[corrected_id], "经过校订的第一段。")
        self.assertEqual(len(self.fts()), 3)
        self.assertTrue(self.page.text.startswith("此前漏识的页首正文。"))

    def test_review_and_type_changes_alone_increment_revision_and_survive(self):
        old = self.store([block(0, "这是一条实际属于图注的文字。", 0.3)])[0]
        sid = old.id
        patch_segment(self.db, old, None, "caption", "reviewed", None, 0)
        self.assertEqual(old.revision, 1)
        with self.assertRaises(HTTPException) as caught:
            patch_segment(self.db, old, "过期保存", None, None, None, 0)
        self.assertEqual(caught.exception.status_code, 409)
        rows = self.store([block(0, "这是一条实际属于图注的文字。", 0.3)])
        self.assertEqual((rows[0].id, rows[0].kind, rows[0].review_status, rows[0].revision), (sid, "caption", "reviewed", 1))

    def test_unmatched_human_work_is_retained_without_attaching_to_new_block(self):
        old = self.store([block(0, "已经仔细核校的重要原文。", 0.1), block(1, "应当淘汰的旧机器噪声。", 0.7)])
        keep, remove = old[0].id, old[1].id
        patch_segment(self.db, old[0], "人工校訂原文", None, "rejected", "先保留待查", 0)
        rows = self.store([block(0, "全新的版面块，与旧块内容和位置均不相同。", 0.4)])
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0].text_edit, "")
        self.assertEqual(rows[1].id, keep)
        self.assertEqual(rows[1].review_status, "rejected")
        self.assertIsNone(self.db.get(Segment, remove))
        self.assertEqual(self.page.stats["retained_review"]["segment_ids"], [keep])
        self.assertEqual(set(self.fts()), {s.id for s in rows})
        self.assertEqual(self.fts()[keep], "人工校訂原文")

    def test_cross_page_text_shrinks_without_losing_segment_identity(self):
        first = "这是本页真实段落，记载武梁祠画像的主体内容。"
        appended = "这是下一页被错误拼进来的延续，原来不应该在此处。"
        old = self.store([block(0, first + appended, 0.7)])[0]
        sid = old.id
        patch_segment(self.db, old, "校订本页段落", None, None, None, 0)
        rows = self.store([block(0, first, 0.7)])
        self.assertEqual((rows[0].id, rows[0].text, rows[0].text_edit), (sid, first, "校订本页段落"))

    def test_same_text_in_different_positions_keeps_correct_edits(self):
        old = self.store([block(0, "同一条重复引文。", 0.1), block(1, "同一条重复引文。", 0.6)])
        first, second = old[0].id, old[1].id
        patch_segment(self.db, old[1], "第二处的校订稿", None, None, None, 0)
        rows = self.store([block(0, "同一条重复引文。", 0.6), block(1, "同一条重复引文。", 0.1)])
        self.assertEqual([s.id for s in rows], [second, first])
        self.assertEqual([s.text_edit for s in rows], ["第二处的校订稿", ""])

    def test_figures_keep_identity_caption_and_crop_when_sequence_changes(self):
        source = Path(_temp.name) / "fixture.jpg"
        source.write_bytes(b"fixture for copy identity; image decode not part of this test")
        fg = {"seq": 0, "bbox": [0.2, 0.5, 0.8, 0.8], "caption": "机器图注", "label": "图一", "image_path": str(source)}
        self.store([], [fg])
        f = self.page.figures[0]
        fid, image = f.id, f.image_relpath
        f.caption, f.label, f.note, f.review_status = "人工改过图注", "图甲", "说明", "reviewed"
        self.db.commit()
        self.store([], [{"seq": 0, "bbox": [0.1, 0.1, 0.8, 0.3], "caption": "新增页首图"}, {**fg, "seq": 1}])
        found = next(f for f in self.page.figures if f.id == fid)
        self.assertEqual((found.caption, found.label, found.note, found.review_status, found.image_relpath),
                         ("人工改过图注", "图甲", "说明", "reviewed", image))
        self.store([], [])
        self.assertIsNotNone(self.db.get(Figure, fid))
        self.assertIn(fid, self.page.stats["retained_review"]["figure_ids"])

    def test_normalization_metadata_is_saved_with_original_duration(self):
        extra = {"normalization": "mineru-physical-pages-v1", "source": "middle.preproc_blocks", "physical_blocks": 2, "merged_away_blocks": 1}
        _store_page(self.db, self.doc, 1, {"blocks": [block(0, "恢复的本页正文。", 0.1)], "extra": extra, "seconds": 11.985}, "mineru")
        self.assertEqual(self.page.stats["ocr_normalization"], extra)
        self.assertEqual(self.page.stats["seconds"], 11.985)


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        _temp.cleanup()
