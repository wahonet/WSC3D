# -*- coding: utf-8 -*-
"""Normalize MinerU's *physical* page blocks without loading an OCR model.

The exported content_list is a document-reading format: paragraph/table merging
can move a later page's content into an earlier page and clear its original
lines. A page-aligned annotation tool must use preproc_blocks instead. Never
combine those blocks with para_blocks or the merged content_list.
"""
from __future__ import annotations

import math
import re
from pathlib import Path

NORMALIZATION_VERSION = "mineru-physical-pages-v1"
KIND_MAP = {
    "text": "text", "title": "title", "ref_text": "text", "phonetic": "text",
    "header": "header", "footer": "header", "page_number": "page_number",
    "aside_text": "other", "page_footnote": "footnote", "footnote": "footnote",
    "list": "list", "code": "text", "code_body": "text", "code_caption": "caption",
    "equation": "equation", "interline_equation": "equation", "table": "table",
    "image_caption": "caption", "table_caption": "caption", "chart_caption": "caption",
    "image_footnote": "footnote", "table_footnote": "footnote", "chart_footnote": "footnote",
}
_SUP_RE = re.compile(r"(?<![A-Za-z0-9])(?:\$\s*)?\^\{\s*\[?([0-9]{1,3})\]?\s*\}(?:\s*\$)?")
_CJK = "\u4e00-\u9fff\u3000-\u303f\uff00-\uffef"
_LABEL_RE = re.compile(r"^\s*((?:图版|图|表|Fig\.?|Figure|Table|Plate)\s*[0-9一二三四五六七八九十]+(?:[.．\-－·][0-9]+)*)")


def clean_text(text: str) -> str:
    text = _SUP_RE.sub(r"[\1]", text)
    text = re.sub(rf"(?<=[{_CJK}])\s+(?=[{_CJK}\[])", "", text)
    text = re.sub(rf"(?<=\])\s+(?=[{_CJK}])", "", text)
    return text.strip()


def _bbox(block: dict, size: list) -> list[float]:
    box = block.get("bbox")
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        raise ValueError("MinerU physical block has no valid bbox")
    width, height = map(float, size)
    vals = [float(v) for v in box]
    if not all(math.isfinite(v) for v in vals):
        raise ValueError("MinerU physical block has non-finite bbox")
    result = [max(0., min(1., v / (width if i % 2 == 0 else height))) for i, v in enumerate(vals)]
    if result[2] < result[0] or result[3] < result[1]:
        raise ValueError("MinerU physical block has reversed bbox")
    return result


def _spans(block: dict):
    for line in block.get("lines") or []:
        yield from line.get("spans") or []
    for child in block.get("blocks") or []:
        yield from _spans(child)


def _text(block: dict) -> str:
    lines = []
    for line in block.get("lines") or []:
        parts = []
        for span in line.get("spans") or []:
            content = span.get("content")
            if content is None:
                continue
            if not isinstance(content, str):
                raise ValueError("Unsupported MinerU span content; expected a string")
            if span.get("type") in ("inline_equation", "interline_equation", "equation"):
                content = f"${content}$"
            parts.append(content)
        lines.append("".join(parts))
    # Preserve list items/code lines; ordinary CJK line breaks are joined by clean_text.
    own = clean_text("\n".join(lines))
    children = [_text(child) for child in block.get("blocks") or []]
    return "\n".join(t for t in [own, *children] if t)


def _image_path(block: dict, raw_dir: Path) -> str:
    for span in _spans(block):
        name = span.get("image_path")
        if name:
            rel = Path(name)
            if rel.is_absolute() or ".." in rel.parts:
                raise ValueError("MinerU image path must stay inside the raw output directory")
            candidate = raw_dir / rel if rel.parts[0] == "images" else raw_dir / "images" / rel
            return str(candidate)
    return ""


def _add_text(block: dict, size: list, acc: dict, kind: str | None = None, text: str | None = None) -> None:
    value = _text(block) if text is None else text
    if not value:
        return
    acc["blocks"].append({
        "kind": kind or KIND_MAP.get(block.get("type"), "other"), "text": value,
        "bbox": _bbox(block, size), "confidence": None,
        "extra": {"source": "preproc_blocks", "source_index": block.get("index"),
                  "source_type": block.get("type", "text")},
    })


