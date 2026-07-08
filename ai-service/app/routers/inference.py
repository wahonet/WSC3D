from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..mask_ops import compose_mask
from ..sam3_service import sam3_segment
from ..schemas import CannyRequest, MaskComposeRequest, Sam3Request, SamRequest, YoloRequest
from ..utils import legacy_ai_enabled

router = APIRouter()

_LEGACY_GONE_DETAIL = (
    "legacy-ai-disabled: 该端点已下线，SAM3 (/ai/sam3) 是唯一 AI 标注入口。"
    "迁移旧数据或调试时可设环境变量 WSC3D_LEGACY_AI=1 临时恢复。"
)


def _require_legacy() -> None:
    if not legacy_ai_enabled():
        raise HTTPException(status_code=410, detail=_LEGACY_GONE_DETAIL)


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


@router.post("/ai/mask/compose")
def mask_compose(request: MaskComposeRequest):
    """P2 mask 级合成：base 几何 + 补笔/擦除 → 形态学清理 → 重新矢量化。"""

    return compose_mask(request)


# ---------------------------------------------------------------------------
# 以下为 legacy 端点（P0 收敛后默认 410 Gone）。二阶段确认无人依赖后物理删除。
# ---------------------------------------------------------------------------


@router.post("/ai/sam")
def sam(request: SamRequest):
    _require_legacy()
    from ..sam import sam_segment, sam_segment_by_stone, sam_segment_by_uri

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


@router.post("/ai/yolo")
def yolo(request: YoloRequest):
    _require_legacy()
    from ..yolo import yolo_detect, yolo_detect_by_stone, yolo_detect_by_uri

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
    _require_legacy()
    from ..canny import canny_line

    return canny_line(request.imageBase64, request.low, request.high)
