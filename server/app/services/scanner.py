# -*- coding: utf-8 -*-
"""资产扫描器：把 assets/stones/ 下的目录结构摄入数据库。

目录约定（未来 40+ 块石头照此放入，重新扫描自动入库）：

    assets/stones/<编号>_<名称>/
    ├─ meta.json          可选：era/material/carving/dims_text/location/description/layers
    ├─ photos/            全幅高清照片
    │  └─ <任意子文件夹>/  局部照片（进"局部"分组）
    ├─ rubbings/          拓片
    └─ models/high|mid|low/   各一套 obj + mtl + 贴图

规则：
- 按 relpath 幂等 upsert；文件消失则删除记录（标注一并删除）；
- 同名文件被替换（字节数变化）时：重读尺寸并作废预览缓存；
- photos/ 直接子文件 = photo；子文件夹内 = photo_part（局部）；
- meta.json 的文字字段只在数据库为空时填入——研究模块中的人工编辑优先，
  重新扫描不会覆盖。layers 只在库中尚无分层时播种。
- 每块石头保证有一张主图（坐标系原点）：仅在尚无主图时兜底指派最高分辨率的全幅照片。
"""
from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterator
from pathlib import Path

from PIL import Image
from sqlalchemy.orm import Session

from ..config import settings
from ..constants import IMG_EXT, TWO_D_KINDS
from ..models import Asset, Layer, Stone
from . import previews
from . import transforms as tf

log = logging.getLogger("stonelab.scanner")

Image.MAX_IMAGE_PIXELS = None

KIND_BY_MODEL_DIR = {"high": "model_high", "mid": "model_mid", "low": "model_low"}
META_TEXT_FIELDS = ("name", "era", "material", "carving", "dims_text", "location", "description")


def _img_size(p: Path) -> tuple[int, int, str]:
    try:
        with Image.open(p) as im:
            return im.size[0], im.size[1], (im.format or "").upper()
    except Exception:
        return 0, 0, ""


def _split_dirname(dirname: str) -> tuple[str, str]:
    if "_" in dirname:
        code, name = dirname.split("_", 1)
        return code.strip(), name.strip()
    return dirname, dirname


def _iter_asset_files(stone_dir: Path) -> Iterator[tuple[str, Path]]:
    photos = stone_dir / "photos"
    if photos.is_dir():
        for f in sorted(photos.rglob("*")):
            if f.is_file() and f.suffix.lower() in IMG_EXT:
                yield ("photo" if f.parent == photos else "photo_part"), f
    rub = stone_dir / "rubbings"
    if rub.is_dir():
        for f in sorted(rub.rglob("*")):
            if f.is_file() and f.suffix.lower() in IMG_EXT:
                yield "rubbing", f
    models = stone_dir / "models"
    if models.is_dir():
        for sub, kind in KIND_BY_MODEL_DIR.items():
            d = models / sub
            if d.is_dir():
                for f in sorted(d.glob("*.obj")):
                    yield kind, f


def _model_extra(obj_path: Path) -> dict:
    d = obj_path.parent
    mtl = next((f.name for f in d.glob("*.mtl")), None)
    textures = [f.name for f in sorted(d.iterdir())
                if f.is_file() and f.suffix.lower() in IMG_EXT]
    return {"mtl": mtl, "textures": textures}


def _read_meta(stone_dir: Path) -> dict:
    meta_p = stone_dir / "meta.json"
    if not meta_p.exists():
        return {}
    try:
        return json.loads(meta_p.read_text(encoding="utf-8"))
    except Exception as e:
        log.warning("meta.json 解析失败 %s: %s", meta_p, e)
        return {}


def _apply_meta(db: Session, stone: Stone, meta: dict) -> None:
    # 文字字段：库里为空才填（人工编辑优先，重扫不覆盖）
    for field in META_TEXT_FIELDS:
        if not getattr(stone, field, "") and meta.get(field):
            setattr(stone, field, str(meta[field]))
    # 分层释文只在库中尚无分层时播种；此后以库内（研究模块可编辑）为准，
    # 避免重扫覆盖人工编辑并作废图文关联偏移
    has_layers = db.query(Layer).filter(Layer.stone_id == stone.id).count() > 0
    if isinstance(meta.get("layers"), list) and not has_layers:
        for lay in meta["layers"]:
            db.add(Layer(stone_id=stone.id, seq=int(lay.get("seq", 0)),
                         name=str(lay.get("name", "")),
                         summary=str(lay.get("summary", ""))))


