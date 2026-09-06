# -*- coding: utf-8 -*-
"""多来源节点引用的隔离回归测试；只使用临时 SQLite 和临时素材目录。"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

_temp = tempfile.TemporaryDirectory(prefix="stonelab-reference-tests-")
os.environ["STONELAB_DATA"] = str(Path(_temp.name) / "data")
os.environ["STONELAB_LIBRARY"] = str(Path(_temp.name) / "library")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app.config import settings
from app.migrations import migrate
from app.models import Annotation, AnnotationReference, Asset, Document, Figure, Layer, Page, Segment, Stone
from app.routers.annotations import router
from app.services import references, structure, textlinks
from app.services.library import _store_page
from app.services.serialize import annotation_out


def block(value: str, y: float = 0.1, seq: int = 0) -> dict:
    return {"seq": seq, "kind": "text", "text": value, "bbox": [0.1, y, 0.9, y + 0.1]}


class AnnotationReferenceTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        migrate(self.engine)
        self.db = Session(self.engine, autoflush=False, expire_on_commit=False)
        self.stone = Stone(code="TEST", name="测试石", dirname="test", description="甲段文字。乙段文字。丙段文字。")
        self.db.add(self.stone)
        self.db.flush()
        self.asset = Asset(stone_id=self.stone.id, kind="photo", filename="test.jpg", relpath="test.jpg")
        self.stone.layers.append(Layer(seq=1, name="第一层", summary="层甲释文。层乙释文。"))
        self.db.add(self.asset)
        self.db.flush()
        self.node = self.make_node("节点甲", note="保留用户自己的研究说明")
        self.other = self.make_node("节点乙")
        self.docs = [Document(code=f"DOC-{i}", title=f"第{i}本文献", relpath=f"book-{i}.pdf", page_count=1) for i in (1, 2)]
        self.db.add_all(self.docs)
        self.db.flush()
        self.pages = [Page(document_id=d.id, page_no=1) for d in self.docs]
        self.db.add_all(self.pages)
        self.db.commit()
        for i, d in enumerate(self.docs):
            _store_page(self.db, d, 1, {"blocks": [block(f"第{i + 1}本文献记载的画像石主体纹饰。")],
                                       "figures": [{"seq": 0, "bbox": [0.1, 0.5, 0.9, 0.9],
                                                    "caption": "", "label": ""}]}, "mineru")
        self.app = FastAPI()
        self.app.include_router(router, prefix="/api")
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.db.close()
        self.engine.dispose()

    def make_node(self, label, note=""):
        node = Annotation(stone_id=self.stone.id, asset_id=self.asset.id, tool="annotate", atype="rect",
                          geometry={"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}, label=label, note=note)
        self.db.add(node)
        self.db.flush()
        return node

    def add(self, body, node=None):
        node = node or self.node
        response = self.client.post(f"/api/annotations/{node.id}/references", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def desc(self, start=0, end=4, source="description", node=None):
        return self.add({"kind": "description", "desc_source": source, "desc_start": start, "desc_end": end}, node)

    def test_mixed_many_sources_dedup_and_independent_delete(self):
        self.desc()
        self.desc(5, 9)
        first = self.pages[0].segments[0]
        second = self.pages[1].segments[0]
        for s in (first, second):
            self.add({"kind": "segment", "segment_id": s.id, "text": "不能伪造的前端文字"})
        figure = self.pages[1].figures[0]
        figure.caption, figure.label = "原刊画像插图", "图2"
        self.db.commit()
        result = self.add({"kind": "figure", "figure_id": figure.id})
        self.assertEqual(len(result["references"]), 5)
        self.assertEqual(result["note"], "保留用户自己的研究说明")
        self.assertEqual({r["document_title"] for r in result["references"] if r["kind"] == "segment"}, {"第1本文献", "第2本文献"})
        self.assertEqual(result["references"][-1]["figure_label"], "图2")
        result = self.add({"kind": "segment", "segment_id": first.id})
        result = self.desc()
        self.assertEqual(len(result["references"]), 5)
        self.assertIn("文献记载", next(r["text"] for r in result["references"] if r["kind"] == "segment"))
        rid = next(r["id"] for r in result["references"] if r["segment_id"] == first.id)
        result = self.client.delete(f"/api/annotations/{self.node.id}/references/{rid}")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(len(result.json()["references"]), 4)
        self.assertIsNotNone(self.db.get(Segment, first.id))

    def test_same_ocr_source_can_be_shared_and_wrong_node_cannot_delete(self):
        sid = self.pages[0].segments[0].id
        one = self.add({"kind": "segment", "segment_id": sid})
        two = self.add({"kind": "segment", "segment_id": sid}, self.other)
        self.assertNotEqual(one["references"][0]["id"], two["references"][0]["id"])
        result = self.client.delete(f"/api/annotations/{self.other.id}/references/{one['references'][0]['id']}")
        self.assertEqual(result.status_code, 404)
        self.assertEqual(len(self.other.references), 1)

    def test_figure_reference_exposes_existing_crop_and_preserves_source_after_unlink(self):
        crop = settings.library_data_dir / "test-crop.png"
        crop.write_bytes(b"isolated path fixture")
        figure = self.pages[0].figures[0]
        figure.image_relpath = crop.name
        self.db.commit()
        result = self.add({"kind": "figure", "figure_id": figure.id})
        ref = result["references"][0]
        self.assertEqual(ref["image_url"], f"/api/library/figures/{figure.id}/image")
        self.assertFalse(ref["source_missing"])
        result = self.client.delete(f"/api/annotations/{self.node.id}/references/{ref['id']}")
        self.assertEqual(result.status_code, 200)
        self.assertTrue(crop.exists())
        self.assertIsNotNone(self.db.get(Figure, figure.id))

    def test_missing_source_rejected_and_deleted_source_keeps_snapshot(self):
        response = self.client.post(f"/api/annotations/{self.node.id}/references", json={"kind": "segment", "segment_id": 999999})
        self.assertEqual(response.status_code, 404)
        source = self.pages[0].segments[0]
        self.add({"kind": "segment", "segment_id": source.id})
        self.db.delete(self.docs[0])
        self.db.commit()
        self.db.expire_all()
        rows = self.client.get(f"/api/annotations/{self.node.id}/references").json()
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["source_missing"])
        self.assertIsNone(rows[0]["page_id"])
        self.assertEqual(rows[0]["document_title"], "第1本文献")
        self.assertIn("文献记载", rows[0]["text"])

    def test_deleted_document_reusing_all_numeric_ids_never_reattaches_old_references(self):
        doc, page = self.docs[1], self.pages[1]
        segment, figure = page.segments[0], page.figures[0]
        old_ids = doc.id, page.id, segment.id, figure.id
        metadata = {"code": doc.code, "title": doc.title, "relpath": doc.relpath, "page_count": 1}
        self.add({"kind": "segment", "segment_id": segment.id})
        self.add({"kind": "figure", "figure_id": figure.id})
        self.db.delete(doc)
        self.db.commit()
        self.db.expire_all()
        replacement = Document(**metadata)
        replacement_page = Page(page_no=1)
        replacement.pages.append(replacement_page)
        new_segment = Segment(document_id=old_ids[0], seq=0, text="同名文献里的另一段正文")
        new_figure = Figure(document_id=old_ids[0], seq=0, caption="新插图")
        replacement_page.segments.append(new_segment)
        replacement_page.figures.append(new_figure)
        self.db.add(replacement)
        self.db.commit()
        self.assertEqual((replacement.id, replacement_page.id, new_segment.id, new_figure.id), old_ids)
        rows = annotation_out(self.node).references
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(r.source_missing for r in rows))
        self.assertTrue(all(r.page_id is None and r.image_url is None for r in rows))
        self.assertTrue(all(r.page_no == 1 for r in rows))
        result = self.add({"kind": "segment", "segment_id": new_segment.id})
        self.assertEqual(len(result["references"]), 3)
        self.assertFalse(result["references"][-1]["source_missing"])
        self.assertEqual(result["references"][-1]["text"], "同名文献里的另一段正文")

    def test_deleted_items_reusing_ids_leave_original_page_navigable(self):
        page = self.pages[1]
        segment, figure = page.segments[0], page.figures[0]
        sid, fid = segment.id, figure.id
        self.add({"kind": "segment", "segment_id": sid})
        self.add({"kind": "figure", "figure_id": fid})
        self.db.delete(segment)
        self.db.delete(figure)
        self.db.commit()
        self.db.expire_all()
        new_segment = Segment(document_id=page.document_id, seq=0, text="新段落")
        new_figure = Figure(document_id=page.document_id, seq=0, caption="新图")
        page.segments.append(new_segment)
        page.figures.append(new_figure)
        self.db.commit()
        self.assertEqual((new_segment.id, new_figure.id), (sid, fid))
        rows = annotation_out(self.node).references
        self.assertTrue(all(r.source_missing for r in rows))
        self.assertTrue(all(r.page_id == page.id for r in rows))
        self.assertTrue(all(r.image_url is None for r in rows))

    def test_migration_fills_source_identities_once(self):
        # 旧 SQLite 表补列后的 NULL，仅在迁移时生成一次来源身份。
        for table in ("documents", "doc_pages", "segments", "figures"):
            self.db.execute(text(f"UPDATE {table} SET reference_identity=''"))
        self.db.commit()
        migrate(self.engine)
        before = {table: self.db.execute(text(f"SELECT id, reference_identity FROM {table} ORDER BY id")).all()
                  for table in ("documents", "doc_pages", "segments", "figures")}
        identities = [identity for rows in before.values() for _, identity in rows]
        self.assertTrue(all(len(identity) == 32 for identity in identities))
        self.assertEqual(len(identities), len(set(identities)))
        migrate(self.engine)
        after = {table: self.db.execute(text(f"SELECT id, reference_identity FROM {table} ORDER BY id")).all()
                 for table in before}
        self.assertEqual(before, after)

    def test_ocr_rerun_preserves_linked_unreviewed_segment_and_uncaptioned_figure(self):
        page = self.pages[0]
        sid, fid = page.segments[0].id, page.figures[0].id
        self.add({"kind": "segment", "segment_id": sid})
        self.add({"kind": "figure", "figure_id": fid})
        _store_page(self.db, self.docs[0], 1, {"blocks": [block("全新的内容，与原有机器段落不同。", 0.3)], "figures": []}, "mineru")
        self.db.expire_all()
        self.assertIsNotNone(self.db.get(Segment, sid))
        self.assertIsNotNone(self.db.get(Figure, fid))
        self.assertIn(sid, page.stats["retained_review"]["segment_ids"])
        self.assertIn(fid, page.stats["retained_review"]["figure_ids"])
        result = annotation_out(self.node)
        self.assertEqual(len(result.references), 2)
        self.assertTrue(all(not r.source_missing for r in result.references))

    def test_ocr_rerun_matching_sources_keeps_ids_and_reference_snapshot(self):
        source = self.pages[0].segments[0]
        sid = source.id
        self.add({"kind": "segment", "segment_id": sid})
        original = source.text
        _store_page(self.db, self.docs[0], 1, {"blocks": [block("页首新找回的一段文字", 0.0), block(original, 0.1, 1)]}, "mineru")
        self.db.expire_all()
        self.assertEqual(self.pages[0].segments[1].id, sid)
        self.assertEqual(annotation_out(self.node).references[0].text, original)

    def test_description_locks_all_intervals_and_relocates_multiple_sources(self):
        self.desc()
        self.desc(10, 14)
        self.desc(0, 4, "layer:1")
        self.desc(5, 9, node=self.other)
        response = self.client.post(f"/api/annotations/{self.node.id}/references",
                                    json={"kind": "description", "desc_start": 6, "desc_end": 9})
        self.assertEqual(response.status_code, 409)
        original = self.stone.description
        with self.assertRaises(HTTPException) as caught:
            textlinks.save_text_with_links(self.db, self.stone.id, "description", original.replace("丙段", "删去"),
                                            lambda value: setattr(self.stone, "description", value))
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.stone.description, original)
        textlinks.save_text_with_links(self.db, self.stone.id, "description", "前缀：" + original,
                                        lambda value: setattr(self.stone, "description", value))
        self.db.commit()
        description_refs = [r for r in self.node.references if r.desc_source == "description"]
        self.assertEqual([r.desc_start for r in description_refs], [3, 13])
        self.assertEqual(self.node.desc_start, 3)
        self.assertEqual(self.other.desc_start, 8)
        self.assertEqual(next(r.desc_start for r in self.node.references if r.desc_source == "layer:1"), 0)
        self.assertTrue(all(not r.source_missing for r in annotation_out(self.node).references))

    def test_legacy_patch_projects_first_and_clear_preserves_remaining_references(self):
        self.desc()
        self.desc(10, 14)
        self.add({"kind": "segment", "segment_id": self.pages[0].segments[0].id})
        patch = self.client.patch(f"/api/annotations/{self.node.id}",
                                  json={"desc_start": 5, "desc_end": 9, "desc_text": "乙段文字"})
        self.assertEqual(patch.status_code, 200, patch.text)
        self.assertEqual(patch.json()["desc_text"], "乙段文字")
        self.assertEqual(len(patch.json()["references"]), 3)
        clear = self.client.patch(f"/api/annotations/{self.node.id}", json={"clear_link": True})
        self.assertEqual(clear.status_code, 200, clear.text)
        self.assertEqual(clear.json()["desc_text"], "丙段文字")
        self.assertEqual(len(clear.json()["references"]), 2)
        self.assertEqual(clear.json()["note"], "保留用户自己的研究说明")

    def test_migration_keeps_legacy_fields_and_runs_once_without_resurrection(self):
        self.node.desc_source, self.node.desc_start, self.node.desc_end, self.node.desc_text = "description", 0, 4, "甲段文字"
        self.db.commit()
        # 模拟升级前的数据库：旧列存在、新表尚不存在。
        self.db.execute(text("DELETE FROM schema_fixes WHERE key='2026-09-annotation-references'"))
        self.db.execute(text("DROP TABLE annotation_references"))
        self.db.commit()
        migrate(self.engine)
        migrate(self.engine)
        self.db.expire_all()
        self.assertEqual(len(self.node.references), 1)
        self.assertEqual(self.node.references[0].text, "甲段文字")
        self.assertEqual(self.node.desc_text, "甲段文字")
        self.assertEqual(self.node.note, "保留用户自己的研究说明")
        references.remove_reference(self.db, self.node, self.node.references[0].id)
        self.db.commit()
        migrate(self.engine)
        self.db.expire_all()
        self.assertEqual(self.node.references, [])

    def test_adopt_preserves_both_nodes_references_and_deletion_cascades_only_owned_rows(self):
        self.desc()
        self.desc(5, 9, node=self.other)
        sid = self.pages[0].segments[0].id
        self.add({"kind": "segment", "segment_id": sid})
        self.add({"kind": "segment", "segment_id": sid}, self.other)
        self.add({"kind": "figure", "figure_id": self.pages[0].figures[0].id}, self.other)
        other_id = self.other.id
        structure.adopt_geometry(self.db, self.node, self.other)
        self.db.commit()
        self.db.expire_all()
        self.assertIsNone(self.db.get(Annotation, other_id))
        self.assertEqual(len(self.node.references), 4)
        self.assertEqual({r.annotation_id for r in self.node.references}, {self.node.id})
        self.assertEqual(self.node.note, "保留用户自己的研究说明")
        response = self.client.delete(f"/api/annotations/{self.node.id}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.db.query(AnnotationReference).count(), 0)
        self.assertIsNotNone(self.db.get(Segment, sid))


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        _temp.cleanup()
