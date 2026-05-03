from __future__ import annotations

import cv2

from .utils import decode_image


def yolo_detect(image_base64: str, class_filter: list[str] | None = None) -> dict:
    image = decode_image(image_base64)
    height, width = image.shape[:2]

    try:
      from ultralytics import YOLO

      model = YOLO("yolov8n.pt")
      results = model.predict(image, verbose=False, conf=0.25)
      detections = []
      for result in results:
          names = result.names
          for box in result.boxes:
              cls = int(box.cls[0])
              label = str(names.get(cls, cls))
              if class_filter and label not in class_filter:
                  continue
              x1, y1, x2, y2 = [float(value) for value in box.xyxy[0].tolist()]
              detections.append({"bbox": [x1, y1, x2, y2], "confidence": float(box.conf[0]), "label": label})
      return {"detections": detections[:30], "model": "YOLOv8n"}
    except Exception:
      # 没装 ultralytics 或权重无法下载时，退化为轮廓候选框，保证流程不中断。
      gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
      edges = cv2.Canny(gray, 60, 140)
      contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
      detections = []
      for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:12]:
          area = cv2.contourArea(contour)
          if area < max(120, width * height * 0.0008):
              continue
          x, y, w, h = cv2.boundingRect(contour)
          detections.append({"bbox": [x, y, x + w, y + h], "confidence": 0.35, "label": "contour-candidate"})
      return {"detections": detections, "model": "YOLOv8-fallback-contour"}
