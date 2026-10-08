# -*- coding: utf-8 -*-
"""对齐：提交对应点配准结果，接入主图坐标链。"""
from __future__ import annotations

import json
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Asset
from ..schemas import AlignCommitIn, AlignCommitOut
from ..services import alignment

router = APIRouter(prefix="/align", tags=["对齐"])


@router.get('/preview', summary='原色透视叠加预览（透明 PNG）')
def projective_preview(left_asset_id: int, right_asset_id: int,
                       matrix: str = Query(max_length=1200), db: Session = Depends(get_db)):
    from ..services.alignment_preview import ensure_projective_preview
    left, right = db.get(Asset, left_asset_id), db.get(Asset, right_asset_id)
    if not left or not right:
        raise HTTPException(404, '资产不存在')
    if left.is_model or right.is_model or left.stone_id != right.stone_id:
        raise HTTPException(422, '透视叠加须使用同石的二维图像')
    if min(left.width, left.height, right.width, right.height) <= 0:
        raise HTTPException(422, '图像尺寸未知，无法换算原图坐标')
    try:
        path = ensure_projective_preview(left, right, json.loads(matrix))
    except (ValueError, TypeError, KeyError, OverflowError, ZeroDivisionError) as error:
        raise HTTPException(422, f'透视矩阵无效：{error}') from None
    return FileResponse(path, media_type='image/png', headers={'Cache-Control': 'private, max-age=86400'})

_REQUIRED = ("s", "theta_deg", "tx", "ty")


@router.post("/commit", response_model=AlignCommitOut, summary="保存对齐并更新坐标链")
def commit(body: AlignCommitIn, db: Session = Depends(get_db)):
    left = db.get(Asset, body.left_asset_id)
    right = db.get(Asset, body.right_asset_id)
    if not left or not right:
        raise HTTPException(404, "资产不存在")
    if left.id == right.id:
        raise HTTPException(422, "左右图不能是同一资产")
    if left.stone_id != body.stone_id or right.stone_id != body.stone_id:
        raise HTTPException(422, '左右图必须属于指定的同一文物')
    if left.is_model or right.is_model:
        raise HTTPException(400, "三维资产不参与 2D 对齐")
    missing = [k for k in (('homography',) if body.geometry.get('model') == 'homography' else _REQUIRED) if k not in body.geometry]
    if missing:
        raise HTTPException(422, f"geometry 缺少字段：{', '.join(missing)}")
    alignment.validate_geometry(body.geometry)
    return alignment.commit_alignment(db, body.stone_id, left, right, body.geometry)
