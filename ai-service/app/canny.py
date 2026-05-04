from __future__ import annotations

import re
from pathlib import Path
from typing import Literal, Optional

import cv2
import numpy as np

from .sam import get_source_image_png
from .utils import decode_image, encode_png

# 线图 PNG 落盘缓存目录：与高清图转码缓存同 parent，命名按 stoneId 数字前缀 +
# Canny 阈值参数，前端可以并行请求不同阈值组合。
_LINEART_CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "lineart"

# F2 阶段：支持的线图方法。
#   - canny：经典双阈值边缘检测；最快，对清晰浮雕够用
#   - sobel：Sobel 梯度幅值 → 阈值化；对灰度渐变更敏感（拓片软边缘）
#   - scharr：Scharr 改进卷积核（比 Sobel 更精确小邻域）；适合细节多的浮雕
#   - morph：自适应阈值 + 形态学闭运算 → 骨架；强化连通性，断边变少
#   - canny-plus：Canny + 形态学闭运算填补断边（最适合汉画像石残损浮雕）
LineartMethod = Literal["canny", "sobel", "scharr", "morph", "canny-plus"]


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


def _detect_canny(gray: np.ndarray, low: int, high: int) -> np.ndarray:
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    return cv2.Canny(blurred, low, high)


def _detect_sobel(gray: np.ndarray, low: int, _high: int) -> np.ndarray:
    """Sobel 梯度幅值 → 按 low 阈值化。high 暂不用。"""
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    gx = cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=3)
    mag = cv2.magnitude(gx, gy)
    mag = cv2.normalize(mag, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    _, edges = cv2.threshold(mag, low, 255, cv2.THRESH_BINARY)
    return edges


def _detect_scharr(gray: np.ndarray, low: int, _high: int) -> np.ndarray:
    """Scharr 改进卷积核，比 Sobel 更精确，对小邻域细节更敏感。"""
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    gx = cv2.Scharr(blurred, cv2.CV_32F, 1, 0)
    gy = cv2.Scharr(blurred, cv2.CV_32F, 0, 1)
    mag = cv2.magnitude(gx, gy)
    mag = cv2.normalize(mag, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    _, edges = cv2.threshold(mag, low, 255, cv2.THRESH_BINARY)
    return edges


def _detect_morph(gray: np.ndarray, low: int, _high: int) -> np.ndarray:
    """
    自适应阈值 + 形态学闭运算：用 ADAPTIVE_THRESH_GAUSSIAN_C 局部阈值化，
    再做闭运算填补断边。对汉画像石残损 / 风化表面比 Canny 更稳，能把"几乎
    看不见的浅浮雕轮廓"提出来。

    low 参数当作 blockSize（必须奇数，11~31 推荐），_high 不使用。
    """
    block_size = max(3, low | 1)  # 强制奇数
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    binary = cv2.adaptiveThreshold(
        blurred,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        block_size,
        2,
    )
    kernel = np.ones((3, 3), np.uint8)
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)
    # 留细线：再用 erosion 把粗块"细化"
    skeleton = cv2.morphologyEx(closed, cv2.MORPH_GRADIENT, kernel, iterations=1)
    return skeleton


def _detect_canny_plus(gray: np.ndarray, low: int, high: int) -> np.ndarray:
    """
    Canny + 形态学闭运算（3x3 一次）填补断边。在汉画像石残损浮雕上比纯 Canny
    连通性更好，断断续续的轮廓更容易闭合。
    """
    edges = _detect_canny(gray, low, high)
    kernel = np.ones((3, 3), np.uint8)
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=1)
    return closed


_METHOD_DETECTORS = {
    "canny": _detect_canny,
    "sobel": _detect_sobel,
    "scharr": _detect_scharr,
    "morph": _detect_morph,
    "canny-plus": _detect_canny_plus,
}

LINEART_METHODS = list(_METHOD_DETECTORS.keys())


def get_lineart_png(
    stone_id: str,
    low: int = 60,
    high: int = 140,
    max_edge: int = 4096,
    method: str = "canny",
) -> Optional[Path]:
    """
    给该画像石生成线图 PNG（白色边缘 + alpha 软渐变，可直接半透明叠加在
    高清图之上），落盘缓存后返回路径。

    流程：
      1. 复用 sam.get_source_image_png 拿到该画像石的转码 PNG（同样按 max_edge
         缩放，避免大图重复处理）；如果原图都找不到就返回 None
      2. cv2.imread 读 PNG → 灰度 → 按 method 走对应检测器
      3. 输出 RGBA：RGB 白色，alpha = 边缘强度
      4. 缓存命中策略：源 PNG 的 mtime 比线图缓存新就重新生成；不同 method /
         阈值组合各自缓存独立
    """
    source_png = get_source_image_png(stone_id, max_edge=max_edge)
    if source_png is None:
        return None

    detector = _METHOD_DETECTORS.get(method)
    if detector is None:
        return None

    safe_low = max(0, min(int(low), 254))
    safe_high = max(safe_low + 1, min(int(high), 255))
    safe_max = max(256, min(int(max_edge), 8192))

    m = re.search(r"(\d+)", stone_id)
    numeric = (m.group(1).lstrip("0") or "0") if m else "unknown"

    _LINEART_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = _LINEART_CACHE_DIR / (
        f"{numeric}_{method}_l{safe_low}_h{safe_high}_max{safe_max}.png"
    )
    if cache_path.exists() and cache_path.stat().st_mtime >= source_png.stat().st_mtime:
        return cache_path

    print(
        f"[lineart] generating {method} {cache_path.name} from {source_png.name}"
        f" (low={safe_low}, high={safe_high})",
        flush=True,
    )
    try:
        image = cv2.imread(str(source_png), cv2.IMREAD_COLOR)
        if image is None:
            print(f"[lineart] cv2.imread returned None for {source_png}", flush=True)
            return None
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        edges = detector(gray, safe_low, safe_high)
        height, width = edges.shape
        rgba = np.zeros((height, width, 4), dtype=np.uint8)
        rgba[..., 0] = 255
        rgba[..., 1] = 255
        rgba[..., 2] = 255
        rgba[..., 3] = edges
        cv2.imwrite(str(cache_path), rgba)
    except Exception as exc:  # noqa: BLE001
        print(f"[lineart] generate-failed: {exc}", flush=True)
        return None
    return cache_path
