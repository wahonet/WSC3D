"""
P2 mask 级标注合成。

把"SAM3 / 人工几何（矢量） + 补笔（有宽度的折线） + 擦除笔"统一到底图像素网格
上做布尔合成，经形态学清理后重新矢量化，返回带洞多边形 + mask / cutout 资产。

流程：
    baseGeometries 栅格化 → binary mask
    strokes 按顺序应用（add=OR，erase=AND NOT）
    形态学 close / open
    去小碎片（connected components < minIslandPx）
    填小洞（背景连通域不接边界且 < fillHolePx）
    findContours(RETR_CCOMP) → 外环 + 洞，approxPolyDP 简化
    可选输出 mask.png / cutout.png / thumb.png（base64）

设计要点：
- 栅格网格 = 底图自然尺寸（有图时）或调用方给的 imageSize，长边 cap 4096；
  几何坐标全程归一化 UV，网格分辨率只影响边缘精度不影响坐标系
- 输出 polygon 的 ring[0] 是外环，其余是洞（与 IIML Polygon 语义一致）
- cutout 裁到 bbox（含 8px margin），mask 保持整图对齐（跨分辨率可迁移）
"""

from __future__ import annotations

import base64
import io
from typing import Any, Optional

import cv2
import numpy as np
from PIL import Image

from .resources import load_image_from_uri, load_source_image
from .schemas import MaskCleanupOptions, MaskComposeRequest

_MAX_RASTER_EDGE = 4096
_MAX_RING_POINTS = 400
_THUMB_EDGE = 256


def compose_mask(request: MaskComposeRequest) -> dict[str, Any]:
    image, size = _resolve_canvas(request)
    if size is None:
        return {"ok": False, "error": "image_or_size_required"}
    width, height = size
    if width < 2 or height < 2:
        return {"ok": False, "error": "invalid_size"}

    mask = np.zeros((height, width), dtype=np.uint8)
    for geometry in request.baseGeometries:
        _rasterize_geometry(mask, geometry, width, height)

    for stroke in request.strokes:
        _apply_stroke(mask, stroke.mode, stroke.pointsUv, stroke.widthPx, width, height)

    cleanup = request.cleanup or MaskCleanupOptions()
    mask = _cleanup_mask(mask, cleanup)

    if int(cv2.countNonZero(mask)) == 0:
        return {"ok": False, "error": "empty_mask", "imageSizePx": [width, height]}

    polygons = _vectorize(mask, cleanup.simplifyTolerancePx, width, height)
    if not polygons:
        return {"ok": False, "error": "vectorize_failed", "imageSizePx": [width, height]}

    area_px = int(cv2.countNonZero(mask))
    ys, xs = np.nonzero(mask)
    min_x, max_x = int(xs.min()), int(xs.max())
    min_y, max_y = int(ys.min()), int(ys.max())
    bbox_uv = [min_x / width, min_y / height, (max_x + 1) / width, (max_y + 1) / height]
    moments = cv2.moments(mask, binaryImage=True)
    centroid_uv = (
        [moments["m10"] / moments["m00"] / width, moments["m01"] / moments["m00"] / height]
        if moments["m00"] > 0
        else [(bbox_uv[0] + bbox_uv[2]) / 2, (bbox_uv[1] + bbox_uv[3]) / 2]
    )

    response: dict[str, Any] = {
        "ok": True,
        "model": "mask-compose-v1",
        "polygons": polygons,
        "areaPx": area_px,
        "bboxUv": bbox_uv,
        "centroidUv": centroid_uv,
        "imageSizePx": [width, height],
    }

    if request.returnMask:
        response["maskPngBase64"] = _encode_gray_png(mask * 255)

    if request.returnCutout and image is not None:
        margin = 8
        x0 = max(0, min_x - margin)
        y0 = max(0, min_y - margin)
        x1 = min(width, max_x + 1 + margin)
        y1 = min(height, max_y + 1 + margin)
        crop_rgb = image[y0:y1, x0:x1]
        crop_alpha = (mask[y0:y1, x0:x1] * 255).astype(np.uint8)
        cutout = np.dstack([crop_rgb, crop_alpha])
        response["cutoutPngBase64"] = _encode_rgba_png(cutout)
        response["thumbnailPngBase64"] = _encode_rgba_png(_shrink_rgba(cutout, _THUMB_EDGE))
        response["cutoutBboxPx"] = [x0, y0, x1, y1]

    return response


