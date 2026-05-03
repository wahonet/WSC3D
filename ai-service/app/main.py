from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from .canny import canny_line, get_lineart_png
from .sam import get_source_image_png
from .sam import get_status as get_sam_status
from .sam import kickoff_load as sam_kickoff_load
from .sam import sam_segment, sam_segment_by_stone
from .utils import ok_response
from .yolo import yolo_detect

app = FastAPI(title="WSC3D AI Service", version="0.1.0")


@app.on_event("startup")
def on_startup() -> None:
    # SAM 权重下载与模型加载都在后台线程里进行，uvicorn 启动不阻塞。
    # 前端通过 /ai/health 轮询 sam.status 来决定 SAM 按钮是否可用。
    sam_kickoff_load()


class SamPrompt(BaseModel):
    # type 支持：
    #   "point" / "box"           —— 图像像素坐标（旧路径）
    #   "point_uv" / "box_uv"     —— modelBox 归一化坐标 v 向上（高清图路径）
    type: str
    x: float | None = None
    y: float | None = None
    u: float | None = None
    v: float | None = None
    label: int | None = 1
    bbox: list[float] | None = None
    bbox_uv: list[float] | None = None


class SamRequest(BaseModel):
    # 三个输入入口（由高到低优先级）：
    #   stoneId     —— 按画像石 id 去 pic/ 目录匹配原图（推荐，支持高清图）
    #   imageBase64 —— 前端截图 base64（当前视角，1000px 级）
    #   imageUri    —— M3-a 预留：后端直接读本地文件，避免 100MB 原图 base64
    stoneId: str | None = None
    imageBase64: str | None = None
    imageUri: str | None = None
    prompts: list[SamPrompt] = Field(default_factory=list)


class YoloRequest(BaseModel):
    imageBase64: str
    classFilter: list[str] | None = None


class CannyRequest(BaseModel):
    imageBase64: str
    low: int = 60
    high: int = 140


@app.get("/ai/health")
def health():
    return ok_response({
        "features": ["sam", "yolo", "canny"],
        "sam": get_sam_status()
    })


@app.post("/ai/sam")
def sam(request: SamRequest):
    prompts = [prompt.model_dump(exclude_none=True) for prompt in request.prompts]
    # 优先用高清原图：stoneId 有且 pic/ 里能匹配到文件就走这条分支。
    if request.stoneId:
        return sam_segment_by_stone(request.stoneId, prompts)
    if request.imageBase64:
        return sam_segment(request.imageBase64, prompts)
    return {
        "error": "stoneId_or_imageBase64_required",
        "polygons": [],
        "confidence": 0.0,
        "model": "unavailable",
    }


@app.post("/ai/yolo")
def yolo(request: YoloRequest):
    return yolo_detect(request.imageBase64, request.classFilter)


@app.post("/ai/canny")
def canny(request: CannyRequest):
    return canny_line(request.imageBase64, request.low, request.high)


@app.get("/ai/source-image/{stone_id}")
def source_image(stone_id: str, max_edge: int = 4096):
    """
    返回 pic/ 下高清原图转码后的 PNG。tif 浏览器原生不支持显示，
    标注界面"高清图模式"通过该端点直接 <img src=...> 渲染。
    首次访问会做一次解码 + 缩放 + 写盘，之后直接命中缓存（约 ms 级响应）。
    """
    cache_path = get_source_image_png(stone_id, max_edge=max_edge)
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


@app.get("/ai/lineart/{stone_id}")
def lineart(
    stone_id: str,
    method: str = "canny",
    low: int = 60,
    high: int = 140,
    max_edge: int = 4096,
):
    """
    返回该画像石的线图 PNG（白色描边 + alpha 渐变），可直接半透明叠加在
    高清原图上辅助辨识浅浮雕轮廓。

    method: 当前仅支持 canny；预留 sobel / hed / relic2contour 等 M3 后续阶段。
    low / high: Canny 双阈值，前端 UI 会带滑杆，调阈值 = 拉不同 cache 文件，
                所以阈值变化 = 立即出新结果 + 不同阈值各自缓存独立。
    """
    if method != "canny":
        return JSONResponse(
            status_code=400,
            content={"error": "unsupported-method", "method": method},
        )
    cache_path = get_lineart_png(stone_id, low=low, high=high, max_edge=max_edge)
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
