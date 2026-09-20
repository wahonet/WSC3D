"""Isolated regression tests for source-bound graph candidates and explicit imports."""
from __future__ import annotations

from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_sandbox = tempfile.TemporaryDirectory(prefix="wsc-knowledge-tests-")
os.environ["STONELAB_DATA"] = str(Path(_sandbox.name) / "data")
os.environ["STONELAB_LIBRARY"] = str(Path(_sandbox.name) / "library")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/backend"))

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app.knowledge_graph_models import AnnotationKnowledgeLink, KnowledgeGraphBinding, KnowledgeGraphConcept
from app.models import Annotation, AnnotationConcept, Asset, Concept, Document, Page, Segment, Stone
from app.routers.knowledge_graph import router
from app.services import knowledge_graph as graph


class KnowledgeGraphTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, autoflush=False, expire_on_commit=False)
        self.db.execute(text("CREATE TABLE source_manifests(id TEXT PRIMARY KEY, payload TEXT NOT NULL)"))
        self.stone = Stone(id="武011", code="武011", name="测试西壁", dirname="test")
        self.other_stone = Stone(id="武010", code="武010", name="测试东壁", dirname="other")
        self.db.add_all([self.stone, self.other_stone]); self.db.flush()
        self.asset = Asset(stone_id=self.stone.id, kind="photo", filename="fixture.jpg", relpath="fixture.jpg", extra={"is_master": True})
        self.other_asset = Asset(stone_id=self.other_stone.id, kind="photo", filename="other.jpg", relpath="other.jpg")
        self.doc = Document(code="CORE", title="核心原书", collection="core", relpath="core.pdf", sha256="a" * 64, page_count=2)
        self.extension = Document(code="EXT", title="扩展资料", collection="extension", relpath="ext.pdf", sha256="b" * 64, page_count=1)
        self.db.add_all([self.asset, self.other_asset, self.doc, self.extension]); self.db.flush()
        self.pages = [Page(document_id=self.doc.id, page_no=i) for i in (1, 2)]
        self.db.add_all(self.pages); self.db.flush()
        self.segments = [Segment(document_id=self.doc.id, page_id=page.id, seq=0,
                         text=f"武011的故事{'甲' if i == 0 else '乙'}中，荆轲持匕首。人物身份及故事归属仍须核对原图。",
                         review_status="reviewed") for i, page in enumerate(self.pages)]
        self.db.add_all(self.segments); self.db.flush()
        self.legacy = Annotation(stone_id=self.stone.id, asset_id=self.asset.id, tool="annotate", atype="rect",
                      geometry={"x": .1, "y": .2, "w": .3, "h": .4}, label="故事甲", note="保留人工笔记", review_status="approved")
        self.db.add(self.legacy)
        self.db.execute(text("INSERT INTO source_manifests VALUES('core10-v1',:payload)"),
                        {"payload": json.dumps([{"id": self.doc.id, "sha256": self.doc.sha256}])})
        self.db.commit()
        self.data = {"schema_version": 1, "dataset_id": "test-core-v1", "documents": [{"document_id": self.doc.id, "title": self.doc.title, "total_pages": 2, "readable_pages": 2}],
                     "nodes": [{"id": "stone:w11", "kind": "stone", "label": "测试西壁", "stone_id": "武011"},
                               {"id": "story:a", "kind": "story", "label": "故事甲"}, {"id": "story:b", "kind": "story", "label": "故事乙"},
                               {"id": "person:jingke", "kind": "person", "label": "荆轲", "category_id": "cat-person-figure"},
                               {"id": "object:dagger", "kind": "object", "label": "匕首", "entity_scope": "object_type"}],
                     "edges": [{"id": "edge:wa", "source": "stone:w11", "target": "story:a", "relation": "depicts", "evidence_ids": ["e1"]},
                               {"id": "edge:wb", "source": "stone:w11", "target": "story:b", "relation": "depicts", "evidence_ids": ["e2"]},
                               {"id": "edge:ap", "source": "story:a", "target": "person:jingke", "relation": "has_character", "evidence_ids": ["e1"]},
                               {"id": "edge:bp", "source": "story:b", "target": "person:jingke", "relation": "has_character", "evidence_ids": ["e2"]},
                               {"id": "edge:ao", "source": "story:a", "target": "object:dagger", "relation": "has_object", "evidence_ids": ["e1"]}],
                     "evidence": [{"id": f"e{i + 1}", "document_id": self.doc.id, "document_title": self.doc.title,
                                   "document_identity": self.doc.reference_identity, "document_sha256": self.doc.sha256,
                                   "page_id": page.id, "page_no": page.page_no, "page_identity": page.reference_identity,
                                   "segment_id": segment.id, "source_identity": segment.reference_identity,
                                   "excerpt": segment.text, "review_status": segment.review_status}
                                  for i, (page, segment) in enumerate(zip(self.pages, self.segments))]}
        self.path = Path(_sandbox.name) / "graph.json"
        self.save()
        self.path_patch = patch.object(graph, "DATASET_PATH", self.path); self.path_patch.start()
        # Asset pinning has separate file-integrity tests; this suite never writes real asset snapshots.
        self.pin_patch = patch("app.services.resource_versions.pin_asset"); self.pin = self.pin_patch.start()
        app = FastAPI(); app.include_router(router, prefix="/api")
        app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close(); self.pin_patch.stop(); self.path_patch.stop(); self.db.close(); self.engine.dispose()

    def save(self):
        self.path.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")

    def create(self, items, asset_id=None):
        return self.client.post(f"/api/knowledge-graph/stones/{self.stone.id}/materialize",
                                json={"asset_id": asset_id or self.asset.id, "items": items})

    def test_graph_read_is_source_checked_and_never_writes_annotations_or_concepts(self):
        response = self.client.get("/api/knowledge-graph")
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["meta"]["counts"], {"stone": 1, "story": 2, "person": 1, "object": 1})
        self.assertTrue(all(e["source_available"] for e in data["evidence"]))
        self.assertTrue(all(n["status"] == "candidate" for n in data["nodes"]))
        self.assertTrue(all(e["status"] == "candidate" for e in data["edges"]))
        self.assertEqual(self.db.query(Annotation).count(), 1)
        self.assertEqual(self.db.query(Concept).count(), 0)
        self.assertEqual(self.db.query(KnowledgeGraphBinding).count(), 0)
        self.assertEqual(self.db.query(KnowledgeGraphConcept).count(), 0)

    def test_shared_person_has_distinct_story_occurrences_and_reusable_concept(self):
        response = self.create([{"node_id": "person:jingke", "story_id": "story:a"}, {"node_id": "person:jingke", "story_id": "story:b"}])
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json(); self.assertEqual(data["created"], 4)
        people = [node for node in data["annotations"] if node["label"] == "荆轲"]
        self.assertEqual(len(people), 2)
        self.assertNotEqual(people[0]["parent_id"], people[1]["parent_id"])
        self.assertEqual(people[0]["concept_ids"], people[1]["concept_ids"])
        self.assertEqual(len(people[0]["concept_ids"]), 1)
        for node in data["annotations"]:
            self.assertEqual(node["review_status"], "candidate")
            self.assertEqual(node["atype"], "none"); self.assertEqual(node["geometry"], {})
            self.assertTrue(node["references"])
            self.assertTrue(all(not r["source_missing"] for r in node["references"]))
        menu = self.client.get(f"/api/knowledge-graph/stones/{self.stone.id}/candidates").json()
        occurrences = [n for n in menu["entities"] if n["id"] == "person:jingke"]
        self.assertEqual({n["story_id"] for n in occurrences}, {"story:a", "story:b"})
        self.assertTrue(all(len(n["annotation_ids"]) == 1 for n in occurrences))

    def test_repeat_import_preserves_human_changes_and_same_named_legacy_node(self):
        before = (self.legacy.label, deepcopy(self.legacy.geometry), self.legacy.note, self.legacy.review_status)
        items = [{"node_id": "person:jingke", "story_id": "story:a"}]
        first = self.create(items).json()
        person_id = next(b["annotation_id"] for b in first["bindings"] if b["node_id"] == "person:jingke")
        person = self.db.get(Annotation, person_id)
        person.label, person.review_status, person.note = "人工已修名称", "approved", "人工新增说明"
        person.atype, person.geometry = "rect", {"x": .2, "y": .3, "w": .1, "h": .1}
        self.db.commit()
        second = self.create(items)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["created"], 0); self.assertEqual(second.json()["reused"], 2)
        self.assertEqual(person.label, "人工已修名称"); self.assertEqual(person.review_status, "approved")
        self.assertEqual(person.atype, "rect"); self.assertEqual(person.note, "人工新增说明")
        self.assertEqual(before, (self.legacy.label, self.legacy.geometry, self.legacy.note, self.legacy.review_status))
        self.assertEqual(self.db.query(Annotation).count(), 3)

    def test_shared_person_identity_survives_a_manual_concept_rename(self):
        first = self.create([{"node_id": "person:jingke", "story_id": "story:a"}]).json()
        person = next(n for n in first["annotations"] if n["label"] == "荆轲")
        concept = self.db.get(Concept, person["concept_ids"][0])
        concept.name = "人工核订人物名"; self.db.commit()
        second = self.create([{"node_id": "person:jingke", "story_id": "story:b"}])
        self.assertEqual(second.status_code, 200, second.text)
        next_person = next(n for n in second.json()["annotations"] if n["label"] == "荆轲")
        self.assertEqual(next_person["concept_ids"], [concept.id])
        graph_person = next(n for n in self.client.get("/api/knowledge-graph").json()["nodes"] if n["id"] == "person:jingke")
        self.assertEqual(graph_person["concept_id"], concept.id)

    def test_same_named_concept_in_another_category_is_preserved_and_not_reused(self):
        existing = Concept(name="荆轲", category_id="cat-story-other", description="已有故事概念")
        self.db.add(existing); self.db.commit()
        response = self.create([{"node_id": "person:jingke", "story_id": "story:a"}])
        self.assertEqual(response.status_code, 200, response.text)
        person = next(n for n in response.json()["annotations"] if n["label"] == "荆轲")
        created = self.db.get(Concept, person["concept_ids"][0])
        self.assertNotEqual(created.id, existing.id)
        self.assertEqual(created.category_id, "cat-person-figure")
        self.assertEqual(existing.description, "已有故事概念")

    def test_replaced_ocr_id_keeps_snapshot_but_blocks_import(self):
        self.segments[0].reference_identity = "replacement-identity"; self.db.commit()
        data = self.client.get("/api/knowledge-graph").json()
        evidence = next(e for e in data["evidence"] if e["id"] == "e1")
        self.assertFalse(evidence["source_available"]); self.assertEqual(evidence["source_status"], "changed")
        self.assertEqual(evidence["excerpt"], self.data["evidence"][0]["excerpt"])
        response = self.create([{"node_id": "person:jingke", "story_id": "story:a"}])
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.db.query(Annotation).count(), 1)

    def test_core_manifest_and_document_hash_are_required(self):
        self.doc.collection = "extension"; self.db.commit()
        evidence = self.client.get("/api/knowledge-graph").json()["evidence"]
        self.assertTrue(all(e["source_status"] == "excluded" for e in evidence))
        self.doc.collection = "core"; self.doc.sha256 = "changed"; self.db.commit()
        self.assertEqual(self.create([{"node_id": "story:a"}]).status_code, 409)

    def test_current_review_status_replaces_source_snapshot_status(self):
        self.segments[0].review_status = "machine"; self.db.commit()
        evidence = self.client.get("/api/knowledge-graph").json()["evidence"][0]
        self.assertEqual(evidence["review_status"], "machine")
        self.assertEqual(evidence["recorded_review_status"], "reviewed")
        self.assertTrue(evidence["source_available"])

    def test_missing_master_uses_an_available_photo_for_menu_and_default_import(self):
        self.asset.missing = True
        valid = Asset(stone_id=self.stone.id, kind="photo", filename="valid.jpg", relpath="valid.jpg")
        self.db.add(valid); self.db.commit()
        menu = self.client.get(f"/api/knowledge-graph/stones/{self.stone.id}/candidates").json()
        self.assertEqual(menu["asset_id"], valid.id)
        response = self.client.post(f"/api/knowledge-graph/stones/{self.stone.id}/materialize", json={"items": [{"node_id": "story:a"}]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["annotations"][0]["asset_id"], valid.id)

    def test_generic_story_roles_do_not_share_an_existing_global_person(self):
        self.db.add(Concept(name="荆轲", category_id="cat-person-figure")); self.db.commit()
        self.data["nodes"][3].update(entity_scope="story_role", context_story_id="story:a")
        self.save()
        response = self.create([{"node_id": "person:jingke", "story_id": "story:a"}])
        self.assertEqual(response.status_code, 200, response.text)
        person = next(n for n in response.json()["annotations"] if n["label"] == "荆轲")
        self.assertEqual(self.db.get(Concept, person["concept_ids"][0]).name, "荆轲（故事甲）")
        self.data["nodes"][3]["context_story_id"] = "story:missing"; self.save()
        self.assertEqual(self.client.get("/api/knowledge-graph").status_code, 503)

    def test_changed_excerpt_and_missing_source_identity_cannot_be_imported(self):
        self.data["evidence"][0]["excerpt"] = "并不存在的编造引文"
        del self.data["evidence"][1]["source_identity"]
        self.save()
        evidence = self.client.get("/api/knowledge-graph").json()["evidence"]
        self.assertEqual({e["source_status"] for e in evidence}, {"changed", "unverified"})
        self.assertEqual(self.create([{"node_id": "story:a"}]).status_code, 409)

    def test_wrong_stone_asset_and_invalid_selection_have_no_partial_writes(self):
        self.assertEqual(self.create([{"node_id": "story:a"}], self.other_asset.id).status_code, 422)
        self.assertEqual(self.create([{"node_id": "story:a"}, {"node_id": "person:not-a-candidate"}]).status_code, 422)
        self.assertEqual(self.create([{"node_id": "person:jingke", "story_id": "story:wrong"}]).status_code, 422)
        self.assertEqual(self.db.query(Annotation).count(), 1)
        self.assertEqual(self.db.query(Concept).count(), 0)
        self.assertEqual(self.db.query(KnowledgeGraphBinding).count(), 0)
        self.assertFalse(self.pin.called)

    def test_truncation_and_center_neighborhood_are_explicit_and_have_no_dangling_edges(self):
        data = self.client.get("/api/knowledge-graph?limit=2").json()
        self.assertEqual(data["meta"]["total_nodes"], 5)
        self.assertTrue(data["meta"]["truncated"])
        ids = {node["id"] for node in data["nodes"]}
        self.assertTrue(all(edge["source"] in ids and edge["target"] in ids for edge in data["edges"]))
        data = self.client.get("/api/knowledge-graph/nodes/person:jingke?limit=1").json()
        self.assertEqual(data["nodes"][0]["id"], "person:jingke")
        self.assertEqual(data["meta"]["total_nodes"], 3)

    def test_deleted_imported_annotation_is_recreated_without_touching_other_nodes(self):
        first = self.create([{"node_id": "story:a"}]).json()
        self.db.delete(self.db.get(Annotation, first["bindings"][0]["annotation_id"])); self.db.commit()
        second = self.create([{"node_id": "story:a"}])
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["created"], 1)
        self.assertEqual(self.db.query(KnowledgeGraphBinding).count(), 1)
        self.assertIsNotNone(self.db.get(Annotation, self.legacy.id))

    def test_untrusted_materialize_payload_cannot_set_review_or_geometry(self):
        response = self.client.post(f"/api/knowledge-graph/stones/{self.stone.id}/materialize",
                                    json={"items": [{"node_id": "story:a"}], "review_status": "approved", "geometry": {"x": 1}})
        self.assertEqual(response.status_code, 422)
        response = self.client.post(f"/api/knowledge-graph/stones/{self.stone.id}/materialize",
                                    json={"items": [{"node_id": "story:a"}]}, headers={"origin": "https://different.example"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.db.query(Annotation).count(), 1)

    def region(self):
        node = Annotation(stone_id=self.stone.id, asset_id=self.asset.id, tool='annotate', atype='polygon',
                          geometry={'points': [[.1, .1], [.2, .1], [.2, .3]]}, label='', note='保留分割来源', review_status='candidate')
        self.db.add(node); self.db.commit()
        return node

    def attach(self, node, **kwargs):
        return self.client.post(f'/api/knowledge-graph/stones/{self.stone.id}/attach', json={
            'annotation_id': node.id, 'node_id': 'person:jingke', 'story_id': 'story:a', 'evidence_ids': ['e1'], **kwargs})

    def test_attach_names_original_regions_without_merging_them_or_approving(self):
        first, second = self.region(), self.region()
        geometry = deepcopy(first.geometry)
        for node in (first, second):
            response = self.attach(node)
            self.assertEqual(response.status_code, 200, response.text)
            saved = response.json()['annotation']
            self.assertEqual(saved['id'], node.id)
            self.assertEqual(saved['geometry'], geometry)
            self.assertEqual(saved['review_status'], 'candidate')
            self.assertEqual(saved['note'], '保留分割来源')
            self.assertEqual(saved['label'], '荆轲')
            self.assertEqual([r['segment_id'] for r in saved['references']], [self.segments[0].id])
        self.assertEqual(first.parent_id, second.parent_id)
        self.assertEqual([c.concept_id for c in first.concept_links], [c.concept_id for c in second.concept_links])
        self.assertEqual(self.db.query(AnnotationKnowledgeLink).count(), 2)
        before = self.db.query(Annotation).count()
        repeat = self.attach(first)
        self.assertEqual(repeat.status_code, 200, repeat.text)
        self.assertEqual(len(repeat.json()['annotation']['references']), 1)
        self.assertEqual(self.db.query(Annotation).count(), before)
        self.assertEqual(self.legacy.review_status, 'approved')

    def test_attach_invalid_evidence_or_wrong_stone_rolls_back_parent_and_label(self):
        node = self.region()
        for payload in ({'evidence_ids': ['e2']}, {'annotation_id': 9999}, {'node_id': 'person:missing'}):
            response = self.attach(node, **payload)
            self.assertGreaterEqual(response.status_code, 400, response.text)
        with patch.object(graph.references, 'add_reference', side_effect=ValueError('reference storage failed')):
            with self.assertRaises(ValueError):
                graph.attach(self.db, self.stone.id, node.id, 'person:jingke', 'story:a', ['e1'])
        self.db.refresh(node)
        self.assertEqual(node.label, '')
        self.assertIsNone(node.parent_id)
        self.assertEqual(self.db.query(Annotation).count(), 2)
        self.assertEqual(self.db.query(Concept).count(), 0)
        self.assertEqual(self.db.query(AnnotationKnowledgeLink).count(), 0)

    def test_reassigning_references_removes_only_managed_sources(self):
        from app.schemas import AnnotationReferenceCreate
        node = self.region()
        manual = graph.references.add_reference(self.db, node, AnnotationReferenceCreate(kind='segment', segment_id=self.segments[1].id))
        self.db.commit()
        self.assertEqual(self.attach(node).status_code, 200)
        self.assertEqual(len(node.references), 2)
        response = self.attach(node, evidence_ids=[])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([r['id'] for r in response.json()['annotation']['references']], [manual.id])
        # Reassigning to a whole scene cannot leave it parented under that scene.
        response = self.attach(node, node_id='story:b', story_id=None, evidence_ids=['e2'])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(node.parent_id)
        self.assertEqual(len(node.references), 1)

    def test_manual_region_creation_defaults_to_candidate_but_measurements_do_not(self):
        from app.routers.annotations import _new
        from app.schemas import AnnotationCreate
        manual = _new(self.db, AnnotationCreate(stone_id=self.stone.id, asset_id=self.asset.id, tool='annotate',
                      atype='rect', geometry={'x': .1, 'y': .1, 'w': .2, 'h': .2}))
        self.assertEqual(manual.review_status, 'candidate')
        measured = _new(self.db, AnnotationCreate(stone_id=self.stone.id, asset_id=self.asset.id, tool='measure',
                        atype='line', geometry={'p1': [.1, .1], 'p2': [.2, .2]}))
        self.assertEqual(measured.review_status, 'reviewed')

    def test_all_subject_inventory_uses_positive_descriptions_and_stable_stone_ids(self):
        from app.services import stone_knowledge as sk
        self.stone.archive = {'intro': '第一层刻玉兔，第二层又刻玉兔。资料来源：书中对比凤鸟图。'}
        self.other_stone.archive = {'intro': '本石未见玉兔。下层刻凤鸟。'}
        with patch.object(graph, 'search_vocabulary', return_value=[]):
            for question in ['有多少画像石有玉兔的形象', '有多少带有玉兔形象的画像石', '哪些石头上刻着玉兔']:
                result = sk.inventory(question, [], [self.stone, self.other_stone])
                self.assertIsNotNone(result, question)
                self.assertEqual([s['id'] for s in result['items']], [self.stone.id], question)
                self.assertEqual(result['count'], 1)
            birds = sk.inventory('有多少画像石有凤鸟的形象', [], [self.stone, self.other_stone])
            self.assertEqual([s['id'] for s in birds['items']], [self.other_stone.id])
        self.stone.archive = {'intro': '下层有鸟。'}
        with patch.object(graph, 'search_vocabulary', return_value=[['鸟'], ['兔']]):
            birds = sk.inventory('有多少画像石有凤鸟的形象', [], [self.stone, self.other_stone])
            self.assertEqual(birds['topic'], '凤鸟')
            self.assertEqual([s['id'] for s in birds['items']], [self.other_stone.id])

    def test_scoped_book_chapters_reset_and_manifest_edits_invalidate_reading_map(self):
        from app.services import stone_knowledge as sk
        self.segments[0].kind, self.segments[0].text = 'title', '一、测试西壁画像'
        self.segments[1].kind, self.segments[1].text = 'text', '画像下层有凤鸟。'
        second_heading = Segment(document_id=self.doc.id, page_id=self.pages[1].id, seq=1, kind='title', text='二、未登记东壁画像')
        third = Segment(document_id=self.doc.id, page_id=self.pages[1].id, seq=2, text='这里另刻玉兔。')
        self.db.add_all([second_heading, third]); self.db.commit()
        index = sk.reading_index(self.db)
        self.assertIn(self.segments[1].id, index['links'][self.stone.id])
        self.assertNotIn(third.id, index['links'][self.stone.id])
        self.assertEqual(index['unresolved'][0]['segment_id'], second_heading.id)
        before = self.db.query(Annotation).count()
        self.db.execute(text("UPDATE source_manifests SET payload='[]' WHERE id='core10-v1'")); self.db.commit()
        self.assertEqual(sk.reading_index(self.db)['passages'], {})
        self.assertEqual(self.db.query(Annotation).count(), before)

    def test_ambiguous_short_stone_names_never_override_specific_unique_names(self):
        from app.services import stone_knowledge as sk
        registry = {'后壁': {'武001', '武002'}, '前石室后壁': {'武003'}, '左石室後壁'.replace('後', '后'): {'武004'}}
        self.assertEqual(sk.match_names('后壁的画像', registry), {})
        self.assertEqual(set(sk.match_names('前石室后壁与左石室後壁', registry)), {'武003', '武004'})

    def test_figure_captions_resolve_numeric_stone_names_and_own_following_text(self):
        from app.services import stone_knowledge as sk
        self.stone.name = '徐村画像第十一石'
        self.segments[0].kind, self.segments[0].text = 'title', '图12 徐村画像第11石'
        self.segments[1].text = '原石高一米。画面刻双鱼串璧。'
        self.db.commit()
        self.assertEqual(sk.normalize(self.stone.name), sk.normalize('徐村畫像第11石'))
        index = sk.reading_index(self.db)
        link = index['links'][self.stone.id][self.segments[1].id]
        self.assertEqual(link['method'], 'chapter')
        self.assertIn('第11石', link['heading'])


if __name__ == "__main__":
    unittest.main(verbosity=2)
