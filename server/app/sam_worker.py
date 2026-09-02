# -*- coding: utf-8 -*-
"""SAM 分割工作进程（在带 CUDA torch / sam3 / mobile_sam 的独立 Python 中运行，不在 StoneLab 主环境）。

协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应（顺序一一对应）。
库的杂散输出全部重定向到 stderr，保证 stdout 协议纯净。

引擎：
- mobilesam : MobileSAM vit_t 点提示交互分割（CPU）
- sam3      : facebook/sam3 官方 checkpoint 文本 / 示例框概念分割
- sam3.1    : SAM-3.1 multiplex fp16 safetensors 的 detector 部分灌入图像模型。
              实测与 sam3 检出一致（缺 37 键：32 个 RoPE 缓冲为运行时生成，
              convs.3 与 text_projection 在 3.1 检查点中不存在，保持初始化）。

概念分割的三个增强（针对"拓片能识别、照片识别不出"的域差距）：
- preprocess : none / enhance（去光照 + CLAHE）/ rubbing（再自适应二值化，仿拓片）
- tiling     : 整图 / 切块（约 1024 px 一块、20% 重叠，结果按"交集/较小框"去重合并）
               —— SAM3 内部把整图缩到 1008x1008，切块才能让小人物有足够像素
- boxes      : SAM3 示例框（正例/负例，归一化 cx,cy,w,h），可单独使用或与文字叠加；
               示例特征来自本图，因此示例框模式按整图推理

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

TILE_PX = 1024          # 切块边长（源图像素）
TILE_OVERLAP = 0.2      # 相邻切块重叠比例
WHOLE_MAX_EDGE = 1600   # 整图那遍先缩到此长边：模型内部只用 1008，更大只会撑爆掩膜显存


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


# ------------------------------------------------------------------ 图像 / 预处理 / 掩膜
def read_image_rgb(path: str):
    import cv2
    import numpy as np
    data = np.fromfile(path, dtype=np.uint8)      # 兼容中文路径
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"image-decode-failed: {path}")
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def write_jpeg(path: str, rgb, quality: int = 88) -> None:
    import cv2
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR),
                           [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("jpeg-encode-failed")
    buf.tofile(path)                              # 兼容中文路径


def preprocess_image(rgb, mode: str, invert: bool = False):
    """把照片变得更像模型"认识"的东西。

    enhance：灰度 -> 除以大尺度光照估计（去掉明暗渐变）-> CLAHE 提局部对比；
    rubbing：在 enhance 基础上中值去颗粒 -> 大窗口自适应二值化 -> 形态学去斑，
             得到黑底白图形的"仿拓片"（减地平面线刻的图形面通常更平滑、更亮）；
             光照相反时用 invert 翻转。
    """
    if not mode or mode == "none":
        return rgb
    import cv2
    import numpy as np
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    h, w = gray.shape
    # 光照估计在 1/8 缩略图上做大高斯模糊，再放大：等价且快 60 倍
    ds = max(1, min(w, h) // 300)
    small = cv2.resize(gray, (max(1, w // ds), max(1, h // ds)), interpolation=cv2.INTER_AREA)
    sigma = max(small.shape) / 40.0
    base = cv2.GaussianBlur(small, (0, 0), sigma)
    base = cv2.resize(base, (w, h), interpolation=cv2.INTER_LINEAR).astype(np.float32)
    flat = np.clip(gray.astype(np.float32) / (base + 1.0) * 128.0, 0, 255).astype(np.uint8)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(12, 12))
    out = clahe.apply(flat)

    if mode == "rubbing":
        sm = cv2.medianBlur(out, 5)
        block = max(31, (max(w, h) // 40) | 1)
        bw = cv2.adaptiveThreshold(sm, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, block, 2)
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        bw = cv2.morphologyEx(bw, cv2.MORPH_OPEN, k)
        out = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, k)

    if invert:
        out = 255 - out
    return cv2.cvtColor(out, cv2.COLOR_GRAY2RGB)


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


def tile_windows(w: int, h: int, tile: int = TILE_PX, overlap: float = TILE_OVERLAP) -> list:
    """返回覆盖整图的切块 (x0, y0, x1, y1)，最后一块贴边对齐。"""
    def axis(n: int) -> list:
        if n <= tile * 1.15:
            return [0]
        step = max(1, int(tile * (1 - overlap)))
        xs = list(range(0, n - tile + 1, step))
        if xs[-1] + tile < n:
            xs.append(n - tile)
        return xs
    return [(x, y, min(x + tile, w), min(y + tile, h)) for y in axis(h) for x in axis(w)]


def is_blocky(mask, bx: list, rw: int, rh: int, is_tile: bool) -> bool:
    """块状伪检出。
    - 切块：外接框占切块 60% 以上（比切块更大的目标的一部分，整图那遍负责），
            或面积不小（>12%）且掩膜几乎填满外接框（真实人物剪影不会是矩形）；
    - 整图：外接框覆盖 92% 以上的整图（示例框模式常见的"整张背景"掩膜）。
    局部特写照片里一个人物可能占整图六成，所以整图阈值要宽。"""
    import numpy as np
    x0, y0 = max(0, int(bx[0])), max(0, int(bx[1]))
    x1, y1 = min(rw, int(bx[2]) + 1), min(rh, int(bx[3]) + 1)
    if x1 <= x0 or y1 <= y0:
        return True
    box_ratio = ((x1 - x0) * (y1 - y0)) / float(rw * rh)
    if not is_tile:
        return box_ratio >= 0.92
    if box_ratio >= 0.6:
        return True
    if box_ratio >= 0.12:
        fill = float(np.asarray(mask)[y0:y1, x0:x1].mean())
        if fill > 0.9:
            return True
    return False


def merge_detections(dets: list, w: int, h: int, contain: float = 0.85, iou_thr: float = 0.5) -> list:
    """合并整图与各切块的检出（基于掩膜栅格，而非外接框）：
    - 一个掩膜 85% 以上落在另一个之内 -> 视为残片，保留面积大的（切块边界残片被完整目标吸收）；
    - 否则 IoU > 0.5 -> 同一目标的重复检出，保留分数高的。"""
    if len(dets) <= 1:
        return dets
    import cv2
    import numpy as np
    s = 768.0 / max(w, h)
    gw, gh = max(1, round(w * s)), max(1, round(h * s))
    rasters: list = []
    areas: list = []
    for d in dets:
        m = np.zeros((gh, gw), np.uint8)
        pts = np.array([[x * gw, y * gh] for x, y in d["polygon"]], np.int32).reshape(-1, 1, 2)
        cv2.fillPoly(m, [pts], 1)
        rasters.append(m.astype(bool))
        areas.append(int(m.sum()))

    order = sorted(range(len(dets)), key=lambda i: dets[i]["score"], reverse=True)
    kept: list = []
    for i in order:
        drop = False
        for j in list(kept):
            bi, bj = dets[i]["box"], dets[j]["box"]
            if bi[2] <= bj[0] or bj[2] <= bi[0] or bi[3] <= bj[1] or bj[3] <= bi[1]:
                continue
            inter = int(np.logical_and(rasters[i], rasters[j]).sum())
            if inter == 0:
                continue
            ai, aj = areas[i], areas[j]
            if inter / max(1, min(ai, aj)) > contain:
                if ai > aj:
                    kept.remove(j)          # 后来的更大：吸收已保留的残片
                else:
                    drop = True
                    break
            elif inter / max(1, ai + aj - inter) > iou_thr:
                drop = True                 # 重复检出：已保留者分数更高
                break
        if not drop:
            kept.append(i)
    return [dets[i] for i in sorted(kept, key=lambda i: dets[i]["score"], reverse=True)]


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
        _procs[engine] = Sam3Processor(model, device=dev)
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


def _sam3_infer(proc, rgb, prompt: str, boxes: list, threshold: float) -> list:
    """在一张（子）图上跑 SAM3：文字提示 和/或 示例框。返回 [(mask, score, box_xyxy_px)]。"""
    import numpy as np
    from PIL import Image
    if not prompt and not boxes:
        return []
    with _lock, _autocast():
        proc.set_confidence_threshold(threshold)          # 否则模型内部按默认 0.5 先过滤
        state = proc.set_image(Image.fromarray(rgb))
        if prompt:
            proc.set_text_prompt(prompt=prompt, state=state)
        for b in boxes:
            proc.add_geometric_prompt(box=[b["cx"], b["cy"], b["w"], b["h"]],
                                      label=bool(b.get("label", 1)), state=state)
        masks = _to_numpy(state.get("masks"))
        scores = _to_numpy(state.get("scores"))
        bxs = _to_numpy(state.get("boxes"))
    if masks is None or scores is None or bxs is None:
        return []
    masks = np.asarray(masks)
    if masks.ndim == 4:
        masks = masks[:, 0, :, :]
    if masks.ndim == 2:
        masks = masks[None, :, :]
    scores = np.ravel(scores)
    bxs = np.asarray(bxs).reshape(-1, 4)
    n = min(len(masks), len(scores), len(bxs))
    return [(masks[i], float(scores[i]), [float(v) for v in bxs[i]]) for i in range(n)]


def text_segment(engine: str, image_path: str, prompt: str, threshold: float, max_results: int,
                 boxes: list | None = None, preprocess: str = "none", invert: bool = False,
                 tiling: str = "none") -> dict:
    import cv2
    proc = _procs.get(engine)
    if proc is None:
        return {"ok": False, "error": f"{engine}-not-loaded"}
    boxes = boxes or []
    prompt = (prompt or "").strip()
    if not prompt and not boxes:
        return {"ok": False, "error": "需要文字提示或至少一个示例框"}

    img = preprocess_image(read_image_rgb(image_path), preprocess, invert)
    H, W = img.shape[:2]

    # 整图一遍（负责大目标）+ 可选切块（负责小目标），结果按掩膜包含关系合并。
    # 示例框的特征来自本图，切块后其他块看不到示例 -> 示例框模式只跑整图。
    whole = (0, 0, W, H)
    tiles = tile_windows(W, H) if (tiling != "none" and not boxes) else []
    if len(tiles) == 1:
        tiles = []
    windows = [(whole, False)] + [(t, True) for t in tiles]

    dets: list = []
    for (x0, y0, x1, y1), is_tile in windows:
        crop = img[y0:y1, x0:x1]
        ch, cw = crop.shape[:2]
        # 模型内部只用 1008x1008，整图先缩小以免上采样掩膜撑爆显存
        scale = 1.0 if is_tile else min(1.0, WHOLE_MAX_EDGE / max(cw, ch))
        if scale < 1.0:
            crop = cv2.resize(crop, (max(1, round(cw * scale)), max(1, round(ch * scale))),
                              interpolation=cv2.INTER_AREA)
        rh, rw = crop.shape[:2]
        for mask, sc, bx in _sam3_infer(proc, crop, prompt, boxes, threshold):
            if sc < threshold:
                continue
            # 块状伪检出：比切块更大的目标的一部分（整图那遍负责）、找不到目标时的大片低分区域、
            # 以及示例框模式下覆盖整张背景的掩膜
            if is_blocky(mask, bx, rw, rh, is_tile):
                continue
            polys = mask_to_polygons(mask, rw, rh, max_polys=1)
            if not polys:
                continue
            poly = [[(x0 + px * cw) / W, (y0 + py * ch) / H] for px, py in polys[0]]
            box = [(x0 + bx[0] / rw * cw) / W, (y0 + bx[1] / rh * ch) / H,
                   (x0 + bx[2] / rw * cw) / W, (y0 + bx[3] / rh * ch) / H]
            dets.append({"polygon": poly, "score": sc, "box": box, "from_tile": is_tile})

    dets = merge_detections(dets, W, H) if tiles else sorted(dets, key=lambda d: d["score"], reverse=True)
    for d in dets:
        d.pop("from_tile", None)
    return {"ok": True, "detections": dets[:max(1, min(max_results, 100))],
            "size": [W, H], "model": engine, "prompt": prompt,
            "tiles": len(tiles), "preprocess": preprocess, "exemplars": len(boxes)}


def preprocess_to_file(image_path: str, mode: str, invert: bool, out_path: str) -> dict:
    rgb = preprocess_image(read_image_rgb(image_path), mode, invert)
    write_jpeg(out_path, rgb)
    return {"ok": True, "path": out_path, "size": [rgb.shape[1], rgb.shape[0]], "mode": mode}


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
        return text_segment(req.get("engine", "sam3"), req["image"], req.get("prompt", ""),
                            float(req.get("threshold", 0.5)), int(req.get("max_results", 20)),
                            boxes=req.get("boxes") or [], preprocess=req.get("preprocess", "none"),
                            invert=bool(req.get("invert", False)), tiling=req.get("tiling", "none"))
    if cmd == "preprocess":
        return preprocess_to_file(req["image"], req.get("mode", "enhance"),
                                  bool(req.get("invert", False)), req["out"])
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
