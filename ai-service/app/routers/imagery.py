from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse

from ..quality import analyze_image_quality
from ..resources import get_pic_preview_png, get_source_image_png
from ..utils import ok_response

router = APIRouter()


@router.get("/ai/pic-preview")
def pic_preview(fileName: str, max_edge: int = 400):
    cache_path = get_pic_preview_png(fileName, max_edge=max_edge)
    if cache_path is None:
        return JSONResponse(
            status_code=404,
            content={"error": "pic-preview-not-found", "fileName": fileName},
        )
    return FileResponse(
        cache_path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/ai/source-image/{stone_id}")
def source_image(stone_id: str, max_edge: int = 4096, face: str | None = None):
    cache_path = get_source_image_png(stone_id, max_edge=max_edge, face=face)
    if cache_path is None:
        return JSONResponse(
            status_code=404,
            content={"error": "source-image-not-found", "stoneId": stone_id, "face": face},
        )
    return FileResponse(
        cache_path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/ai/quality/{stone_id}")
def image_quality(stone_id: str, max_edge: int = 4096):
    cache_path = get_source_image_png(stone_id, max_edge=max_edge)
    if cache_path is None:
        return JSONResponse(
            status_code=404,
            content={"error": "source-image-not-found", "stoneId": stone_id},
        )
    result = analyze_image_quality(stone_id, cache_path)
    if "error" in result:
        return JSONResponse(status_code=500, content=result)
    return ok_response(result)
