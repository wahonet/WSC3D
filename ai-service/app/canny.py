from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

from .sam import get_source_image_png
from .utils import decode_image, encode_png

# 线图 PNG 落盘缓存目录：与高清图转码缓存同 parent，命名按 stoneId 数字前缀 +
# Canny 阈值参数，前端可以并行请求不同阈值组合。
_LINEART_CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "lineart"


def canny_line(image_base64: str, low: int = 60, high: int = 140) -> dict:
    """
    旧路径：从 base64 截图生成 Canny 线图 base64 返回（前端需要再 decode）。
    新代码请优先走 /ai/lineart/{stone_id}（落盘缓存 + 浏览器直接 <img> 加载）。
    """
    image = decode_image(image_base64)
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(blurred, low, high)
    rgba = np.zeros((edges.shape[0], edges.shape[1], 4), dtype=np.uint8)
    rgba[..., 0] = 255
    rgba[..., 1] = 255
    rgba[..., 2] = 255
    rgba[..., 3] = edges
    return {"imageBase64": encode_png(rgba), "resourceId": "line-opencv-canny", "model": "opencv-canny"}


def get_lineart_png(
    stone_id: str,
    low: int = 60,
    high: int = 140,
    max_edge: int = 4096,
) -> Optional[Path]:
    """
    给该画像石生成 Canny 线图 PNG（白色边缘 + alpha 软渐变，可直接半透明叠加在
    高清图之上），落盘缓存后返回路径。

    流程：
      1. 复用 sam.get_source_image_png 拿到该画像石的转码 PNG（同样按 max_edge
         缩放，避免大图重复 Canny）；如果原图都找不到就返回 None
      2. cv2.imread 读 PNG → 灰度 → 高斯去噪 → Canny
      3. 输出 RGBA：RGB 白色，alpha = 边缘强度（0/255 → Canny 直接给的）
      4. 缓存命中策略：源 PNG 的 mtime 比线图缓存新就重新生成

    为什么不用双边滤波：bilateralFilter 在 4500×6900 上耗时数秒，普通 GaussianBlur
    在浅浮雕灰度图上效果接近，启动可控；想要更精细的边缘留给 M3 后续阶段
    （Sobel、HED、Relic2Contour）。
    """
    source_png = get_source_image_png(stone_id, max_edge=max_edge)
    if source_png is None:
        return None

    safe_low = max(0, min(int(low), 254))
    safe_high = max(safe_low + 1, min(int(high), 255))
    safe_max = max(256, min(int(max_edge), 8192))

    m = re.search(r"(\d+)", stone_id)
    numeric = (m.group(1).lstrip("0") or "0") if m else "unknown"

    _LINEART_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = _LINEART_CACHE_DIR / (
        f"{numeric}_canny_l{safe_low}_h{safe_high}_max{safe_max}.png"
    )
    if cache_path.exists() and cache_path.stat().st_mtime >= source_png.stat().st_mtime:
        return cache_path

    print(
        f"[lineart] generating canny {cache_path.name} from {source_png.name}"
        f" (low={safe_low}, high={safe_high})",
        flush=True,
    )
    try:
        image = cv2.imread(str(source_png), cv2.IMREAD_COLOR)
        if image is None:
            print(f"[lineart] cv2.imread returned None for {source_png}", flush=True)
            return None
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(blurred, safe_low, safe_high)
        height, width = edges.shape
        rgba = np.zeros((height, width, 4), dtype=np.uint8)
        rgba[..., 0] = 255
        rgba[..., 1] = 255
        rgba[..., 2] = 255
        rgba[..., 3] = edges
        # cv2.imwrite 默认按 BGR(A) 写，我们的 RGBA 与 BGRA 的 alpha 通道顺序一致
        # （RGB 三通道全是 255 时颠倒不可见）。
        cv2.imwrite(str(cache_path), rgba)
    except Exception as exc:  # noqa: BLE001
        print(f"[lineart] generate-failed: {exc}", flush=True)
        return None
    return cache_path
