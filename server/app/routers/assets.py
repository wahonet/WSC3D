# -*- coding: utf-8 -*-
"""资产文件：2D 预览 / 缩略图 / 三维模型文件 / 跨图投影。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import Asset
from ..schemas import ProjectedOut
from ..services import alignment, previews
from .deps import get_2d_asset, get_asset

router = APIRouter(prefix="/assets", tags=["资产"])

_CACHE = {"Cache-Control": "public, max-age=86400"}
_MEDIA = {".obj": "text/plain", ".mtl": "text/plain", ".png": "image/png",
          ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
          ".tif": "image/tiff", ".tiff": "image/tiff", ".bmp": "image/bmp"}


@router.get("/{asset_id}/preview", summary="2D 预览（sRGB JPEG，长边 2560）")
def preview(a: Asset = Depends(get_2d_asset)):
    p = previews.ensure_preview(a.id, a.relpath)
    return FileResponse(p, media_type="image/jpeg", headers=_CACHE)


@router.get("/{asset_id}/thumb", summary="缩略图（长边 320）")
def thumb(a: Asset = Depends(get_2d_asset)):
    p = previews.ensure_thumb(a.id, a.relpath)
    return FileResponse(p, media_type="image/jpeg", headers=_CACHE)


@router.get("/{asset_id}/model/{fname}", summary="三维模型文件（obj / mtl / 贴图）")
def model_file(fname: str, a: Asset = Depends(get_asset)):
    """限定在该资产所在目录内，杜绝路径穿越。"""
    if not a.is_model:
        raise HTTPException(404, "模型资产不存在")
    base = (settings.assets_root / a.relpath).parent.resolve()
    target = (base / fname).resolve()
    if base not in target.parents and target != base:
        raise HTTPException(403, "非法路径")
    if not target.is_file():
        raise HTTPException(404, f"文件不存在：{fname}")
    return FileResponse(target, media_type=_MEDIA.get(target.suffix.lower(), "application/octet-stream"),
                        headers=_CACHE)


@router.get("/{asset_id}/projected", response_model=ProjectedOut, summary="同石其他图的标注投影到本图")
def projected(a: Asset = Depends(get_asset), db: Session = Depends(get_db)):
    if a.is_model:
        return ProjectedOut(ok=False, reason="三维投影尚未支持（需照片-模型配准）")
    return alignment.project_annotations(db, a)
