"""
SAM（Segment Anything Model）推理服务

基于 MobileSAM ViT-T 的轻量分割模型，提供三条互补的输入路径：

1. **base64 截图**（``sam_segment``）—— 旧路径；前端把当前视角截图发过来，
   SAM 在小图上做分割。坐标系是图像归一化（v 向下）。
2. **stoneId 高清图**（``sam_segment_by_stone``）—— 主路径；按 stoneId 去
   ``pic/`` 找高清原图，原始分辨率上做分割。坐标系是 modelBox-uv（v 向下）。
3. **任意资源 URI**（``sam_segment_by_uri``）—— v0.8.0 J 起；URI 形如
   ``/assets/stone-resources/{stoneId}/{file}.png``，反解到本地路径后做分割。
   不依赖 backend 在线，让 SAM 直接跑在正射图 / 拓片 / 法线图等任意底图上。

模型加载：
- 启动时调用 ``kickoff_load`` 在后台线程下载权重 + 加载模型，FastAPI 启动
  不阻塞；前端通过 ``/ai/health`` 轮询 ``status`` 字段（pending /
  downloading / loading / ready / error）
- 权重文件按需下载到 ``ai-service/weights/mobile_sam.pt``（约 39 MB）；
  已存在就直接复用
- 加载失败时记录详细 detail，前端 UI 据此提示用户

高清图缓存：
- 一份内存图缓存（``_source_cache``，最近一次访问的 stoneId / image）
  减少 tif 重复解码
- 浏览器可读 PNG 落盘缓存到 ``ai-service/cache/source/``，前端通过
  ``/ai/source-image/{stoneId}`` 直接 ``<img src=...>`` 渲染

线程安全：
- predict 时 ``_predictor_lock`` 串行化 ``set_image``，避免并发请求互相覆盖

prompt 协议：
- ``point`` / ``box``：图像像素坐标（旧 base64 路径）
- ``point_uv`` / ``box_uv``：归一化 UV 坐标（高清图 / URI 路径）
- ``label = 1`` 正点（要这里）；``label = 0`` 负点（不要这里）
"""

from __future__ import annotations

import threading
import urllib.request
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np

from .resources import load_image_from_uri, load_source_image
from .utils import contour_to_polygon, decode_image, fallback_box_polygon

# MobileSAM 官方权重（约 39 MB），首次启动时后台下载。
_WEIGHT_URL = "https://github.com/ChaoningZhang/MobileSAM/raw/master/weights/mobile_sam.pt"
_WEIGHT_PATH = Path(__file__).resolve().parent.parent / "weights" / "mobile_sam.pt"
_MODEL_TYPE = "vit_t"
_MODEL_NAME = "mobile-sam-vit-t"

# predictor 实例与加载状态；predict 时加互斥锁，避免并发 set_image 冲突。
_predictor_lock = threading.Lock()
_predictor: Optional[Any] = None

_load_status: dict[str, Any] = {
    "status": "pending",
    "model": _MODEL_NAME,
    "detail": "",
    "weightPath": str(_WEIGHT_PATH),
}

def _set_status(status: str, detail: str = "") -> None:
    _load_status["status"] = status
    _load_status["detail"] = detail
    print(f"[SAM] status={status} detail={detail}", flush=True)


# --------------------------------------------------------------
# 权重下载 + 模型加载
# --------------------------------------------------------------


