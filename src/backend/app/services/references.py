# -*- coding: utf-8 -*-
"""节点引用：追加研究依据、独立解除、来源快照及失效状态。"""
from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Annotation, AnnotationReference, Asset, Document, Figure, Page, Segment, Stone, now
from ..schemas import AnnotationReferenceCreate, AnnotationReferenceOut
from . import textlinks


def reference_key(r: AnnotationReference) -> tuple:
    if r.kind == "description":
        return r.kind, r.desc_source, r.desc_start, r.desc_end, r.text
    return r.kind, r.segment_id if r.kind == "segment" else r.figure_id, r.source_identity


def add_reference(db: Session, x: Annotation, body: AnnotationReferenceCreate) -> AnnotationReference:
    if not x.is_structural:
        raise HTTPException(422, "只有结构节点可以关联研究依据")
    textlinks.ensure_legacy_reference(x)
    if body.kind == "description":
        if body.desc_start is None or body.desc_end is None or body.segment_id is not None or body.figure_id is not None:
            raise HTTPException(422, "释文引用需要起止位置，不能同时指定文段或插图")
        source = body.desc_source or "description"
        duplicate = next((r for r in x.references if r.kind == "description" and r.desc_source == source
                          and r.desc_start == body.desc_start and r.desc_end == body.desc_end), None)
        excerpt = textlinks.validate_description(db, x, source, body.desc_start, body.desc_end, body.text,
                                                 replacing=duplicate)
        if duplicate:
            return duplicate
        r = AnnotationReference(kind="description", desc_source=source, desc_start=body.desc_start,
                                desc_end=body.desc_end, text=excerpt, figure_label="")
    else:
        if body.desc_source is not None or body.desc_start is not None or body.desc_end is not None:
            raise HTTPException(422, "文献引用不接受释文位置")
        if body.kind == "segment":
            if body.segment_id is None or body.figure_id is not None:
                raise HTTPException(422, "文段引用必须指定 segment_id")
            item = db.get(Segment, body.segment_id)
        else:
            if body.figure_id is None or body.segment_id is not None:
                raise HTTPException(422, "插图引用必须指定 figure_id")
            item = db.get(Figure, body.figure_id)
        if item is None:
            raise HTTPException(404, "引用的文段或插图不存在，请刷新书库")
        page = db.get(Page, item.page_id)
        doc = db.get(Document, item.document_id)
        if page is None or doc is None or page.document_id != doc.id:
            raise HTTPException(404, "引用来源的文献或页不存在")
        r = AnnotationReference(kind=body.kind, text=item.display_text if body.kind == "segment" else item.caption or "",
                                document_id=doc.id, document_title=doc.title, document_code=doc.code,
                                page_id=page.id, page_no=page.page_no,
                                segment_id=item.id if body.kind == "segment" else None,
                                figure_id=item.id if body.kind == "figure" else None,
                                figure_label=item.label or "" if body.kind == "figure" else "",
                                document_identity=doc.reference_identity, page_identity=page.reference_identity,
                                source_identity=item.reference_identity)
        duplicate = next((old for old in x.references if reference_key(old) == reference_key(r)), None)
        if duplicate:
            return duplicate
    x.references.append(r)
    textlinks.sync_legacy_link(x)
    x.updated_at = now()
    db.flush()
    return r


def remove_reference(db: Session, x: Annotation, reference_id: int) -> None:
    r = next((r for r in x.references if r.id == reference_id), None)
    if r is None:
        raise HTTPException(404, "该节点的引用不存在")
    x.references.remove(r)
    textlinks.sync_legacy_link(x)
    x.updated_at = now()
    db.flush()


def transfer_references(source: Annotation, target: Annotation) -> None:
    """候选并入时转移全部依据，同一来源重复引用只保留一条。"""
    textlinks.ensure_legacy_reference(source)
    textlinks.ensure_legacy_reference(target)
    have = {reference_key(r): r for r in target.references}
    for r in list(source.references):
        key = reference_key(r)
        source.references.remove(r)
        if key not in have:
            target.references.append(r)
            have[key] = r
        elif r.text == have[key].text:
            have[key].excerpts = list(have[key].excerpts or []) + [item for item in r.excerpts or [] if item not in (have[key].excerpts or [])]
    textlinks.sync_legacy_link(source)
    textlinks.sync_legacy_link(target)


