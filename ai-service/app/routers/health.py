from __future__ import annotations

from fastapi import APIRouter

from ..sam3_service import get_status as get_sam3_status
from ..utils import legacy_ai_enabled, ok_response

router = APIRouter()


@router.get("/ai/health")
def health():
    # P0 收敛：SAM3 是唯一 AI 标注入口；lineart（线图叠加）是视觉辅助保留。
    # legacy 开启时才回报旧 feature 与 MobileSAM 状态，避免前端误判可用。
    payload: dict = {
        "features": ["sam3", "mask-compose", "lineart"],
        "sam3": get_sam3_status(),
        "legacyAi": legacy_ai_enabled(),
    }
    if legacy_ai_enabled():
        from ..sam import get_status as get_sam_status

        payload["features"] = ["sam3", "mask-compose", "lineart", "sam", "yolo", "canny"]
        payload["sam"] = get_sam_status()
    return ok_response(payload)
