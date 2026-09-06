# -*- coding: utf-8 -*-
"""总述 / 分层释文的多条引用、文字锁定与偏移重定位。

Annotation.desc_* 保留为第一条释文引用的兼容投影；新的增删接口操作具体引用。
"""
from __future__ import annotations

from collections.abc import Callable

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Annotation, AnnotationReference, Layer, Stone


def source_text(stone: Stone, source: str) -> tuple[str, Stone | Layer]:
    if source == "description":
        return stone.description or "", stone
    if source.startswith("layer:"):
        try:
            seq = int(source.split(":", 1)[1])
        except ValueError:
            raise HTTPException(422, f"非法文本源：{source}")
        lay = next((l for l in stone.layers if l.seq == seq), None)
        if lay is None:
            raise HTTPException(404, f"第 {seq} 层释文不存在")
        return lay.summary or "", lay
    raise HTTPException(422, f"未知文本源：{source}")


def ensure_legacy_reference(x: Annotation) -> None:
    """兼容由旧脚本创建的单条关联，不覆盖现有引用。"""
    if not x.desc_text or x.desc_start is None or x.desc_end is None:
        return
    source = x.desc_source or "description"
    if any(r.kind == "description" and r.desc_source == source and r.desc_start == x.desc_start
           and r.desc_end == x.desc_end and r.text == x.desc_text for r in x.references):
        return
    x.references.append(AnnotationReference(kind="description", desc_source=source,
                                            desc_start=x.desc_start, desc_end=x.desc_end,
                                            text=x.desc_text, figure_label=""))


def description_references(x: Annotation) -> list[AnnotationReference]:
    return sorted((r for r in x.references if r.kind == "description"),
                  key=lambda r: r.id if r.id is not None else float("inf"))


def sync_legacy_link(x: Annotation) -> None:
    refs = description_references(x)
    if refs:
        r = refs[0]
        x.desc_source, x.desc_start, x.desc_end, x.desc_text = r.desc_source, r.desc_start, r.desc_end, r.text
    else:
        x.desc_source, x.desc_start, x.desc_end, x.desc_text = "description", None, None, ""


def linked_references(db: Session, stone_id: int, source: str) -> list[AnnotationReference]:
    # 从关系读取可同时看到本事务中尚未 flush 的新增 / 删除引用。
    rows = db.query(Annotation).filter(Annotation.stone_id == stone_id).all()
    refs = []
    for x in rows:
        ensure_legacy_reference(x)
        refs.extend(r for r in x.references if r.kind == "description" and r.desc_source == source
                    and r.desc_start is not None and r.desc_end is not None and r.text)
    return sorted(refs, key=lambda r: (r.desc_start, r.desc_end))


def linked_annotations(db: Session, stone_id: int, source: str,
                       exclude_id: int | None = None) -> list[Annotation]:
    """旧调用的节点视图；校验与重定位使用 linked_references 逐条处理。"""
    seen = set()
    rows = []
    for r in linked_references(db, stone_id, source):
        x = r.annotation
        if x.id != exclude_id and x.id not in seen:
            seen.add(x.id)
            rows.append(x)
    return rows


def save_text_with_links(db: Session, stone_id: int, source: str,
                         new_text: str, apply: Callable[[str], None]) -> None:
    links = linked_references(db, stone_id, source)
    pos = 0
    relocated: list[tuple[AnnotationReference, int]] = []
    missing: list[str] = []
    # 相同的历史区间共用一次查找，历史共享引用不会误判为文字消失。
    positions: dict[tuple[int, int, str], int] = {}
    for r in links:
        key = (r.desc_start, r.desc_end, r.text)
        idx = positions.get(key)
        if idx is None:
            idx = new_text.find(r.text, pos)
            if idx >= 0:
                positions[key] = idx
                pos = idx + len(r.text)
        if idx < 0:
            snippet = r.text[:18] + ("…" if len(r.text) > 18 else "")
            missing.append(f"「{snippet}」（标注 {r.annotation.label}）")
        else:
            relocated.append((r, idx))
    if missing:
        raise HTTPException(409, "已关联的文字不可修改或删除：" + "；".join(missing))
    apply(new_text)
    for r, idx in relocated:
        r.desc_start, r.desc_end = idx, idx + len(r.text)
    for x in {r.annotation for r, _ in relocated}:
        sync_legacy_link(x)


def validate_description(db: Session, x: Annotation, source: str, start: int, end: int,
                         text: str | None, replacing: AnnotationReference | None = None) -> str:
    stone = db.get(Stone, x.stone_id)
    if not stone:
        raise HTTPException(404, "石头不存在")
    src_text, _ = source_text(stone, source)
    if not (0 <= start < end <= len(src_text)):
        raise HTTPException(422, "关联区间越界")
    excerpt = src_text[start:end]
    if text is not None and excerpt != text:
        raise HTTPException(409, "关联文字与当前内容不一致，请刷新后重试")
    for r in linked_references(db, x.stone_id, source):
        if r is replacing:
            continue
        if not (end <= r.desc_start or start >= r.desc_end):
            raise HTTPException(409, f"该段文字与标注「{r.annotation.label}」的关联区间重叠")
    return excerpt


def clear_link(x: Annotation) -> None:
    """旧 clear_link 仅解除兼容投影指向的第一条，不影响其余引用。"""
    ensure_legacy_reference(x)
    refs = description_references(x)
    if refs:
        x.references.remove(refs[0])
    sync_legacy_link(x)


def set_link(db: Session, x: Annotation, source: str, start: int, end: int, text: str) -> None:
    """旧 PATCH 更新首条释文引用；保留其他引用和用户说明。"""
    ensure_legacy_reference(x)
    refs = description_references(x)
    first = refs[0] if refs else None
    text = validate_description(db, x, source, start, end, text, replacing=first)
    if first is None:
        first = AnnotationReference(kind="description", figure_label="")
        x.references.append(first)
    first.desc_source, first.desc_start, first.desc_end, first.text = source, start, end, text
    sync_legacy_link(x)