# -*- coding: utf-8 -*-
"""分割服务：管理 SAM 工作进程（sidecar）。

真实推理在 app/sam_worker.py 中进行，由带 CUDA torch / sam3 / mobile_sam 的独立
Python 环境运行（默认取 WSC3D 项目的 venv，可用 STONELAB_SAM_PYTHON 指定）。
StoneLab 主环境零污染。

引擎：
- mobilesam : 交互点选分割（CPU，秒级）
- sam3      : facebook/sam3 官方 checkpoint，文本概念分割（GPU）
- sam3.1    : SAM-3.1 multiplex fp16 safetensors（detector 部分），文本概念分割（GPU）

协议：stdin/stdout 每行一个 JSON，一问一答；支持加载与卸载（卸载释放显存）。
"""
from __future__ import annotations

import json
import logging
import subprocess
import threading
from pathlib import Path
from typing import Any, Optional

from ..config import settings

log = logging.getLogger("stonelab.segment")

WORKER_SCRIPT = Path(__file__).resolve().parents[1] / "sam_worker.py"

MOBILESAM_WEIGHT = settings.ml_root / "mobilesam" / "mobile_sam.pt"
SAM3_WEIGHT = settings.ml_root / "sam3" / "sam3.pt"


def _find_sam31() -> Optional[Path]:
    hits = list(settings.ml_root.glob("sam3.1/**/sam3*multiplex*.safetensors"))
    return hits[0] if hits else None


SAM31_WEIGHT = _find_sam31()

ENGINES = ("mobilesam", "sam3", "sam3.1")
TEXT_ENGINES = ("sam3", "sam3.1")

_lock = threading.Lock()
_proc: Optional[subprocess.Popen] = None
_boot_info: dict[str, Any] = {}
_engine_state: dict[str, dict] = {e: {"status": "idle", "detail": ""} for e in ENGINES}


def worker_python() -> Optional[str]:
    for p in settings.sam_python_candidates:
        if p and Path(p).exists():
            return p
    return None


def _alive() -> bool:
    return _proc is not None and _proc.poll() is None


