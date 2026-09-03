# -*- coding: utf-8 -*-
"""ORM 对象 -> 接口模型 的转换。"""
from __future__ import annotations

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..constants import GROUPS, KIND_LABEL, TREE_MODEL_KINDS
from ..models import Annotation, AnnotationConcept, Asset, Concept, Stone
from ..schemas import (
    AnnotationOut, AssetBrief, AssetGroup, ConceptOut, LayerOut, Semantics, StoneDetail, StoneNode,
)
from . import previews


def _iso(dt) -> str | None:
    return dt.isoformat(timespec="seconds") if dt else None


def annotation_out(x: Annotation, concept_ids: list[int] | None = None) -> AnnotationOut:
    """concept_ids 未给出时走关系加载（单条场景）；批量请用 annotations_out 避免 N+1。"""
    if concept_ids is None:
        concept_ids = [l.concept_id for l in x.concept_links]
    return AnnotationOut(
        id=x.id, stone_id=x.stone_id, asset_id=x.asset_id,
        tool=x.tool, atype=x.atype, geometry=x.geometry or {},
        label=x.label, note=x.note or "", color=x.color,
        value=x.value, unit=x.unit or "",
        desc_source=x.desc_source or "description",
        desc_start=x.desc_start, desc_end=x.desc_end, desc_text=x.desc_text or "",
        parent_id=x.parent_id, level=x.level or "", category=x.category or "", seq=x.seq,
        review_status=x.review_status or "reviewed", quality=x.quality or "",
        geometry_intent=x.geometry_intent or "",
        semantics=Semantics.model_validate(x.semantics or {}),
        concept_ids=sorted(concept_ids),
        created_at=_iso(x.created_at) or "", updated_at=_iso(x.updated_at),
    )


def annotations_out(db: Session, rows: list[Annotation]) -> list[AnnotationOut]:
    ids = [x.id for x in rows]
    links: dict[int, list[int]] = {i: [] for i in ids}
    if ids:
        for aid, cid in (db.query(AnnotationConcept.annotation_id, AnnotationConcept.concept_id)
                         .filter(AnnotationConcept.annotation_id.in_(ids)).all()):
            links[aid].append(cid)
    return [annotation_out(x, links[x.id]) for x in rows]


def concept_out(c: Concept, usage: int = 0) -> ConceptOut:
    return ConceptOut(id=c.id, name=c.name, category_id=c.category_id or "",
                      aliases=list(c.aliases or []), description=c.description or "", usage=usage)


def asset_brief(a: Asset, anno_count: int = 0) -> AssetBrief:
    extra = a.extra or {}
    return AssetBrief(
        id=a.id, kind=a.kind, kind_label=KIND_LABEL.get(a.kind, a.kind),
        filename=a.filename, bytes=a.bytes, width=a.width, height=a.height, fmt=a.fmt,
        extra=extra,
        is_master=bool(extra.get("is_master")),
        in_frame=extra.get("align_to_master") is not None,
        has_preview=(not a.is_model) and previews.has_preview(a.id),
        annotation_count=anno_count,
    )


def annotation_counts_by_asset(db: Session, stone_id: int) -> dict[int, int]:
    rows = (db.query(Annotation.asset_id, func.count(Annotation.id))
            .filter(Annotation.stone_id == stone_id)
            .group_by(Annotation.asset_id).all())
    return {aid: n for aid, n in rows}


def stone_node(s: Stone, db: Session) -> StoneNode:
    counts = annotation_counts_by_asset(db, s.id)
    buckets: dict[str, list[AssetBrief]] = {k: [] for k, _ in GROUPS}
    master_id: int | None = None
    for a in sorted(s.assets, key=lambda x: (x.kind, x.filename)):
        if a.is_master:
            master_id = a.id
        if a.is_model:
            if a.kind in TREE_MODEL_KINDS:
                buckets["model"].append(asset_brief(a, counts.get(a.id, 0)))
        else:
            buckets[a.kind].append(asset_brief(a, counts.get(a.id, 0)))
    return StoneNode(
        id=s.id, code=s.code, name=s.name,
        asset_count=len(s.assets), annotation_count=sum(counts.values()),
        master_asset_id=master_id,
        groups=[AssetGroup(key=k, label=lb, assets=buckets[k]) for k, lb in GROUPS],
    )


def stone_detail(s: Stone, db: Session) -> StoneDetail:
    n = db.query(func.count(Annotation.id)).filter(Annotation.stone_id == s.id).scalar() or 0
    return StoneDetail(
        id=s.id, code=s.code, name=s.name, dirname=s.dirname,
        era=s.era or "", material=s.material or "", carving=s.carving or "",
        dims_text=s.dims_text or "", location=s.location or "", description=s.description or "",
        layers=[LayerOut(seq=l.seq, name=l.name, summary=l.summary or "") for l in s.layers],
        annotation_count=n, asset_count=len(s.assets), updated_at=s.updated_at,
    )
