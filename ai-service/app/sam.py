from __future__ import annotations

import cv2
import numpy as np

from .utils import contour_to_polygon, decode_image, fallback_box_polygon


def sam_segment(image_base64: str, prompts: list[dict]) -> dict:
    image = decode_image(image_base64)
    height, width = image.shape[:2]
    prompt = prompts[0] if prompts else {"type": "point", "x": width / 2, "y": height / 2}

    # MobileSAM 权重不可用时使用局部边缘闭合轮廓作为稳定 fallback。
    # 这样前端候选闭环可先跑通，安装权重后再替换为真正 MobileSAM predictor。
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

    return {"polygons": [polygon], "confidence": 0.62, "model": "MobileSAM-fallback-contour"}
