# -*- coding: utf-8 -*-
"""接口请求/响应模型（Pydantic）。所有路由都声明 response_model，/docs 即为可用的接口文档。"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

AssetKind = Literal["photo", "photo_part", "rubbing", "model_high", "model_mid", "model_low"]
GroupKey = Literal["model", "photo", "photo_part", "rubbing"]
# ellipse = 圆 / 椭圆 {cx, cy, rx, ry}（归一化）；none = 尚无几何的骨架节点（先由释文生成，之后绘制或并入候选几何）
AType = Literal["rect", "ellipse", "polygon", "point", "line", "point3d", "line3d", "align", "none"]
Level = Literal["", "whole", "band", "layer", "scene", "figure", "component", "inscription", "trace", "damage"]
Category = Literal[
    "", "figure-deity", "figure-immortal", "figure-mythic-ruler", "figure-loyal-assassin",
    "figure-filial-son", "figure-virtuous-woman", "figure-music-dance", "chariot-procession",
    "mythic-creature", "celestial", "daily-life-scene", "architecture", "inscription",
    "pattern-border", "unknown",
]
ReviewStatus = Literal["candidate", "reviewed", "approved", "rejected"]
Quality = Literal["", "weak", "silver", "gold"]
GeometryIntent = Literal["", "visible_trace", "semantic_extent", "reconstructed_extent"]


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
    name: str | None = None


class SetMasterOut(BaseModel):
    ok: bool
    message: str
    rebased: int = 0


# ---------------------------------------------------------------- 标注（结构树节点）
class InscriptionSem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    transcription: str = ""     # 录文（照原字，异体字保留）
    translation: str = ""       # 今译
    notes: str = ""             # 释读注


class Semantics(BaseModel):
    """图像志三层文本（Panofsky）+ 榜题子面板。"""
    model_config = ConfigDict(extra="ignore")
    pre_iconographic: str = ""  # 前图像志：只描述看到了什么
    iconographic: str = ""      # 图像志：主题 / 故事识别
    iconological: str = ""      # 图像学：文化阐释，可多解并存
    inscription: InscriptionSem = Field(default_factory=InscriptionSem)


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
    parent_id: int | None = None
    level: str = ""
    category: str = ""
    seq: int | None = None
    review_status: str = "reviewed"
    quality: str = ""
    geometry_intent: str = ""
    semantics: Semantics = Field(default_factory=Semantics)
    concept_ids: list[int] = Field(default_factory=list)
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
    parent_id: int | None = None
    level: Level = ""
    category: Category = ""
    seq: int | None = None
    review_status: ReviewStatus = "reviewed"
    concept_ids: list[int] = Field(default_factory=list)
    # true：未给 parent_id 时按几何包含自动挂到最贴合的容器节点，并按父级推断层级
    auto_parent: bool = False


class AnnotationBatchCreate(BaseModel):
    items: list[AnnotationCreate] = Field(min_length=1, max_length=500)


class AnnotationBatchPatchItem(BaseModel):
    """批量修改的一项：名称 / 内容 / 颜色 / 结构字段（图文关联请走单条 PATCH）。"""
    id: int
    label: str | None = None
    note: str | None = None
    color: str | None = None
    parent_id: int | None = None
    clear_parent: bool = False
    level: Level | None = None
    category: Category | None = None
    seq: int | None = None
    review_status: ReviewStatus | None = None


class AnnotationBatchPatch(BaseModel):
    items: list[AnnotationBatchPatchItem] = Field(min_length=1, max_length=1000)


class IdList(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=1000)


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
    # 结构树
    parent_id: int | None = None
    clear_parent: bool = False
    level: Level | None = None
    category: Category | None = None
    seq: int | None = None
    clear_seq: bool = False
    review_status: ReviewStatus | None = None
    quality: Quality | None = None
    geometry_intent: GeometryIntent | None = None
    semantics: Semantics | None = None
    concept_ids: list[int] | None = None
    # 给骨架节点挂接几何（三者同时给出；asset 须属同一石头）
    asset_id: int | None = None
    atype: AType | None = None
    geometry: dict[str, Any] | None = None


class AdoptIn(BaseModel):
    """把另一条标注（通常是机器候选）的几何并入本节点，并删除来源。"""
    source_id: int


class ParentSuggestion(BaseModel):
    id: int
    label: str
    level: str
    ratio: float            # 本节点面积落在候选父级内的比例
    area_ratio: float       # 候选父级面积 / 本节点面积


class AutoParentIn(BaseModel):
    ids: list[int] | None = None        # 缺省 = 该石头全部结构节点
    only_orphans: bool = True           # 只处理尚无父级的
    min_ratio: float = Field(0.7, ge=0.3, le=1.0)
    include_candidates: bool = True


class AutoParentOut(BaseModel):
    assigned: int
    skipped: int
    details: list[str] = Field(default_factory=list)


class SkeletonItem(BaseModel):
    key: str
    parent_key: str | None = None
    parent_label: str = ""             # 父级未被选中创建时，按此名称挂到库中已有节点
    level: str
    label: str
    seq: int | None = None
    category: str = ""
    desc_source: str | None = None
    desc_start: int | None = None
    desc_end: int | None = None
    transcription: str = ""
    concept_names: list[str] = Field(default_factory=list)
    exists: bool = False               # 石头上已有同名节点
    excerpt: str = ""                  # 来源释文摘录（预览用）


class SkeletonPreview(BaseModel):
    items: list[SkeletonItem]
    asset_id: int | None = None        # 建议挂载的资产（主图）


class SkeletonCreateIn(BaseModel):
    items: list[SkeletonItem] = Field(min_length=1, max_length=500)
    asset_id: int | None = None


class SkeletonCreateOut(BaseModel):
    created: int
    linked: int
    skipped_links: list[str] = Field(default_factory=list)
    annotations: list[AnnotationOut]


# ---------------------------------------------------------------- 概念
class ConceptCategory(BaseModel):
    id: str
    name: str
    parent_id: str | None = None


class ConceptOut(BaseModel):
    id: int
    name: str
    category_id: str
    aliases: list[str] = Field(default_factory=list)
    description: str = ""
    usage: int = 0


class ConceptCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    category_id: str = ""
    aliases: list[str] = Field(default_factory=list)
    description: str = ""


class ConceptPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=128)
    category_id: str | None = None
    aliases: list[str] | None = None
    description: str | None = None


class TaxonomyOut(BaseModel):
    categories: list[ConceptCategory]
    levels: dict[str, str]
    sop_categories: dict[str, str]
    review_statuses: dict[str, str]
    qualities: dict[str, str]
    geometry_intents: dict[str, str]


# ---------------------------------------------------------------- 文献库 / OCR
DocKind = Literal["book", "article", "catalog", "other"]
DocScript = Literal["modern", "classical"]
OcrEngine = Literal["mineru", "ndl"]
SegmentKind = Literal["text", "title", "caption", "footnote", "header", "page_number", "table",
                      "equation", "list", "line", "other"]
SegmentReview = Literal["machine", "reviewed", "rejected"]


class DocumentOut(BaseModel):
    id: int
    code: str
    title: str
    authors: str
    year: str
    publisher: str
    kind: str
    script: str
    relpath: str
    filename: str
    bytes: int
    page_count: int
    has_text_layer: bool
    notes: str
    pages_done: int = 0
    pages_error: int = 0
    segments: int = 0
    figures: int = 0
    updated_at: str | None = None


class DocumentPatch(BaseModel):
    title: str | None = None
    authors: str | None = None
    year: str | None = None
    publisher: str | None = None
    kind: DocKind | None = None
    script: DocScript | None = None
    notes: str | None = None


class PageBrief(BaseModel):
    id: int
    page_no: int
    status: str
    engine: str
    width: int
    height: int
    segments: int = 0
    figures: int = 0
    snippet: str = ""
    error: str = ""


class SegmentOut(BaseModel):
    id: int
    document_id: int
    page_id: int
    page_no: int
    seq: int
    kind: str
    text: str
    text_edit: str
    bbox: list[float]
    confidence: float | None
    review_status: str
    revision: int
    note: str


class SegmentPatch(BaseModel):
    text_edit: str | None = None
    kind: SegmentKind | None = None
    review_status: SegmentReview | None = None
    note: str | None = None
    base_revision: int | None = None      # 并发保护：给出时与当前 revision 不一致则 409


class FigureOut(BaseModel):
    id: int
    document_id: int
    page_id: int
    page_no: int
    seq: int
    bbox: list[float]
    caption: str
    label: str
    review_status: str
    note: str
    has_image: bool


class FigurePatch(BaseModel):
    caption: str | None = None
    label: str | None = None
    review_status: SegmentReview | None = None
    note: str | None = None


class PageDetail(BaseModel):
    id: int
    document_id: int
    document_code: str
    document_title: str
    page_no: int
    page_count: int
    status: str
    engine: str
    width: int
    height: int
    text: str
    error: str
    stats: dict[str, Any] = Field(default_factory=dict)
    segments: list[SegmentOut]
    figures: list[FigureOut]


class OcrStartIn(BaseModel):
    engine: OcrEngine | None = None          # 缺省按文献 script：modern -> mineru，classical -> ndl
    pages: list[int] | None = None           # 物理页号；缺省 = 全部未完成页
    redo: bool = False                       # 已完成的页也重做
    backend: str = ""                        # mineru 后端：hybrid-engine（默认）/ vlm-engine / pipeline


class OcrJobOut(BaseModel):
    running: bool
    document_id: int | None = None
    engine: str = ""
    total: int = 0
    done: int = 0
    errors: int = 0
    current_page: int | None = None
    started_at: str | None = None
    finished_at: str | None = None
    message: str = ""
    cancel_requested: bool = False


class OcrWorkerInfo(BaseModel):
    engine: str
    python: str | None
    available: bool
    alive: bool
    detail: str = ""


class OcrStatusOut(BaseModel):
    workers: list[OcrWorkerInfo]
    job: OcrJobOut
    log: str


class SearchHit(BaseModel):
    segment_id: int
    document_id: int
    document_code: str
    document_title: str
    page_id: int
    page_no: int
    kind: str
    snippet: str
    text: str


class LibraryScanReport(BaseModel):
    documents: int
    added: int
    updated: int
    removed: int
    duration_ms: int


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
    level: str = ""
    review_status: str = "reviewed"


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
