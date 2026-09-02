# -*- coding: utf-8 -*-
"""接口请求/响应模型（Pydantic）。所有路由都声明 response_model，/docs 即为可用的接口文档。"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

AssetKind = Literal["photo", "photo_part", "rubbing", "model_high", "model_mid", "model_low"]
GroupKey = Literal["model", "photo", "photo_part", "rubbing"]
AType = Literal["rect", "polygon", "point", "line", "point3d", "line3d", "align"]


# ---------------------------------------------------------------- 通用
class OkOut(BaseModel):
    ok: bool = True
    message: str = ""


class HealthOut(BaseModel):
    ok: bool
    app: str
    version: str
    db: str
    assets_root: str


class StatsOut(BaseModel):
    stones: int
    assets: int
    assets_2d: int
    assets_3d: int
    annotations: int
    linked_annotations: int
    previews_cached: int
    preview_cache_bytes: int
    db_bytes: int
    version: str


# ---------------------------------------------------------------- 资产 / 石头
class AssetBrief(BaseModel):
    id: int
    kind: AssetKind
    kind_label: str
    filename: str
    bytes: int
    width: int
    height: int
    fmt: str
    extra: dict[str, Any] = Field(default_factory=dict)
    is_master: bool = False
    in_frame: bool = False          # 已接入主图坐标链（含主图自身）
    has_preview: bool = False       # 2D 预览缓存是否已生成
    annotation_count: int = 0


class AssetGroup(BaseModel):
    key: GroupKey
    label: str
    assets: list[AssetBrief]


class StoneNode(BaseModel):
    id: int
    code: str
    name: str
    asset_count: int
    annotation_count: int
    master_asset_id: int | None = None
    groups: list[AssetGroup]


class LayerOut(BaseModel):
    seq: int
    name: str
    summary: str


class StoneDetail(BaseModel):
    id: int
    code: str
    name: str
    dirname: str
    era: str
    material: str
    carving: str
    dims_text: str
    location: str
    description: str
    layers: list[LayerOut]
    annotation_count: int
    asset_count: int
    updated_at: datetime | None = None


class StonePatch(BaseModel):
    era: str | None = None
    material: str | None = None
    carving: str | None = None
    dims_text: str | None = None
    location: str | None = None
    description: str | None = None


class LayerPatch(BaseModel):
    summary: str


class SetMasterOut(BaseModel):
    ok: bool
    message: str
    rebased: int = 0


# ---------------------------------------------------------------- 标注
class AnnotationOut(BaseModel):
    id: int
    stone_id: int
    asset_id: int
    tool: str
    atype: str
    geometry: dict[str, Any]
    label: str
    note: str
    color: str
    value: float | None
    unit: str
    desc_source: str
    desc_start: int | None
    desc_end: int | None
    desc_text: str
    created_at: str
    updated_at: str | None = None


class AnnotationCreate(BaseModel):
    stone_id: int
    asset_id: int
    tool: str = "annotate"
    atype: AType
    geometry: dict[str, Any]
    label: str = "未命名"
    note: str = ""
    color: str = "#e8a33d"
    value: float | None = None
    unit: str = ""


class AnnotationBatchCreate(BaseModel):
    items: list[AnnotationCreate] = Field(min_length=1, max_length=500)


class AnnotationPatch(BaseModel):
    label: str | None = None
    note: str | None = None
    color: str | None = None
    # 图文关联：三者同时给出即建立/更新关联；clear_link 解除
    desc_source: str | None = None
    desc_start: int | None = None
    desc_end: int | None = None
    desc_text: str | None = None
    clear_link: bool = False


# ---------------------------------------------------------------- 对齐 / 投影
class AlignCommitIn(BaseModel):
    stone_id: int
    left_asset_id: int
    right_asset_id: int
    geometry: dict[str, Any]        # 前端求解的 AlignGeometry（s/theta_deg/tx/ty/rmse_px/pairs/尺寸）


class AlignCommitOut(BaseModel):
    annotation: AnnotationOut
    chain_updates: list[str]
    warning: str = ""


class ProjectedItem(BaseModel):
    id: int
    label: str
    color: str
    tool: str
    atype: Literal["polygon", "point", "line"]
    geometry: dict[str, Any]
    source_asset_id: int
    source_filename: str
    value: float | None
    unit: str


class ProjectedOut(BaseModel):
    ok: bool
    reason: str = ""
    items: list[ProjectedItem] = Field(default_factory=list)
    skipped_unaligned: int = 0


# ---------------------------------------------------------------- 扫描
class MasterAssigned(BaseModel):
    stone: str
    asset_id: int
    filename: str


class ScanReport(BaseModel):
    stones: int
    assets_added: int
    assets_updated: int
    assets_kept: int
    assets_removed: int
    previews_invalidated: int
    masters_assigned: list[MasterAssigned] = Field(default_factory=list)
    previews_warming: int = 0
    duration_ms: int = 0


# ---------------------------------------------------------------- 分割
class PointSegIn(BaseModel):
    asset_id: int
    points: list[list[float]] = Field(description="归一化坐标 [[u,v],...]")
    labels: list[int] = Field(description="1=正点（要这里） 0=负点（不要这里）")


SegPreprocess = Literal["none", "enhance", "rubbing"]
SegTiling = Literal["none", "preview", "hires"]


class ExemplarBox(BaseModel):
    """SAM3 示例框：归一化中心点与宽高（0..1），label 1=正例 0=负例。"""
    cx: float = Field(ge=0.0, le=1.0)
    cy: float = Field(ge=0.0, le=1.0)
    w: float = Field(gt=0.0, le=1.0)
    h: float = Field(gt=0.0, le=1.0)
    label: int = Field(1, ge=0, le=1)


class TextSegIn(BaseModel):
    asset_id: int
    prompt: str = ""
    engine: Literal["sam3", "sam3.1"] = "sam3"
    threshold: float = Field(0.5, ge=0.0, le=1.0)
    max_results: int = Field(20, ge=1, le=100)
    boxes: list[ExemplarBox] = Field(default_factory=list, description="示例框；给出时按整图推理")
    preprocess: SegPreprocess = Field("none", description="none 原图 / enhance 去光照+CLAHE / rubbing 仿拓片二值化")
    invert: bool = Field(False, description="仿拓片反相（光照相反时）")
    tiling: SegTiling = Field("none", description="none 整图 / preview 切块(2560 预览) / hires 切块(5120 工作图)")


class LooseModel(BaseModel):
    """工作进程直接透传的结果，字段随引擎而异。"""
    model_config = ConfigDict(extra="allow")
    ok: bool


class SegEngineState(BaseModel):
    status: str
    detail: str = ""


class SegWorkerInfo(BaseModel):
    python: str | None
    available: bool
    alive: bool
    gpu: str | None = None
    cuda: bool | None = None
    torch: str | None = None
    vram_used_mb: int | None = None
    log: str


class SegWeightInfo(BaseModel):
    file: str | None
    exists: bool
    bytes: int


class SegStatusOut(BaseModel):
    worker: SegWorkerInfo
    weights: dict[str, SegWeightInfo]
    engines: dict[str, SegEngineState]


class SegEnginesOut(BaseModel):
    ok: bool
    error: str | None = None
    engines: dict[str, SegEngineState]


class SegDetection(BaseModel):
    polygon: list[list[float]]
    score: float
    box: list[float] | None = None      # 归一化 [x0, y0, x1, y1]


class PointSegOut(LooseModel):
    error: str | None = None
    polygons: list[list[list[float]]] | None = None
    score: float | None = None
    size: list[int] | None = None
    model: str | None = None


class TextSegOut(LooseModel):
    error: str | None = None
    detections: list[SegDetection] | None = None
    size: list[int] | None = None
    model: str | None = None
    prompt: str | None = None
    tiles: int | None = None
    preprocess: str | None = None
    exemplars: int | None = None
