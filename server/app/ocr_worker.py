# -*- coding: utf-8 -*-
"""OCR 工作进程（sidecar）：在独立 Python 环境中运行，不在 StoneLab 主环境。

两个引擎，各自一个进程（环境不同）：
- mineru : 现代横排书籍。MinerU（版面分析 + 文字 / 表格识别 + 阅读顺序），直接读 PDF，
           输出带坐标的版面块与裁好的插图；默认 hybrid-engine 后端（有文字层的页直接抽字，扫描页走 VLM）。
- ndl    : 古籍竖排。NDL-KotenOCR Lite（RTMDet 版面 + PARSeq 识别 + 古典籍阅读顺序，ONNX CPU），
           输入为渲染好的页图，输出按阅读顺序排好的行。

协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应（顺序一一对应）。
协议管道只由 _PROTO 写：启动时把 fd 1 复制给 _PROTO，再把 fd 1 指向 stderr，
这样库的 print、C 层输出、子进程继承的 stdout 都进日志而不会污染协议。
两个引擎都输出同一套"页级契约"（见 normalize_* 函数）：
    {page_no, width, height, engine, seconds, text,
     blocks:  [{seq, kind, text, bbox:[x0,y0,x1,y1] 归一化, confidence, extra}],
     figures: [{seq, bbox, image_path, caption, label, caption_bbox}]}
"""
from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import os
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path

if __package__:
    from .ocr_normalize import normalize_mineru_output
else:  # sidecar is launched as a script in an isolated Python environment
    from ocr_normalize import normalize_mineru_output

_PROTO = None


def send(obj: dict) -> None:
    _PROTO.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _PROTO.flush()


def log(msg: str) -> None:
    print(f"[ocr-worker] {msg}", file=sys.stderr, flush=True)


def sha256_file(p: str) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def gpu_info() -> dict:
    try:
        import torch
        ok = torch.cuda.is_available()
        return {"torch": torch.__version__, "cuda": ok, "gpu": torch.cuda.get_device_name(0) if ok else None}
    except Exception as e:  # ndl 环境没有 torch
        return {"torch": None, "cuda": False, "gpu": None, "note": str(e)[:80]}


# ================================================================ 页图渲染（两个环境都装了 pypdfium2）
def render_page(pdf: str, page_no: int, dpi: int, out: str) -> dict:
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(pdf)
    try:
        page = doc[page_no - 1]
        img = page.render(scale=dpi / 72).to_pil().convert("RGB")
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        img.save(out)
        return {"ok": True, "width": img.width, "height": img.height, "sha256": sha256_file(out)}
    finally:
        doc.close()


def pdf_info(pdf: str) -> dict:
    """页数与是否有文字层（抽样前 12 页）。"""
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(pdf)
    try:
        n = len(doc)
        chars = 0
        for i in range(min(n, 12)):
            tp = doc[i].get_textpage()
            chars += len(tp.get_text_bounded().strip())
        return {"ok": True, "page_count": n, "has_text_layer": chars > 40}
    finally:
        doc.close()


# ================================================================ MinerU（现代书籍）
def _patch_fasttext_for_nonascii_path() -> None:
    """fasttext（C++）打不开含中文的路径：把小语种模型拷到 ASCII 临时目录并预先放进 fast_langdetect 的缓存。"""
    try:
        import fasttext
        import fast_langdetect.ft_detect.infer as fli
        src = Path(fli.LOCAL_SMALL_MODEL_PATH)
        dst = Path(tempfile.gettempdir()) / "stonelab-lid.176.ftz"
        if not dst.exists() or dst.stat().st_size != src.stat().st_size:
            shutil.copy2(src, dst)
        model = fasttext.load_model(str(dst))
        fli._model_cache.cache_model("low_memory", model)
        fli._model_cache.cache_model("high_memory", model)
        log(f"fasttext lid model preloaded from {dst}")
    except Exception as e:
        log(f"fasttext preload skipped: {type(e).__name__}: {e}")


