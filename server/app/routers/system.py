# -*- coding: utf-8 -*-
"""系统：健康检查 / 统计 / 素材扫描。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import APP_NAME, APP_VERSION, settings
from ..constants import TWO_D_KINDS
from ..db import get_db
from ..models import Annotation, Asset, Stone
from ..schemas import HealthOut, ScanReport, StatsOut
from ..services import previews, scanner

router = APIRouter(tags=["系统"])


@router.get("/health", response_model=HealthOut, summary="健康检查")
def health():
    return HealthOut(ok=True, app=APP_NAME.lower(), version=APP_VERSION, db="sqlite",
                     assets_root=str(settings.assets_root))


@router.get("/stats", response_model=StatsOut, summary="全库统计（首页仪表）")
def stats(db: Session = Depends(get_db)):
    n_prev, cache_bytes = previews.cache_stats()
    assets_2d = db.query(func.count(Asset.id)).filter(Asset.kind.in_(TWO_D_KINDS)).scalar() or 0
    assets_all = db.query(func.count(Asset.id)).scalar() or 0
    linked = (db.query(func.count(Annotation.id))
              .filter(Annotation.references.any()).scalar() or 0)
    return StatsOut(
        stones=db.query(func.count(Stone.id)).scalar() or 0,
        assets=assets_all, assets_2d=assets_2d, assets_3d=assets_all - assets_2d,
        annotations=db.query(func.count(Annotation.id)).scalar() or 0,
        linked_annotations=linked,
        previews_cached=n_prev, preview_cache_bytes=cache_bytes,
        db_bytes=settings.db_path.stat().st_size if settings.db_path.exists() else 0,
        version=APP_VERSION,
    )


@router.post("/scan", response_model=ScanReport, summary="扫描 assets/stones 入库")
def scan(warm: bool | None = None, db: Session = Depends(get_db)):
    """幂等：新文件入库、消失文件删除记录、被替换文件重读尺寸并作废预览缓存。
    `warm` 覆盖配置项，控制是否在后台预热预览缓存。"""
    return scanner.scan(db, warm=warm)
