"""
AI 服务图像资源层。

集中处理 pic/ 图源匹配、PNG/preview 缓存、前端资源 URI 反解和图像加载。SAM、
YOLO、lineart、quality 路由都应依赖这里，而不是互相从模型模块 import 图像逻辑。
"""

from __future__ import annotations

import hashlib
import os
import re
import urllib.parse
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from PIL import Image

_PIC_DIR = Path(
    os.environ.get("WSC3D_PIC_DIR", Path(__file__).resolve().parent.parent.parent / "pic")
)
_PROJECT_ROOT = Path(
    os.environ.get("WSC3D_ROOT", Path(__file__).resolve().parent.parent.parent)
)
_SOURCE_EXTS = {".tif", ".tiff", ".png", ".jpg", ".jpeg", ".webp", ".bmp"}
_SOURCE_CACHE: dict[str, object] = {"stoneId": None, "image": None, "name": None}
_PNG_CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "source"
_PREVIEW_CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "preview"


def find_source_image(stone_id: str, face: Optional[str] = None) -> Optional[Path]:
    if not _PIC_DIR.exists():
        return None
    match = re.search(r"(\d+)", stone_id)
    if not match:
        return None
    expected = match.group(1).lstrip("0") or "0"
    wanted_face = face.upper() if face else None
    primary: Optional[Path] = None
    fallback: Optional[Path] = None
    try:
        for entry in _PIC_DIR.iterdir():
            if not entry.is_file() or entry.suffix.lower() not in _SOURCE_EXTS:
                continue
            file_match = re.match(r"^(\d+)(?:-([A-Z]))?", entry.name)
            if not file_match:
                continue
            if (file_match.group(1).lstrip("0") or "0") != expected:
                continue
            entry_face = file_match.group(2) or None
            if wanted_face is not None:
                if entry_face == wanted_face:
                    return entry
                continue
            if entry_face is None:
                primary = entry
                break
            if fallback is None:
                fallback = entry
    except OSError:
        return None
    return primary or fallback


def load_source_image(stone_id: str) -> Optional[tuple[np.ndarray, str]]:
    global _SOURCE_CACHE
    if _SOURCE_CACHE["stoneId"] == stone_id and _SOURCE_CACHE["image"] is not None:
        return _SOURCE_CACHE["image"], _SOURCE_CACHE["name"]  # type: ignore[return-value]
    path = find_source_image(stone_id)
    if path is None:
        print(f"[resources] no source image for {stone_id} in {_PIC_DIR}", flush=True)
        return None
    size_mb = path.stat().st_size / 1024 / 1024
    print(f"[resources] loading source image {path.name} ({size_mb:.1f} MB)", flush=True)
    try:
        pil = Image.open(path)
        pil.load()
        arr = np.array(pil.convert("RGB"))
    except Exception as exc:  # noqa: BLE001
        print(f"[resources] source-load-failed: {exc}", flush=True)
        return None
    _SOURCE_CACHE = {"stoneId": stone_id, "image": arr, "name": path.name}
    print(f"[resources] source loaded: {arr.shape[1]}x{arr.shape[0]} px", flush=True)
    return arr, path.name


def get_source_image_png(stone_id: str, max_edge: int = 4096, face: Optional[str] = None) -> Optional[Path]:
    path = find_source_image(stone_id, face=face)
    if path is None:
        return None

    match = re.search(r"(\d+)", stone_id)
    numeric = (match.group(1).lstrip("0") or "0") if match else "unknown"
    face_key = f"_{face.upper()}" if face else ""
    safe_max = max(256, min(int(max_edge), 8192))

    _PNG_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = _PNG_CACHE_DIR / f"{numeric}{face_key}_max{safe_max}.png"
    if cache_path.exists() and cache_path.stat().st_mtime >= path.stat().st_mtime:
        return cache_path

    print(
        f"[source-image] transcoding {path.name} -> {cache_path.name} (max edge {safe_max}px)",
        flush=True,
    )
    try:
        with Image.open(path) as pil:
            pil = pil.convert("RGB")
            long_edge = max(pil.size)
            if long_edge > safe_max:
                ratio = safe_max / float(long_edge)
                new_size = (max(1, int(pil.size[0] * ratio)), max(1, int(pil.size[1] * ratio)))
                pil = pil.resize(new_size, Image.LANCZOS)
            pil.save(cache_path, format="PNG", optimize=False, compress_level=3)
    except Exception as exc:  # noqa: BLE001
        print(f"[source-image] transcode-failed: {exc}", flush=True)
        return None
    return cache_path


