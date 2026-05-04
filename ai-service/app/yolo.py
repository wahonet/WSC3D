from __future__ import annotations

import threading
from collections import Counter
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np

from .sam import get_source_image_png
from .utils import decode_image

# YOLOv8 nano 通用模型：~6 MB，对汉画像石"人物 / 鸟兽"等 COCO 类别可识别，但对
# "祥瑞 / 礼器 / 车马"识别精度低；前端 UI 应明确"通用模型识别，可作 SAM 二次
# 精修的起点"。专门针对汉画像石微调的模型留给 M3 后续阶段。
_MODEL_NAME = "yolov8n"
# 模型权重的 fallback 查找顺序：
#   1. ai-service/yolov8n.pt（仓库根 + 第一次启动 ultralytics 自动下载到这）
#   2. ai-service/weights/yolov8n.pt（与 mobile_sam.pt 同目录，便于统一管理）
#   3. 直接给 "yolov8n.pt" 让 ultralytics 走它的下载逻辑
_MODEL_FILE = "yolov8n.pt"
_REPO_ROOT = Path(__file__).resolve().parent.parent
_MODEL_CANDIDATE_PATHS = [
    _REPO_ROOT / "yolov8n.pt",
    _REPO_ROOT / "weights" / "yolov8n.pt",
]

_model_lock = threading.Lock()
_model: Optional[Any] = None


def _resolve_weight_path() -> str:
    """优先返回已有权重文件的绝对路径，没找到就返回相对名 ultralytics 自己下。"""
    for candidate in _MODEL_CANDIDATE_PATHS:
        if candidate.exists() and candidate.is_file():
            return str(candidate)
    return _MODEL_FILE


def _load_model() -> Optional[Any]:
    """懒加载 YOLO 模型；线程安全。失败时返回 None，让调用方走 fallback。"""
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        weight_path = _resolve_weight_path()
        try:
            from ultralytics import YOLO  # type: ignore

            print(f"[yolo] loading {weight_path} (~6 MB)", flush=True)
            _model = YOLO(weight_path)
            print(f"[yolo] loaded {_MODEL_NAME}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[yolo] load-failed: {exc}", flush=True)
            _model = None
    return _model


def _enhance_for_relief(image: np.ndarray) -> np.ndarray:
    """
    汉画像石拓片 / 浮雕预处理：灰度 + CLAHE 提对比 + 复制成 3 通道。
    COCO 模型是在彩色自然照片上训练的，对低对比度灰度图响应低；这里把局部对比
    拉起来再喂给模型，能显著降低"什么都检测不到"的概率。

    输入 / 输出都是 RGB uint8 numpy 图。
    """
    if image is None:
        return image
    if image.ndim == 2:
        gray = image
    else:
        gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    return cv2.cvtColor(enhanced, cv2.COLOR_GRAY2RGB)


def _detections_from_model(
    image: np.ndarray,
    class_filter: Optional[list[str]],
    conf_threshold: float,
    max_detections: int,
) -> Optional[dict]:
    """用真实 YOLO 模型推理；模型未就绪时返回 None。

    返回 dict 含：
      - detections: 经过 conf_threshold + class_filter 过滤后的结果
      - debug.rawDetections: 模型输出的原始检测条数（未过滤）
      - debug.classDistribution: 模型实际识别出的类别 → 数量映射
      - debug.filteredByConf / debug.filteredByClass: 被过滤掉的数量
    前端可用于排查"为什么什么都没检测到"。
    """
    model = _load_model()
    if model is None:
        return None

    # 同时跑两遍：一次用原图，一次用 CLAHE 增强图（拓片 / 浮雕走这一路效果好）。
    # 取两边并集，按相同 IoU 去重避免双倍候选；显著降低"什么都没扫到"的频率。
    images_to_try = [image]
    enhanced = _enhance_for_relief(image)
    if enhanced is not None and not np.array_equal(enhanced, image):
        images_to_try.append(enhanced)

    raw_low_threshold = max(0.01, min(conf_threshold, 0.95))
    height, width = image.shape[:2]
    raw_records: list[dict] = []  # 保留原始（未按 class 过滤）所有检测
    class_counter: Counter = Counter()

    try:
        for run_image in images_to_try:
            results = model.predict(
                run_image,
                verbose=False,
                conf=raw_low_threshold,
                iou=0.45,
            )
            for result in results:
                names = result.names
                for box in result.boxes:
                    cls = int(box.cls[0])
                    label = str(names.get(cls, cls))
                    x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
                    confidence = float(box.conf[0])
                    raw_records.append(
                        {
                            "bbox": [x1, y1, x2, y2],
                            "bbox_uv": [
                                max(0.0, min(x1 / width, 1.0)),
                                max(0.0, min(y1 / height, 1.0)),
                                max(0.0, min(x2 / width, 1.0)),
                                max(0.0, min(y2 / height, 1.0)),
                            ],
                            "confidence": confidence,
                            "label": label,
                        }
                    )
                    class_counter[label] += 1
    except Exception as exc:  # noqa: BLE001
        print(f"[yolo] predict-failed: {exc}", flush=True)
        return None

    raw_records = _dedupe_overlapping(raw_records, iou_threshold=0.55)
    raw_count = len(raw_records)

    filtered_by_class = 0
    filtered_by_conf = 0
    detections: list[dict] = []
    for record in raw_records:
        if class_filter and record["label"] not in class_filter:
            filtered_by_class += 1
            continue
        if record["confidence"] < conf_threshold:
            filtered_by_conf += 1
            continue
        detections.append(record)

    detections.sort(key=lambda item: item["confidence"], reverse=True)
    capped = detections[: max(1, min(int(max_detections), 200))]

    print(
        f"[yolo] raw={raw_count} after-class={raw_count - filtered_by_class}"
        f" after-conf={len(detections)} returned={len(capped)} "
        f"top-classes={class_counter.most_common(8)}",
        flush=True,
    )

    return {
        "detections": capped,
        "model": _MODEL_NAME,
        "imageSize": [width, height],
        "coordinateSystem": "image-normalized",
        "debug": {
            "rawDetections": raw_count,
            "classDistribution": dict(class_counter.most_common(20)),
            "filteredByClass": filtered_by_class,
            "filteredByConf": filtered_by_conf,
            "appliedConfThreshold": conf_threshold,
            "appliedClassFilter": class_filter,
            "enhancedPasses": len(images_to_try),
        },
    }