def references_out(db: Session, refs: list[AnnotationReference]) -> list[AnnotationReferenceOut]:
    """批量校验来源；文献消失后仍保留标题、页码和引文快照。"""
    if not refs:
        return []

    def fetch(model, ids):
        ids = {i for i in ids if i is not None}
        return {v.id: v for v in db.query(model).filter(model.id.in_(ids)).all()} if ids else {}

    docs = fetch(Document, (r.document_id for r in refs))
    pages = fetch(Page, (r.page_id for r in refs))
    segments = fetch(Segment, (r.segment_id for r in refs))
    figures = fetch(Figure, (r.figure_id for r in refs))
    stones = fetch(Stone, (r.annotation.stone_id for r in refs if r.kind == "description"))
    out = []
    for r in refs:
        image_url = None
        page_id = r.page_id
        missing = False
        if r.kind == "description":
            stone = stones.get(r.annotation.stone_id)
            try:
                content = textlinks.source_text(stone, r.desc_source or "description")[0] if stone else ""
                missing = r.desc_start is None or r.desc_end is None or content[r.desc_start:r.desc_end] != r.text
            except HTTPException:
                missing = True
        else:
            doc, page = docs.get(r.document_id), pages.get(r.page_id)
            item = segments.get(r.segment_id) if r.kind == "segment" else figures.get(r.figure_id)
            page_valid = bool(doc is not None and r.document_identity
                              and doc.reference_identity == r.document_identity
                              and page is not None and r.page_identity
                              and page.reference_identity == r.page_identity
                              and page.document_id == r.document_id and page.page_no == r.page_no)
            if not page_valid:
                page_id = None
            missing = (not page_valid or item is None or not r.source_identity
                       or item.reference_identity != r.source_identity
                       or item.document_id != r.document_id or item.page_id != r.page_id)
            if not missing and r.kind == "figure":
                from .library import figure_image_path
                if figure_image_path(item) is not None:
                    image_url = f"/api/library/figures/{item.id}/image"
        out.append(AnnotationReferenceOut(
            id=r.id, annotation_id=r.annotation_id, kind=r.kind,
            desc_source=r.desc_source, desc_start=r.desc_start, desc_end=r.desc_end, text=r.text or "",
            document_id=r.document_id, document_title=r.document_title, document_code=r.document_code,
            page_id=page_id, page_no=r.page_no, segment_id=r.segment_id, figure_id=r.figure_id,
            figure_label=r.figure_label or "", image_url=image_url, source_missing=missing,
            excerpts=r.excerpts or []))
    return out


def prepare_excerpts(x: Annotation, items, semantics) -> dict[int, list[dict]]:
    """校验引用快照中的字符位置；先全部校验，再随标注保存一次提交。"""
    refs = {r.id: r for r in x.references}
    updates = {}
    for item in items:
        ref = refs.get(item.reference_id)
        if ref is None:
            raise HTTPException(422, "所选文献关联已不存在，请重新选择")
        if item.end <= item.start or item.end > len(ref.text) or ref.text[item.start:item.end] != item.text:
            raise HTTPException(422, "选中文字与引用原文不一致，请重新选择")
        if semantics is None or item.text not in getattr(semantics, item.field):
            raise HTTPException(422, "所选引文不在对应的图像描述中")
        excerpt = item.model_dump(exclude={"reference_id"})
        saved = updates.setdefault(ref.id, list(ref.excerpts or []))
        if excerpt not in saved:
            saved.append(excerpt)
    return updates


def page_annotations(db: Session, page: Page) -> list[dict]:
    """按持久来源身份反查书页中的图像标注，避免删除后复用页号造成错挂。"""
    from .serialize import annotation_out
    refs = db.query(AnnotationReference).filter(AnnotationReference.page_id == page.id).all()
    valid = references_out(db, refs)
    grouped = {}
    for r in valid:
        if r.page_id == page.id and not r.source_missing:
            grouped.setdefault(r.annotation_id, []).append(r)
    result = []
    for annotation_id, source_refs in grouped.items():
        annotation = db.get(Annotation, annotation_id)
        if annotation is None or not annotation.has_geometry or annotation.review_status == "rejected":
            continue
        asset, stone = db.get(Asset, annotation.asset_id), db.get(Stone, annotation.stone_id)
        if asset is None or stone is None or asset.is_model:
            continue
        result.append({"annotation": annotation_out(annotation), "stone_name": stone.name,
                       "asset_width": asset.width or 1, "asset_height": asset.height or 1,
                       "references": source_refs})
    return result
