"""
WSC3D AI 服务入口（FastAPI，:8010）。

入口层只负责应用生命周期和 router 装配；图像资源、质量分析、SAM、YOLO、线图
逻辑分别位于独立模块。
"""

from __future__ import annotations

from fastapi import FastAPI

from .routers.health import router as health_router
from .routers.imagery import router as imagery_router
from .routers.inference import router as inference_router
from .routers.lineart import router as lineart_router
from .utils import legacy_ai_enabled

app = FastAPI(title="WSC3D AI Service", version="0.1.0")


@app.on_event("startup")
def on_startup() -> None:
    # P0 收敛：MobileSAM 仅在 WSC3D_LEGACY_AI=1 时预加载；SAM3 保持首次请求懒加载。
    if legacy_ai_enabled():
        from .sam import kickoff_load as sam_kickoff_load

        sam_kickoff_load()


app.include_router(health_router)
app.include_router(inference_router)
app.include_router(imagery_router)
app.include_router(lineart_router)
