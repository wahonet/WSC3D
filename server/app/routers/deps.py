# -*- coding: utf-8 -*-
"""路由共用的依赖：按 id 取对象，不存在即 404。"""
from __future__ import annotations

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Annotation, Asset, Stone


def get_stone(stone_id: int, db: Session = Depends(get_db)) -> Stone:
    s = db.get(Stone, stone_id)
    if not s:
        raise HTTPException(404, "石头不存在")
    return s


def get_asset(asset_id: int, db: Session = Depends(get_db)) -> Asset:
    a = db.get(Asset, asset_id)
    if not a:
        raise HTTPException(404, "资产不存在")
    return a


def get_2d_asset(asset: Asset = Depends(get_asset)) -> Asset:
    if asset.is_model:
        raise HTTPException(400, "三维资产没有 2D 预览")
    return asset


def get_annotation(anno_id: int, db: Session = Depends(get_db)) -> Annotation:
    x = db.get(Annotation, anno_id)
    if not x:
        raise HTTPException(404, "标注不存在")
    return x