def _ensure_weight() -> bool:
    if _WEIGHT_PATH.exists():
        size_mb = _WEIGHT_PATH.stat().st_size / 1024 / 1024
        _set_status("loading", f"using existing weight ({size_mb:.1f} MB) at {_WEIGHT_PATH}")
        return True
    _set_status("downloading", f"downloading MobileSAM weight ~40MB to {_WEIGHT_PATH}")
    try:
        _WEIGHT_PATH.parent.mkdir(parents=True, exist_ok=True)
        last_pct = {"value": -1}

        def _progress(blocks: int, block_size: int, total_size: int) -> None:
            if total_size <= 0:
                return
            downloaded = blocks * block_size
            pct = min(100, int(downloaded * 100 / total_size))
            if pct - last_pct["value"] >= 10:
                last_pct["value"] = pct
                mb_done = downloaded / 1024 / 1024
                mb_total = total_size / 1024 / 1024
                print(f"[SAM] download progress {pct}%  ({mb_done:.1f} / {mb_total:.1f} MB)", flush=True)

        urllib.request.urlretrieve(_WEIGHT_URL, str(_WEIGHT_PATH), reporthook=_progress)
        size_mb = _WEIGHT_PATH.stat().st_size / 1024 / 1024
        _set_status("loading", f"downloaded ({size_mb:.1f} MB), loading model")
    except Exception as exc:  # noqa: BLE001
        if _WEIGHT_PATH.exists():
            try:
                _WEIGHT_PATH.unlink()
            except OSError:
                pass
        _set_status(
            "error",
            f"weight-download-failed: {type(exc).__name__}: {exc}. "
            f"manually place mobile_sam.pt at {_WEIGHT_PATH}",
        )
        return False
    return True


def _load_predictor_blocking() -> None:
    global _predictor
    if _predictor is not None:
        return
    if not _ensure_weight():
        return
    try:
        from mobile_sam import SamPredictor, sam_model_registry  # type: ignore

        sam = sam_model_registry[_MODEL_TYPE](checkpoint=str(_WEIGHT_PATH))
        sam.to(device="cpu")
        sam.eval()
        _predictor = SamPredictor(sam)
        _set_status("ready", _MODEL_NAME)
    except Exception as exc:  # noqa: BLE001
        _set_status(
            "error",
            f"load-failed: {type(exc).__name__}: {exc}. "
            "run `pip install -r requirements.txt` in ai-service/",
        )


def kickoff_load() -> None:
    if _load_status["status"] in {"downloading", "loading", "ready"}:
        return
    thread = threading.Thread(target=_load_predictor_blocking, daemon=True)
    thread.start()


def get_status() -> dict[str, Any]:
    return {
        "ready": _predictor is not None and _load_status["status"] == "ready",
        "status": _load_status["status"],
        "model": _load_status["model"],
        "detail": _load_status["detail"],
    }


# --------------------------------------------------------------
# 高清图查找与加载（按 stoneId）
# --------------------------------------------------------------


# --------------------------------------------------------------
# 坐标系转换
# --------------------------------------------------------------


def _uv_to_pixel_prompt(prompt: dict, width: int, height: int) -> dict:
    """
    把 UV 空间的 prompt 换成图像像素 prompt。
    前后端的 UV 约定一致：u 向右、v 向下（v=0 顶部 / v=1 底部，与图像坐标一致）。
    所以不需要做 y 翻转，直接乘以 width / height 即可。
    """
    p_type = prompt.get("type")
    if p_type == "point_uv":
        u = float(prompt.get("u", 0.5))
        v = float(prompt.get("v", 0.5))
        x = max(0.0, min(u * width, width - 1.0))
        y = max(0.0, min(v * height, height - 1.0))
        return {"type": "point", "x": x, "y": y, "label": int(prompt.get("label", 1))}
    if p_type == "box_uv":
        u1, v1, u2, v2 = prompt.get("bbox_uv", [0.0, 0.0, 1.0, 1.0])
        return {
            "type": "box",
            "bbox": [u1 * width, v1 * height, u2 * width, v2 * height],
        }
    return prompt


# --------------------------------------------------------------
# SAM 核心 predictor 调用
# --------------------------------------------------------------


