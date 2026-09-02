# -*- coding: utf-8 -*-
"""SAM 分割工作进程（在 WSC3D 的 venv Python 中运行，不在 StoneLab 主环境）。

协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应（顺序一一对应）。
库的杂散输出全部重定向到 stderr，保证 stdout 协议纯净。

引擎：
- mobilesam : MobileSAM vit_t 点提示交互分割（CPU）
- sam3      : facebook/sam3 官方 checkpoint 文本概念分割
- sam3.1    : SAM-3.1 multiplex fp16 safetensors 的 detector 部分灌入图像模型。
              实测与 sam3 检出一致（缺 37 键：32 个 RoPE 缓冲为运行时生成，
              convs.3 与 text_projection 在 3.1 检查点中不存在，保持初始化）。

支持按需加载与卸载（卸载后释放显存/内存）。
"""
from __future__ import annotations

import argparse
import gc
import json
import os
import sys
import threading
from contextlib import nullcontext

_PROTO = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", newline="\n")
sys.stdout = sys.stderr


def send(obj: dict) -> None:
    _PROTO.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _PROTO.flush()


def log(msg: str) -> None:
    print(f"[worker] {msg}", file=sys.stderr, flush=True)


ap = argparse.ArgumentParser()
ap.add_argument("--mobilesam", default="")
ap.add_argument("--sam3", default="")
ap.add_argument("--sam31", default="")
ap.add_argument("--sam3-device", default="")
args = ap.parse_args()

_lock = threading.Lock()
STATE: dict = {
    "mobilesam": {"status": "idle", "detail": ""},
    "sam3": {"status": "idle", "detail": ""},
    "sam3.1": {"status": "idle", "detail": ""},
}
_predictor = None                                # MobileSAM
_procs: dict = {"sam3": None, "sam3.1": None}    # Sam3Processor per engine


def device_for_sam3() -> str:
    if args.sam3_device:
        return args.sam3_device
    try:
        import torch
        return "cuda" if getattr(torch.version, "cuda", None) and torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def gpu_info() -> dict:
    try:
        import torch
        ok = torch.cuda.is_available()
        out = {"torch": torch.__version__, "cuda": ok,
               "gpu": torch.cuda.get_device_name(0) if ok else None}
        if ok:
            out["vram_used_mb"] = round(torch.cuda.memory_allocated() / 1048576)
        return out
    except Exception as e:
        return {"torch": None, "cuda": False, "gpu": None, "error": str(e)}


# ------------------------------------------------------------------ 图像与掩膜
def read_image_rgb(path: str):
    import cv2
    import numpy as np
    data = np.fromfile(path, dtype=np.uint8)      # 兼容中文路径
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"image-decode-failed: {path}")
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def mask_to_polygons(mask, width: int, height: int, max_polys: int = 4) -> list:
    import cv2
    import numpy as np
    m = (np.asarray(mask) > 0.5).astype(np.uint8) * 255
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    polys = []
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:max_polys]:
        if cv2.contourArea(c) < 16:
            continue
        eps = 0.0015 * cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)
        if len(approx) < 3:
            continue
        if len(approx) > 300:
            step = len(approx) // 300 + 1
            approx = approx[::step]
        polys.append([[float(x) / width, float(y) / height] for x, y in approx])
    return polys


# ------------------------------------------------------------------ MobileSAM
def load_mobilesam() -> None:
    global _predictor
    if _predictor is not None:
        STATE["mobilesam"] = {"status": "ready", "detail": "已加载"}
        return
    if not args.mobilesam or not os.path.exists(args.mobilesam):
        STATE["mobilesam"] = {"status": "error", "detail": f"权重不存在: {args.mobilesam}"}
        return
    STATE["mobilesam"] = {"status": "loading", "detail": "加载 MobileSAM vit_t"}
    try:
        from mobile_sam import SamPredictor, sam_model_registry
        sam = sam_model_registry["vit_t"](checkpoint=args.mobilesam)
        sam.to(device="cpu")
        sam.eval()
        _predictor = SamPredictor(sam)
        STATE["mobilesam"] = {"status": "ready", "detail": "mobile-sam vit_t (cpu)"}
        log("mobilesam ready")
    except Exception as e:
        STATE["mobilesam"] = {"status": "error", "detail": f"{type(e).__name__}: {e}"}


def point_segment(image_path: str, points: list, labels: list) -> dict:
    import numpy as np
    if _predictor is None:
        return {"ok": False, "error": "mobilesam-not-loaded"}
    img = read_image_rgb(image_path)
    h, w = img.shape[:2]
    pts = np.array([[p[0] * w, p[1] * h] for p in points], dtype=np.float32)
    lbs = np.array(labels, dtype=np.int32)
    with _lock:
        _predictor.set_image(img)
        masks, scores, _ = _predictor.predict(
            point_coords=pts, point_labels=lbs, multimask_output=True)
    best = int(scores.argmax())
    polys = mask_to_polygons(masks[best], w, h)
    return {"ok": True, "polygons": polys, "score": float(scores[best]),
            "size": [w, h], "model": "mobile-sam-vit-t"}


# ------------------------------------------------------------------ SAM3 / SAM3.1
def _bpe_path():
    try:
        import sam3 as sam3_pkg
        cand = os.path.join(os.path.dirname(sam3_pkg.__file__),
                            "assets", "bpe_simple_vocab_16e6.txt.gz")
        return cand if os.path.exists(cand) else None
    except Exception:
        return None


