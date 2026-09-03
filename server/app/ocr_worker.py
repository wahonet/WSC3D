# -*- coding: utf-8 -*-
"""OCR 工作进程（sidecar）：在独立 Python 环境中运行，不在 StoneLab 主环境。

两个引擎，各自一个进程（环境不同）：
- mineru : 现代横排书籍。MinerU（版面分析 + 文字 / 表格 / 公式识别 + 阅读顺序），直接读 PDF，
           输出带坐标的版面块与裁好的插图；默认 hybrid-engine 后端（有文字层的页直接抽字，扫描页走 VLM）。
- ndl    : 古籍竖排。NDL-KotenOCR Lite（RTMDet 版面 + PARSeq 识别 + 古典籍阅读顺序，ONNX CPU），
           输入为渲染好的页图，输出按阅读顺序排好的行。

协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应（顺序一一对应）；库的杂散输出全部重定向到 stderr。
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
import re
import sys
import time
import traceback
from pathlib import Path

_PROTO = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", newline="\n")
sys.stdout = sys.stderr


def send(obj: dict) -> None:
    _PROTO.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _PROTO.flush()


def log(msg: str) -> None:
    print(f"[ocr-worker] {msg}", file=sys.stderr, flush=True)


ap = argparse.ArgumentParser()
ap.add_argument("--engine", choices=["mineru", "ndl"], required=True)
ap.add_argument("--ndl-root", default="")
ap.add_argument("--models-dir", default="")
args = ap.parse_args()


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
_LABEL_RE = re.compile(r"^\s*((?:图版|图|表|Fig\.?|Figure|Table|Plate)\s*[0-9一二三四五六七八九十]+(?:[.．\-－·][0-9]+)*)")

# MinerU content_list 的块类型 -> 我们的文段类型
KIND_MAP = {
    "text": "text", "title": "title", "equation": "equation", "list": "list", "code": "text",
    "header": "header", "footer": "header", "page_number": "page_number", "aside_text": "other",
    "page_footnote": "footnote", "footnote": "footnote", "ref_text": "text",
    "table": "table", "image_caption": "caption", "table_caption": "caption",
    "image_footnote": "footnote", "table_footnote": "footnote",
}


def _bbox_norm(b) -> list[float]:
    try:
        x0, y0, x1, y1 = [float(v) / 1000.0 for v in b[:4]]
        return [max(0.0, min(1.0, x0)), max(0.0, min(1.0, y0)), max(0.0, min(1.0, x1)), max(0.0, min(1.0, y1))]
    except Exception:
        return [0.0, 0.0, 0.0, 0.0]


def _join(v) -> str:
    if isinstance(v, list):
        return "\n".join(str(x) for x in v if str(x).strip())
    return str(v or "")


class MinerUEngine:
    def __init__(self, models_dir: str):
        os.environ.setdefault("MINERU_MODEL_SOURCE", "modelscope")
        if models_dir:
            os.environ.setdefault("MINERU_MODELS_DIR", models_dir)
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
        out.mkdir(parents=True, exist_ok=True)
        pdf_bytes = self._read_fn(pdf_path) if self._read_fn else pdf_path.read_bytes()
        kw = {
            "output_dir": str(out), "pdf_file_names": [pdf_path.stem], "pdf_bytes_list": [pdf_bytes],
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
        # 找输出：<out>/<stem>/<method>/<stem>_content_list(_v2).json
        cl_files = sorted(out.rglob("*_content_list_v2.json")) or sorted(out.rglob("*_content_list.json"))
        if not cl_files:
            raise RuntimeError(f"MinerU 未产出 content_list：{out}")
        cl_path = cl_files[0]
        blocks = json.loads(cl_path.read_text(encoding="utf-8"))
        if isinstance(blocks, dict):          # v2 可能是 {"pages": [...]} 之类的包装
            blocks = blocks.get("content_list") or blocks.get("blocks") or blocks.get("pages") or []
        images_dir = cl_path.parent / "images"
        per_page: dict[int, dict] = {}
        for b in blocks:
            idx = int(b.get("page_idx", 0))
            page_no = start + idx
            per_page.setdefault(page_no, {"blocks": [], "figures": []})
            self._absorb_block(b, per_page[page_no], images_dir)
        result: dict[str, dict] = {}
        for page_no in pages:
            d = per_page.get(page_no, {"blocks": [], "figures": []})
            for i, blk in enumerate(d["blocks"]):
                blk["seq"] = i
            for i, fg in enumerate(d["figures"]):
                fg["seq"] = i
            text = "\n".join(blk["text"] for blk in d["blocks"]
                             if blk["kind"] in ("text", "title", "caption", "footnote", "list", "table") and blk["text"])
            result[str(page_no)] = {
                "page_no": page_no, "engine": f"mineru/{backend or 'hybrid-engine'}",
                "seconds": round(seconds / max(1, len(pages)), 3), "text": text,
                "blocks": d["blocks"], "figures": d["figures"],
                "raw_dir": str(cl_path.parent),
            }
        return result

    def _absorb_block(self, b: dict, acc: dict, images_dir: Path) -> None:
        btype = str(b.get("type", "text"))
        bbox = _bbox_norm(b.get("bbox") or [0, 0, 0, 0])
        if btype in ("image", "chart"):
            captions = _join(b.get("image_caption") or b.get("chart_caption") or b.get("caption"))
            img_rel = b.get("img_path") or ""
            img_path = ""
            if img_rel:
                cand = images_dir.parent / img_rel
                img_path = str(cand) if cand.exists() else str(images_dir / Path(img_rel).name)
            m = _LABEL_RE.match(captions)
            acc["figures"].append({
                "bbox": bbox, "image_path": img_path, "caption": captions,
                "label": m.group(1).replace(" ", "") if m else "", "caption_bbox": None,
                "extra": {"type": btype, "sub_type": b.get("sub_type", "")},
            })
            foot = _join(b.get("image_footnote") or b.get("chart_footnote"))
            if foot:
                acc["blocks"].append({"kind": "footnote", "text": foot, "bbox": bbox, "confidence": None, "extra": {"of": "image"}})
            if captions:
                acc["blocks"].append({"kind": "caption", "text": captions, "bbox": bbox, "confidence": None, "extra": {"of": "image"}})
            return
        if btype == "table":
            body = b.get("table_body") or b.get("html") or ""
            cap = _join(b.get("table_caption"))
            acc["blocks"].append({"kind": "table", "text": body if isinstance(body, str) else _join(body),
                                  "bbox": bbox, "confidence": None, "extra": {"caption": cap}})
            if cap:
                acc["blocks"].append({"kind": "caption", "text": cap, "bbox": bbox, "confidence": None, "extra": {"of": "table"}})
            foot = _join(b.get("table_footnote"))
            if foot:
                acc["blocks"].append({"kind": "footnote", "text": foot, "bbox": bbox, "confidence": None, "extra": {"of": "table"}})
            return
        text = _join(b.get("text") if b.get("text") is not None else b.get("content"))
        if btype == "list" and b.get("list_items"):
            text = "\n".join(_join(x) for x in b["list_items"])
        if not text.strip():
            return
        kind = KIND_MAP.get(btype, "other")
        if btype == "text" and int(b.get("text_level") or 0) >= 1:
            kind = "title"
        acc["blocks"].append({"kind": kind, "text": text.strip(), "bbox": bbox, "confidence": None,
                              "extra": {k: b[k] for k in ("text_level", "sub_type") if k in b}})


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
    sys.exit(1)

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
        send({"ok": False, "error": f"{type(e).__name__}: {e}"})