def _run_predictor(image: np.ndarray, prompts_px: list[dict], fallback_source: str) -> dict:
    """
    输入 RGB numpy 图 + 像素坐标 prompts，返回归一化 polygon（y 向下 / 图像坐标系）。

    支持的 prompt 类型（一次调用可任意组合）：
      - {"type": "point", "x", "y", "label": 0|1}：正点(1) / 负点(0)，可有多个
      - {"type": "box", "bbox": [x1, y1, x2, y2]}：box 框，可有 0 或 1 个
    其它 prompt（包括 box_uv/point_uv 这类 UV 形态）应该已被 _uv_to_pixel_prompt
    转成了上述像素形态再传进来。

    多 prompt 行为：mobile-sam SamPredictor.predict 原生支持 point_coords +
    point_labels + box 三者一起；当 box 与点都给了，box 限定 mask 大致区域，
    点继续做"内部要 / 不要"的精修，特别适合"用 box 框出人物 + 用负点把背景剔掉"。
    """
    if _predictor is None:
        result = _run_fallback(image, prompts_px)
        result["warning"] = _load_status["status"]
        result["model"] = result.get("model", "mobile-sam-fallback-contour") + f":{fallback_source}"
        return result

    height, width = image.shape[:2]

    # 把所有 point 收集到一起，box 只取最后一个。无任何 prompt 时退化为图像中心一个正点。
    point_xy: list[list[float]] = []
    point_labels: list[int] = []
    box_xyxy: Optional[list[float]] = None
    for prompt in prompts_px:
        kind = prompt.get("type")
        if kind == "point":
            x = float(prompt.get("x", width / 2))
            y = float(prompt.get("y", height / 2))
            label = int(prompt.get("label", 1))
            point_xy.append([x, y])
            point_labels.append(1 if label != 0 else 0)
        elif kind == "box":
            bbox = prompt.get("bbox", [0, 0, width, height])
            box_xyxy = [float(v) for v in bbox]

    if not point_xy and box_xyxy is None:
        point_xy = [[width / 2, height / 2]]
        point_labels = [1]

    point_coords = np.array(point_xy, dtype=np.float32) if point_xy else None
    point_labels_arr = np.array(point_labels, dtype=np.int32) if point_labels else None
    box_arr = np.array(box_xyxy, dtype=np.float32).reshape(4) if box_xyxy is not None else None

    # 多 prompt 时 multimask_output=False 让 SAM 直接给最优 mask（避免 3 mask 启发式
    # 把 box 框出来的整块再切成"小、中、大"造成不必要的歧义）。
    multimask = box_arr is None and (point_labels_arr is None or len(point_labels_arr) <= 1)

    try:
        with _predictor_lock:
            _predictor.set_image(image)
            masks, scores, _ = _predictor.predict(
                point_coords=point_coords,
                point_labels=point_labels_arr,
                box=box_arr,
                multimask_output=multimask,
            )

        # 选最佳 mask：单 mask 直接选；多 mask 走启发式（去掉过大、必须包含每个正点）。
        if masks.shape[0] == 1:
            best_idx: Optional[int] = 0 if int(masks[0].sum()) > 0 else None
        else:
            # 启发式选择需要"代表点"作为参照，这里取所有正点；
            # _select_best_mask 当前 API 只接受单点，传一个正点即可（多点已经在 SAM
            # 推理时让 mask 收敛，启发式只是兜底防止"整张图"答案）。
            ref_prompt: dict
            if point_xy and 1 in point_labels:
                pos_index = point_labels.index(1)
                ref_prompt = {
                    "type": "point",
                    "x": point_xy[pos_index][0],
                    "y": point_xy[pos_index][1],
                }
            elif box_arr is not None:
                cx = (box_arr[0] + box_arr[2]) / 2
                cy = (box_arr[1] + box_arr[3]) / 2
                ref_prompt = {"type": "point", "x": float(cx), "y": float(cy)}
            else:
                ref_prompt = {"type": "point", "x": width / 2, "y": height / 2}
            best_idx = _select_best_mask(masks, scores, width, height, ref_prompt)
        if best_idx is None:
            return _run_fallback(image, prompts_px)
        mask = masks[best_idx]
        polygon = _mask_to_polygon(mask, width, height)
        if polygon is None:
            return _run_fallback(image, prompts_px)
        return {
            "polygons": [polygon],
            "confidence": float(scores[best_idx]),
            "model": _MODEL_NAME,
            "maskAreaRatio": float(mask.sum()) / float(width * height),
            "promptCounts": {
                "positive": sum(1 for label in point_labels if label == 1),
                "negative": sum(1 for label in point_labels if label == 0),
                "box": 1 if box_arr is not None else 0,
            },
        }
    except Exception as exc:  # noqa: BLE001
        result = _run_fallback(image, prompts_px)
        result["warning"] = f"predict-failed: {exc}"
        return result