def _upsert_asset(db: Session, stone: Stone, kind: str, f: Path, report: dict) -> None:
    rel = f.relative_to(settings.assets_root).as_posix()
    size = f.stat().st_size
    asset = db.query(Asset).filter(Asset.relpath == rel).one_or_none()

    if asset is None:
        w = h = 0
        fmt = f.suffix.lstrip(".").upper()
        extra: dict = {}
        if kind in TWO_D_KINDS:
            w, h, fmt = _img_size(f)
        else:
            extra = _model_extra(f)
        db.add(Asset(stone_id=stone.id, kind=kind, filename=f.name, relpath=rel,
                     bytes=size, width=w, height=h, fmt=fmt, extra=extra))
        report["assets_added"] += 1
        return

    changed = False
    if asset.kind != kind:
        asset.kind = kind
        changed = True
    if asset.bytes != size:
        asset.bytes = size
        if kind in TWO_D_KINDS:
            asset.width, asset.height, asset.fmt = _img_size(f)
            if previews.invalidate(asset.id):
                report["previews_invalidated"] += 1
        changed = True
    if kind.startswith("model"):
        asset.extra = {**(asset.extra or {}), **_model_extra(f)}
    if kind in TWO_D_KINDS and asset.width == 0:
        asset.width, asset.height, asset.fmt = _img_size(f)
        changed = True
    report["assets_updated" if changed else "assets_kept"] += 1


def _assign_masters(db: Session, report: dict) -> None:
    """仅在该石头尚无主图时兜底（手动指定优先）。"""
    for stone in db.query(Stone).all():
        two_d = [a for a in stone.assets if a.kind in TWO_D_KINDS]
        if not two_d or any(a.is_master for a in two_d):
            continue
        fulls = [a for a in two_d if a.kind == "photo"] or two_d
        m = max(fulls, key=lambda a: a.width * a.height)
        m.extra = {**(m.extra or {}), "is_master": True,
                   "align_to_master": {**tf.identity(), "master_asset_id": m.id, "via": "self"}}
        report["masters_assigned"].append(
            {"stone": stone.code, "asset_id": m.id, "filename": m.filename})


def scan(db: Session, warm: bool | None = None) -> dict:
    t0 = time.perf_counter()
    report: dict = {"stones": 0, "assets_added": 0, "assets_updated": 0,
                    "assets_kept": 0, "assets_removed": 0, "previews_invalidated": 0,
                    "masters_assigned": [], "previews_warming": 0, "duration_ms": 0}
    seen: set[str] = set()

    if not settings.assets_root.is_dir():
        log.warning("素材目录不存在：%s", settings.assets_root)
        return report

    for stone_dir in sorted(p for p in settings.assets_root.iterdir() if p.is_dir()):
        code, name = _split_dirname(stone_dir.name)
        stone = db.query(Stone).filter(Stone.code == code).one_or_none()
        if stone is None:
            stone = Stone(code=code, name=name, dirname=stone_dir.name)
            db.add(stone)
            db.flush()
        stone.dirname = stone_dir.name
        if not stone.name:
            stone.name = name
        _apply_meta(db, stone, _read_meta(stone_dir))
        report["stones"] += 1

        for kind, f in _iter_asset_files(stone_dir):
            seen.add(f.relative_to(settings.assets_root).as_posix())
            _upsert_asset(db, stone, kind, f, report)

    for asset in db.query(Asset).all():
        if asset.relpath not in seen:
            db.delete(asset)
            report["assets_removed"] += 1

    db.flush()
    _assign_masters(db, report)
    db.commit()

    if warm if warm is not None else settings.warm_previews:
        items = [(a.id, a.relpath) for a in db.query(Asset).filter(Asset.kind.in_(TWO_D_KINDS)).all()]
        report["previews_warming"] = previews.warm_in_background(items)

    report["duration_ms"] = int((time.perf_counter() - t0) * 1000)
    log.info("scan: %s", {k: v for k, v in report.items() if k != "masters_assigned"})
    return report
