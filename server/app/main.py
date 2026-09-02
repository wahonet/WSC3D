# -*- coding: utf-8 -*-
"""StoneLab 后端入口。

开发：cd stonelab/server && python -m uvicorn app.main:app --host 127.0.0.1 --port 8020 --reload
生产：先 `npm run build` 生成 web/dist，再启动后端即可在同一端口访问前端（单进程）。

接口文档：http://127.0.0.1:8020/docs
"""
from __future__ import annotations

import logging
import traceback
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import APP_NAME, APP_VERSION, settings
from .db import Base, SessionLocal, engine
from .migrations import migrate
from .routers import api
from .services import scanner, segment

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("stonelab")


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)
    migrate(engine)
    log.info("%s %s · assets=%s · db=%s", APP_NAME, APP_VERSION, settings.assets_root, settings.db_path)
    if settings.scan_on_startup:
        with SessionLocal() as db:
            try:
                scanner.scan(db)
            except Exception as e:  # 扫描失败不应阻止服务启动
                log.exception("启动扫描失败：%s", e)
    yield
    segment.shutdown_worker()


app = FastAPI(
    title=APP_NAME,
    version=APP_VERSION,
    description="汉画像石研究平台后端：素材入库、预览、标注、SAM 分割、统一坐标系对齐、图文关联。",
    lifespan=lifespan,
    openapi_tags=[
        {"name": "系统", "description": "健康检查、统计、素材扫描"},
        {"name": "石头", "description": "石头树、详情、元数据与释文编辑、主图"},
        {"name": "资产", "description": "预览、缩略图、模型文件、跨图投影"},
        {"name": "标注", "description": "标注 CRUD 与图文关联"},
        {"name": "分割", "description": "MobileSAM / SAM3 / SAM3.1"},
        {"name": "对齐", "description": "对应点配准与坐标链"},
    ],
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(api)


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception):
    if isinstance(exc, HTTPException):
        raise exc
    log.error("未处理异常 %s %s\n%s", request.method, request.url.path, traceback.format_exc())
    return JSONResponse(status_code=500,
                        content={"detail": f"服务器内部错误：{type(exc).__name__}: {exc}"})


# ---------------------------------------------------------------- 托管前端构建产物（可选）
_dist = settings.web_dist
if (_dist / "index.html").is_file():
    if (_dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="web-assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "接口不存在")
        target = (_dist / path).resolve() if path else _dist / "index.html"
        if path and _dist.resolve() in target.parents and target.is_file():
            return FileResponse(target)
        return FileResponse(_dist / "index.html")

    log.info("serving web/dist at http://%s:%s/", settings.host, settings.port)
