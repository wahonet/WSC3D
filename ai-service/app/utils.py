"""
AI 服务通用工具函数

跨 sam / yolo / canny 模块共享的小工具：base64 编解码、PIL ↔ numpy 互转、
SAM 输出的 contour ↔ 归一化 polygon 转换、健康响应模板等。

所有函数都是无状态纯函数，没有副作用，便于在多线程环境下并发调用。
"""

from __future__ import annotations

import base64
import io
from typing import Any

import numpy as np
from PIL import Image


def decode_image(image_base64: str) -> np.ndarray:
    """把前端传来的 base64 字符串解码为 RGB 像素 numpy 数组。

    支持 ``data:image/png;base64,...`` 形式（带 MIME 前缀）和裸 base64 两种
    输入；解码后统一转 RGB（去 alpha 通道）。
    """

    payload = image_base64.split(",", 1)[1] if "," in image_base64 else image_base64
    data = base64.b64decode(payload)
    image = Image.open(io.BytesIO(data)).convert("RGB")
    return np.array(image)


def encode_png(image: np.ndarray) -> str:
    """numpy 数组 → ``data:image/png;base64,...`` 字符串。

    适用场景：旧 Canny / SAM base64 路径需要把生成的图片塞回 JSON 响应里。
    新代码请走"落盘缓存 + ``<img src=...>``"路径，避免大字符串往返。
    """

    pil = Image.fromarray(image)
    buffer = io.BytesIO()
    pil.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def contour_to_polygon(contour: np.ndarray, width: int, height: int) -> list[list[float]]:
    """把 OpenCV / SAM 的 contour（像素坐标整数）转成归一化 polygon。

    输出格式：``[[u, v, 0.0], ...]``，``u, v ∈ [0, 1]``，与 IIML
    ``IimlPoint`` 第三维兼容。
    点数超过 120 时按整数步长降采样，避免极端 contour 把响应撑爆。
    最后一个点与第一个点不重合时自动闭合。
    """

    points = contour.reshape(-1, 2)
    if len(points) > 120:
        step = max(1, len(points) // 120)
        points = points[::step]
    polygon = [[float(x) / max(width, 1), float(y) / max(height, 1), 0.0] for x, y in points]
    if polygon and polygon[0] != polygon[-1]:
        polygon.append(polygon[0])
    return polygon


def fallback_box_polygon(x: float, y: float, width: int, height: int, radius: int = 80) -> list[list[float]]:
    """SAM 输出空 contour 时的兜底正方形 polygon。

    以 ``(x, y)`` 像素为中心、``radius`` 半边长，画一个正方形（5 顶点闭合）。
    用于避免前端在 SAM 偶发返回空 polygon 时拿不到任何东西。
    """

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
    """统一健康 / 状态响应：基础字段 + 可选扩展字段。"""

    return {"ok": True, "service": "wsc3d-ai", **(extra or {})}
