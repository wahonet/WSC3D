"""Bindings for explicitly imported knowledge candidates; existing annotations stay intact."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base
from .models import now


class KnowledgeGraphBinding(Base):
    __tablename__ = "knowledge_graph_bindings"
    __table_args__ = (UniqueConstraint("dataset_id", "stone_id", "node_id", "story_id", name="uq_knowledge_graph_occurrence"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dataset_id: Mapped[str] = mapped_column(String(128))
    stone_id: Mapped[str] = mapped_column(ForeignKey("stones.id", ondelete="CASCADE"), index=True)
    node_id: Mapped[str] = mapped_column(String(256))
    # Shared persons/objects have one concept but a separate image occurrence in each story.
    story_id: Mapped[str] = mapped_column(String(256), default="")
    annotation_id: Mapped[int] = mapped_column(ForeignKey("annotations.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class KnowledgeGraphConcept(Base):
    """Keep candidate identity stable when a researcher edits a concept's name."""
    __tablename__ = "knowledge_graph_concepts"
    __table_args__ = (UniqueConstraint("dataset_id", "node_id", name="uq_knowledge_graph_concept"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dataset_id: Mapped[str] = mapped_column(String(128))
    node_id: Mapped[str] = mapped_column(String(256))
    concept_id: Mapped[int | None] = mapped_column(ForeignKey("concepts.id", ondelete="SET NULL"), index=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class AnnotationKnowledgeLink(Base):
    """Several image regions may name the same book entity without merging shapes."""
    __tablename__ = "annotation_knowledge_links"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    annotation_id: Mapped[int] = mapped_column(ForeignKey("annotations.id", ondelete="CASCADE"), unique=True, index=True)
    dataset_id: Mapped[str] = mapped_column(String(128))
    stone_id: Mapped[str] = mapped_column(ForeignKey("stones.id", ondelete="CASCADE"), index=True)
    node_id: Mapped[str] = mapped_column(String(256))
    story_id: Mapped[str] = mapped_column(String(256), default="")
    reference_ids: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
