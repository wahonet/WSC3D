from __future__ import annotations

import base64
import io
from typing import Any

import numpy as np
from PIL import Image


def decode_image(image_base64: str) -> np.ndarray:
    payload = image_base64.split(",", 1)[1] if "," in image_base64 else image_base64
    data = base64.b64decode(payload)
    image = Image.open(io.BytesIO(data)).convert("RGB")
    return np.array(image)


def encode_png(image: np.ndarray) -> str:
    pil = Image.fromarray(image)
    buffer = io.BytesIO()
    pil.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def contour_to_polygon(contour: np.ndarray, width: int, height: int) -> list[list[float]]:
    points = contour.reshape(-1, 2)
    if len(points) > 120:
        step = max(1, len(points) // 120)
        points = points[::step]
    polygon = [[float(x) / max(width, 1), float(y) / max(height, 1), 0.0] for x, y in points]
    if polygon and polygon[0] != polygon[-1]:
        polygon.append(polygon[0])
    return polygon


def fallback_box_polygon(x: float, y: float, width: int, height: int, radius: int = 80) -> list[list[float]]:
    min_x = max(0, x - radius)
    min_y = max(0, y - radius)
    max_x = min(width, x + radius)
    max_y = min(height, y + radius)
    return [
        [min_x / width, min_y / height, 0.0],
        [max_x / width, min_y / height, 0.0],
        [max_x / width, max_y / height, 0.0],
        [min_x / width, max_y / height, 0.0],
        [min_x / width, min_y / height, 0.0],
    ]


def ok_response(extra: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"ok": True, "service": "wsc3d-ai", **(extra or {})}
