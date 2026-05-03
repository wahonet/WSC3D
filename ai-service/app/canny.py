from __future__ import annotations

import cv2
import numpy as np

from .utils import decode_image, encode_png


def canny_line(image_base64: str, low: int = 60, high: int = 140) -> dict:
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
