# -*- coding: utf-8 -*-
"""分割工具：引擎状态 / 加载 / 卸载 / 点选分割 / 文本概念分割。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Asset
from ..schemas import PointSegIn, PointSegOut, SegEnginesOut, SegStatusOut, TextSegIn, TextSegOut
from ..services import previews, segment

router = APIRouter(prefix="/tools/segment", tags=["分割"])


def _preview_for(asset_id: int, db: Session):
    a = db.get(Asset, asset_id)
    if not a:
        raise HTTPException(404, "资产不存在")
    if a.is_model:
        raise HTTPException(400, "三维资产不支持 2D 分割")
    return previews.ensure_preview(a.id, a.relpath)


@router.get("/status", response_model=SegStatusOut, summary="工作进程 / 权重 / 引擎状态")
def status():
    return segment.models_status()


@router.post("/load/{engine}", response_model=SegEnginesOut, summary="加载引擎（异步，轮询 status）")
def load(engine: str):
    return segment.load_engine(engine)


@router.post("/unload/{engine}", response_model=SegEnginesOut, summary="卸载引擎（释放显存）")
def unload(engine: str):
    return segment.unload_engine(engine)


@router.post("/point", response_model=PointSegOut, summary="MobileSAM 点选分割")
def point(body: PointSegIn, db: Session = Depends(get_db)):
    if not body.points or len(body.points) != len(body.labels):
        raise HTTPException(422, "points 与 labels 数量须一致且非空")
    return segment.point_segment(_preview_for(body.asset_id, db), body.points, body.labels)


@router.post("/text", response_model=TextSegOut, summary="SAM3 / SAM3.1 文本概念分割")
def text(body: TextSegIn, db: Session = Depends(get_db)):
    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(422, "prompt 不能为空")
    return segment.text_segment(body.engine, _preview_for(body.asset_id, db), prompt,
                                body.threshold, body.max_results)
