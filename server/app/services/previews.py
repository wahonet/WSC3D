# -*- coding: utf-8 -*-
"""预览与缩略图：浏览器不能解码 300MB 的 TIF，首次请求时生成 sRGB JPEG 并缓存。

- 预览：长边 settings.preview_long_edge（默认 2560），只做等比缩小 + 真实 ICC 色彩转换
  （Adobe RGB → sRGB），不做任何增强；
- 缩略图：由预览再缩到长边 settings.thumb_long_edge（默认 320），供列表/卡片使用；
- warm_in_background：扫描后在后台线程顺序补齐缺失的缓存，避免用户首次点击等待。
"""
from __future__ import annotations

import io
import logging
import threading
from pathlib import Path

from PIL import Image, ImageCms

from ..config import settings

log = logging.getLogger("stonelab.previews")

Image.MAX_IMAGE_PIXELS = None

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_warm_thread: threading.Thread | None = None
_SRGB = ImageCms.createProfile("sRGB")


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        if key not in _locks:
            _locks[key] = threading.Lock()
        return _locks[key]


def preview_path(asset_id: int) -> Path:
    return settings.preview_dir / f"{asset_id}.jpg"


def thumb_path(asset_id: int) -> Path:
    return settings.thumb_dir / f"{asset_id}.jpg"


def work_path(asset_id: int) -> Path:
    """高清工作图（长边 settings.work_long_edge），供切块推理使用。"""
    return settings.preview_dir / f"{asset_id}_hires.jpg"


def preprocessed_path(asset_id: int, mode: str, invert: bool) -> Path:
    return settings.preview_dir / f"pp_{asset_id}_{mode}{'_inv' if invert else ''}.jpg"


def has_preview(asset_id: int) -> bool:
    return preview_path(asset_id).exists()


def invalidate(asset_id: int) -> bool:
    """删除某资产的全部派生缓存（预览、缩略图、高清工作图、预处理图），返回是否删除了预览。"""
    pv = preview_path(asset_id)
    removed = pv.exists()
    for p in [pv, thumb_path(asset_id), work_path(asset_id),
              *settings.preview_dir.glob(f"pp_{asset_id}_*.jpg")]:
        if p.exists():
            p.unlink()
    return removed


def _to_srgb(im: Image.Image) -> Image.Image:
    icc = im.info.get("icc_profile")
    img = im
    if icc and im.mode == "RGB":
        try:
            prof = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            if "sRGB" not in ImageCms.getProfileDescription(prof):
                img = ImageCms.profileToProfile(im, prof, _SRGB, outputMode="RGB")
        except Exception:
            pass  # ICC 损坏时原样缩小，不中断
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    return img


def _fit(img: Image.Image, long_edge: int) -> Image.Image:
    scale = min(1.0, long_edge / max(img.size))
    if scale >= 1.0:
        return img
    return img.resize((max(1, round(img.size[0] * scale)),
                       max(1, round(img.size[1] * scale))), Image.LANCZOS)


def _save_jpeg(img: Image.Image, dst: Path, quality: int) -> None:
    tmp = dst.with_suffix(".tmp.jpg")
    img.save(tmp, "JPEG", quality=quality, optimize=True)
    tmp.replace(dst)


def ensure_preview(asset_id: int, relpath: str) -> Path:
    dst = preview_path(asset_id)
    if dst.exists():
        return dst
    with _lock_for(f"p{asset_id}"):
        if dst.exists():
            return dst
        src = settings.assets_root / relpath
        with Image.open(src) as im:
            img = _fit(_to_srgb(im), settings.preview_long_edge)
            _save_jpeg(img, dst, settings.preview_quality)
        log.info("preview generated: asset %s (%s)", asset_id, relpath)
    return dst


def ensure_work_image(asset_id: int, relpath: str) -> Path:
    """高清工作图：从原件生成长边 work_long_edge 的 sRGB JPEG（切块推理用，首次需数秒）。"""
    dst = work_path(asset_id)
    if dst.exists():
        return dst
    with _lock_for(f"w{asset_id}"):
        if dst.exists():
            return dst
        src = settings.assets_root / relpath
        with Image.open(src) as im:
            img = _fit(_to_srgb(im), settings.work_long_edge)
            _save_jpeg(img, dst, settings.preview_quality)
        log.info("work image generated: asset %s", asset_id)
    return dst


def ensure_thumb(asset_id: int, relpath: str) -> Path:
    dst = thumb_path(asset_id)
    if dst.exists():
        return dst
    with _lock_for(f"t{asset_id}"):
        if dst.exists():
            return dst
        pv = ensure_preview(asset_id, relpath)
        with Image.open(pv) as im:
            img = _fit(im.convert("RGB"), settings.thumb_long_edge)
            _save_jpeg(img, dst, 82)
    return dst


def cache_stats() -> tuple[int, int]:
    """返回 (已缓存预览数, 缓存总字节数：预览+缩略图)。"""
    n = 0
    total = 0
    for d in (settings.preview_dir, settings.thumb_dir):
        for p in d.glob("*.jpg"):
            total += p.stat().st_size
            if d == settings.preview_dir and p.stem.isdigit():   # 只数标准预览，不数工作图/预处理图
                n += 1
    return n, total


def warm_in_background(items: list[tuple[int, str]]) -> int:
    """为缺少缓存的 2D 资产在后台生成预览与缩略图；返回排入队列的数量。"""
    global _warm_thread
    todo = [(i, r) for i, r in items if not preview_path(i).exists() or not thumb_path(i).exists()]
    if not todo:
        return 0
    if _warm_thread is not None and _warm_thread.is_alive():
        return 0

    def run() -> None:
        for asset_id, relpath in todo:
            try:
                ensure_thumb(asset_id, relpath)
            except Exception as e:  # 单个失败不影响其余
                log.warning("warm preview failed for asset %s: %s", asset_id, e)
        log.info("preview warm-up finished (%d assets)", len(todo))

    _warm_thread = threading.Thread(target=run, name="preview-warm", daemon=True)
    _warm_thread.start()
    return len(todo)
