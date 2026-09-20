"""Knowledge candidates are read-only until an explicit materialize request."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..services import knowledge_graph
from .archive import same_origin

router = APIRouter(prefix="/knowledge-graph", tags=["知识图谱"])
Kind = Literal["stone", "story", "person", "object"]


class CandidateSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    node_id: str = Field(min_length=1, max_length=256)
    story_id: str | None = Field(None, max_length=256)


class MaterializeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: int | None = Field(None, gt=0)
    items: list[CandidateSelection] = Field(min_length=1, max_length=100)


class AttachIn(CandidateSelection):
    annotation_id: int = Field(gt=0)
    evidence_ids: list[str] | None = Field(None, max_length=1000)


@router.get("")
def graph(stone_id: str | None = None, q: str = Query("", max_length=200), kind: Kind | None = None,
          limit: int = Query(1000, ge=1, le=3000), db: Session = Depends(get_db)):
    return knowledge_graph.graph(db, stone_id=stone_id, q=q.strip(), kind=kind, limit=limit)


@router.get("/candidates")
def candidates(kind: Kind | None = None, stone_id: str | None = None, story_id: str | None = None,
               q: str = Query("", max_length=200), limit: int = Query(60, ge=1, le=1000), db: Session = Depends(get_db)):
    return knowledge_graph.candidates(db, kind=kind, stone_id=stone_id, story_id=story_id, q=q.strip(), limit=limit)


@router.get("/nodes/{node_id}")
def node(node_id: str, limit: int = Query(1000, ge=1, le=3000), db: Session = Depends(get_db)):
    return knowledge_graph.graph(db, node_id=node_id, limit=limit)


@router.get("/stones/{stone_id}/candidates")
def stone_candidates(stone_id: str, db: Session = Depends(get_db)):
    return knowledge_graph.stone_candidates(db, stone_id)


@router.get('/stones/{stone_id}/literature')
def stone_literature(stone_id: str, db: Session = Depends(get_db)):
    from ..services.stone_knowledge import literature
    return literature(db, stone_id)


@router.post('/stones/{stone_id}/attach')
def attach(stone_id: str, body: AttachIn, request: Request, db: Session = Depends(get_db)):
    same_origin(request)
    return knowledge_graph.attach(db, stone_id, body.annotation_id, body.node_id, body.story_id, body.evidence_ids)


@router.post("/stones/{stone_id}/materialize")
def materialize(stone_id: str, body: MaterializeIn, request: Request, db: Session = Depends(get_db)):
    same_origin(request)
    return knowledge_graph.materialize(db, stone_id, [item.model_dump() for item in body.items], body.asset_id)