class MinerUEngine:
    def __init__(self, models_dir: str):
        os.environ.setdefault("MINERU_MODEL_SOURCE", "modelscope")
        if models_dir:
            os.environ.setdefault("MINERU_MODELS_DIR", models_dir)
        _patch_fasttext_for_nonascii_path()
        import mineru  # noqa: F401  (校验环境)
        from mineru.cli.common import do_parse, read_fn
        self._do_parse = do_parse
        self._read_fn = read_fn
        self._sig = set(inspect.signature(do_parse).parameters)
        try:
            from importlib.metadata import version
            self.version = version("mineru")
        except Exception:
            self.version = "unknown"
        log(f"mineru {self.version} ready; do_parse params={sorted(self._sig)}")

    def parse_pages(self, pdf: str, pages: list[int], out_dir: str, backend: str, lang: str) -> dict:
        """对一段连续页 [start..end] 运行 MinerU，返回 {page_no: normalized}。"""
        start, end = min(pages), max(pages)
        pdf_path = Path(pdf)
        out = Path(out_dir) / f"p{start:04d}-{end:04d}"
        if out.exists():
            shutil.rmtree(out, ignore_errors=True)
        out.mkdir(parents=True, exist_ok=True)
        pdf_bytes = self._read_fn(pdf_path) if self._read_fn else pdf_path.read_bytes()
        kw = {
            "output_dir": str(out), "pdf_file_names": ["doc"], "pdf_bytes_list": [pdf_bytes],
            "p_lang_list": [lang or "ch"], "backend": backend or "hybrid-engine", "parse_method": "auto",
            "formula_enable": False, "table_enable": True,
            "start_page_id": start - 1, "end_page_id": end - 1,
            "f_draw_layout_bbox": False, "f_draw_span_bbox": False, "f_dump_md": False,
            "f_dump_middle_json": True, "f_dump_model_output": False, "f_dump_orig_pdf": False,
            "f_dump_content_list": True, "effort": "medium", "image_analysis": False,
        }
        kw = {k: v for k, v in kw.items() if k in self._sig}
        t0 = time.perf_counter()
        self._do_parse(**kw)
        seconds = time.perf_counter() - t0
        # content_list/para_blocks may merge text and tables across physical pages.
        # The untouched preproc blocks retain the actual page and bounding box.
        middle_files = sorted(out.rglob("*_middle.json"))
        if len(middle_files) != 1:
            raise RuntimeError(f"MinerU 未产出唯一的物理页 middle.json：{out}")
        middle_path = middle_files[0]
        return normalize_mineru_output(
            json.loads(middle_path.read_text(encoding="utf-8")), pages,
            middle_path.parent, f"mineru/{backend or 'hybrid-engine'}", seconds,
        )