def _select_best_mask(masks: np.ndarray, scores: np.ndarray, width: int, height: int, prompt: dict) -> Optional[int]:
    """
    MobileSAM multimask_output=True 返回 3 个候选 mask（small / medium / large）。
    直接 argmax(scores) 常把"最大那个"选出来 —— 在汉画像石浅浮雕上就是整块场景一锅端。
    改成：
      1. 丢掉占图像面积 > 50% 的 mask（通常是"场景级"大块）
      2. 丢掉必须包含 prompt 点但没包含的 mask
      3. 在剩下的里选面积最小的（最紧凑）
    """
    total = float(width * height)
    max_ratio = 0.5
    point_x: Optional[int] = None
    point_y: Optional[int] = None
    if prompt.get("type") == "point":
        point_x = int(max(0, min(width - 1, float(prompt.get("x", width / 2)))))
        point_y = int(max(0, min(height - 1, float(prompt.get("y", height / 2)))))

    candidates: list[tuple[int, int]] = []  # (area, idx)
    for idx in range(len(masks)):
        mask = masks[idx]
        area = int(mask.sum())
        if area == 0:
            continue
        if area / total > max_ratio:
            continue
        if point_x is not None and point_y is not None and not mask[point_y, point_x]:
            # point prompt 要求 mask 包含点击点；某些 mask 是"周边区域"，跳过。
            continue
        candidates.append((area, idx))

    if not candidates:
        # 所有 mask 都太大：选面积最小那个（至少不会整张图都是）
        nonzero = [(int(masks[i].sum()), i) for i in range(len(masks)) if int(masks[i].sum()) > 0]
        if not nonzero:
            return None
        nonzero.sort()
        return nonzero[0][1]

    candidates.sort()  # 面积升序
    return candidates[0][1]


def _mask_to_polygon(mask: np.ndarray, width: int, height: int) -> Optional[list[list[float]]]:
    mask_u8 = (mask.astype(np.uint8)) * 255
    contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    largest = max(contours, key=cv2.contourArea)
    # 高清大图时最小面积门槛相应放大。
    min_area = max(80, int(width * height * 0.0001))
    if cv2.contourArea(largest) < min_area:
        return None
    # epsilon 用更小的系数让 polygon 顶点多一些、轮廓更贴合 mask（而不是简化成矩形）。
    # contour_to_polygon 内部有 120 点上限自动降采样，不用担心顶点过多。
    epsilon = max(1.0, 0.002 * cv2.arcLength(largest, True))
    approx = cv2.approxPolyDP(largest, epsilon, True)
    return contour_to_polygon(approx, width, height)


def _run_fallback(image: np.ndarray, prompts_px: list[dict]) -> dict:
    """OpenCV Canny fallback，用 numpy 图作为输入。"""
    height, width = image.shape[:2]
    prompt = prompts_px[0] if prompts_px else {"type": "point", "x": width / 2, "y": height / 2}

    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 130)
    kernel = np.ones((5, 5), np.uint8)
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if prompt.get("type") == "box":
        x1, y1, x2, y2 = prompt.get("bbox", [0, 0, width, height])
        cx = (float(x1) + float(x2)) / 2
        cy = (float(y1) + float(y2)) / 2
    else:
        cx = float(prompt.get("x", width / 2))
        cy = float(prompt.get("y", height / 2))

    best = None
    best_score = float("inf")
    for contour in contours:
        if cv2.contourArea(contour) < 80:
            continue
        inside = cv2.pointPolygonTest(contour, (cx, cy), True)
        x, y, w, h = cv2.boundingRect(contour)
        center_distance = ((x + w / 2 - cx) ** 2 + (y + h / 2 - cy) ** 2) ** 0.5
        score = -inside if inside > 0 else center_distance
        if score < best_score:
            best_score = score
            best = contour

    if best is None:
        polygon = fallback_box_polygon(cx, cy, width, height)
    else:
        epsilon = max(1.5, 0.01 * cv2.arcLength(best, True))
        approx = cv2.approxPolyDP(best, epsilon, True)
        polygon = contour_to_polygon(approx, width, height)

    return {"polygons": [polygon], "confidence": 0.62, "model": "mobile-sam-fallback-contour"}


