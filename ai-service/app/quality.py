from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


def analyze_image_quality(stone_id: str, cache_path: Path) -> dict:
    bgr = cv2.imread(str(cache_path), cv2.IMREAD_COLOR)
    if bgr is None:
        return {"error": "decode-failed", "stoneId": stone_id, "cachePath": str(cache_path)}

    height, width = bgr.shape[:2]
    long_edge = max(width, height)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    total_px = float(gray.size)
    over_ratio = float(np.count_nonzero(gray > 245)) / total_px
    under_ratio = float(np.count_nonzero(gray < 10)) / total_px
    lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    warnings = []
    if long_edge < 1500:
        warnings.append("low-resolution")
    if over_ratio > 0.3:
        warnings.append("overexposed")
    if under_ratio > 0.3:
        warnings.append("underexposed")
    if lap_var < 50:
        warnings.append("blurry")

    return {
        "stoneId": stone_id,
        "fileName": cache_path.name,
        "width": width,
        "height": height,
        "longEdge": long_edge,
        "isLongEdgeOk": long_edge >= 1500,
        "overexposedRatio": round(over_ratio, 4),
        "underexposedRatio": round(under_ratio, 4),
        "isExposureOk": over_ratio < 0.3 and under_ratio < 0.3,
        "laplacianVariance": round(lap_var, 2),
        "isFocusOk": lap_var >= 50,
        "warnings": warnings,
    }
