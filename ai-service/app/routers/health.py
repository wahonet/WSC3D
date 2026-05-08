from __future__ import annotations

from fastapi import APIRouter

from ..sam import get_status as get_sam_status
from ..sam3_service import get_status as get_sam3_status
from ..utils import ok_response

router = APIRouter()


@router.get("/ai/health")
def health():
    return ok_response({
        "features": ["sam", "sam3", "yolo", "canny"],
        "sam": get_sam_status(),
        "sam3": get_sam3_status(),
    })