def load_sam3_family(engine: str) -> None:
    """engine: 'sam3'（官方 .pt）或 'sam3.1'（multiplex fp16 safetensors 的 detector 部分）"""
    if _procs.get(engine) is not None:
        STATE[engine] = {"status": "ready", "detail": "已加载"}
        return
    weight = args.sam3 if engine == "sam3" else args.sam31
    if not weight or not os.path.exists(weight):
        STATE[engine] = {"status": "error", "detail": f"权重不存在: {weight}"}
        return
    dev = device_for_sam3()
    STATE[engine] = {"status": "loading",
                     "detail": f"加载 {engine} 到 {dev}（首次约 1 分钟内）"}
    try:
        from sam3.model.sam3_image_processor import Sam3Processor
        from sam3.model_builder import build_sam3_image_model

        if engine == "sam3":
            model = build_sam3_image_model(
                bpe_path=_bpe_path(), device=dev, checkpoint_path=weight,
                load_from_HF=False, enable_segmentation=True)
            note = f"facebook/sam3 ({dev})"
        else:
            from safetensors.torch import load_file
            model = build_sam3_image_model(
                bpe_path=_bpe_path(), device="cpu", checkpoint_path=None,
                load_from_HF=False, enable_segmentation=True)
            sd = load_file(weight)
            det = {k.replace("detector.", "", 1): v.float()
                   for k, v in sd.items() if k.startswith("detector.")}
            missing, unexpected = model.load_state_dict(det, strict=False)
            if dev == "cuda":
                model = model.cuda()
            model.eval()
            note = (f"sam3.1 multiplex fp16 detector ({dev})；"
                    f"未覆盖键 {len(missing)}（含 32 个运行时 RoPE 缓冲），实测检出与 sam3 一致")
        _procs[engine] = Sam3Processor(model)
        STATE[engine] = {"status": "ready", "detail": note}
        log(f"{engine} ready on {dev}")
    except Exception as e:
        _procs[engine] = None
        STATE[engine] = {"status": "error", "detail": f"{type(e).__name__}: {e}"}


def unload_engine(engine: str) -> dict:
    """卸载引擎并释放显存/内存。"""
    global _predictor
    with _lock:
        if engine == "mobilesam":
            _predictor = None
        elif engine in ("sam3", "sam3.1"):
            _procs[engine] = None
        else:
            return {"ok": False, "error": f"unknown-engine: {engine}"}
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
    STATE[engine] = {"status": "idle", "detail": "已卸载"}
    info = gpu_info()
    log(f"{engine} unloaded, vram={info.get('vram_used_mb')}MB")
    return {"ok": True, "engines": STATE, **info}


def _autocast():
    try:
        import torch
        if device_for_sam3().startswith("cuda"):
            return torch.autocast(device_type="cuda", dtype=torch.bfloat16)
    except Exception:
        pass
    return nullcontext()


def _to_numpy(v):
    import numpy as np
    if v is None:
        return None
    if hasattr(v, "detach"):
        t = v.detach().cpu()
        if str(getattr(t, "dtype", "")) == "torch.bfloat16":
            t = t.float()
        return t.numpy()
    return np.asarray(v)


def text_segment(engine: str, image_path: str, prompt: str,
                 threshold: float, max_results: int) -> dict:
    import numpy as np
    from PIL import Image
    proc = _procs.get(engine)
    if proc is None:
        return {"ok": False, "error": f"{engine}-not-loaded"}
    img = read_image_rgb(image_path)
    h, w = img.shape[:2]
    with _lock, _autocast():
        state = proc.set_image(Image.fromarray(img))
        out = proc.set_text_prompt(state=state, prompt=prompt)

    masks = _to_numpy(out.get("masks"))
    scores = _to_numpy(out.get("scores"))
    if masks is None:
        return {"ok": True, "detections": [], "size": [w, h], "model": engine}
    masks = np.asarray(masks)
    if masks.ndim == 4:
        masks = masks[:, 0, :, :]
    if masks.ndim == 2:
        masks = masks[None, :, :]

    dets = []
    for i, m in enumerate(masks):
        sc = float(np.ravel(scores)[i]) if scores is not None and np.ravel(scores).size > i else 1.0
        if sc < threshold:
            continue
        polys = mask_to_polygons(m, w, h, max_polys=1)
        if not polys:
            continue
        dets.append({"polygon": polys[0], "score": sc})
    dets.sort(key=lambda d: d["score"], reverse=True)
    return {"ok": True, "detections": dets[:max(1, min(max_results, 100))],
            "size": [w, h], "model": engine, "prompt": prompt}


# ------------------------------------------------------------------ 主循环
def handle(req: dict) -> dict:
    cmd = req.get("cmd")
    if cmd == "ping":
        return {"ok": True, "pid": os.getpid(), **gpu_info()}
    if cmd == "status":
        return {"ok": True, "engines": STATE, **gpu_info()}
    if cmd == "load":
        eng = req.get("engine")
        if eng == "mobilesam":
            load_mobilesam()
        elif eng in ("sam3", "sam3.1"):
            load_sam3_family(eng)
        else:
            return {"ok": False, "error": f"unknown-engine: {eng}"}
        return {"ok": STATE[eng]["status"] == "ready", "engines": STATE}
    if cmd == "unload":
        return unload_engine(req.get("engine", ""))
    if cmd == "point_segment":
        return point_segment(req["image"], req["points"], req["labels"])
    if cmd == "text_segment":
        return text_segment(req.get("engine", "sam3"), req["image"], req["prompt"],
                            float(req.get("threshold", 0.5)),
                            int(req.get("max_results", 20)))
    return {"ok": False, "error": f"unknown-cmd: {cmd}"}


def main() -> None:
    log(f"worker start pid={os.getpid()} gpu={gpu_info()}")
    send({"ok": True, "event": "started", **gpu_info()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            send({"ok": False, "error": f"bad-json: {e}"})
            continue
        try:
            send(handle(req))
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            send({"ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
