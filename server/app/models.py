# -*- coding: utf-8 -*-
"""ORM 模型：石头 / 分层释文 / 资产 / 标注（结构树节点） / 概念 / 标注-概念关联 / 文献库（文献、页、文段、插图）。

表结构与既有数据库兼容；新增列一律通过 migrations.py 以 ALTER 补齐。
"""
from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def now() -> datetime:
    return datetime.now()


def reference_identity() -> str:
    """来源的持久身份；SQLite 复用数字主键也不能让旧引用指向新资料。"""
    return uuid4().hex


class Stone(Base):
    __tablename__ = "stones"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)   # WS-003
    name: Mapped[str] = mapped_column(String(128))                          # 武梁祠西壁
    dirname: Mapped[str] = mapped_column(String(256))
    era: Mapped[str] = mapped_column(String(128), default="")
    material: Mapped[str] = mapped_column(String(128), default="")
    carving: Mapped[str] = mapped_column(String(128), default="")           # 刻法
    dims_text: Mapped[str] = mapped_column(String(256), default="")
    location: Mapped[str] = mapped_column(String(256), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)

    layers: Mapped[list["Layer"]] = relationship(
        back_populates="stone", cascade="all, delete-orphan", order_by="Layer.seq")
    assets: Mapped[list["Asset"]] = relationship(
        back_populates="stone", cascade="all, delete-orphan")


