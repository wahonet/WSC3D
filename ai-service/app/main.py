"""
WSC3D AI 服务入口（FastAPI，:8000）

为前端提供 SAM 语义分割、YOLO 目标检测、Canny 线图与高清原图转码 4 个核心
端点，所有重模型在后台线程懒加载，FastAPI 启动不阻塞。

主要端点：
- ``GET  /ai/health``                 健康检查 + SAM 加载状态（含进度）
- ``POST /ai/sam``                    SAM 多 prompt 智能分割（imageUri / stoneId / base64 三路径）
- ``POST /ai/yolo``                   YOLOv8n 目标检测（同样三路径）
- ``POST /ai/canny``                  OpenCV Canny 线图（旧 base64 路径）
- ``GET  /ai/source-image/{stoneId}`` 高清原图 tif → PNG 转码并落盘缓存
- ``GET  /ai/lineart/{stoneId}``      线图 PNG（5 种算法 / 阈值组合各自缓存）
- ``GET  /ai/lineart/methods``        前端 UI 拉取支持的线图方法列表

输入路径优先级（SAM / YOLO 同型）：
``imageUri > stoneId > imageBase64``。前端在不同场景按需选择：
- imageUri：v0.8.0 J 起，用于在正射图 / 拓片等任意资源上跑分割检测
- stoneId：默认，按数字前缀去 pic/ 下匹配高清原图
- imageBase64：fallback，把当前画布截图传过来（精度低，仅在前两路径都不
  可用时使用）

启动机制：
- ``on_startup`` 钩子触发 ``sam_kickoff_load``，在后台线程下载权重并加载
  MobileSAM；前端通过 ``/ai/health`` 轮询 sam.status 决定 SAM 按钮可用性
- 若 ``ai-service/weights/`` 已有 ``mobile_sam.pt`` 就跳过下载
- 仅监听 127.0.0.1，前端走 Vite proxy 同源访问
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from .canny import LINEART_METHODS, canny_line, get_lineart_png
from .sam import get_source_image_png
from .sam import get_status as get_sam_status
from .sam import kickoff_load as sam_kickoff_load
from .sam import sam_segment, sam_segment_by_stone, sam_segment_by_uri
from .utils import ok_response
from .yolo import yolo_detect, yolo_detect_by_stone, yolo_detect_by_uri

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
    #   imageUri    —— 任意资源 URI（正射图 / 拓片 / 法线图 …），v0.8.0 J 起
    #                   与 stoneId 同等支持，允许 SAM 跑在非 pic/ 的任意底图
    #   stoneId     —— 按画像石 id 去 pic/ 目录匹配原图
    #   imageBase64 —— 前端截图 base64（当前视角，1000px 级）
    stoneId: str | None = None
    imageBase64: str | None = None
    imageUri: str | None = None
    prompts: list[SamPrompt] = Field(default_factory=list)


class YoloRequest(BaseModel):
    # 与 SamRequest 同型：imageUri 优先 > stoneId (pic/ 高清图) > imageBase64 截图。
    # 默认 conf 0.10：汉画像石灰度浮雕在 COCO 模型上置信度普遍偏低，0.25 实测会
    # 过滤掉绝大多数检测。前端如果想严格筛选，UI 滑杆自己拉高。
    stoneId: str | None = None
    imageBase64: str | None = None
    imageUri: str | None = None
    classFilter: list[str] | None = None
    confThreshold: float = 0.10
    maxDetections: int = 80


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
    # 优先级 imageUri > stoneId (pic/ 高清图) > imageBase64 (前端截图)
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


@app.post("/ai/yolo")
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


@app.get("/ai/quality/{stone_id}")
def image_quality(stone_id: str, max_edge: int = 4096):
    """
    图像质量自动校验（SOP §3.5）。返回长边 / 过曝 / 欠曝 / 聚焦清晰度的启发式
    指标，B/D 阶段的 preflight UI 据此提示标员"哪些石头不适合训练"。

    指标说明：
      - longEdge：原始 tif 解码后长边像素，门槛 ≥ 1500
      - overexposedRatio：灰度 > 245 像素占比，门槛 < 0.30
      - underexposedRatio：灰度 < 10 像素占比，门槛 < 0.30
      - laplacianVariance：拉普拉斯方差（越大越锐），门槛 ≥ 50
        汉画像石浅浮雕的拉普拉斯方差经验值 50-300，整体偏低；< 50 通常说明
        整体糊或拍摄距离太远

    所有指标都基于转码后的 PNG（≤ max_edge 长边）；原 tif 解码 + 缩放都已在
    get_source_image_png 缓存，重复调不增加 IO。
    """
    import cv2
    import numpy as np

    cache_path = get_source_image_png(stone_id, max_edge=max_edge)
    if cache_path is None:
        return JSONResponse(
            status_code=404,
            content={"error": "source-image-not-found", "stoneId": stone_id},
        )
    bgr = cv2.imread(str(cache_path), cv2.IMREAD_COLOR)
    if bgr is None:
        return JSONResponse(
            status_code=500,
            content={"error": "decode-failed", "stoneId": stone_id, "cachePath": str(cache_path)},
        )
    height, width = bgr.shape[:2]
    long_edge = max(width, height)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    total_px = float(gray.size)
    over_ratio = float(np.count_nonzero(gray > 245)) / total_px
    under_ratio = float(np.count_nonzero(gray < 10)) / total_px
    # 拉普拉斯方差：经典聚焦评价指标
    lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    warnings = []
    if long_edge < 1500:
        warnings.append("low-resolution")
    if over_ratio > 0.3:
        warnings.append("overexposed")
    if under_ratio > 0.3:
        warnings.append("underexposed")
    if lap_var < 50:
        warnings.append("blurry")

    return ok_response(
        {
            "stoneId": stone_id,
            "fileName": cache_path.name,
            "width": width,
            "height": height,
            "longEdge": long_edge,
            "isLongEdgeOk": long_edge >= 1500,
            "overexposedRatio": round(over_ratio, 4),
            "underexposedRatio": round(under_ratio, 4),
            "isExposureOk": over_ratio < 0.3 and under_ratio < 0.3,
            "laplacianVariance": round(lap_var, 2),
            "isFocusOk": lap_var >= 50,
            "warnings": warnings,
        }
    )


@app.get("/ai/lineart/methods")
def lineart_methods():
    """前端 UI 拉支持的线图方法列表，避免硬编码。"""
    return ok_response({"methods": LINEART_METHODS})


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

    method 支持：
      - canny：经典双阈值；最快
      - sobel：Sobel 梯度幅值阈值化；对灰度软边缘敏感
      - scharr：Scharr 改进核；细节多的浮雕更精细
      - morph：自适应阈值 + 形态学；残损 / 风化表面更稳
      - canny-plus：Canny + 形态学闭运算填补断边；汉画像石残损浮雕推荐
    low / high: 阈值；morph 方法把 low 当 blockSize 用（强制奇数）。
                调阈值 / 切方法 = 拉不同 cache 文件，互不影响。
    """
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
