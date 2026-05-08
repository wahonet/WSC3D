from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse

from ..canny import LINEART_METHODS, get_lineart_png
from ..utils import ok_response

router = APIRouter()


@router.get("/ai/lineart/methods")
def lineart_methods():
    return ok_response({"methods": LINEART_METHODS})


@router.get("/ai/lineart/{stone_id}")
def lineart(
    stone_id: str,
    method: str = "canny",
    low: int = 60,
    high: int = 140,
    max_edge: int = 4096,
):
    if method not in LINEART_METHODS:
        return JSONResponse(
            status_code=400,
            content={
                "error": "unsupported-method",
                "method": method,
                "supported": LINEART_METHODS,
            },
        )
    cache_path = get_lineart_png(
        stone_id, low=low, high=high, max_edge=max_edge, method=method
    )
    if cache_path is None:
        return JSONResponse(
            status_code=404,
            content={"error": "source-image-not-found", "stoneId": stone_id},
        )
    return FileResponse(
        cache_path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )
