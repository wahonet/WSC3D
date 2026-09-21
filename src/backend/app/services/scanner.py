# -*- coding: utf-8 -*-
"""资产扫描器：把 resources/stones/ 下的目录结构摄入数据库。

目录约定（编号稳定，名称用于人工整理）：

    resources/stones/<名称>__<编号>/
    ├─ metadata/catalogue.json   身份和档案元数据
    ├─ images/photos/           照片
    ├─ images/research-rubbings/ 拓片
    ├─ models/scans/high|mid|low/ 扫描模型、材质和贴图
    └─ versions/                标注底图快照，不参与新素材扫描

档案页只扫描新增文件，并将新照片/拓片加入档案影像版本；不覆盖人工文字和标注。
研究资源检查另按指纹追踪移动、缺失及替换文件，保留原有身份和标注底图。
缩略图、预览图、旧版查看器封面及 versions 快照不参与新素材扫描。
"""
from __future__ import annotations

import json
import logging
import time
import threading
from collections.abc import Iterator
from pathlib import Path

from PIL import Image
from sqlalchemy.orm import Session

from ..config import settings
from ..constants import IMG_EXT, TWO_D_KINDS
from ..models import Asset, Stone
from ..resource_paths import iter_resource_files, resolve_resource, resource_metadata, verify_resource_archives

log = logging.getLogger("stonelab.scanner")
_scan_lock = threading.Lock()

Image.MAX_IMAGE_PIXELS = None

KIND_BY_MODEL_DIR = {"high": "model_high", "mid": "model_mid", "low": "model_low"}


def _img_size(p: Path) -> tuple[int, int, str]:
    try:
        with Image.open(resolve_resource(p)) as im:
            return im.size[0], im.size[1], (im.format or "").upper()
    except Exception:
        return 0, 0, ""


def _iter_asset_files(stone_dir: Path) -> Iterator[tuple[str, Path]]:
    images = stone_dir / "images"
    for path in sorted(iter_resource_files(images)):
        if path.suffix.lower() not in IMG_EXT:
            continue
        parts = path.relative_to(images).parts
        if any(part.casefold() in {'previews', 'thumbnails'} for part in parts[:-1]):
            continue
        # Fixed cover used by the retained legacy viewer, not a new photograph.
        if tuple(part.casefold() for part in parts) == ('rubbings', 'catalogue.png'):
            continue
        if not path.resolve().is_relative_to(stone_dir.resolve()):
            continue
        yield ('rubbing' if 'rubbings' in parts[0] else 'photo'), path
    models = stone_dir / 'models'
    if models.is_dir():
        for path in sorted(models.rglob('*')):
            if path.is_file() and path.suffix.lower() in {'.obj', '.glb', '.gltf'} and path.resolve().is_relative_to(stone_dir.resolve()):
                yield KIND_BY_MODEL_DIR.get(path.parent.name, 'model_high'), path


def _resource_identity(path: Path) -> Path:
    """Compare aliases without expanding packed originals into the local cache."""
    path = path.resolve()
    if not path.is_relative_to(settings.assets_root.resolve()):
        raise ValueError('资源文件路径不合法')
    packed = resource_metadata(path)
    if packed:
        return (settings.root / packed.get('path', path)).resolve()
    from .resources import live_asset_path
    return live_asset_path(path.relative_to(settings.assets_root).as_posix()).resolve()


def _resource_fingerprint(path: Path) -> tuple[int, str]:
    packed = resource_metadata(path)
    if packed:
        return packed['bytes'], packed['sha256']
    from .resource_versions import digest
    physical = resolve_resource(path)
    return physical.stat().st_size, digest(physical)


def _resource_size(path: Path) -> int:
    packed = resource_metadata(path)
    return packed['bytes'] if packed else resolve_resource(path).stat().st_size


def _model_extra(obj_path: Path) -> dict:
    d = obj_path.parent
    mtl = next((f.name for f in d.glob("*.mtl")), None)
    textures = [f.name for f in sorted(d.iterdir())
                if f.is_file() and f.suffix.lower() in IMG_EXT]
    return {"mtl": mtl, "textures": textures}


def scan(db: Session, warm: bool | None = None, *, stone_id: str | None = None,
         additions_only: bool = False, publish_archive: bool = False) -> dict:
    from fastapi import HTTPException
    if not _scan_lock.acquire(blocking=False):
        raise HTTPException(409, '已有资源扫描正在进行，请完成后重试')
    try:
        return _scan(db, stone_id=stone_id, additions_only=additions_only, publish_archive=publish_archive)
    finally:
        _scan_lock.release()


def _scan(db: Session, *, stone_id: str | None, additions_only: bool, publish_archive: bool) -> dict:
    """Hash-check resources; recover moved files; preserve all research identities."""
    from datetime import datetime
    from sqlalchemy import text
    from .resource_versions import digest
    t0 = time.perf_counter()
    stones = db.query(Stone).filter(Stone.id == stone_id).all() if stone_id else db.query(Stone).all()
    report = {"stones": len(stones), "assets_added": 0, "assets_updated": 0,
              "assets_kept": 0, "assets_removed": 0, "assets_missing": [], "changed_files": [],
              "previews_invalidated": 0, "masters_assigned": [], "previews_warming": 0, "duration_ms": 0,
              "archive_added": 0, "added": [], "skipped": []}
    registered = db.query(Asset).filter(Asset.stone_id == stone_id).all() if stone_id else db.query(Asset).all()
    # A missing/truncated pack is a storage error, not hundreds of deleted images.
    # Validate the complete scan scope before changing any asset records.
    files_by_stone = {}
    try:
        for asset in registered:
            resource_metadata(settings.assets_root / asset.relpath)
        for stone in stones:
            directory = settings.assets_root / stone.dirname
            if directory.resolve().is_relative_to(settings.assets_root.resolve()):
                files_by_stone[stone.id] = list(_iter_asset_files(directory))
        if not additions_only:
            verify_resource_archives([
                *(settings.assets_root / asset.relpath for asset in registered),
                *(path for files in files_by_stone.values() for _, path in files),
            ])
    except (OSError, ValueError) as exc:
        from fastapi import HTTPException
        raise HTTPException(409, f'资源压缩包不可用，未修改资产登记：{exc}') from exc
    seen = {a.relpath for a in registered}
    # Several catalogue paths may resolve to the same retained original.
    # Recognise those aliases without reading/hashing the old files again.
    physical = set()
    for asset in registered:
        try:
            physical.add(_resource_identity(settings.assets_root / asset.relpath))
        except Exception:
            pass
    for asset in ([] if additions_only else registered):
        try:
            path = settings.assets_root / asset.relpath
            _resource_identity(path)
            size, sha = _resource_fingerprint(path)
        except Exception:
            # A move may change the filename, never the asset/annotation identity.
            stone = asset.stone
            # Immutable snapshots and generated previews are not renamed live files.
            matches = []
            for _, candidate in files_by_stone.get(stone.id, []):
                if not asset.sha256 or candidate.suffix.lower() != Path(asset.filename).suffix.lower():
                    continue
                try:
                    if _resource_size(candidate) == asset.bytes and _resource_fingerprint(candidate)[1] == asset.sha256:
                        matches.append(candidate)
                except (OSError, ValueError):
                    # An absent pack cannot serve as a renamed original.
                    continue
            if len(matches) == 1:
                path = matches[0]
                rel = path.relative_to(settings.assets_root).as_posix()
                if rel not in seen:
                    seen.discard(asset.relpath); seen.add(rel)
                    asset.relpath, asset.filename, asset.missing = rel, path.name, False
                    report["assets_updated"] += 1
                    continue
            asset.missing = True
            report["assets_missing"].append(asset.id)
            continue
        if (asset.sha256 and sha != asset.sha256) or size != asset.bytes:
            report["changed_files"].append(asset.id)
            # Keep the original file snapshot and all geometry. Register the change for review.
            db.execute(text('INSERT INTO asset_versions(asset_id,payload,created_at) SELECT :id,:payload,:created WHERE NOT EXISTS (SELECT 1 FROM asset_versions WHERE asset_id=:id AND payload=:payload)'),
                       {"id":asset.id,"payload":json.dumps({"kind":"replacement-pending","relpath":asset.relpath,"sha256":sha},ensure_ascii=False),"created":datetime.now().isoformat()})
            continue
        asset.sha256 = sha
        asset.missing = False
        report["assets_kept"] += 1
    # New images in existing research folders can be added without reseeding identities or labels.
    for stone in stones:
        directory = settings.assets_root / stone.dirname
        if not directory.resolve().is_relative_to(settings.assets_root.resolve()):
            continue
        from .catalogue import decode
        media = list(decode((stone.archive or {}).get('media'), []))
        archive_paths = {directory / item[key] for item in media for key in ('file', 'original') if item.get(key)}
        if (stone.archive or {}).get('rubbing'):
            archive_paths.add(directory / stone.archive['rubbing'])
        archive_paths.update(directory / 'images/photos' / batch.get('batch', '') / filename
                             for batch in decode((stone.archive or {}).get('photos'), []) for filename in batch.get('files', []))
        archive_physical = set()
        for old_path in archive_paths:
            try:
                archive_physical.add(_resource_identity(old_path))
            except Exception:
                pass
        published = False
        for kind, path in files_by_stone.get(stone.id, []):
            rel = path.relative_to(settings.assets_root).as_posix()
            if rel in seen:
                continue
            try:
                identity = _resource_identity(path)
                if identity in physical or (publish_archive and identity in archive_physical):
                    continue
                packed = resource_metadata(path)
                if packed:
                    size, sha = packed['bytes'], packed['sha256']
                    width, height, fmt = packed['width'], packed['height'], packed['fmt']
                else:
                    stamp = path.stat()
                    size = stamp.st_size
                    width, height, fmt = _img_size(path) if kind in TWO_D_KINDS else (0, 0, path.suffix[1:].upper())
                    sha = digest(path)
                    current = path.stat()
                    if (stamp.st_size, stamp.st_mtime_ns) != (current.st_size, current.st_mtime_ns):
                        raise ValueError('文件正在写入，请复制完成后再扫描')
                if kind in TWO_D_KINDS and not width:
                    raise ValueError('图片尚未复制完成或格式不可读')
            except (OSError, ValueError) as exc:
                report['skipped'].append({'file': rel, 'reason': str(exc)})
                continue
            asset = Asset(stone_id=stone.id,kind=kind,filename=path.name,relpath=rel,bytes=size,
                          width=width,height=height,fmt=fmt,sha256=sha,source_root='research',
                          extra={} if kind in TWO_D_KINDS else _model_extra(path))
            db.add(asset)
            db.flush()
            physical.add(identity)
            seen.add(rel);report["assets_added"] += 1
            report['added'].append({'stone_id': stone.id, 'asset_id': asset.id, 'filename': path.name})
            if publish_archive and kind in TWO_D_KINDS and identity not in archive_physical:
                media.append({'id': f'asset-{asset.id}', 'asset_id': asset.id, 'kind': kind,
                              'version': '本地新增拓片' if kind == 'rubbing' else '本地新增照片',
                              'label': path.stem, 'file': path.relative_to(directory).as_posix(),
                              'original_name': path.name, 'bytes': size, 'image_size': [width, height]})
                archive_physical.add(identity)
                report['archive_added'] += 1
                published = True
        if published:
            stone.archive = {**(stone.archive or {}), 'media': media}
    db.commit()
    report["duration_ms"] = int((time.perf_counter() - t0) * 1000)
    return report