# ================================================================ NDL-KotenOCR Lite（古籍）
class NdlEngine:
    def __init__(self, root: str):
        self.root = Path(root)
        src = self.root / "src"
        if not src.is_dir():
            raise RuntimeError(f"NDL 引擎目录不存在：{src}")
        sys.path.insert(0, str(src))
        os.chdir(src)                       # 引擎内部按相对路径找 config / model
        import yaml
        from parseq import PARSEQ
        from rtmdet import RTMDet
        self._convert = __import__("ndl_parser").convert_to_xml_string3
        self._eval_xml = __import__("reading_order.xy_cut.eval", fromlist=["eval_xml"]).eval_xml
        self.detector = RTMDet(model_path=str(src / "model" / "rtmdet-s-1280x1280.onnx"),
                               class_mapping_path=str(src / "config" / "ndl.yaml"),
                               score_threshold=0.3, conf_thresold=0.3, iou_threshold=0.3, device="cpu")
        with open(src / "config" / "NDLmoji.yaml", encoding="utf-8") as f:
            charlist = list(yaml.safe_load(f)["model"]["charset_train"])
        self.recognizer = PARSEQ(model_path=str(src / "model" / "parseq-ndl-32x384-tiny-10.onnx"),
                                 charlist=charlist, device="cpu")
        log("ndl-kotenocr-lite ready (cpu)")

    def ocr_image(self, image: str) -> dict:
        import xml.etree.ElementTree as ET
        import numpy as np
        from PIL import Image
        t0 = time.perf_counter()
        pil = Image.open(image).convert("RGB")
        img = np.array(pil)
        h, w = img.shape[:2]
        detections = self.detector.detect(img)
        classes = list(self.detector.classes.values())
        resultobj = [dict(), dict()]
        resultobj[0][0] = []
        for i in range(16):
            resultobj[1][i] = []
        for det in detections:
            xmin, ymin, xmax, ymax = det["box"]
            if det["class_index"] == 0:
                resultobj[0][0].append([xmin, ymin, xmax, ymax])
            resultobj[1][det["class_index"]].append([xmin, ymin, xmax, ymax, det["confidence"]])
        xmlstr = self._convert(w, h, Path(image).name, classes, resultobj, score_thr=0.3, min_bbox_size=5, use_block_ad=False)
        root = ET.fromstring("<OCRDATASET>" + xmlstr + "</OCRDATASET>")
        self._eval_xml(root, logger=None)      # 古典籍阅读顺序（列右→左、列内上→下）
        blocks = []
        vertical = 0
        for idx, line in enumerate(root.findall(".//LINE")):
            x, y = int(line.get("X")), int(line.get("Y"))
            lw, lh = int(line.get("WIDTH")), int(line.get("HEIGHT"))
            crop = img[y:y + lh, x:x + lw, :]
            text = self.recognizer.read(crop) if crop.size else ""
            try:
                conf = float(line.get("CONF"))
            except (TypeError, ValueError):
                conf = None
            if lh > lw:
                vertical += 1
            blocks.append({"seq": idx, "kind": "line", "text": text,
                           "bbox": [x / w, y / h, (x + lw) / w, (y + lh) / h],
                           "confidence": conf, "extra": {"is_vertical": lh > lw}})
        return {
            "width": w, "height": h, "engine": "ndl-kotenocr-lite", "seconds": round(time.perf_counter() - t0, 3),
            "text": "\n".join(b["text"] for b in blocks if b["text"]),
            "blocks": blocks, "figures": [],
            "extra": {"vertical_ratio": round(vertical / len(blocks), 3) if blocks else None},
        }


# ================================================================ 主循环
def main() -> None:
    global _PROTO
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["mineru", "ndl"], required=True)
    ap.add_argument("--ndl-root", default="")
    ap.add_argument("--models-dir", default="")
    args = ap.parse_args()

    # 协议通道：复制 fd 1 给自己用，然后把 fd 1 指向 stderr（库的一切输出都进日志）
    _PROTO = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", newline="\n")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr

    engine_obj = None
    boot = {"ok": True, "engine": args.engine, "python": sys.executable, **gpu_info()}
    try:
        if args.engine == "mineru":
            engine_obj = MinerUEngine(args.models_dir)
            boot["version"] = engine_obj.version
        else:
            engine_obj = NdlEngine(args.ndl_root)
            boot["version"] = "ndlkotenocr-lite"
    except Exception as e:
        boot = {"ok": False, "engine": args.engine, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1500:]}
    send(boot)
    if not boot.get("ok"):
        os._exit(1)

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
            cmd = req.get("cmd")
            if cmd == "status":
                send({"ok": True, **gpu_info(), "engine": args.engine})
            elif cmd == "shutdown":
                send({"ok": True})
                break
            elif cmd == "render":
                send(render_page(req["pdf"], int(req["page_no"]), int(req.get("dpi", 300)), req["out"]))
            elif cmd == "pdf_info":
                send(pdf_info(req["pdf"]))
            elif cmd == "ocr_pages" and args.engine == "mineru":
                r = engine_obj.parse_pages(req["pdf"], [int(p) for p in req["pages"]], req["out_dir"],
                                           req.get("backend", ""), req.get("lang", "ch"))
                send({"ok": True, "pages": r})
            elif cmd == "ocr_image" and args.engine == "ndl":
                send({"ok": True, **engine_obj.ocr_image(req["image"])})
            else:
                send({"ok": False, "error": f"unknown-or-unsupported cmd: {cmd} for engine {args.engine}"})
        except Exception as e:
            log(traceback.format_exc())
            try:
                send({"ok": False, "error": f"{type(e).__name__}: {e}"})
            except Exception:
                os._exit(2)
    # 不等待库的后台线程（ray 等），直接退出
    try:
        _PROTO.flush()
    finally:
        os._exit(0)


if __name__ == "__main__":
    main()