# --------------------------------------------------------------
# 对外两个入口：image_base64（旧路径）/ stoneId（高清图路径）
# --------------------------------------------------------------


def sam_segment(image_base64: str, prompts: list[dict]) -> dict:
    """
    旧路径：前端截图 three-stage canvas 为 base64，prompts 是图像像素坐标。
    返回 polygon 为图像归一化坐标（y 向下），前端再通过 screenToUV 转到 modelBox。
    """
    try:
        image = decode_image(image_base64)
    except Exception as exc:  # noqa: BLE001
        return {"polygons": [], "confidence": 0.0, "model": "error", "error": f"decode-failed: {exc}"}
    result = _run_predictor(image, prompts, fallback_source="screenshot")
    result.setdefault("sourceMode", "screenshot")
    result["coordinateSystem"] = "image-normalized"
    return result


def sam_segment_by_stone(stone_id: str, prompts_uv: list[dict]) -> dict:
    """
    高清图路径：根据 stoneId 在 pic 目录找对应原图，跑 SAM，返回 modelBox UV 归一化 polygon。
    前端可以直接把 polygon 作为 annotation 坐标使用，不需要再做 screenToUV。
    """
    loaded = load_source_image(stone_id)
    if loaded is None:
        return {
            "polygons": [],
            "confidence": 0.0,
            "model": "none",
            "error": "source-image-not-found",
            "sourceMode": "source",
        }
    image, name = loaded
    height, width = image.shape[:2]
    prompts_px = [_uv_to_pixel_prompt(p, width, height) for p in prompts_uv]
    result = _run_predictor(image, prompts_px, fallback_source="source")
    # _run_predictor 内部 contour_to_polygon 已输出 [x/W, y/H, 0]，
    # 与前端 modelBox UV (v 向下) 约定一致，前端直接当 UV 用，无需再翻 y。
    result["coordinateSystem"] = "modelbox-uv"
    result["sourceMode"] = "source"
    result["sourceImage"] = name
    result["sourceSize"] = [width, height]
    # 模型标签加 :source 后缀方便前端区分。
    if result.get("model") and not result["model"].endswith(":source"):
        result["model"] = f"{result['model']}:source"
    return result


# --------------------------------------------------------------
# v0.8.0 J：任意资源 URI 路径（正射图 / 拓片 / 法线图等）
# --------------------------------------------------------------


def sam_segment_by_uri(uri: str, prompts_uv: list[dict]) -> dict:
    """
    v0.8.0 J：让 SAM 用任意资源 URI（正射图 / 拓片 / 法线图 / 外链 PNG）作为输入。
    prompts 用 UV 传入，返回 polygon 为同一 UV（归一化到图像尺寸，v 向下）。

    调用方（前端）确保 URI 对应的图像与当前画布坐标系等价时（如生成时
    equivalentToModel 的正射图），返回的 UV 可直接当 modelBox UV 用；否则由
    前端做必要的跨资源变换。
    """
    loaded = load_image_from_uri(uri)
    if loaded is None:
        return {
            "polygons": [],
            "confidence": 0.0,
            "model": "none",
            "error": "resource-uri-not-found",
            "sourceMode": "resource-uri",
            "uri": uri,
        }
    image, name = loaded
    height, width = image.shape[:2]
    prompts_px = [_uv_to_pixel_prompt(p, width, height) for p in prompts_uv]
    result = _run_predictor(image, prompts_px, fallback_source="resource-uri")
    result["coordinateSystem"] = "image-uv"
    result["sourceMode"] = "resource-uri"
    result["sourceImage"] = name
    result["sourceSize"] = [width, height]
    result["sourceUri"] = uri
    if result.get("model") and not result["model"].endswith(":resource"):
        result["model"] = f"{result['model']}:resource"
    return result