# ---------------------------------------------------------------------------
# 画布解析
# ---------------------------------------------------------------------------


def _resolve_canvas(request: MaskComposeRequest) -> tuple[Optional[np.ndarray], Optional[tuple[int, int]]]:
    """返回 (RGB 图像或 None, (width, height))；无法确定尺寸时 (None, None)。"""

    image: Optional[np.ndarray] = None
    if request.imageUri:
        loaded = load_image_from_uri(request.imageUri)
        if loaded is not None:
            image = loaded[0]
    if image is None and request.stoneId:
        loaded = load_source_image(request.stoneId)
        if loaded is not None:
            image = loaded[0]

    if image is not None:
        height, width = image.shape[:2]
        long_edge = max(width, height)
        if long_edge > _MAX_RASTER_EDGE:
            ratio = _MAX_RASTER_EDGE / float(long_edge)
            width = max(1, int(width * ratio))
            height = max(1, int(height * ratio))
            image = cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA)
        return image, (width, height)

    if request.imageSize and len(request.imageSize) == 2:
        width = int(request.imageSize[0])
        height = int(request.imageSize[1])
        long_edge = max(width, height)
        if long_edge > _MAX_RASTER_EDGE:
            ratio = _MAX_RASTER_EDGE / float(long_edge)
            width = max(1, int(width * ratio))
            height = max(1, int(height * ratio))
        return None, (width, height)
    return None, None


# ---------------------------------------------------------------------------
# 栅格化
# ---------------------------------------------------------------------------


def _ring_to_px(ring: list[list[float]], width: int, height: int) -> Optional[np.ndarray]:
    points = [
        [float(point[0]) * width, float(point[1]) * height]
        for point in ring
        if isinstance(point, (list, tuple)) and len(point) >= 2
    ]
    if len(points) < 3:
        return None
    return np.round(np.array(points, dtype=np.float64)).astype(np.int32)


def _rasterize_geometry(mask: np.ndarray, geometry: dict, width: int, height: int) -> None:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "BBox" and isinstance(coordinates, (list, tuple)) and len(coordinates) == 4:
        u1, v1, u2, v2 = (float(value) for value in coordinates)
        x0 = int(round(min(u1, u2) * width))
        y0 = int(round(min(v1, v2) * height))
        x1 = int(round(max(u1, u2) * width))
        y1 = int(round(max(v1, v2) * height))
        cv2.rectangle(mask, (x0, y0), (x1, y1), 1, thickness=-1)
        return
    if geometry_type == "Polygon" and isinstance(coordinates, list):
        _fill_polygon_with_holes(mask, coordinates, width, height)
        return
    if geometry_type == "MultiPolygon" and isinstance(coordinates, list):
        for polygon in coordinates:
            if isinstance(polygon, list):
                _fill_polygon_with_holes(mask, polygon, width, height)
        return
    if geometry_type == "LineString" and isinstance(coordinates, list):
        # 无宽度信息的 LineString 按默认 4px 补笔处理，保证参与合成而非被丢弃。
        _apply_stroke(mask, "add", coordinates, 4.0, width, height)


def _fill_polygon_with_holes(mask: np.ndarray, rings: list, width: int, height: int) -> None:
    outer = _ring_to_px(rings[0], width, height) if rings else None
    if outer is None:
        return
    layer = np.zeros_like(mask)
    cv2.fillPoly(layer, [outer], 1)
    for hole_ring in rings[1:]:
        hole = _ring_to_px(hole_ring, width, height)
        if hole is not None:
            cv2.fillPoly(layer, [hole], 0)
    np.bitwise_or(mask, layer, out=mask)


