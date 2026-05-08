from __future__ import annotations

from fastapi import APIRouter

from ..canny import canny_line
from ..sam import sam_segment, sam_segment_by_stone, sam_segment_by_uri
from ..sam3_service import sam3_segment
from ..schemas import CannyRequest, Sam3Request, SamRequest, YoloRequest
from ..yolo import yolo_detect, yolo_detect_by_stone, yolo_detect_by_uri

router = APIRouter()


@router.post("/ai/sam")
def sam(request: SamRequest):
    prompts = [prompt.model_dump(exclude_none=True) for prompt in request.prompts]
    if request.imageUri:
        return sam_segment_by_uri(request.imageUri, prompts)
    if request.stoneId:
        return sam_segment_by_stone(request.stoneId, prompts)
    if request.imageBase64:
        return sam_segment(request.imageBase64, prompts)
    return {
        "error": "imageUri_or_stoneId_or_imageBase64_required",
        "polygons": [],
        "confidence": 0.0,
        "model": "unavailable",
    }


@router.post("/ai/sam3")
def sam3(request: Sam3Request):
    return sam3_segment(
        text_prompt=request.textPrompt,
        stone_id=request.stoneId,
        image_uri=request.imageUri,
        image_base64=request.imageBase64,
        threshold=request.threshold,
        max_results=request.maxResults,
    )


@router.post("/ai/yolo")
def yolo(request: YoloRequest):
    if request.imageUri:
        return yolo_detect_by_uri(
            request.imageUri,
            class_filter=request.classFilter,
            conf_threshold=request.confThreshold,
            max_detections=request.maxDetections,
        )
    if request.stoneId:
        return yolo_detect_by_stone(
            request.stoneId,
            class_filter=request.classFilter,
            conf_threshold=request.confThreshold,
            max_detections=request.maxDetections,
        )
    if request.imageBase64:
        return yolo_detect(
            request.imageBase64,
            class_filter=request.classFilter,
            conf_threshold=request.confThreshold,
            max_detections=request.maxDetections,
        )
    return {
        "error": "imageUri_or_stoneId_or_imageBase64_required",
        "detections": [],
        "model": "unavailable",
        "coordinateSystem": "image-normalized",
    }


@router.post("/ai/canny")
def canny(request: CannyRequest):
    return canny_line(request.imageBase64, request.low, request.high)
