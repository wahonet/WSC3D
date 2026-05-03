from __future__ import annotations

import threading
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
_MODEL_FILE = "yolov8n.pt"

_model_lock = threading.Lock()
_model: Optional[Any] = None


def _load_model() -> Optional[Any]:
    """懒加载 YOLO 模型；线程安全。失败时返回 None，让调用方走 fallback。"""
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        try:
            from ultralytics import YOLO  # type: ignore

            print(f"[yolo] loading {_MODEL_FILE} (~6 MB, 首次会自动下载)", flush=True)
            _model = YOLO(_MODEL_FILE)
            print(f"[yolo] loaded {_MODEL_NAME}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[yolo] load-failed: {exc}", flush=True)
            _model = None
    return _model


def _detections_from_model(
    image: np.ndarray,
    class_filter: Optional[list[str]],
    conf_threshold: float,
    max_detections: int,
) -> Optional[dict]:
    """用真实 YOLO 模型推理；模型未就绪时返回 None。"""
    model = _load_model()
    if model is None:
        return None
    try:
        results = model.predict(image, verbose=False, conf=max(0.05, min(conf_threshold, 0.95)))
    except Exception as exc:  # noqa: BLE001
        print(f"[yolo] predict-failed: {exc}", flush=True)
        return None

    height, width = image.shape[:2]
    detections: list[dict] = []
    for result in results:
        names = result.names
        for box in result.boxes:
            cls = int(box.cls[0])
            label = str(names.get(cls, cls))
            if class_filter and label not in class_filter:
                continue
            x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
            confidence = float(box.conf[0])
            detections.append(
                {
                    # 像素坐标兼容旧接口
                    "bbox": [x1, y1, x2, y2],
                    # UV 坐标（image-normalized，v 向下；与 SAM polygon 同约定）
                    # 前端直接拿来当 BBox UV，无需再变换
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

    detections.sort(key=lambda item: item["confidence"], reverse=True)
    return {
        "detections": detections[: max(1, min(int(max_detections), 200))],
        "model": _MODEL_NAME,
        "imageSize": [width, height],
        "coordinateSystem": "image-normalized",
    }


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
    }


def yolo_detect(
    image_base64: str,
    class_filter: Optional[list[str]] = None,
    conf_threshold: float = 0.25,
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
    conf_threshold: float = 0.25,
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
