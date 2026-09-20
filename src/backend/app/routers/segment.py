# -*- coding: utf-8 -*-
"""分割工具：引擎状态 / 加载 / 卸载 / 点选分割 / 文本与示例框概念分割。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Asset
from ..schemas import PointSegIn, PointSegOut, SegEnginesOut, SegStatusOut, TextSegIn, TextSegOut
from ..services import previews, segment

router = APIRouter(prefix="/tools/segment", tags=["分割"])


def _asset_2d(asset_id: int, db: Session) -> Asset:
    a = db.get(Asset, asset_id)
    if not a:
        raise HTTPException(404, "资产不存在")
    if a.is_model:
        raise HTTPException(400, "三维资产不支持 2D 分割")
    return a


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
    a = _asset_2d(body.asset_id, db)
    return segment.point_segment(previews.ensure_preview(a.id, a.relpath), body.points, body.labels)


@router.post("/text", response_model=TextSegOut, summary="SAM3 / SAM3.1 概念分割（文字 和/或 示例框）")
def text(body: TextSegIn, db: Session = Depends(get_db)):
    """- prompt 与 boxes 至少给一个；示例框给出时按整图推理（示例特征来自本图）
    - preprocess：照片上建议先试 enhance / rubbing
    - tiling=hires 首次会从原件生成 5120 长边工作图（数秒到数十秒）"""
    prompt = body.prompt.strip()
    if not prompt and not body.boxes:
        raise HTTPException(422, "需要文字提示或至少一个示例框")
    a = _asset_2d(body.asset_id, db)
    path = (previews.ensure_work_image(a.id, a.relpath) if body.tiling == "hires" and not body.boxes
            else previews.ensure_preview(a.id, a.relpath))
    return segment.text_segment(body.engine, path, prompt, body.threshold, body.max_results,
                                boxes=[b.model_dump() for b in body.boxes],
                                preprocess=body.preprocess, invert=body.invert, tiling=body.tiling)
