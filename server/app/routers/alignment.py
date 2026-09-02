# -*- coding: utf-8 -*-
"""对齐：提交对应点配准结果，接入主图坐标链。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Asset
from ..schemas import AlignCommitIn, AlignCommitOut
from ..services import alignment

router = APIRouter(prefix="/align", tags=["对齐"])

_REQUIRED = ("s", "theta_deg", "tx", "ty")


@router.post("/commit", response_model=AlignCommitOut, summary="保存对齐并更新坐标链")
def commit(body: AlignCommitIn, db: Session = Depends(get_db)):
    left = db.get(Asset, body.left_asset_id)
    right = db.get(Asset, body.right_asset_id)
    if not left or not right:
        raise HTTPException(404, "资产不存在")
    if left.id == right.id:
        raise HTTPException(422, "左右图不能是同一资产")
    if left.is_model or right.is_model:
        raise HTTPException(400, "三维资产不参与 2D 对齐")
    missing = [k for k in _REQUIRED if k not in body.geometry]
    if missing:
        raise HTTPException(422, f"geometry 缺少字段：{', '.join(missing)}")
    return alignment.commit_alignment(db, body.stone_id, left, right, body.geometry)
