# -*- coding: utf-8 -*-
"""ORM 模型：石头 / 分层释文 / 资产 / 标注（结构树节点） / 概念 / 标注-概念关联。

表结构与既有数据库兼容；新增列一律通过 migrations.py 以 ALTER 补齐。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def now() -> datetime:
    return datetime.now()


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

    @property
    def is_linked(self) -> bool:
        return bool(self.desc_text) and self.desc_start is not None

    @property
    def has_geometry(self) -> bool:
        return self.atype not in ("none", "") and bool(self.geometry)

    @property
    def is_structural(self) -> bool:
        """结构树节点：排除测量与对齐记录。"""
        return self.tool in ("annotate", "segment") and self.atype != "align"


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