def _absorb(block: dict, size: list, acc: dict, raw_dir: Path) -> None:
    typ = block.get("type", "text")
    if typ in ("image", "chart"):
        children = block.get("blocks") or []
        caps = [b for b in children if b.get("type") in ("image_caption", "chart_caption")]
        caption = "\n".join(_text(b) for b in caps if _text(b))
        cap_boxes = [_bbox(b, size) for b in caps if _text(b)]
        cap_box = [min(b[0] for b in cap_boxes), min(b[1] for b in cap_boxes),
                   max(b[2] for b in cap_boxes), max(b[3] for b in cap_boxes)] if cap_boxes else None
        match = _LABEL_RE.match(caption)
        acc["figures"].append({"bbox": _bbox(block, size), "image_path": _image_path(block, raw_dir),
                               "caption": caption, "caption_bbox": cap_box,
                               "label": match.group(1).replace(" ", "") if match else "",
                               "extra": {"type": typ, "sub_type": block.get("sub_type", "")}})
        for child in children:
            if child.get("type") not in ("image_body", "chart_body"):
                _add_text(child, size, acc)
        return
    if typ == "table":
        bodies = [b for b in block.get("blocks") or [] if b.get("type") == "table_body"]
        html = "\n".join(str(span["html"]) for body in (bodies or [block])
                         for span in _spans(body) if span.get("html"))
        _add_text(block, size, acc, "table", html or _text(block))
        for child in block.get("blocks") or []:
            if child.get("type") != "table_body":
                _add_text(child, size, acc)
        return
    if typ == "code" and block.get("blocks"):
        for child in block["blocks"]:
            _add_text(child, size, acc)
        return
    _add_text(block, size, acc)


def normalize_mineru_output(middle: dict, pages: list[int], raw_dir: Path,
                           engine: str, seconds: float = 0) -> dict[str, dict]:
    """Map one contiguous parse batch to its requested 1-based physical pages.

    Accept explicit zero-based relative or absolute page_idx values. Missing,
    duplicate or unexpected indices fail the batch instead of marking an empty
    or wrong physical page as done. A genuinely blank preproc_blocks=[] is valid.
    """
    if not pages or pages != list(range(pages[0], pages[-1] + 1)) or pages[0] < 1:
        raise ValueError("MinerU pages must be a unique contiguous 1-based range")
    entries = middle.get("pdf_info")
    if not isinstance(entries, list) or len(entries) != len(pages):
        raise ValueError("MinerU physical page count differs from requested page range")
    if any(not isinstance(p, dict) or not isinstance(p.get("page_idx"), int) for p in entries):
        raise ValueError("MinerU middle output must identify every physical page")
    indices = [p["page_idx"] for p in entries]
    if len(set(indices)) != len(indices):
        raise ValueError("MinerU middle output contains duplicate physical page indices")
    if set(indices) == set(range(len(pages))):
        mapped = {pages[p["page_idx"]]: p for p in entries}
    elif set(indices) == {p - 1 for p in pages}:
        mapped = {p["page_idx"] + 1: p for p in entries}
    else:
        raise ValueError("MinerU middle output has missing or unexpected physical page indices")
    result = {}
    for page_no in pages:
        page = mapped[page_no]
        if not isinstance(page.get("preproc_blocks"), list):
            raise ValueError("MinerU has no original physical blocks; refusing merged paragraph output")
        size = page.get("page_size")
        if not isinstance(size, (list, tuple)) or len(size) != 2 or not all(math.isfinite(float(x)) and float(x) > 0 for x in size):
            raise ValueError("MinerU physical page has no valid page_size")
        acc = {"blocks": [], "figures": []}
        # List order is the model's reading order (including multiple columns),
        # not geometric y order. Keep headers/footers separately at the end.
        for block in page["preproc_blocks"]:
            _absorb(block, size, acc, Path(raw_dir))
        for block in page.get("discarded_blocks") or []:
            _absorb(block, size, acc, Path(raw_dir))
        for key in ("blocks", "figures"):
            for seq, block in enumerate(acc[key]):
                block["seq"] = seq
        result[str(page_no)] = {
            "page_no": page_no, "engine": engine, "seconds": round(seconds / len(pages), 3),
            "text": "\n".join(b["text"] for b in acc["blocks"] if b["kind"] not in ("header", "page_number")),
            **acc, "raw_dir": str(raw_dir),
            "extra": {"normalization": NORMALIZATION_VERSION, "source": "middle.preproc_blocks",
                      "physical_blocks": len(page["preproc_blocks"]),
                      "merged_away_blocks": sum(bool(b.get("lines_deleted")) for b in page.get("para_blocks") or [])},
        }
    return result
