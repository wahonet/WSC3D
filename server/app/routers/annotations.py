# -*- coding: utf-8 -*-
"""标注（结构树节点）：按资产列出 / 创建 / 批量创建 / 编辑（含图文关联与结构字段） / 批量编辑 / 删除 / 候选并入。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..constants import CHILD_LEVEL
from ..db import get_db
from ..models import Annotation, Asset
from ..schemas import (
    AdoptIn, AnnotationBatchCreate, AnnotationBatchPatch, AnnotationBatchPatchItem, AnnotationCreate,
    AnnotationOut, AnnotationPatch, AnnotationReferenceCreate, AnnotationReferenceOut, IdList, OkOut, ParentSuggestion,
)
from ..services import references, structure, textlinks
from ..services.serialize import annotation_out, annotations_out
from .deps import get_annotation

router = APIRouter(prefix="/annotations", tags=["标注"])


@router.get("", response_model=list[AnnotationOut], summary="某资产的全部标注")
def list_by_asset(asset_id: int = Query(..., description="资产 id"), db: Session = Depends(get_db)):
    rows = db.query(Annotation).filter(Annotation.asset_id == asset_id).order_by(Annotation.id).all()
    return annotations_out(db, rows)


def _new(db: Session, body: AnnotationCreate) -> Annotation:
    a = db.get(Asset, body.asset_id)
    if not a:
        raise HTTPException(404, "资产不存在")
    if a.stone_id != body.stone_id:
        raise HTTPException(422, "stone_id 与资产所属石头不一致")
    if body.atype == "none":
        body.geometry = {}
    data = body.model_dump(exclude={"concept_ids", "auto_parent", "parent_id"})
    x = Annotation(**data)
    db.add(x)
    db.flush()
    if body.parent_id is not None:
        p = structure.validate_parent(db, x, body.parent_id)
        x.parent_id = body.parent_id
        if p and not x.level:
            x.level = CHILD_LEVEL.get(p.level, "figure")
    elif body.auto_parent and x.has_geometry:
        structure.apply_auto_parent_on_create(db, x)
    if body.concept_ids:
        structure.set_concepts(db, x, body.concept_ids)
    return x


@router.post("", response_model=AnnotationOut, status_code=201, summary="创建标注 / 结构节点")
def create(body: AnnotationCreate, db: Session = Depends(get_db)):
    """`auto_parent=true` 时按几何包含自动挂到最贴合的容器节点并推断层级；
    `atype='none'` 为尚无几何的骨架节点。"""
    x = _new(db, body)
    db.commit()
    return annotation_out(x)


@router.post("/batch", response_model=list[AnnotationOut], status_code=201,
             summary="批量创建标注（如一次保存多条分割候选）")
def create_batch(body: AnnotationBatchCreate, db: Session = Depends(get_db)):
    rows = [_new(db, item) for item in body.items]
    db.commit()
    return annotations_out(db, rows)


def _apply_structure(db: Session, x: Annotation, it: AnnotationBatchPatchItem | AnnotationPatch) -> None:
    """单条 / 批量共用：结构字段（父级、层级、类别、次序、审核状态）。"""
    if it.clear_parent:
        x.parent_id = None
    elif it.parent_id is not None:
        structure.validate_parent(db, x, it.parent_id)
        x.parent_id = it.parent_id
    if it.level is not None:
        x.level = it.level
    if it.category is not None:
        x.category = it.category
    if it.seq is not None:
        x.seq = it.seq
    if it.review_status is not None:
        x.review_status = it.review_status
    for k in ("label", "note", "color"):
        v = getattr(it, k)
        if v is not None:
            setattr(x, k, v)


@router.patch("/batch", response_model=list[AnnotationOut],
              summary="批量修改：名称 / 内容 / 颜色 / 父级 / 层级 / 类别 / 次序 / 审核状态")
def patch_batch(body: AnnotationBatchPatch, db: Session = Depends(get_db)):
    ids = [it.id for it in body.items]
    rows = {x.id: x for x in db.query(Annotation).filter(Annotation.id.in_(ids)).all()}
    missing = [i for i in ids if i not in rows]
    if missing:
        raise HTTPException(404, f"标注不存在：{missing[:5]}")
    for it in body.items:
        _apply_structure(db, rows[it.id], it)
    db.commit()
    return annotations_out(db, [rows[i] for i in ids])


@router.post("/batch-delete", response_model=OkOut, summary="批量删除（子节点上挂一级）")
def delete_batch(body: IdList, db: Session = Depends(get_db)):
    rows = db.query(Annotation).filter(Annotation.id.in_(body.ids)).all()
    for x in rows:
        structure.rehang_children(db, x)
    for x in rows:
        db.delete(x)
    db.commit()
    return OkOut(ok=True, message=f"已删除 {len(rows)} 条")


@router.patch("/{anno_id}", response_model=AnnotationOut, summary="编辑标注：内容 / 图文关联 / 结构 / 语义 / 挂接几何")
def patch(body: AnnotationPatch, x: Annotation = Depends(get_annotation),
          db: Session = Depends(get_db)):
    """兼容旧客户端：desc_* 更新第一条释文引用，clear_link=true 仅解除第一条。
    多条引用应使用 /references 追加与逐条删除；引用操作不覆盖 note。
    asset_id/atype/geometry 三者齐全即给节点挂接（替换）几何。concept_ids 整体替换概念集合。"""
    if body.clear_link:
        textlinks.clear_link(x)
    if body.desc_start is not None and body.desc_end is not None and body.desc_text is not None:
        textlinks.set_link(db, x, body.desc_source or "description",
                           body.desc_start, body.desc_end, body.desc_text)
    _apply_structure(db, x, body)
    if body.clear_seq:
        x.seq = None
    if body.quality is not None:
        x.quality = body.quality
    if body.geometry_intent is not None:
        x.geometry_intent = body.geometry_intent
    if body.semantics is not None:
        x.semantics = body.semantics.model_dump()
    if body.concept_ids is not None:
        structure.set_concepts(db, x, body.concept_ids)
    if body.atype is not None and body.geometry is not None:
        aid = body.asset_id if body.asset_id is not None else x.asset_id
        a = db.get(Asset, aid)
        if not a or a.stone_id != x.stone_id:
            raise HTTPException(422, "几何所在资产不存在或不属于同一石头")
        if a.is_model:
            raise HTTPException(422, "结构节点的几何须在 2D 图上")
        x.asset_id, x.atype, x.geometry = aid, body.atype, (body.geometry if body.atype != "none" else {})
        if x.tool not in ("annotate", "segment"):
            x.tool = "annotate"
    db.commit()
    return annotation_out(x)


@router.get("/{anno_id}/references", response_model=list[AnnotationReferenceOut], summary="节点的全部文献与图像引用")
def list_references(x: Annotation = Depends(get_annotation), db: Session = Depends(get_db)):
    return references.references_out(db, list(x.references))


@router.post("/{anno_id}/references", response_model=AnnotationOut, summary="追加释文、文段或插图引用")
def add_reference(body: AnnotationReferenceCreate, x: Annotation = Depends(get_annotation), db: Session = Depends(get_db)):
    references.add_reference(db, x, body)
    db.commit()
    return annotation_out(x)


@router.delete("/{anno_id}/references/{reference_id}", response_model=AnnotationOut, summary="仅解除指定引用")
def delete_reference(reference_id: int, x: Annotation = Depends(get_annotation), db: Session = Depends(get_db)):
    references.remove_reference(db, x, reference_id)
    db.commit()
    return annotation_out(x)


@router.get("/{anno_id}/parent-suggestions", response_model=list[ParentSuggestion],
            summary="按几何包含推荐父级（主图坐标系）")
def parent_suggestions(x: Annotation = Depends(get_annotation), db: Session = Depends(get_db)):
    return structure.suggest_parents(db, x.stone_id, x)


@router.post("/{anno_id}/adopt", response_model=AnnotationOut, summary="并入另一条标注的几何（并删除来源）")
def adopt(body: AdoptIn, x: Annotation = Depends(get_annotation), db: Session = Depends(get_db)):
    src = db.get(Annotation, body.source_id)
    if not src:
        raise HTTPException(404, "来源标注不存在")
    structure.adopt_geometry(db, x, src)
    db.commit()
    return annotation_out(x)


@router.delete("/{anno_id}", response_model=OkOut, summary="删除标注（子节点上挂一级）")
def delete(x: Annotation = Depends(get_annotation), db: Session = Depends(get_db)):
    n = structure.rehang_children(db, x)
    db.delete(x)
    db.commit()
    return OkOut(ok=True, message=f"已删除；{n} 个子节点上挂一级" if n else "已删除")
