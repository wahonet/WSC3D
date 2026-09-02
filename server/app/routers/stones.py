# -*- coding: utf-8 -*-
"""石头：列表树 / 详情 / 元数据编辑 / 分层释文编辑 / 全部标注 / 主图指派。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Annotation, Asset, Stone
from ..schemas import AnnotationOut, LayerPatch, SetMasterOut, StoneDetail, StoneNode, StonePatch
from ..services import alignment, textlinks
from ..services.serialize import annotation_out, stone_detail, stone_node
from .deps import get_stone

router = APIRouter(prefix="/stones", tags=["石头"])


@router.get("", response_model=list[StoneNode], summary="石头与资产分组树")
def list_stones(db: Session = Depends(get_db)):
    return [stone_node(s, db) for s in db.query(Stone).order_by(Stone.code).all()]


@router.get("/{stone_id}", response_model=StoneDetail, summary="石头详情（含分层释文）")
def get_detail(s: Stone = Depends(get_stone), db: Session = Depends(get_db)):
    return stone_detail(s, db)


@router.patch("/{stone_id}", response_model=StoneDetail, summary="编辑元数据 / 总述")
def patch_stone(body: StonePatch, s: Stone = Depends(get_stone), db: Session = Depends(get_db)):
    """总述（description）受图文关联锁定保护：删改已关联文字返回 409。"""
    data = body.model_dump(exclude_none=True)
    new_desc = data.pop("description", None)
    if new_desc is not None and new_desc != (s.description or ""):
        textlinks.save_text_with_links(db, s.id, "description", new_desc,
                                       lambda t: setattr(s, "description", t))
    for k, v in data.items():
        setattr(s, k, v)
    db.commit()
    return stone_detail(s, db)


@router.patch("/{stone_id}/layers/{seq}", response_model=StoneDetail, summary="编辑第 N 层释文")
def patch_layer(seq: int, body: LayerPatch, s: Stone = Depends(get_stone),
                db: Session = Depends(get_db)):
    cur, lay = textlinks.source_text(s, f"layer:{seq}")
    if body.summary != cur:
        textlinks.save_text_with_links(db, s.id, f"layer:{seq}", body.summary,
                                       lambda t: setattr(lay, "summary", t))
    db.commit()
    return stone_detail(s, db)


@router.get("/{stone_id}/annotations", response_model=list[AnnotationOut], summary="石头全部标注")
def stone_annotations(s: Stone = Depends(get_stone), db: Session = Depends(get_db)):
    rows = db.query(Annotation).filter(Annotation.stone_id == s.id).order_by(Annotation.id).all()
    return [annotation_out(x) for x in rows]


@router.post("/{stone_id}/master/{asset_id}", response_model=SetMasterOut, summary="设为主图")
def set_master(asset_id: int, s: Stone = Depends(get_stone), db: Session = Depends(get_db)):
    """已有坐标链时自动重定基；新主图未对齐且他图已入链时拒绝切换（ok=false）。"""
    a = db.get(Asset, asset_id)
    if not a or a.stone_id != s.id:
        raise HTTPException(404, "该石头下不存在此资产")
    return alignment.set_master(db, s.id, a)