def _ensure_worker() -> Optional[str]:
    """确保工作进程在跑；返回错误信息或 None。"""
    global _proc, _boot_info
    if _alive():
        return None
    py = worker_python()
    if py is None:
        return ("找不到分割工作环境（需含 CUDA torch、sam3、mobile_sam 的 Python）。"
                "请设置环境变量 STONELAB_SAM_PYTHON 指向该解释器")
    try:
        logf = settings.worker_log.open("a", encoding="utf-8")
        _proc = subprocess.Popen(
            [py, "-X", "utf8", str(WORKER_SCRIPT),
             "--mobilesam", str(MOBILESAM_WEIGHT),
             "--sam3", str(SAM3_WEIGHT),
             "--sam31", str(SAM31_WEIGHT or "")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=logf,
            text=True, encoding="utf-8", bufsize=1,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        line = _proc.stdout.readline()
        _boot_info = json.loads(line) if line.strip() else {}
        log.info("sam worker started pid=%s gpu=%s", _proc.pid, _boot_info.get("gpu"))
        return None
    except Exception as e:
        _proc = None
        return f"工作进程启动失败：{type(e).__name__}: {e}"


def _request(payload: dict) -> dict:
    err = _ensure_worker()
    if err:
        return {"ok": False, "error": err}
    assert _proc and _proc.stdin and _proc.stdout
    with _lock:
        try:
            _proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            _proc.stdin.flush()
            line = _proc.stdout.readline()
            if not line:
                code = _proc.poll()
                return {"ok": False,
                        "error": f"工作进程中断（exit={code}），详见 {settings.worker_log.name}"}
            return json.loads(line)
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def shutdown_worker() -> None:
    """应用退出时终止工作进程，释放显存。"""
    global _proc
    if _proc is None:
        return
    try:
        if _proc.poll() is None:
            _proc.terminate()
            _proc.wait(timeout=5)
    except Exception:
        try:
            _proc.kill()
        except Exception:
            pass
    _proc = None
    for e in ENGINES:
        _engine_state[e] = {"status": "idle", "detail": ""}


# ------------------------------------------------------------------ 对外接口
def models_status() -> dict:
    py = worker_python()

    def w(p: Optional[Path]) -> dict:
        exists = p is not None and p.exists()
        return {"file": str(p.relative_to(settings.ml_root)) if p else None,
                "exists": exists,
                "bytes": p.stat().st_size if exists else 0}

    return {
        "worker": {"python": py, "available": py is not None, "alive": _alive(),
                   "gpu": _boot_info.get("gpu"), "cuda": _boot_info.get("cuda"),
                   "torch": _boot_info.get("torch"),
                   "vram_used_mb": _boot_info.get("vram_used_mb"),
                   "log": str(settings.worker_log)},
        "weights": {"mobilesam": w(MOBILESAM_WEIGHT), "sam3": w(SAM3_WEIGHT),
                    "sam3.1": w(SAM31_WEIGHT)},
        "engines": _engine_state,
    }


def load_engine(engine: str) -> dict:
    if engine not in ENGINES:
        return {"ok": False, "error": f"未知引擎：{engine}", "engines": _engine_state}
    if _engine_state[engine]["status"] in ("ready", "loading"):
        return {"ok": True, "engines": _engine_state}

    err = _ensure_worker()
    if err:
        _engine_state[engine] = {"status": "error", "detail": err}
        return {"ok": False, "error": err, "engines": _engine_state}

    _engine_state[engine] = {
        "status": "loading",
        "detail": "首次加载约 1 分钟内（GPU）" if engine.startswith("sam3") else "加载中",
    }

    def run() -> None:
        r = _request({"cmd": "load", "engine": engine})
        if r.get("ok"):
            _engine_state[engine] = r.get("engines", {}).get(engine, {"status": "ready", "detail": ""})
        else:
            detail = r.get("error") or r.get("engines", {}).get(engine, {}).get("detail", "未知错误")
            _engine_state[engine] = {"status": "error", "detail": str(detail)}
        log.info("engine %s -> %s", engine, _engine_state[engine]["status"])

    threading.Thread(target=run, name=f"sam-load-{engine}", daemon=True).start()
    return {"ok": True, "engines": _engine_state}


def unload_engine(engine: str) -> dict:
    """卸载引擎，释放显存/内存。"""
    global _boot_info
    if engine not in ENGINES:
        return {"ok": False, "error": f"未知引擎：{engine}", "engines": _engine_state}
    if not _alive():
        _engine_state[engine] = {"status": "idle", "detail": ""}
        return {"ok": True, "engines": _engine_state}
    r = _request({"cmd": "unload", "engine": engine})
    if r.get("ok"):
        _engine_state[engine] = {"status": "idle", "detail": "已卸载"}
        if "vram_used_mb" in r:
            _boot_info = {**_boot_info, "vram_used_mb": r["vram_used_mb"]}
            _engine_state[engine]["detail"] = f"已卸载（显存占用 {r['vram_used_mb']} MB）"
    return {"ok": bool(r.get("ok")), "error": r.get("error"), "engines": _engine_state}


def point_segment(image_path: Path, points: list, labels: list) -> dict:
    if _engine_state["mobilesam"]["status"] != "ready":
        return {"ok": False, "error": "MobileSAM 未就绪，请先在分割面板点「加载」"}
    return _request({"cmd": "point_segment", "image": str(image_path),
                     "points": points, "labels": labels})


def text_segment(engine: str, image_path: Path, prompt: str, threshold: float, max_results: int,
                 boxes: list[dict] | None = None, preprocess: str = "none", invert: bool = False,
                 tiling: str = "none") -> dict:
    """SAM3 / SAM3.1 概念分割：文字提示 和/或 示例框；可选预处理与切块。"""
    if engine not in TEXT_ENGINES:
        return {"ok": False, "error": f"文本分割不支持引擎：{engine}"}
    if _engine_state[engine]["status"] != "ready":
        return {"ok": False, "error": f"{engine} 未就绪，请先在分割面板点「加载」"}
    return _request({"cmd": "text_segment", "engine": engine, "image": str(image_path),
                     "prompt": prompt, "threshold": threshold, "max_results": max_results,
                     "boxes": boxes or [], "preprocess": preprocess, "invert": invert,
                     "tiling": tiling})


def preprocess_image(image_path: Path, mode: str, invert: bool, out_path: Path) -> dict:
    """由工作进程生成预处理图（enhance / rubbing）到 out_path。不需要加载任何引擎。"""
    return _request({"cmd": "preprocess", "image": str(image_path), "mode": mode,
                     "invert": invert, "out": str(out_path)})
