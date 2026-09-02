# -*- coding: utf-8 -*-
"""标注：按资产列出 / 创建 / 批量创建 / 编辑（含图文关联） / 删除。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Annotation, Asset
from ..schemas import (
    AnnotationBatchCreate, AnnotationBatchPatch, AnnotationCreate, AnnotationOut, AnnotationPatch, OkOut,
)
from ..services import textlinks
from ..services.serialize import annotation_out
from .deps import get_annotation

router = APIRouter(prefix="/annotations", tags=["标注"])


@router.get("", response_model=list[AnnotationOut], summary="某资产的全部标注")
def list_by_asset(asset_id: int = Query(..., description="资产 id"), db: Session = Depends(get_db)):
    rows = db.query(Annotation).filter(Annotation.asset_id == asset_id).order_by(Annotation.id).all()
    return [annotation_out(x) for x in rows]


def _new(db: Session, body: AnnotationCreate) -> Annotation:
    a = db.get(Asset, body.asset_id)
    if not a:
        raise HTTPException(404, "资产不存在")
    if a.stone_id != body.stone_id:
        raise HTTPException(422, "stone_id 与资产所属石头不一致")
    x = Annotation(**body.model_dump())
    db.add(x)
    return x


@router.post("", response_model=AnnotationOut, status_code=201, summary="创建标注")
def create(body: AnnotationCreate, db: Session = Depends(get_db)):
    x = _new(db, body)
    db.commit()
    return annotation_out(x)


@router.post("/batch", response_model=list[AnnotationOut], status_code=201,
             summary="批量创建标注（如一次保存多条分割候选）")
def create_batch(body: AnnotationBatchCreate, db: Session = Depends(get_db)):
    rows = [_new(db, item) for item in body.items]
    db.commit()
    return [annotation_out(x) for x in rows]


@router.patch("/batch", response_model=list[AnnotationOut], summary="批量修改名称 / 内容 / 颜色（如自动配色）")
def patch_batch(body: AnnotationBatchPatch, db: Session = Depends(get_db)):
    ids = [it.id for it in body.items]
    rows = {x.id: x for x in db.query(Annotation).filter(Annotation.id.in_(ids)).all()}
    missing = [i for i in ids if i not in rows]
    if missing:
        raise HTTPException(404, f"标注不存在：{missing[:5]}")
    for it in body.items:
        x = rows[it.id]
        for k in ("label", "note", "color"):
            v = getattr(it, k)
            if v is not None:
                setattr(x, k, v)
    db.commit()
    return [annotation_out(rows[i]) for i in ids]


@router.patch("/{anno_id}", response_model=AnnotationOut, summary="编辑标注 / 图文关联")
def patch(body: AnnotationPatch, x: Annotation = Depends(get_annotation),
          db: Session = Depends(get_db)):
    """desc_start/desc_end/desc_text 三者齐全即建立关联（校验区间、重叠）；
    clear_link=true 解除关联。label/note/color 直接更新。"""
    if body.clear_link:
        textlinks.clear_link(x)
    if body.desc_start is not None and body.desc_end is not None and body.desc_text is not None:
        textlinks.set_link(db, x, body.desc_source or "description",
                           body.desc_start, body.desc_end, body.desc_text)
    for k in ("label", "note", "color"):
        v = getattr(body, k)
        if v is not None:
            setattr(x, k, v)
    db.commit()
    return annotation_out(x)


@router.delete("/{anno_id}", response_model=OkOut, summary="删除标注")
def delete(x: Annotation = Depends(get_annotation), db: Session = Depends(get_db)):
    db.delete(x)
    db.commit()
    return OkOut(ok=True)
