# -*- coding: utf-8 -*-
"""运行配置：全部路径与可调参数集中于此，均可用环境变量覆盖。

环境变量（可选）：
    STONELAB_HOST / STONELAB_PORT        监听地址（默认 127.0.0.1:8020）
    STONELAB_ASSETS                      素材根目录（默认 <项目>/assets/stones）
    STONELAB_DATA                        数据目录（默认 <项目>/server/data）
    STONELAB_CORS                        允许的前端来源，逗号分隔
    STONELAB_PREVIEW_EDGE                2D 预览长边像素（默认 2560）
    STONELAB_THUMB_EDGE                  缩略图长边像素（默认 320）
    STONELAB_SCAN_ON_STARTUP             启动时自动扫描素材（默认 1）
    STONELAB_WARM_PREVIEWS               扫描后后台预热预览缓存（默认 1）
    STONELAB_SAM_PYTHON                  分割工作进程使用的 Python 解释器
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

APP_NAME = "StoneLab"
APP_VERSION = "1.0.0"

ROOT = Path(__file__).resolve().parents[2]  # .../stonelab


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _env_path(name: str, default: Path) -> Path:
    v = os.environ.get(name)
    return Path(v).expanduser().resolve() if v else default


def _env_list(name: str, default: list[str]) -> list[str]:
    v = os.environ.get(name)
    return [x.strip() for x in v.split(",") if x.strip()] if v else default


@dataclass(frozen=True)
class Settings:
    root: Path = ROOT
    assets_root: Path = field(default_factory=lambda: _env_path("STONELAB_ASSETS", ROOT / "assets" / "stones"))
    ml_root: Path = ROOT / "ml"
    data_dir: Path = field(default_factory=lambda: _env_path("STONELAB_DATA", ROOT / "server" / "data"))
    web_dist: Path = ROOT / "web" / "dist"

    host: str = os.environ.get("STONELAB_HOST", "127.0.0.1")
    port: int = _env_int("STONELAB_PORT", 8020)
    cors_origins: list[str] = field(default_factory=lambda: _env_list(
        "STONELAB_CORS", ["http://127.0.0.1:5173", "http://localhost:5173"]))

    preview_long_edge: int = _env_int("STONELAB_PREVIEW_EDGE", 2560)
    preview_quality: int = 86
    thumb_long_edge: int = _env_int("STONELAB_THUMB_EDGE", 320)

    scan_on_startup: bool = _env_bool("STONELAB_SCAN_ON_STARTUP", True)
    warm_previews: bool = _env_bool("STONELAB_WARM_PREVIEWS", True)

    # 分割工作进程候选解释器（按顺序取第一个存在的）
    sam_python_candidates: list[str] = field(default_factory=lambda: [
        os.environ.get("STONELAB_SAM_PYTHON", ""),
        r"E:\WSC3D\ai-service\.venv\Scripts\python.exe",
        r"E:\wushici3D\WSC3D\ai-service\.venv\Scripts\python.exe",
    ])

    @property
    def preview_dir(self) -> Path:
        return self.data_dir / "previews"

    @property
    def thumb_dir(self) -> Path:
        return self.data_dir / "thumbs"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "stonelab.db"

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.db_path.as_posix()}"

    @property
    def worker_log(self) -> Path:
        return self.data_dir / "sam_worker.log"


settings = Settings()

for _d in (settings.data_dir, settings.preview_dir, settings.thumb_dir):
    _d.mkdir(parents=True, exist_ok=True)