class Layer(Base):
    __tablename__ = "layers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    stone_id: Mapped[int] = mapped_column(ForeignKey("stones.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(128))
    summary: Mapped[str] = mapped_column(Text, default="")

    stone: Mapped[Stone] = relationship(back_populates="layers")


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    stone_id: Mapped[int] = mapped_column(ForeignKey("stones.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)
    filename: Mapped[str] = mapped_column(String(256))
    relpath: Mapped[str] = mapped_column(String(512), unique=True)
    bytes: Mapped[int] = mapped_column(Integer, default=0)
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    fmt: Mapped[str] = mapped_column(String(16), default="")
    # extra: 模型的 mtl/textures；2D 资产的 is_master 与 align_to_master（主图坐标链）
    extra: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

    stone: Mapped[Stone] = relationship(back_populates="assets")
    annotations: Mapped[list["Annotation"]] = relationship(
        back_populates="asset", cascade="all, delete-orphan")

    @property
    def is_model(self) -> bool:
        return self.kind.startswith("model")

    @property
    def is_master(self) -> bool:
        return bool((self.extra or {}).get("is_master"))

    @property
    def chain(self) -> dict | None:
        return (self.extra or {}).get("align_to_master")


class Annotation(Base):
    """标注 = 图像结构树的节点。

    几何（asset_id / atype / geometry）可为空（atype='none'）：这类"骨架节点"先由释文生成，
    之后再在图上绘制或从机器候选并入几何。
    """
    __tablename__ = "annotations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    stone_id: Mapped[int] = mapped_column(ForeignKey("stones.id"), index=True)
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id"), index=True)
    tool: Mapped[str] = mapped_column(String(16))      # annotate / measure / segment / align
    atype: Mapped[str] = mapped_column(String(16))     # rect / polygon / point / line / point3d / line3d / align / none
    geometry: Mapped[dict] = mapped_column(JSON)       # 2D 用 0..1 归一化坐标；none 时为 {}
    label: Mapped[str] = mapped_column(String(256), default="未命名")
    note: Mapped[str] = mapped_column(Text, default="")
    color: Mapped[str] = mapped_column(String(16), default="#e8a33d")
    value: Mapped[float | None] = mapped_column(Float, nullable=True)
    unit: Mapped[str] = mapped_column(String(16), default="")
    # 图文关联：绑定到某段权威文本的字符区间（研究模块）
    # desc_source: 'description'（总述）或 'layer:N'（第 N 层释文）
    desc_source: Mapped[str] = mapped_column(String(32), default="description")
    desc_start: Mapped[int | None] = mapped_column(Integer, nullable=True)
    desc_end: Mapped[int | None] = mapped_column(Integer, nullable=True)
    desc_text: Mapped[str] = mapped_column(Text, default="")
    # 结构树（沿用 WSC3D 标注 SOP）：父节点 / 结构层级 / 一层类别 / 同级次序 / 审核状态 / 质量 / 几何语义
    parent_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    level: Mapped[str] = mapped_column(String(16), default="")           # constants.LEVELS，空 = 未定
    category: Mapped[str] = mapped_column(String(32), default="")        # constants.CATEGORIES，空 = 未定
    seq: Mapped[int | None] = mapped_column(Integer, nullable=True)      # 同级次序；层节点 = 释文层号
    review_status: Mapped[str] = mapped_column(String(16), default="reviewed")
    quality: Mapped[str] = mapped_column(String(8), default="")
    geometry_intent: Mapped[str] = mapped_column(String(24), default="")
    # 图像志三层文本 + 榜题：{pre_iconographic, iconographic, iconological,
    #                        inscription: {transcription, translation, notes}}
    semantics: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)

    asset: Mapped[Asset] = relationship(back_populates="annotations")
    concept_links: Mapped[list["AnnotationConcept"]] = relationship(
        back_populates="annotation", cascade="all, delete-orphan")
    references: Mapped[list["AnnotationReference"]] = relationship(
        back_populates="annotation", cascade="all, delete-orphan", order_by="AnnotationReference.id",
        lazy="selectin")

    @property
    def is_linked(self) -> bool:
        return bool(self.references) or (bool(self.desc_text) and self.desc_start is not None)

    @property
    def has_geometry(self) -> bool:
        return self.atype not in ("none", "") and bool(self.geometry)

    @property
    def is_structural(self) -> bool:
        """结构树节点：排除测量与对齐记录。"""
        return self.tool in ("annotate", "segment") and self.atype != "align"


class AnnotationReference(Base):
    """节点的多条研究依据；源元数据与引文保存快照，OCR 重建不会级联删除引用。

    只有 annotation_id 建外键；文献、页、文段和插图 id 是可失效的来源锚点。
    源已不存在时仍返回快照，并由序列化器明确标记 source_missing。
    """
    __tablename__ = "annotation_references"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    annotation_id: Mapped[int] = mapped_column(ForeignKey("annotations.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    desc_source: Mapped[str | None] = mapped_column(String(32), nullable=True)
    desc_start: Mapped[int | None] = mapped_column(Integer, nullable=True)
    desc_end: Mapped[int | None] = mapped_column(Integer, nullable=True)
    text: Mapped[str] = mapped_column(Text, default="")
    document_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    document_title: Mapped[str | None] = mapped_column(String(256), nullable=True)
    document_code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    page_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    page_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    segment_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    figure_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    figure_label: Mapped[str] = mapped_column(String(64), default="")
    document_identity: Mapped[str | None] = mapped_column(String(32), nullable=True)
    page_identity: Mapped[str | None] = mapped_column(String(32), nullable=True)
    source_identity: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

    annotation: Mapped[Annotation] = relationship(back_populates="references")


class Concept(Base):
    """概念词：挂在 knowledge.CONCEPT_CATEGORIES 的末级分类下，跨石头共享。"""
    __tablename__ = "concepts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    category_id: Mapped[str] = mapped_column(String(48), index=True, default="")
    aliases: Mapped[list] = mapped_column(JSON, default=list)
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)

    links: Mapped[list["AnnotationConcept"]] = relationship(
        back_populates="concept", cascade="all, delete-orphan")


class AnnotationConcept(Base):
    __tablename__ = "annotation_concepts"

    annotation_id: Mapped[int] = mapped_column(ForeignKey("annotations.id"), primary_key=True)
    concept_id: Mapped[int] = mapped_column(ForeignKey("concepts.id"), primary_key=True)
    role: Mapped[str] = mapped_column(String(16), default="subject")   # subject / attribute / motif

    annotation: Mapped[Annotation] = relationship(back_populates="concept_links")
    concept: Mapped[Concept] = relationship(back_populates="links")


# ================================================================ 文献库
class Document(Base):
    """一部文献（书 / 论文 / 图录）= assets/library 下的一个 PDF。"""
    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    reference_identity: Mapped[str] = mapped_column(String(32), default=reference_identity)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)     # DOC-001
    title: Mapped[str] = mapped_column(String(256), default="")
    authors: Mapped[str] = mapped_column(String(256), default="")
    year: Mapped[str] = mapped_column(String(32), default="")
    publisher: Mapped[str] = mapped_column(String(128), default="")
    kind: Mapped[str] = mapped_column(String(16), default="book")             # book / article / catalog / other
    script: Mapped[str] = mapped_column(String(16), default="modern")         # modern 现代横排 / classical 古籍竖排
    relpath: Mapped[str] = mapped_column(String(512), unique=True)             # 相对 library_root
    sha256: Mapped[str] = mapped_column(String(64), default="")
    bytes: Mapped[int] = mapped_column(Integer, default=0)
    page_count: Mapped[int] = mapped_column(Integer, default=0)
    has_text_layer: Mapped[bool] = mapped_column(Boolean, default=False)      # PDF 自带文字层
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)

    pages: Mapped[list["Page"]] = relationship(back_populates="document", cascade="all, delete-orphan",
                                               order_by="Page.page_no")


