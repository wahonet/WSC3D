# -*- coding: utf-8 -*-
"""文献库：PDF 入库、页图缓存、OCR 作业（sidecar）、文段 / 插图落库、全文检索。

数据分层（沿用古籍 OCR 工程的做法）：
- 源 PDF 留在 assets/library（不入库、不复制）；
- 页图按需渲染到 data/library/doc<id>/pages/，OCR 输入页图记录 SHA-256；
- OCR 原始输出留在 data/library/doc<id>/ocr/（只读），落库的是统一页级契约里的文段与插图；
- 人工校订写 segments.text_edit（机器底稿 text 不改），每次保存 revision +1。
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import text as sql
from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal
from ..models import AnnotationReference, Document, Figure, Page, Segment

log = logging.getLogger("stonelab.library")

WORKER_SCRIPT = Path(__file__).resolve().parents[1] / "ocr_worker.py"
ENGINES = ("mineru", "ndl")
MINERU_CHUNK = 6          # 每次交给 MinerU 的连续页数（模型常驻，分块只为了及时落库与显示进度）


# ================================================================ 文件与页图
def doc_path(d: Document) -> Path:
    return settings.library_root / d.relpath


def doc_dir(d: Document) -> Path:
    p = settings.library_data_dir / f"doc{d.id}"
    p.mkdir(parents=True, exist_ok=True)
    return p


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _pdf_info(p: Path) -> tuple[int, bool]:
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(p))
    try:
        n = len(doc)
        chars = 0
        for i in range(min(n, 12)):
            chars += len(doc[i].get_textpage().get_text_bounded().strip())
        return n, chars > 40
    finally:
        doc.close()


def render_page_image(d: Document, page_no: int, dpi: int, fmt: str = "jpg") -> Path:
    """渲染并缓存一页页图；同一 (页, dpi) 只渲染一次。"""
    out = doc_dir(d) / "pages" / f"p{page_no:04d}_{dpi}.{fmt}"
    if out.exists():
        return out
    import pypdfium2 as pdfium
    out.parent.mkdir(parents=True, exist_ok=True)
    doc = pdfium.PdfDocument(str(doc_path(d)))
    try:
        img = doc[page_no - 1].render(scale=dpi / 72).to_pil().convert("RGB")
        if fmt == "jpg":
            img.save(out, quality=86)
        else:
            img.save(out)
    finally:
        doc.close()
    return out


def figure_image_path(f: Figure) -> Path | None:
    if not f.image_relpath:
        return None
    p = settings.library_data_dir / f.image_relpath
    return p if p.exists() else None


# ================================================================ 入库扫描
def _next_code(db: Session) -> str:
    n = db.query(Document).count()
    while True:
        n += 1
        code = f"DOC-{n:03d}"
        if not db.query(Document).filter(Document.code == code).first():
            return code


def scan(db: Session) -> dict:
    t0 = time.perf_counter()
    report = {"documents": 0, "added": 0, "updated": 0, "removed": 0, "duration_ms": 0}
    root = settings.library_root
    seen: set[str] = set()
    for f in sorted(root.rglob("*.pdf")) + sorted(root.rglob("*.PDF")):
        rel = f.relative_to(root).as_posix()
        if rel in seen:
            continue
        seen.add(rel)
        d = db.query(Document).filter(Document.relpath == rel).one_or_none()
        size = f.stat().st_size
        if d is None:
            n, has_text = _pdf_info(f)
            stem = f.stem
            title = stem.split("_", 1)[1] if stem.startswith("DOC-") and "_" in stem else stem
            d = Document(code=_next_code(db), title=title, relpath=rel, sha256=sha256_file(f), bytes=size,
                         page_count=n, has_text_layer=has_text)
            db.add(d)
            db.flush()
            for i in range(1, n + 1):
                db.add(Page(document_id=d.id, page_no=i))
            report["added"] += 1
        elif d.bytes != size:
            # 同名替换：重读页数与指纹；已有 OCR 结果按页保留（页数变化时补齐 / 标记）
            n, has_text = _pdf_info(f)
            d.sha256, d.bytes, d.page_count, d.has_text_layer = sha256_file(f), size, n, has_text
            have = {p.page_no for p in d.pages}
            for i in range(1, n + 1):
                if i not in have:
                    db.add(Page(document_id=d.id, page_no=i))
            report["updated"] += 1
        report["documents"] += 1
    for d in db.query(Document).all():
        if d.relpath not in seen:
            report["removed"] += 1        # 文件不在了：保留记录与 OCR 结果，只计数提示
    db.commit()
    report["duration_ms"] = int((time.perf_counter() - t0) * 1000)
    log.info("library scan: %s", report)
    return report


# ================================================================ 工作进程管理（每个引擎一个）
_procs: dict[str, Optional[subprocess.Popen]] = {e: None for e in ENGINES}
_boot: dict[str, dict] = {e: {} for e in ENGINES}
_locks: dict[str, threading.Lock] = {e: threading.Lock() for e in ENGINES}


def worker_python(engine: str) -> Optional[str]:
    cands = settings.ocr_python_candidates if engine == "mineru" else settings.ndl_python_candidates
    for p in cands:
        if p and Path(p).exists():
            return p
    return None


def _alive(engine: str) -> bool:
    p = _procs.get(engine)
    return p is not None and p.poll() is None


def _ensure_worker(engine: str) -> Optional[str]:
    if _alive(engine):
        return None
    py = worker_python(engine)
    if py is None:
        return (f"找不到 {engine} 的 OCR 工作环境；请按 README 建立 ml/ocr/{'mineru' if engine == 'mineru' else 'ndl'}-venv，"
                f"或设置环境变量 STONELAB_{'OCR' if engine == 'mineru' else 'NDL'}_PYTHON")
    cmd = [py, "-X", "utf8", str(WORKER_SCRIPT), "--engine", engine,
           "--ndl-root", str(settings.ndl_root), "--models-dir", str(settings.mineru_models_dir)]
    try:
        logf = settings.ocr_log.open("a", encoding="utf-8")
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=logf,
                                text=True, encoding="utf-8", bufsize=1,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        line = proc.stdout.readline()
        boot = json.loads(line) if line.strip() else {"ok": False, "error": "工作进程无输出"}
        if not boot.get("ok"):
            proc.kill()
            return f"OCR 工作进程启动失败：{boot.get('error')}"
        _procs[engine], _boot[engine] = proc, boot
        log.info("ocr worker %s started pid=%s version=%s gpu=%s", engine, proc.pid, boot.get("version"), boot.get("gpu"))
        return None
    except Exception as e:
        return f"OCR 工作进程启动失败：{type(e).__name__}: {e}"


def _request(engine: str, payload: dict) -> dict:
    err = _ensure_worker(engine)
    if err:
        return {"ok": False, "error": err}
    proc = _procs[engine]
    assert proc and proc.stdin and proc.stdout
    with _locks[engine]:
        try:
            proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            proc.stdin.flush()
            line = proc.stdout.readline()
            if not line:
                return {"ok": False, "error": f"OCR 工作进程中断（exit={proc.poll()}），详见 {settings.ocr_log.name}"}
            return json.loads(line)
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def shutdown_workers() -> None:
    for e in ENGINES:
        p = _procs.get(e)
        if p is None:
            continue
        try:
            if p.poll() is None:
                p.terminate()
                p.wait(timeout=5)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
        _procs[e] = None


def workers_status() -> list[dict]:
    out = []
    for e in ENGINES:
        py = worker_python(e)
        b = _boot.get(e) or {}
        detail = ""
        if b:
            detail = " · ".join(str(x) for x in (b.get("version"), b.get("gpu") or ("CPU" if e == "ndl" else None)) if x)
        out.append({"engine": e, "python": py, "available": py is not None, "alive": _alive(e), "detail": detail})
    return out


# ================================================================ OCR 作业
_job: dict[str, Any] = {"running": False, "cancel": False}
_job_lock = threading.Lock()


def job_status() -> dict:
    j = dict(_job)
    return {
        "running": bool(j.get("running")), "document_id": j.get("document_id"), "engine": j.get("engine", ""),
        "total": j.get("total", 0), "done": j.get("done", 0), "errors": j.get("errors", 0),
        "current_page": j.get("current_page"), "started_at": j.get("started_at"), "finished_at": j.get("finished_at"),
        "message": j.get("message", ""), "cancel_requested": bool(j.get("cancel")),
    }


def cancel_job() -> dict:
    _job["cancel"] = True
    return job_status()


def start_job(db: Session, d: Document, engine: str | None, pages: list[int] | None, redo: bool, backend: str) -> dict:
    with _job_lock:
        if _job.get("running"):
            raise HTTPException(409, "已有 OCR 作业在运行，请等待完成或先取消")
        eng = engine or ("ndl" if d.script == "classical" else "mineru")
        if eng not in ENGINES:
            raise HTTPException(422, f"未知引擎：{eng}")
        err = _ensure_worker(eng)
        if err:
            raise HTTPException(503, err)
        q = db.query(Page).filter(Page.document_id == d.id)
        if pages:
            q = q.filter(Page.page_no.in_(pages))
        elif not redo:
            q = q.filter(Page.status.in_(("pending", "error")))
        targets = sorted(p.page_no for p in q.all())
        if not targets:
            raise HTTPException(422, "没有需要 OCR 的页（全部已完成；如需重做请勾选 redo）")
        _job.update({"running": True, "cancel": False, "document_id": d.id, "engine": eng, "total": len(targets),
                     "done": 0, "errors": 0, "current_page": None, "started_at": datetime.now().isoformat(timespec="seconds"),
                     "finished_at": None, "message": "启动中"})
        threading.Thread(target=_run_job, args=(d.id, eng, targets, backend), name=f"ocr-{d.code}", daemon=True).start()
        return job_status()


def _run_job(doc_id: int, engine: str, targets: list[int], backend: str) -> None:
    try:
        with SessionLocal() as db:
            d = db.get(Document, doc_id)
            if d is None:
                raise RuntimeError("文献不存在")
            pdf = str(doc_path(d))
            ocr_dir = doc_dir(d) / "ocr" / engine
            ocr_dir.mkdir(parents=True, exist_ok=True)
            # 标记运行中
            for p in db.query(Page).filter(Page.document_id == d.id, Page.page_no.in_(targets)).all():
                p.status = "running"
            db.commit()

            if engine == "mineru":
                for chunk in _consecutive_chunks(targets, MINERU_CHUNK):
                    if _job.get("cancel"):
                        break
                    _job["current_page"] = chunk[0]
                    _job["message"] = f"MinerU 解析第 {chunk[0]}–{chunk[-1]} 页"
                    r = _request("mineru", {"cmd": "ocr_pages", "pdf": pdf, "pages": chunk, "out_dir": str(ocr_dir),
                                            "backend": backend, "lang": "ch"})
                    if not r.get("ok"):
                        _mark_error(db, d.id, chunk, r.get("error", "未知错误"))
                        _job["errors"] += len(chunk)
                        _job["done"] += len(chunk)
                        continue
                    for page_no in chunk:
                        res = (r.get("pages") or {}).get(str(page_no))
                        if res is None:
                            _mark_error(db, d.id, [page_no], "MinerU 未返回该页")
                            _job["errors"] += 1
                        else:
                            _store_page(db, d, page_no, res, engine)
                        _job["done"] += 1
            else:
                for page_no in targets:
                    if _job.get("cancel"):
                        break
                    _job["current_page"] = page_no
                    _job["message"] = f"NDL 识别第 {page_no} 页"
                    try:
                        img = render_page_image(d, page_no, settings.ocr_dpi, "png")
                        r = _request("ndl", {"cmd": "ocr_image", "image": str(img)})
                        if not r.get("ok"):
                            raise RuntimeError(r.get("error", "未知错误"))
                        r["image_sha256"] = sha256_file(img)
                        r["page_no"] = page_no
                        (ocr_dir / f"p{page_no:04d}.json").write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
                        _store_page(db, d, page_no, r, engine)
                    except Exception as e:
                        _mark_error(db, d.id, [page_no], f"{type(e).__name__}: {e}")
                        _job["errors"] += 1
                    _job["done"] += 1
            # 未处理到的（取消）恢复为 pending
            left = db.query(Page).filter(Page.document_id == d.id, Page.status == "running").all()
            for p in left:
                p.status = "pending"
            db.commit()
            _job["message"] = "已取消" if _job.get("cancel") else f"完成：{_job['done']} 页，{_job['errors']} 页出错"
    except Exception as e:
        log.exception("ocr job failed")
        _job["message"] = f"作业异常：{type(e).__name__}: {e}"
    finally:
        _job["running"] = False
        _job["finished_at"] = datetime.now().isoformat(timespec="seconds")
        _job["current_page"] = None


def _consecutive_chunks(pages: list[int], size: int) -> list[list[int]]:
    out: list[list[int]] = []
    cur: list[int] = []
    for p in pages:
        if cur and (p != cur[-1] + 1 or len(cur) >= size):
            out.append(cur)
            cur = []
        cur.append(p)
    if cur:
        out.append(cur)
    return out


def _mark_error(db: Session, doc_id: int, pages: list[int], msg: str) -> None:
    for p in db.query(Page).filter(Page.document_id == doc_id, Page.page_no.in_(pages)).all():
        p.status, p.error = "error", msg[:2000]
    db.commit()


def _bbox_iou(a: list, b: list) -> float:
    if len(a) != 4 or len(b) != 4:
        return 0.0
    intersection = max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    union = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1]) + max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1]) - intersection
    return intersection / union if union else 0.0


def _match_ocr_segments(old: list[Segment], blocks: list[dict]) -> dict[int, Segment]:
    """按文本和物理位置做一对一匹配，阅读序号变化不能把校订稿转移给别段。"""
    normalize = lambda value: re.sub(r"[\W_]+", "", value, flags=re.UNICODE).casefold()
    old_text = [normalize(s.text) for s in old]
    candidates: list[tuple[float, int, int]] = []
    for bi, b in enumerate(blocks):
        txt = normalize(str(b.get("text", "")))
        for oi, s in enumerate(old):
            overlap = _bbox_iou(s.bbox or [], b.get("bbox") or [])
            if overlap < 0.45:
                continue
            similarity = SequenceMatcher(None, old_text[oi], txt, autojunk=False).ratio() if old_text[oi] and txt else 0.0
            # 修复跨页合并时，旧机器文本可能是本段加下一页的延续；位置不变而文本缩短。
            if (overlap >= 0.85 and similarity >= 0.45) or (overlap >= 0.55 and similarity >= 0.7):
                candidates.append((0.55 * overlap + 0.45 * similarity, oi, bi))
    matches: dict[int, Segment] = {}
    used: set[int] = set()
    for score, oi, bi in sorted(candidates, reverse=True):
        if oi in used or bi in matches:
            continue
        # 几乎并列的候选不能可靠证明身份；旧人工稿会由调用方保留供复核。
        if any(abs(score - other) < 0.025 and (oi == oj or bi == bj) and (oi, bi) != (oj, bj)
               for other, oj, bj in candidates):
            continue
        matches[bi] = old[oi]
        used.add(oi)
    return matches


def _segment_has_human_work(s: Segment, page: Page) -> bool:
    return bool(s.text_edit or s.note or s.review_status != "machine" or s.revision
                or (page.ocr_at and s.updated_at and s.updated_at > page.ocr_at))


def _store_page(db: Session, d: Document, page_no: int, res: dict, engine: str) -> None:
    """保存统一页结果，按文本和位置保留文段身份、人工工作及检索锚点。"""
    page = db.query(Page).filter(Page.document_id == d.id, Page.page_no == page_no).one()
    old_segments = list(page.segments)
    protected = {s.id for s in old_segments if _segment_has_human_work(s, page)}
    referenced_segments = set(db.query(AnnotationReference.segment_id, AnnotationReference.source_identity)
                              .filter(AnnotationReference.page_id == page.id,
                                      AnnotationReference.document_identity == d.reference_identity,
                                      AnnotationReference.page_identity == page.reference_identity,
                                      AnnotationReference.kind == "segment").all())
    protected.update(s.id for s in old_segments if (s.id, s.reference_identity) in referenced_segments)
    blocks = sorted(res.get("blocks") or [], key=lambda b: int(b.get("seq", 0)))
    matches = _match_ocr_segments(old_segments, blocks)
    matched_ids = {s.id for s in matches.values()}
    for s in old_segments:
        db.execute(sql("DELETE FROM segments_fts WHERE segment_id = :i"), {"i": s.id})
    current: list[Segment] = []
    for bi, b in enumerate(blocks):
        s = matches.get(bi)
        if s is None:
            s = Segment(document_id=d.id, seq=bi, kind=str(b.get("kind", "text")), text="")
            page.segments.append(s)
        elif s.id not in protected:
            s.kind = str(b.get("kind", "text"))
        s.seq = bi
        s.text = str(b.get("text", ""))
        s.bbox = [round(float(v), 5) for v in (b.get("bbox") or [0, 0, 0, 0])]
        s.confidence = b.get("confidence")
        current.append(s)
    # 先分配新 id，再删除旧机器块，避免 SQLite 把旧的检索/引用 id 复用给别段。
    db.flush()
    retained = []
    for s in old_segments:
        if s.id in matched_ids:
            continue
        if s.id in protected:
            s.seq = len(current)
            current.append(s)
            retained.append(s.id)
        else:
            page.segments.remove(s)
    db.flush()
    for s in current:
        db.execute(sql("INSERT INTO segments_fts(text, segment_id, document_id, page_no) VALUES (:t, :i, :d, :p)"),
                   {"t": s.text_edit or s.text, "i": s.id, "d": d.id, "p": page_no})

    old_figures = list(page.figures)
    referenced_figures = set(db.query(AnnotationReference.figure_id, AnnotationReference.source_identity)
                             .filter(AnnotationReference.page_id == page.id,
                                     AnnotationReference.document_identity == d.reference_identity,
                                     AnnotationReference.page_identity == page.reference_identity,
                                     AnnotationReference.kind == "figure").all())
    used_figures: set[int] = set()
    figures = sorted(res.get("figures") or [], key=lambda fg: int(fg.get("seq", 0)))
    fig_dir = doc_dir(d) / "figures"
    fig_dir.mkdir(parents=True, exist_ok=True)
    for seq, fg in enumerate(figures):
        candidates = sorted(((_bbox_iou(f.bbox or [], fg.get("bbox") or []), f) for f in old_figures
                             if f.id not in used_figures), key=lambda pair: pair[0], reverse=True)
        f = candidates[0][1] if candidates and candidates[0][0] >= 0.8 and (len(candidates) == 1 or candidates[0][0] - candidates[1][0] >= 0.025) else None
        if f is None:
            f = Figure(document_id=d.id, seq=seq, caption="", label="", image_relpath="")
            page.figures.append(f)
        else:
            used_figures.add(f.id)
        f.seq = seq
        f.bbox = [round(float(v), 5) for v in (fg.get("bbox") or [0, 0, 0, 0])]
        # 旧模型没有记录图注编辑版本；保留已有非空图注、图号，不能假定它们都是机器稿。
        f.caption = f.caption or str(fg.get("caption", ""))
        f.label = f.label or str(fg.get("label", ""))
        f.caption_bbox = fg.get("caption_bbox")
        src = fg.get("image_path") or ""
        if src and Path(src).is_file():
            # 文件名由内容而非 seq 决定；插入新图块不会覆盖保留下来的旧图裁片。
            src_path = Path(src)
            dst = fig_dir / f"p{page_no:04d}_{sha256_file(src_path)[:20]}{src_path.suffix.lower() or '.jpg'}"
            if src_path.resolve() != dst.resolve():
                shutil.copy2(src_path, dst)
            f.image_relpath = dst.relative_to(settings.library_data_dir).as_posix()
    db.flush()
    retained_figures = []
    for f in old_figures:
        if f.id in used_figures:
            continue
        if (f.id, f.reference_identity) in referenced_figures or f.caption or f.label or f.note or f.review_status != "machine":
            f.seq = len(figures) + len(retained_figures)
            retained_figures.append(f.id)
        else:
            page.figures.remove(f)
    page.text = "\n".join(s.text for s in current if s.text and s.kind not in ("header", "page_number"))
    page.width = int(res.get("width") or page.width or 0)
    page.height = int(res.get("height") or page.height or 0)
    page.image_sha256 = str(res.get("image_sha256") or page.image_sha256 or "")
    page.engine = str(res.get("engine") or engine)
    page.status, page.error = "done", ""
    confs = [b.get("confidence") for b in blocks if b.get("confidence") is not None]
    page.stats = {**(res.get("stats") or {}), "segments": len(current), "figures": len(figures) + len(retained_figures),
                  "confidence": round(sum(confs) / len(confs), 4) if confs else None,
                  "seconds": res.get("seconds")}
    if res.get("extra"):
        page.stats["ocr_normalization"] = res["extra"]
    if retained or retained_figures:
        page.stats["retained_review"] = {"segment_ids": retained, "figure_ids": retained_figures,
                                         "message": "重建时部分旧记录未能可靠匹配，已保留人工工作及节点引用的来源，请复核。"}
    page.ocr_at = datetime.now()
    db.commit()


# ================================================================ 校订与检索
def patch_segment(db: Session, s: Segment, text_edit: str | None, kind: str | None, review: str | None,
                  note: str | None, base_revision: int | None) -> Segment:
    if base_revision is not None and base_revision != s.revision:
        raise HTTPException(409, f"该文段已被修改（当前版本 {s.revision}），请刷新后再保存")
    changed = False
    text_changed = text_edit is not None and text_edit != s.text_edit
    for attr, value in (("text_edit", text_edit), ("kind", kind), ("review_status", review), ("note", note)):
        if value is not None and value != getattr(s, attr):
            setattr(s, attr, value)
            changed = True
    if changed:
        s.revision += 1
    if text_changed:
        db.execute(sql("DELETE FROM segments_fts WHERE segment_id = :i"), {"i": s.id})
        db.execute(sql("INSERT INTO segments_fts(text, segment_id, document_id, page_no) VALUES (:t, :i, :d, :p)"),
                   {"t": s.text_edit or s.text, "i": s.id, "d": s.document_id, "p": s.page.page_no})
    db.commit()
    return s


def _search_words(q: str) -> list[str]:
    """空白分词，多词为 AND 关系；去重保持顺序。"""
    seen: list[str] = []
    for w in re.split(r"\s+", q.strip()):
        if w and w not in seen:
            seen.append(w)
    return seen


def _like_snippet(txt: str, words: list[str], ctx: int = 22) -> str:
    """LIKE 路线的高亮片段：以首个命中词为中心截取，所有词都用 [[ ]] 标出。"""
    lower = txt.lower()
    pos = [p for p in (lower.find(w.lower()) for w in words) if p >= 0]
    i = min(pos) if pos else 0
    a, b = max(0, i - ctx), min(len(txt), i + ctx * 2)
    piece = txt[a:b]
    for w in sorted(words, key=len, reverse=True):
        piece = re.sub(re.escape(w), lambda m: f"[[{m.group(0)}]]", piece, flags=re.IGNORECASE)
    return ("…" if a > 0 else "") + piece.replace("\n", " ") + ("…" if b < len(txt) else "")


def search(db: Session, q: str, document_id: int | None, limit: int = 50, offset: int = 0) -> dict:
    """全库 / 单书检索 OCR 文本（人工校订稿优先）。

    - 空白分词，多词 AND；每词都 ≥3 字时走 FTS5 trigram，否则退回 LIKE 子串匹配；
    - 结果按 书 → 页 → 段 的阅读顺序排列，支持 offset 翻页；
    - `facets` 给出各书命中数（不受 document_id 过滤，供前端做书签筛选）。
    """
    words = _search_words(q)
    if not words:
        return {"q": q, "total": 0, "offset": offset, "hits": [], "facets": []}
    use_fts = all(len(w) >= 3 for w in words)
    doc_filter = " AND {col} = :d" if document_id else ""
    if use_fts:
        term = " AND ".join('"' + w.replace('"', '""') + '"' for w in words)
        params: dict = {"q": term, "d": document_id, "n": limit, "o": offset}
        base = "FROM segments_fts f WHERE segments_fts MATCH :q"
        total = db.execute(sql(f"SELECT count(*) {base}{doc_filter.format(col='f.document_id')}"), params).scalar() or 0
        facet_rows = db.execute(sql(f"SELECT f.document_id, count(*) {base} GROUP BY f.document_id"), params).fetchall()
        rows = db.execute(sql(
            f"SELECT f.segment_id, snippet(segments_fts, 0, '[[', ']]', '…', 20) "
            f"FROM segments_fts f JOIN segments s ON s.id = f.segment_id "
            f"WHERE segments_fts MATCH :q{doc_filter.format(col='f.document_id')} "
            f"ORDER BY f.document_id, f.page_no, s.seq LIMIT :n OFFSET :o"), params).fetchall()
    else:
        body = "CASE WHEN s.text_edit != '' THEN s.text_edit ELSE s.text END"
        cond = " AND ".join(f"{body} LIKE :w{i}" for i in range(len(words)))
        params = {f"w{i}": f"%{w}%" for i, w in enumerate(words)} | {"d": document_id, "n": limit, "o": offset}
        base = f"FROM segments s WHERE {cond}"
        total = db.execute(sql(f"SELECT count(*) {base}{doc_filter.format(col='s.document_id')}"), params).scalar() or 0
        facet_rows = db.execute(sql(f"SELECT s.document_id, count(*) {base} GROUP BY s.document_id"), params).fetchall()
        rows = db.execute(sql(
            f"SELECT s.id, NULL FROM segments s JOIN doc_pages p ON p.id = s.page_id WHERE {cond}"
            f"{doc_filter.format(col='s.document_id')} ORDER BY s.document_id, p.page_no, s.seq LIMIT :n OFFSET :o"),
            params).fetchall()

    doc_ids = {int(r[0]) for r in facet_rows}
    docs = {d.id: d for d in db.query(Document).filter(Document.id.in_(doc_ids)).all()} if doc_ids else {}

    def _code(did: int) -> str:
        return docs[did].code if did in docs else ""

    facets = [{"document_id": int(did), "document_code": _code(did), "count": int(n),
               "document_title": docs[did].title if did in docs else ""}
              for did, n in sorted(facet_rows, key=lambda r: (_code(r[0]), r[0]))]

    ids = [r[0] for r in rows]
    segs = {s.id: s for s in db.query(Segment).filter(Segment.id.in_(ids)).all()} if ids else {}
    hits = []
    for sid, snip in rows:
        s = segs.get(sid)
        if not s:
            continue
        d = docs.get(s.document_id)
        txt = s.text_edit or s.text
        if not snip:
            snip = _like_snippet(txt, words)
        hits.append({"segment_id": s.id, "document_id": s.document_id, "document_code": d.code if d else "",
                     "document_title": d.title if d else "", "page_id": s.page_id, "page_no": s.page.page_no,
                     "kind": s.kind, "snippet": snip, "text": txt})
    return {"q": q, "total": int(total), "offset": offset, "hits": hits, "facets": facets}
