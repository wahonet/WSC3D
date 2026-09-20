# -*- coding: utf-8 -*-
"""概念树：分类骨架（常量）+ 概念词 CRUD（跨石头共享）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..constants import CATEGORIES, GEOMETRY_INTENTS, LEVELS, QUALITIES, REVIEW_STATUSES
from ..db import get_db
from ..knowledge import CATEGORY_IDS, CONCEPT_CATEGORIES
from ..models import AnnotationConcept, Concept
from ..schemas import ConceptCategory, ConceptCreate, ConceptOut, ConceptPatch, OkOut, TaxonomyOut
from ..services.serialize import concept_out

router = APIRouter(prefix="/concepts", tags=["概念"])


@router.get("/taxonomy", response_model=TaxonomyOut, summary="分类骨架与各枚举的显示名")
def taxonomy():
    return TaxonomyOut(
        categories=[ConceptCategory(id=i, name=n, parent_id=p) for i, n, p in CONCEPT_CATEGORIES],
        levels=LEVELS, sop_categories=CATEGORIES, review_statuses=REVIEW_STATUSES,
        qualities=QUALITIES, geometry_intents=GEOMETRY_INTENTS,
    )


@router.get("", response_model=list[ConceptOut], summary="全部概念（含使用次数）")
def list_concepts(db: Session = Depends(get_db)):
    usage = dict(db.query(AnnotationConcept.concept_id, func.count(AnnotationConcept.annotation_id))
                 .group_by(AnnotationConcept.concept_id).all())
    return [concept_out(c, usage.get(c.id, 0)) for c in db.query(Concept).order_by(Concept.name).all()]


def _check_category(cid: str) -> None:
    if cid and cid not in CATEGORY_IDS:
        raise HTTPException(422, f"未知分类：{cid}")


@router.post("", response_model=ConceptOut, status_code=201, summary="新增概念")
def create_concept(body: ConceptCreate, db: Session = Depends(get_db)):
    name = body.name.strip()
    _check_category(body.category_id)
    if db.query(Concept).filter(Concept.name == name).first():
        raise HTTPException(409, f"概念「{name}」已存在")
    c = Concept(name=name, category_id=body.category_id, aliases=[a.strip() for a in body.aliases if a.strip()],
                description=body.description.strip())
    db.add(c)
    db.commit()
    return concept_out(c, 0)


@router.patch("/{concept_id}", response_model=ConceptOut, summary="编辑概念")
def patch_concept(concept_id: int, body: ConceptPatch, db: Session = Depends(get_db)):
    c = db.get(Concept, concept_id)
    if not c:
        raise HTTPException(404, "概念不存在")
    if body.name is not None:
        name = body.name.strip()
        other = db.query(Concept).filter(Concept.name == name, Concept.id != c.id).first()
        if other:
            raise HTTPException(409, f"概念「{name}」已存在")
        c.name = name
    if body.category_id is not None:
        _check_category(body.category_id)
        c.category_id = body.category_id
    if body.aliases is not None:
        c.aliases = [a.strip() for a in body.aliases if a.strip()]
    if body.description is not None:
        c.description = body.description.strip()
    db.commit()
    n = db.query(func.count(AnnotationConcept.annotation_id)).filter(AnnotationConcept.concept_id == c.id).scalar()
    return concept_out(c, n or 0)


@router.delete("/{concept_id}", response_model=OkOut, summary="删除概念（同时解除全部挂接）")
def delete_concept(concept_id: int, db: Session = Depends(get_db)):
    c = db.get(Concept, concept_id)
    if not c:
        raise HTTPException(404, "概念不存在")
    n = db.query(func.count(AnnotationConcept.annotation_id)).filter(AnnotationConcept.concept_id == c.id).scalar()
    db.delete(c)
    db.commit()
    return OkOut(ok=True, message=f"已删除概念「{c.name}」" + (f"，解除 {n} 处挂接" if n else ""))
