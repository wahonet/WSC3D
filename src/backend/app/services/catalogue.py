"""The unified business database owns identity cards; source files are resources only."""
from __future__ import annotations
import json
from functools import lru_cache
from urllib.parse import quote
from sqlalchemy import text
from sqlalchemy.orm import Session
from ..config import settings
from ..resource_paths import resolve_resource
from ..models import Stone
from .catalogue_presentation import public_aliases, public_version, VERSION_ORDER


def metadata(stone: Stone) -> dict:
    value = (stone.archive or {}).get("metadata", {})
    return json.loads(value) if isinstance(value, str) else value


def decode(value, fallback):
    if isinstance(value, str):
        return json.loads(value) if value else fallback
    return value if value is not None else fallback


def brief(stone: Stone) -> dict:
    row, meta = stone.archive or {}, metadata(stone)
    media, photos = decode(row.get("media"), []), decode(row.get("photos"), [])
    grading = meta.get("grading")
    return {"id": stone.id, "catalogue_no": stone.id, "legacy_id": stone.id,
            "name": stone.name, "location": row.get("location", stone.location),
            "size_cm": decode(row.get("size_cm"), None), "size_source": row.get("size_source"),
            "size_display": meta.get("size_display") or "", "condition": row.get("condition") or "",
            "note": row.get("note") or "", "photo_count": sum(len(b["files"]) for b in photos) + len(media),
            "has_model": bool(row.get("model")), "has_rubbing": any(x.get("kind") == "rubbing" for x in media),
            "has_intro": bool(row.get("intro")), "classification_no": meta.get("classification_no") or "",
            "collections": meta.get("collections") or [], "display_order": row.get("display_order", 9999),
            "aliases": [a for a in public_aliases(meta.get("aliases")) if a != stone.name],
            "grading": grading, "is_graded": bool(grading and grading.get("confirmed")), "media_keywords": ""}


def all_books(db: Session) -> list[dict]:
    return [json.loads(row[0]) for row in db.execute(text("SELECT payload FROM extension_books ORDER BY id"))]


@lru_cache(maxsize=2)
def _quality_at(mtime):
    path = settings.data_dir / 'library-quality.json'
    return {r['book_id']: r for r in json.loads(path.read_text(encoding='utf-8'))} if mtime else {}


def library_quality():
    path = settings.data_dir / 'library-quality.json'
    return _quality_at(path.stat().st_mtime_ns if path.is_file() else 0)


def book_view(book: dict) -> dict:
    meta = book.get("provenance", {})
    bid, filename = book["id"], book.get("file")
    local = resolve_resource(settings.extension_root / "books" / bid / (filename or ""))
    shared = resolve_resource(settings.extension_root / "library" / (filename or ""))
    pdf = (f"/files/books/{quote(bid)}/{quote(filename)}" if local.is_file() else f"/files/library/{quote(filename)}" if shared.is_file() else None) if filename else None
    return {**book, "quality": library_quality().get(bid, {}), "pdf": pdf, "cover": f"/files/books/{quote(bid)}/{quote(book['cover'])}" if book.get("cover") else None,
            "refs": book.get("refs", []), "ref_count": len(book.get("refs", [])),
            "text_index": meta.get("text_index"), "completeness": meta.get("completeness", ""),
            "import_batch": meta.get("import_batch", ""),
            "original_pdf": f"/files/library/{quote(meta['source_container_file'])}" if meta.get("source_container_file") else None}


def detail(stone: Stone, db: Session) -> dict:
    row, meta, out = stone.archive or {}, metadata(stone), brief(stone)
    prefix = "/files/" + quote(stone.id) + "/"
    photos = [{"batch": b["batch"], "photos": [prefix + "images/photos/" + quote((b["batch"] + "/" if b["batch"] else "") + f) for f in b["files"]]} for b in decode(row.get("photos"), [])]
    versions = {}
    for item in decode(row.get("media"), []):
        label = item['version'] if item.get('asset_id') and item.get('version') in ('本地新增照片', '本地新增拓片') else public_version(item.get("version"), item.get("kind", "photo"))
        group = versions.setdefault(label, {"id": label, "label": label, "kind": item.get("kind", "photo"), "items": []})
        asset_id = item.get('asset_id')
        group["items"].append({**item, "url": f'/api/assets/{asset_id}/preview' if asset_id else prefix + quote(item["file"]),
                               "thumbnail_url": f'/api/assets/{asset_id}/thumb' if asset_id else prefix + quote(item.get("thumbnail") or item["file"]),
                               "original_url": prefix + quote(item.get("original") or item["file"])})
    for batch in photos:
        label = public_version(batch["batch"])
        group = versions.setdefault(label, {"id": label, "label": label, "kind": "photo", "items": []})
        group["items"].extend({"id": url, "label": f"{stone.name} · 照片{i + 1}", "url": url, "thumbnail_url": url, "original_url": url} for i, url in enumerate(batch["photos"]))
    refs = [{"book": book["id"], "title": book["title"], "year": book["year"], "loc": ref.get("loc", ""), "note": ref.get("note", ""), "scope": "extension"}
            for book in all_books(db) for ref in book.get("refs", []) if ref.get("stone") == stone.id]
    out.update({"era": row.get("era", ""), "category": row.get("category", ""), "group": row.get("grp", ""), "surveyed": row.get("surveyed", ""),
                "intro": row.get("intro", ""), "research": row.get("research", ""),
                "media_versions": sorted(versions.values(), key=lambda v: VERSION_ORDER.index(v["id"]) if v["id"] in VERSION_ORDER else 999),
                "technique": meta.get("technique") or "待考", "material": meta.get("material") or "石", "catalogue": meta.get("catalogue") or {},
                "position_code": meta.get("position_code") or stone.id, "photos": [u for b in photos for u in b["photos"]],
                "photo_batches": photos, "book_refs": refs, "model": prefix + "models/gallery/" + quote(row["model"]) if row.get("model") else None,
                "model_info": meta.get("model_reconstruction"), "rubbing": prefix + quote(row["rubbing"]) if row.get("rubbing") else None})
    return out


def statistics(db: Session) -> dict:
    stones = db.query(Stone).all()
    rows = [brief(s) for s in stones]
    by_location = {}
    for row in rows:
        by_location[row["location"]] = by_location.get(row["location"], 0) + 1
    groups = json.loads((settings.locations_file).read_text(encoding="utf-8"))
    if isinstance(groups, dict):
        groups = groups.get("groups", [])
    by_area = {g["key"]: sum(by_location.get(loc, 0) for loc in g.get("locs", []) + g.get("children", [])) for g in groups}
    return {"total": len(rows), "by_location": by_location, "by_area": by_area,
            "measured": sum(r["size_source"] == "measured" for r in rows), "with_model": sum(r["has_model"] for r in rows),
            "with_photos": sum(r["photo_count"] > 0 for r in rows), "graded": sum(r["is_graded"] for r in rows),
            "books": len(all_books(db)), "core_books": 10}
