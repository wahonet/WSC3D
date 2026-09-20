"""Versioned, source-checked core-book candidates and explicit annotation imports.

Reading the graph never seeds concepts, annotations, or references. A graph edge
is an interpretation candidate, even when its source paragraph was reviewed.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import threading

from fastapi import HTTPException
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from ..config import settings
from ..constants import PALETTE, TWO_D_KINDS
from ..knowledge import CATEGORY_IDS
from ..knowledge_graph_models import AnnotationKnowledgeLink, KnowledgeGraphBinding, KnowledgeGraphConcept
from ..models import Annotation, Asset, Concept, Document, Page, Segment, Stone
from ..schemas import AnnotationCreate, AnnotationReferenceCreate
from . import references
from .serialize import annotations_out

DATASET_PATH = settings.root / "config/knowledge-graph/core10-candidates.v1.json"
KINDS = ("stone", "story", "person", "object")
NOTICE = "核心十本文献整理的候选关系，尚待逐条核对原页和图像；共现与目录识别不等于已确认的图像归属。"
_import_lock = threading.RLock()


def _unique(values):
    return list(dict.fromkeys(values))


def _dataset(path: Path | None = None) -> dict:
    path = path or DATASET_PATH
    if not path.is_file():
        return {"schema_version": 1, "dataset_id": "core10-candidates-v1", "nodes": [], "edges": [], "evidence": [], "documents": [], "notice": "核心文献候选正在整理，暂未发布候选数据。"}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("schema_version") != 1 or not isinstance(data.get("dataset_id"), str) or not data["dataset_id"]:
            raise ValueError("候选数据版本或身份无效")
        for name in ("nodes", "edges", "evidence"):
            if not isinstance(data.get(name), list):
                raise ValueError(f"缺少候选集合：{name}")
            ids = [item.get("id") for item in data[name]]
            if any(not isinstance(i, str) or not i for i in ids) or len(ids) != len(set(ids)):
                raise ValueError(f"候选集合存在缺失或重复身份：{name}")
        node_ids = {n["id"] for n in data["nodes"]}
        story_ids = {n["id"] for n in data["nodes"] if n.get("kind") == "story"}
        evidence_ids = {e["id"] for e in data["evidence"]}
        for node in data["nodes"]:
            if node.get("kind") not in KINDS or not isinstance(node.get("label"), str) or not node["label"].strip():
                raise ValueError("候选节点种类或名称无效")
            if node.get("entity_scope") == "story_role" and node.get("context_story_id") not in story_ids:
                raise ValueError("泛称人物缺少有效的所属故事，不能合并为全局人物")
        for edge in data["edges"]:
            if edge.get("source") not in node_ids or edge.get("target") not in node_ids:
                raise ValueError("候选关系包含不存在的节点")
            if not edge.get("evidence_ids"):
                raise ValueError("候选关系缺少文献出处")
        for item in [*data["nodes"], *data["edges"]]:
            if any(eid not in evidence_ids for eid in item.get("evidence_ids", [])):
                raise ValueError("候选引用包含不存在的证据")
        return data
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(503, f"知识候选文件无法读取：{exc}") from exc


def search_vocabulary() -> list[list[str]]:
    """Candidate names are search terms, never proof of a depiction or a count."""
    return [[node['label'], *node.get('aliases', [])] for node in _dataset()['nodes']
            if node['kind'] != 'stone' and node.get('entity_scope') != 'story_role']


def _sources(db: Session, items: list[dict]) -> tuple[list[dict], int]:
    """Fail closed on replaced OCR IDs, changed text, or sources outside core10."""
    try:
        raw = db.execute(text("SELECT payload FROM source_manifests WHERE id='core10-v1'")).scalar()
        manifest = {int(item["id"]): item for item in json.loads(raw or "[]")}
    except Exception:
        manifest = {}
    def fetch(model, key):
        ids = {item.get(key) for item in items if isinstance(item.get(key), int)}
        return {item.id: item for item in db.query(model).filter(model.id.in_(ids)).all()} if ids else {}
    docs, pages, segments = fetch(Document, "document_id"), fetch(Page, "page_id"), fetch(Segment, "segment_id")
    result = []
    normalize = lambda value: re.sub(r"\s+", "", value or "")
    for original in items:
        item = deepcopy(original)
        doc, page, segment = docs.get(item.get("document_id")), pages.get(item.get("page_id")), segments.get(item.get("segment_id"))
        item["document_title"] = item.get("document_title") or (doc.title if doc else "来源文献暂不可用")
        expected = manifest.get(item.get("document_id"))
        state, notice = "available", "可回查核心文献原页；候选释读尚待核对"
        if not expected or (doc and (doc.collection != "core" or doc.sha256 != expected.get("sha256"))):
            state, notice = "excluded", "来源不属于当前核心十本文献原件"
        elif not doc or not page or not segment:
            state, notice = "missing", "原文段或物理页已不存在，保留历史摘录"
        elif not all(item.get(key) for key in ("document_identity", "page_identity", "source_identity", "document_sha256")):
            state, notice = "unverified", "缺少持久来源身份，需要重新核对出处"
        elif (doc.reference_identity != item["document_identity"] or page.reference_identity != item["page_identity"]
              or segment.reference_identity != item["source_identity"] or doc.sha256 != item["document_sha256"]
              or page.document_id != doc.id or page.page_no != item.get("page_no")
              or segment.document_id != doc.id or segment.page_id != page.id):
            state, notice = "changed", "来源身份或页码已变化，不能沿用旧文段定位"
        elif segment.review_status == "rejected" or not normalize(item.get("excerpt")) or normalize(item["excerpt"]) not in normalize(segment.display_text):
            state, notice = "changed", "文段已被否决或摘录与当前文本不符，需要重新核对"
        item.update(source_available=state == "available", source_status=state, source_notice=notice)
        if segment:
            item["recorded_review_status"] = item.get("review_status")
            item["review_status"] = segment.review_status
            item["current_review_status"] = segment.review_status
        result.append(item)
    return result, len(manifest)


def _snapshot(db: Session, path: Path | None = None) -> dict:
    data = _dataset(path)
    evidence, core_count = _sources(db, data["evidence"])
    by_evidence = {item["id"]: item for item in evidence}
    concepts = db.query(Concept).all()
    by_concept = {concept.id: concept for concept in concepts}
    # The standalone migration validator also works before the first server startup.
    identities = db.query(KnowledgeGraphConcept).filter(KnowledgeGraphConcept.dataset_id == data["dataset_id"]).all() if inspect(db.connection()).has_table(KnowledgeGraphConcept.__tablename__) else []
    known_concepts = {item.node_id: by_concept[item.concept_id] for item in identities if item.concept_id in by_concept}
    labels = {node["id"]: node["label"] for node in data["nodes"]}
    def concept_name(node):
        label = node["label"]
        if node.get("entity_scope") == "story_role":
            label += "（" + labels.get(node.get("context_story_id"), node.get("context_story_id") or "待核故事角色") + "）"
        if len(label) > 128:
            label = label[:115] + "·" + hashlib.sha256(node["id"].encode()).hexdigest()[:10]
        return label
    def concept_for(node):
        if node["id"] in known_concepts:
            return known_concepts[node["id"]]
        names = {concept_name(node)} if node.get("entity_scope") == "story_role" else {node["label"], *node.get("aliases", [])}
        matches = [c for c in concepts if c.name in names or names.intersection(c.aliases or [])]
        exact = [c for c in matches if c.name == concept_name(node)]
        matches = exact or matches
        if node.get("category_id"):
            matches = [c for c in matches if c.category_id == node["category_id"]]
        return matches[0] if len(matches) == 1 else None
    nodes = []
    for raw in data["nodes"]:
        node = {**raw, "status": "candidate", "aliases": raw.get("aliases", []), "description": raw.get("description", "")}
        eids = _unique([*raw.get("evidence_ids", []), *(eid for edge in data["edges"] if node["id"] in (edge["source"], edge["target"]) for eid in edge["evidence_ids"])])
        concept = concept_for(node) if node["kind"] != "stone" else None
        node.update(evidence_ids=eids, source_count=len(eids), source_available=any(by_evidence[eid]["source_available"] for eid in eids), concept_id=concept.id if concept else None)
        node["category_id"] = node.get("category_id") or (concept.category_id if concept else "")
        node["concept_name"] = concept_name(node)
        nodes.append(node)
    edges = [{**edge, "status": "candidate", "label": edge.get("label") or edge.get("relation", "候选关联"), "note": edge.get("note", ""),
              "source_available": any(by_evidence[eid]["source_available"] for eid in edge["evidence_ids"])} for edge in data["edges"]]
    return {"meta": {"dataset_id": data["dataset_id"], "schema_version": 1, "status": "candidate", "notice": data.get("notice") or NOTICE,
                     "core_documents": core_count, "evidence_total": len(evidence), "evidence_available": sum(e["source_available"] for e in evidence),
                     "generated_at": data.get("generated_at"), "counts": {kind: sum(n["kind"] == kind for n in nodes) for kind in KINDS}},
            "nodes": nodes, "edges": edges, "evidence": evidence, "documents": data.get("documents", [])}


def _stone_neighborhood(data: dict, stone_id: str) -> set[str]:
    nodes = {n["id"]: n for n in data["nodes"]}
    roots = {n["id"] for n in nodes.values() if n["kind"] == "stone" and n.get("stone_id", n["id"].removeprefix("stone:")) == stone_id}
    selected = set(roots)
    for edge in data["edges"]:
        if edge["source"] in roots or edge["target"] in roots:
            selected.update((edge["source"], edge["target"]))
    stories = {nid for nid in selected if nodes[nid]["kind"] == "story"}
    for edge in data["edges"]:
        if edge["source"] in stories and nodes[edge["target"]]["kind"] in ("person", "object"):
            selected.add(edge["target"])
        if edge["target"] in stories and nodes[edge["source"]]["kind"] in ("person", "object"):
            selected.add(edge["source"])
    return selected


def graph(db: Session, *, stone_id: str | None = None, q: str = "", kind: str | None = None,
          node_id: str | None = None, limit: int = 1000, path: Path | None = None) -> dict:
    data = _snapshot(db, path)
    if stone_id and db.get(Stone, stone_id) is None:
        raise HTTPException(404, "文物不存在")
    selected = _stone_neighborhood(data, stone_id) if stone_id else {n["id"] for n in data["nodes"]}
    if node_id:
        if node_id not in {n["id"] for n in data["nodes"]}:
            raise HTTPException(404, "知识候选不存在")
        neighbors = {node_id}
        for edge in data["edges"]:
            if node_id in (edge["source"], edge["target"]):
                neighbors.update((edge["source"], edge["target"]))
        selected &= neighbors
    if q or kind:
        selected &= {n["id"] for n in data["nodes"] if (not kind or n["kind"] == kind)
                     and (not q or q.casefold() in " ".join([n["label"], *n["aliases"]]).casefold())}
    nodes = [n for n in data["nodes"] if n["id"] in selected]
    # Keep the selected center even in a high-degree neighborhood truncated by limit.
    nodes.sort(key=lambda n: (n["id"] != node_id, KINDS.index(n["kind"]), n["label"], n["id"]))
    all_edges = [e for e in data["edges"] if e["source"] in selected and e["target"] in selected]
    visible = nodes[:limit]
    visible_ids = {n["id"] for n in visible}
    edges = [e for e in all_edges if e["source"] in visible_ids and e["target"] in visible_ids]
    eids = {eid for item in [*visible, *edges] for eid in item["evidence_ids"]}
    data.update(nodes=visible, edges=edges, evidence=[e for e in data["evidence"] if e["id"] in eids])
    data["meta"].update(total_nodes=len(nodes), total_edges=len(all_edges), returned_nodes=len(visible), returned_edges=len(edges), truncated=len(visible) < len(nodes))
    if node_id:
        data["center_id"] = node_id
    return data


def _occurrences(data: dict, stone_id: str) -> list[dict]:
    nodes = {n["id"]: n for n in data["nodes"]}
    roots = {n["id"] for n in nodes.values() if n["kind"] == "stone" and n.get("stone_id", n["id"].removeprefix("stone:")) == stone_id}
    direct = []
    for edge in data["edges"]:
        other = edge["target"] if edge["source"] in roots else edge["source"] if edge["target"] in roots else None
        if other and nodes[other]["kind"] != "stone":
            direct.append((nodes[other], edge))
    items = {}
    def add(node, story_id, edges):
        key = (node["id"], story_id or "")
        eids = _unique(eid for edge in edges for eid in edge["evidence_ids"])
        available = all(edge["source_available"] for edge in edges)
        if key in items:
            items[key]["evidence_ids"] = _unique([*items[key]["evidence_ids"], *eids])
            items[key]["source_available"] |= available
        else:
            items[key] = {**node, "story_id": story_id, "story_label": nodes[story_id]["label"] if story_id else None,
                          "evidence_ids": eids, "source_available": available, "annotation_ids": []}
    for node, edge in direct:
        add(node, None, [edge])
        if node["kind"] == "story":
            for relation in data["edges"]:
                other = relation["target"] if relation["source"] == node["id"] else relation["source"] if relation["target"] == node["id"] else None
                if other and nodes[other]["kind"] in ("person", "object"):
                    add(nodes[other], node["id"], [edge, relation])
    for item in items.values():
        item["source_count"] = len(item["evidence_ids"])
    return list(items.values())


def _default_asset(db: Session, stone_id: str) -> Asset | None:
    """Prefer an available master; migrated archives may retain missing assets."""
    assets = db.query(Asset).filter(Asset.stone_id == stone_id, Asset.kind.in_(TWO_D_KINDS), Asset.missing.is_(False)).order_by(Asset.id).all()
    return next((asset for asset in assets if asset.is_master), assets[0] if assets else None)


def stone_candidates(db: Session, stone_id: str, *, path: Path | None = None) -> dict:
    stone = db.get(Stone, stone_id)
    if stone is None:
        raise HTTPException(404, "文物不存在")
    data = _snapshot(db, path)
    items = _occurrences(data, stone_id)
    bindings = db.query(KnowledgeGraphBinding).join(Annotation, Annotation.id == KnowledgeGraphBinding.annotation_id).filter(
        KnowledgeGraphBinding.dataset_id == data["meta"]["dataset_id"], KnowledgeGraphBinding.stone_id == stone_id,
        Annotation.stone_id == stone_id).all()
    for item in items:
        item["annotation_ids"] = [b.annotation_id for b in bindings if b.node_id == item["id"] and b.story_id == (item["story_id"] or "")]
    asset = _default_asset(db, stone_id)
    eids = {eid for item in items for eid in item["evidence_ids"]}
    result = {"stone_id": stone_id, "stone_name": stone.name, "dataset_id": data["meta"]["dataset_id"], "asset_id": asset.id if asset else None,
            "stories": [n for n in items if n["kind"] == "story"], "entities": [n for n in items if n["kind"] in ("person", "object")],
            "evidence": [e for e in data["evidence"] if e["id"] in eids], "notice": data["meta"]["notice"]}
    if path is None:
        from .stone_knowledge import enrich_candidates
        result = enrich_candidates(db, result)
    if inspect(db.connection()).has_table(AnnotationKnowledgeLink.__tablename__):
        links = db.query(AnnotationKnowledgeLink).filter(AnnotationKnowledgeLink.stone_id == stone_id,
                AnnotationKnowledgeLink.dataset_id == result['dataset_id']).all()
        for item in [*result['stories'], *result['entities']]:
            item['annotation_ids'] = _unique([*item['annotation_ids'], *[link.annotation_id for link in links
                if link.node_id == item['id'] and link.story_id == (item.get('story_id') or '')],
                *[b.annotation_id for b in bindings if b.node_id == item['id'] and b.story_id == (item.get('story_id') or '')]])
    return result


def candidates(db: Session, *, kind: str | None = None, stone_id: str | None = None, story_id: str | None = None, q: str = "", limit: int = 60) -> dict:
    if stone_id:
        result = stone_candidates(db, stone_id)
        items = [*result["stories"], *result["entities"]]
    else:
        result = graph(db, node_id=story_id, limit=3000)
        items = [n for n in result["nodes"] if n["kind"] != "stone"]
    items = [n for n in items if (not kind or n["kind"] == kind) and (not story_id or not stone_id or n.get("story_id") == story_id or n["id"] == story_id)
             and (not q or q.casefold() in " ".join([n["label"], *n["aliases"]]).casefold())]
    return {"items": items[:limit], "total": len(items), "truncated": len(items) > limit, "evidence": result["evidence"]}


def _candidate_concept(db: Session, dataset_id: str, candidate: dict) -> Concept:
    identity = db.query(KnowledgeGraphConcept).filter(KnowledgeGraphConcept.dataset_id == dataset_id, KnowledgeGraphConcept.node_id == candidate["id"]).first()
    concept = db.get(Concept, identity.concept_id) if identity and identity.concept_id else None
    concept = concept or (db.get(Concept, candidate["concept_id"]) if candidate.get("concept_id") else None)
    if concept is None:
        # Explicit import may add a reusable candidate term, but never edits an existing term.
        name = candidate["concept_name"]
        category = candidate.get("category_id") or {"story": "cat-story-other", "person": "cat-person-figure", "object": "cat-artifact-other"}[candidate["kind"]]
        concept = db.query(Concept).filter(Concept.name == name).first()
        if concept and candidate.get("category_id") and concept.category_id != candidate["category_id"]:
            # An identically named term in a different taxonomy is not the same entity.
            suffix = "（" + {"story": "故事", "person": "人物", "object": "物品"}[candidate["kind"]] + "候选）"
            name = name[:128 - len(suffix)] + suffix
            concept = db.query(Concept).filter(Concept.name == name).first()
            if concept and concept.category_id != category:
                raise HTTPException(409, "候选名称与现有概念分类冲突，请先核对概念身份")
        if concept is None:
            concept = Concept(name=name, category_id=category if category in CATEGORY_IDS else "", aliases=[],
                              description="核心文献知识图谱候选词，释读待核。" + (candidate.get("description") or ""))
            db.add(concept); db.flush()
    if identity is None:
        db.add(KnowledgeGraphConcept(dataset_id=dataset_id, node_id=candidate["id"], concept_id=concept.id))
    else:
        identity.concept_id = concept.id
    db.flush()
    return concept


def attach(db: Session, stone_id: str, annotation_id: int, node_id: str, story_id: str | None,
           evidence_ids: list[str] | None = None, *, path: Path | None = None) -> dict:
    """Assign a book label and selected citations; the original region keeps its ID."""
    from . import structure
    with _import_lock:
        annotation = db.get(Annotation, annotation_id)
        if not annotation or annotation.stone_id != stone_id:
            raise HTTPException(422, '所选区域不属于当前画像石')
        if not annotation.has_geometry or annotation.tool in ('align', 'measure'):
            raise HTTPException(422, '请先选择一个分割区域')
        menu = stone_candidates(db, stone_id, path=path)
        candidate = next((node for node in [*menu['stories'], *menu['entities']]
                          if node['id'] == node_id and (node.get('story_id') or '') == (story_id or '')), None)
        if not candidate or not candidate['source_available']:
            raise HTTPException(409, '该条目的出处已变化，请刷新文献')
        sources = {item['id']: item for item in menu['evidence'] if item['source_available']}
        chosen = candidate['evidence_ids'] if evidence_ids is None else evidence_ids
        if any(eid not in candidate['evidence_ids'] or eid not in sources for eid in chosen):
            raise HTTPException(409, '所选文献不属于当前条目或原文已变化')
        try:
            old = db.query(AnnotationKnowledgeLink).filter_by(annotation_id=annotation_id).first()
            if story_id:
                parent = materialize(db, stone_id, [{'node_id': story_id}], annotation.asset_id, path=path, commit=False)
                parent_id = next(binding['annotation_id'] for binding in parent['bindings'] if binding['node_id'] == story_id)
                structure.validate_parent(db, annotation, parent_id)
                annotation.parent_id = parent_id
            elif old and old.story_id:
                old_parent = db.query(KnowledgeGraphBinding).filter_by(dataset_id=old.dataset_id, stone_id=stone_id,
                                    node_id=old.story_id, story_id='').first()
                if old_parent and annotation.parent_id == old_parent.annotation_id:
                    annotation.parent_id = None
            concept = _candidate_concept(db, menu['dataset_id'], candidate)
            current = [link.concept_id for link in annotation.concept_links]
            if old and old.node_id != node_id:
                previous = db.query(KnowledgeGraphConcept).filter_by(dataset_id=old.dataset_id, node_id=old.node_id).first()
                if previous:
                    current = [cid for cid in current if cid != previous.concept_id]
            structure.set_concepts(db, annotation, _unique([*current, concept.id]))
            annotation.label = candidate['label']
            annotation.level = 'scene' if candidate['kind'] == 'story' else 'figure'
            # Naming is an explicit edit, but does not constitute scholarly review.
            selected_segments = _unique(sources[eid]['segment_id'] for eid in chosen)
            owned = set(old.reference_ids or []) if old else set()
            for ref in list(annotation.references):
                if ref.id in owned and ref.segment_id not in selected_segments:
                    references.remove_reference(db, annotation, ref.id)
            existing = {ref.id for ref in annotation.references}
            managed = []
            for segid in selected_segments:
                ref = references.add_reference(db, annotation, AnnotationReferenceCreate(kind='segment', segment_id=segid))
                if ref.id not in existing or ref.id in owned:
                    managed.append(ref.id)
            if old is None:
                old = AnnotationKnowledgeLink(annotation_id=annotation.id, stone_id=stone_id)
                db.add(old)
            old.dataset_id, old.node_id, old.story_id = menu['dataset_id'], node_id, story_id or ''
            old.reference_ids = managed
            db.commit()
        except Exception:
            db.rollback()
            raise
        return {'annotation': annotations_out(db, [annotation])[0], 'added_sources': len(set(chosen))}


def materialize(db: Session, stone_id: str, requested: list[dict], asset_id: int | None = None, *, path: Path | None = None, commit: bool = True) -> dict:
    """Only explicit, source-valid selections create geometry-free candidate nodes."""
    from ..routers.annotations import _new
    with _import_lock:
        result = stone_candidates(db, stone_id, path=path)
        available = {(n["id"], n.get("story_id") or ""): n for n in [*result["stories"], *result["entities"]]}
        keys = _unique((item["node_id"], item.get("story_id") or "") for item in requested)
        for key in list(keys):
            candidate = available.get(key)
            if not candidate:
                raise HTTPException(422, "所选候选不属于这块文物与故事，请刷新候选菜单")
            if not candidate["source_available"]:
                raise HTTPException(409, "候选出处已变化或无法验证，请先重新核对原页")
            if key[1] and (key[1], "") not in keys:
                keys.insert(0, (key[1], ""))
        asset = db.get(Asset, asset_id) if asset_id else _default_asset(db, stone_id)
        if not asset or asset.stone_id != stone_id or asset.kind not in TWO_D_KINDS or asset.missing:
            raise HTTPException(422, "请选择这块文物的有效二维图像作为候选挂载资产")
        bindings = {(b.node_id, b.story_id): b for b in db.query(KnowledgeGraphBinding).filter(
            KnowledgeGraphBinding.dataset_id == result["dataset_id"], KnowledgeGraphBinding.stone_id == stone_id).all()}
        sources = {e["id"]: e for e in result["evidence"] if e["source_available"]}
        made, reused, rows, imported = 0, 0, {}, []
        keys.sort(key=lambda key: bool(key[1]))
        try:
            for key in keys:
                candidate = available[key]
                bound = bindings.get(key)
                node = db.get(Annotation, bound.annotation_id) if bound else None
                if node and node.stone_id == stone_id:
                    # Preserve later human edits, rejection, and geometry on repeat import.
                    reused += 1
                else:
                    if bound:
                        db.delete(bound); db.flush()
                    parent = rows.get((key[1], "")) if key[1] else None
                    concept = _candidate_concept(db, result["dataset_id"], candidate)
                    node = _new(db, AnnotationCreate(stone_id=stone_id, asset_id=asset.id, tool="annotate", atype="none", geometry={},
                                label=candidate["label"], note="知识图谱候选 · 待核对图像与核心文献原页。" + (candidate.get("description") or ""),
                                color=PALETTE[made % len(PALETTE)], level="scene" if candidate["kind"] == "story" else "figure",
                                category="unknown", review_status="candidate", parent_id=parent.id if parent else None,
                                concept_ids=[concept.id], auto_parent=False))
                    for sid in _unique(sources[eid]["segment_id"] for eid in candidate["evidence_ids"] if eid in sources):
                        references.add_reference(db, node, AnnotationReferenceCreate(kind="segment", segment_id=sid))
                    db.add(KnowledgeGraphBinding(dataset_id=result["dataset_id"], stone_id=stone_id, node_id=key[0], story_id=key[1], annotation_id=node.id))
                    made += 1
                rows[key] = node
                imported.append({"node_id": key[0], "story_id": key[1] or None, "annotation_id": node.id})
            if commit:
                db.commit()
            else:
                db.flush()
        except Exception:
            db.rollback()
            raise
        return {"created": made, "reused": reused, "annotations": annotations_out(db, list(rows.values())), "bindings": imported,
                "notice": "已创建待核候选，尚无图上位置；原有标注、几何与审核状态未改动。"}