def _apply_stroke(
    mask: np.ndarray,
    mode: str,
    points_uv: list[list[float]],
    width_px: float,
    width: int,
    height: int,
) -> None:
    points = [
        (int(round(float(point[0]) * width)), int(round(float(point[1]) * height)))
        for point in points_uv
        if isinstance(point, (list, tuple)) and len(point) >= 2
    ]
    if not points:
        return
    thickness = max(1, int(round(width_px)))
    layer = np.zeros_like(mask)
    if len(points) == 1:
        cv2.circle(layer, points[0], max(1, thickness // 2), 1, thickness=-1)
    else:
        cv2.polylines(layer, [np.array(points, dtype=np.int32)], False, 1, thickness=thickness, lineType=cv2.LINE_8)
        # polylines 的端点是平头；补圆头让笔画衔接自然
        cv2.circle(layer, points[0], max(1, thickness // 2), 1, thickness=-1)
        cv2.circle(layer, points[-1], max(1, thickness // 2), 1, thickness=-1)
    if mode == "erase":
        np.bitwise_and(mask, 1 - layer, out=mask)
    else:
        np.bitwise_or(mask, layer, out=mask)


# ---------------------------------------------------------------------------
# 清理与矢量化
# ---------------------------------------------------------------------------


def _cleanup_mask(mask: np.ndarray, options: MaskCleanupOptions) -> np.ndarray:
    result = mask
    if options.closePx and options.closePx > 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (options.closePx * 2 + 1, options.closePx * 2 + 1))
        result = cv2.morphologyEx(result, cv2.MORPH_CLOSE, kernel)
    if options.openPx and options.openPx > 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (options.openPx * 2 + 1, options.openPx * 2 + 1))
        result = cv2.morphologyEx(result, cv2.MORPH_OPEN, kernel)
    if options.minIslandPx and options.minIslandPx > 0:
        count, labels, stats, _ = cv2.connectedComponentsWithStats(result, connectivity=8)
        for label in range(1, count):
            if stats[label, cv2.CC_STAT_AREA] < options.minIslandPx:
                result[labels == label] = 0
    if options.fillHolePx and options.fillHolePx > 0:
        inverted = (1 - result).astype(np.uint8)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(inverted, connectivity=8)
        height, width = result.shape
        for label in range(1, count):
            x = stats[label, cv2.CC_STAT_LEFT]
            y = stats[label, cv2.CC_STAT_TOP]
            w = stats[label, cv2.CC_STAT_WIDTH]
            h = stats[label, cv2.CC_STAT_HEIGHT]
            touches_border = x == 0 or y == 0 or x + w >= width or y + h >= height
            if not touches_border and stats[label, cv2.CC_STAT_AREA] < options.fillHolePx:
                result[labels == label] = 1
    return result


def _vectorize(mask: np.ndarray, tolerance_px: float, width: int, height: int) -> list[dict[str, Any]]:
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None or len(contours) == 0:
        return []
    hierarchy = hierarchy[0]
    epsilon = max(0.0, float(tolerance_px))

    def contour_to_ring(contour: np.ndarray) -> Optional[list[list[float]]]:
        approx = cv2.approxPolyDP(contour, epsilon, True) if epsilon > 0 else contour
        points = approx.reshape(-1, 2)
        if len(points) < 3:
            return None
        if len(points) > _MAX_RING_POINTS:
            step = max(1, len(points) // _MAX_RING_POINTS)
            points = points[::step]
        ring = [[float(x) / width, float(y) / height, 0.0] for x, y in points]
        if ring[0] != ring[-1]:
            ring.append(list(ring[0]))
        return ring

    polygons: list[dict[str, Any]] = []
    for index, contour in enumerate(contours):
        # hierarchy: [next, prev, firstChild, parent]；parent == -1 是外环
        if hierarchy[index][3] != -1:
            continue
        outer = contour_to_ring(contour)
        if outer is None:
            continue
        rings = [outer]
        child = hierarchy[index][2]
        while child != -1:
            hole = contour_to_ring(contours[child])
            if hole is not None:
                rings.append(hole)
            child = hierarchy[child][0]
        polygons.append({"rings": rings})
    return polygons


# ---------------------------------------------------------------------------
# 编码
# ---------------------------------------------------------------------------


def _encode_gray_png(gray: np.ndarray) -> str:
    pil = Image.fromarray(gray.astype(np.uint8), mode="L")
    buffer = io.BytesIO()
    pil.save(buffer, format="PNG", optimize=False, compress_level=6)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _encode_rgba_png(rgba: np.ndarray) -> str:
    pil = Image.fromarray(rgba.astype(np.uint8), mode="RGBA")
    buffer = io.BytesIO()
    pil.save(buffer, format="PNG", optimize=False, compress_level=6)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _shrink_rgba(rgba: np.ndarray, max_edge: int) -> np.ndarray:
    height, width = rgba.shape[:2]
    long_edge = max(width, height)
    if long_edge <= max_edge:
        return rgba
    ratio = max_edge / float(long_edge)
    return cv2.resize(rgba, (max(1, int(width * ratio)), max(1, int(height * ratio))), interpolation=cv2.INTER_AREA)