def _dedupe_overlapping(records: list[dict], iou_threshold: float = 0.55) -> list[dict]:
    """同一 label 的 bbox 互相 IoU 高于阈值视为重复，保留 confidence 高的那个。

    场景：原图扫一遍 + CLAHE 增强图扫一遍，会有大量重复 bbox。直接合并避免
    候选列表翻倍。
    """
    if not records:
        return records
    records = sorted(records, key=lambda r: r["confidence"], reverse=True)
    kept: list[dict] = []
    for cand in records:
        duplicate = False
        for k in kept:
            if k["label"] != cand["label"]:
                continue
            if _bbox_iou(k["bbox"], cand["bbox"]) >= iou_threshold:
                duplicate = True
                break
        if not duplicate:
            kept.append(cand)
    return kept


def _bbox_iou(a: list[float], b: list[float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    inter_w = max(0.0, inter_x2 - inter_x1)
    inter_h = max(0.0, inter_y2 - inter_y1)
    inter = inter_w * inter_h
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    if union <= 0:
        return 0.0
    return inter / union


def _fallback_contour_detections(
    image: np.ndarray,
    max_detections: int,
) -> dict:
    """没装 ultralytics 或权重无法下载时的轮廓候选框，保证流程不中断。"""
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 60, 140)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    detections: list[dict] = []
    for contour in sorted(contours, key=cv2.contourArea, reverse=True):
        area = cv2.contourArea(contour)
        if area < max(120, width * height * 0.0008):
            continue
        x, y, w, h = cv2.boundingRect(contour)
        detections.append(
            {
                "bbox": [x, y, x + w, y + h],
                "bbox_uv": [
                    x / width,
                    y / height,
                    (x + w) / width,
                    (y + h) / height,
                ],
                "confidence": 0.35,
                "label": "contour-candidate",
            }
        )
        if len(detections) >= max_detections:
            break
    return {
        "detections": detections,
        "model": "yolo-fallback-contour",
        "imageSize": [width, height],
        "coordinateSystem": "image-normalized",
        "debug": {
            "rawDetections": len(detections),
            "classDistribution": {"contour-candidate": len(detections)},
            "filteredByClass": 0,
            "filteredByConf": 0,
            "appliedConfThreshold": 0.0,
            "appliedClassFilter": None,
            "enhancedPasses": 0,
        },
    }


def yolo_detect(
    image_base64: str,
    class_filter: Optional[list[str]] = None,
    conf_threshold: float = 0.10,
    max_detections: int = 80,
) -> dict:
    """旧路径：base64 截图作为 YOLO 输入。新代码请优先走 yolo_detect_by_stone。"""
    try:
        image = decode_image(image_base64)
    except Exception as exc:  # noqa: BLE001
        return {
            "detections": [],
            "model": "error",
            "error": f"decode-failed: {exc}",
            "coordinateSystem": "image-normalized",
        }
    result = _detections_from_model(image, class_filter, conf_threshold, max_detections)
    if result is None:
        result = _fallback_contour_detections(image, max_detections)
    result["sourceMode"] = "screenshot"
    return result


def yolo_detect_by_stone(
    stone_id: str,
    class_filter: Optional[list[str]] = None,
    conf_threshold: float = 0.10,
    max_detections: int = 80,
) -> dict:
    """
    新路径：根据 stoneId 走高清原图（pic/）做 YOLO 检测。复用 sam.get_source_image_png
    的转码 PNG 缓存，避免每次都读 tif。
    """
    source_path = get_source_image_png(stone_id)
    if source_path is None:
        return {
            "detections": [],
            "model": "none",
            "error": "source-image-not-found",
            "coordinateSystem": "image-normalized",
            "sourceMode": "source",
        }
    try:
        image = cv2.imread(str(source_path), cv2.IMREAD_COLOR)
        if image is None:
            return {
                "detections": [],
                "model": "error",
                "error": "image-read-failed",
                "coordinateSystem": "image-normalized",
                "sourceMode": "source",
            }
        # OpenCV 读出来是 BGR，YOLO ultralytics 内部会处理但保持 RGB 更稳。
        image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    except Exception as exc:  # noqa: BLE001
        return {
            "detections": [],
            "model": "error",
            "error": f"image-read-failed: {exc}",
            "coordinateSystem": "image-normalized",
            "sourceMode": "source",
        }
    result = _detections_from_model(image, class_filter, conf_threshold, max_detections)
    if result is None:
        result = _fallback_contour_detections(image, max_detections)
    result["sourceMode"] = "source"
    result["sourceImage"] = Path(source_path).name
    return result
