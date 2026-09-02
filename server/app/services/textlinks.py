# -*- coding: utf-8 -*-
"""图文关联（研究模块）：标注 <-> 权威文本片段 的绑定与锁定保护。

文本源（source）：'description'（总述）或 'layer:N'（第 N 层释文）。
规则：
- 建立关联时区间必须落在当前文本内，且与该源上其他标注的区间不重叠；
- 保存文本时，每段已关联文字必须仍按原顺序存在，否则拒绝（409）；
  通过后自动重定位全部关联区间的偏移。
"""
from __future__ import annotations

from collections.abc import Callable

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Annotation, Layer, Stone


def source_text(stone: Stone, source: str) -> tuple[str, Stone | Layer]:
    """取文本源的当前内容与承载对象。"""
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


def linked_annotations(db: Session, stone_id: int, source: str,
                       exclude_id: int | None = None) -> list[Annotation]:
    q = (db.query(Annotation)
         .filter(Annotation.stone_id == stone_id,
                 Annotation.desc_source == source,
                 Annotation.desc_text != "",
                 Annotation.desc_start.isnot(None)))
    if exclude_id is not None:
        q = q.filter(Annotation.id != exclude_id)
    return q.order_by(Annotation.desc_start).all()


def save_text_with_links(db: Session, stone_id: int, source: str,
                         new_text: str, apply: Callable[[str], None]) -> None:
    """保存某文本源并保护该源上的已关联文字。"""
    links = linked_annotations(db, stone_id, source)
    pos = 0
    relocated: list[tuple[Annotation, int]] = []
    missing: list[str] = []
    for a in links:
        idx = new_text.find(a.desc_text, pos)
        if idx < 0:
            snippet = a.desc_text[:18] + ("…" if len(a.desc_text) > 18 else "")
            missing.append(f"「{snippet}」（标注 {a.label}）")
        else:
            relocated.append((a, idx))
            pos = idx + len(a.desc_text)
    if missing:
        raise HTTPException(409, "已关联的文字不可修改或删除：" + "；".join(missing))
    apply(new_text)
    for a, idx in relocated:
        a.desc_start = idx
        a.desc_end = idx + len(a.desc_text)


def clear_link(x: Annotation) -> None:
    x.desc_start = None
    x.desc_end = None
    x.desc_text = ""
    x.desc_source = "description"


def set_link(db: Session, x: Annotation, source: str, start: int, end: int, text: str) -> None:
    """建立/更新图文关联：校验区间合法且同一文本源内不与其他标注重叠。"""
    stone = db.get(Stone, x.stone_id)
    if not stone:
        raise HTTPException(404, "石头不存在")
    src_text, _ = source_text(stone, source)
    if not (0 <= start < end <= len(src_text)):
        raise HTTPException(422, "关联区间越界")
    if src_text[start:end] != text:
        raise HTTPException(409, "关联文字与当前内容不一致，请刷新后重试")
    for o in linked_annotations(db, x.stone_id, source, exclude_id=x.id):
        if not (end <= o.desc_start or start >= o.desc_end):
            raise HTTPException(409, f"该段文字与标注「{o.label}」的关联区间重叠")
    x.desc_source = source
    x.desc_start, x.desc_end, x.desc_text = start, end, text
    x.note = text          # 标注内容 = 关联的权威文字