def get_pic_preview_png(file_name: str, max_edge: int = 400) -> Optional[Path]:
    if not file_name or "/" in file_name or "\\" in file_name or ".." in file_name:
        return None
    src_path = _PIC_DIR / file_name
    try:
        if not src_path.is_file():
            return None
        src_resolved = src_path.resolve()
        pic_resolved = _PIC_DIR.resolve()
        if pic_resolved not in src_resolved.parents and src_resolved != pic_resolved:
            return None
    except OSError:
        return None

    safe_max = max(64, min(int(max_edge), 1024))
    _PREVIEW_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    digest = hashlib.md5(file_name.encode("utf-8")).hexdigest()[:16]
    cache_path = _PREVIEW_CACHE_DIR / f"{digest}_max{safe_max}.png"
    try:
        if cache_path.exists() and cache_path.stat().st_mtime >= src_path.stat().st_mtime:
            return cache_path
    except OSError:
        pass

    print(
        f"[pic-preview] transcoding {file_name} -> {cache_path.name} (max edge {safe_max}px)",
        flush=True,
    )
    try:
        with Image.open(src_path) as pil:
            pil = pil.convert("RGB")
            long_edge = max(pil.size)
            if long_edge > safe_max:
                ratio = safe_max / float(long_edge)
                new_size = (max(1, int(pil.size[0] * ratio)), max(1, int(pil.size[1] * ratio)))
                pil = pil.resize(new_size, Image.LANCZOS)
            pil.save(cache_path, format="PNG", optimize=False, compress_level=3)
    except Exception as exc:  # noqa: BLE001
        print(f"[pic-preview] transcode-failed: {exc}", flush=True)
        return None
    return cache_path


def resolve_resource_uri(uri: str) -> Optional[Path]:
    if not uri:
        return None
    parsed = urllib.parse.urlparse(uri)
    path_part = parsed.path or uri
    query = urllib.parse.parse_qs(parsed.query)
    if path_part.startswith("/assets/stone-resources/"):
        rel = path_part[len("/assets/stone-resources/") :]
        return _PROJECT_ROOT / "data" / "stone-resources" / rel
    if path_part.startswith("/ai/source-image/"):
        stone_id = urllib.parse.unquote(path_part[len("/ai/source-image/") :])
        face = query.get("face", [None])[0]
        max_edge_raw = query.get("max_edge", ["4096"])[0]
        try:
            max_edge = int(max_edge_raw)
        except (TypeError, ValueError):
            max_edge = 4096
        return get_source_image_png(stone_id, max_edge=max_edge, face=face)
    if uri.startswith("file://"):
        return Path(uri[len("file://") :])
    if uri.startswith("/"):
        return None
    candidate = _PROJECT_ROOT / uri
    return candidate if candidate.exists() else None


def load_image_from_uri(uri: str) -> Optional[tuple[np.ndarray, str]]:
    path = resolve_resource_uri(uri)
    if path is None or not path.exists() or not path.is_file():
        print(f"[resources] uri not resolvable: {uri}", flush=True)
        return None
    try:
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if image is None:
            print(f"[resources] cv2.imread returned None: {path}", flush=True)
            return None
        image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    except Exception as exc:  # noqa: BLE001
        print(f"[resources] load-from-uri failed: {exc}", flush=True)
        return None
    return image, path.name