class Page(Base):
    """物理页：OCR 状态、页图指纹与阅读顺序全文。"""
    __tablename__ = "doc_pages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    reference_identity: Mapped[str] = mapped_column(String(32), default=reference_identity)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id"), index=True)
    page_no: Mapped[int] = mapped_column(Integer)                             # 1-based 物理页
    width: Mapped[int] = mapped_column(Integer, default=0)                    # OCR 页图像素
    height: Mapped[int] = mapped_column(Integer, default=0)
    image_sha256: Mapped[str] = mapped_column(String(64), default="")
    status: Mapped[str] = mapped_column(String(16), default="pending")        # pending / running / done / error / skipped
    engine: Mapped[str] = mapped_column(String(32), default="")               # mineru / ndl
    text: Mapped[str] = mapped_column(Text, default="")                       # 按阅读顺序拼接的全页文字
    error: Mapped[str] = mapped_column(Text, default="")
    stats: Mapped[dict] = mapped_column(JSON, default=dict)                   # {segments, figures, confidence, seconds}
    ocr_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    document: Mapped[Document] = relationship(back_populates="pages")
    segments: Mapped[list["Segment"]] = relationship(back_populates="page", cascade="all, delete-orphan",
                                                     order_by="Segment.seq")
    figures: Mapped[list["Figure"]] = relationship(back_populates="page", cascade="all, delete-orphan",
                                                   order_by="Figure.seq")


class Segment(Base):
    """文段：一页里的一个版面块（正文段落 / 标题 / 图注 / 脚注 / 页眉 / 表格 / 古籍行）。

    text 为机器底稿（只读），text_edit 为人工校订稿；引用锚点 = (文献, 物理页, 文段序号)。
    """
    __tablename__ = "segments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    reference_identity: Mapped[str] = mapped_column(String(32), default=reference_identity)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id"), index=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("doc_pages.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)                                 # 页内阅读顺序
    kind: Mapped[str] = mapped_column(String(24), default="text")             # text/title/caption/footnote/header/page_number/table/equation/list/line/other
    text: Mapped[str] = mapped_column(Text, default="")
    text_edit: Mapped[str] = mapped_column(Text, default="")
    bbox: Mapped[list] = mapped_column(JSON, default=list)                    # [x0,y0,x1,y1] 归一化 0..1
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    review_status: Mapped[str] = mapped_column(String(16), default="machine") # machine / reviewed / rejected
    revision: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)

    page: Mapped[Page] = relationship(back_populates="segments")

    @property
    def display_text(self) -> str:
        return self.text_edit or self.text


class Figure(Base):
    """文献插图：版面中的图块 + 绑定的图注（如"图版2.34 东阙第二层墓阙北面画像"）。"""
    __tablename__ = "figures"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    reference_identity: Mapped[str] = mapped_column(String(32), default=reference_identity)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id"), index=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("doc_pages.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    bbox: Mapped[list] = mapped_column(JSON, default=list)
    image_relpath: Mapped[str] = mapped_column(String(512), default="")      # 裁片，相对 library_data_dir
    caption: Mapped[str] = mapped_column(Text, default="")
    label: Mapped[str] = mapped_column(String(64), default="")               # 图1.1 / 图版2.34 / 表2-2
    caption_bbox: Mapped[list | None] = mapped_column(JSON, nullable=True)
    review_status: Mapped[str] = mapped_column(String(16), default="machine")
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

    page: Mapped[Page] = relationship(back_populates="figures")
