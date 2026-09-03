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
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import text as sql
from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal
from ..models import Document, Figure, Page, Segment

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


def _store_page(db: Session, d: Document, page_no: int, res: dict, engine: str) -> None:
    """把一页的统一契约结果写库：文段 / 插图 / 页文本 / FTS。原有机器结果被替换，人工校订稿尽量按位置保留。"""
    page = db.query(Page).filter(Page.document_id == d.id, Page.page_no == page_no).one()
    old_edits = {(s.seq, s.kind): (s.text_edit, s.review_status, s.note, s.revision) for s in page.segments if s.text_edit or s.note}
    for s in page.segments:
        db.execute(sql("DELETE FROM segments_fts WHERE segment_id = :i"), {"i": s.id})
    page.segments.clear()
    page.figures.clear()
    db.flush()
    blocks = res.get("blocks") or []
    for b in blocks:
        seq, kind = int(b.get("seq", 0)), str(b.get("kind", "text"))
        s = Segment(document_id=d.id, page_id=page.id, seq=seq, kind=kind, text=str(b.get("text", "")),
                    bbox=[round(float(v), 5) for v in (b.get("bbox") or [0, 0, 0, 0])],
                    confidence=b.get("confidence"))
        if (seq, kind) in old_edits:
            s.text_edit, s.review_status, s.note, s.revision = old_edits[(seq, kind)]
        db.add(s)
        db.flush()
        db.execute(sql("INSERT INTO segments_fts(text, segment_id, document_id, page_no) VALUES (:t, :i, :d, :p)"),
                   {"t": s.text_edit or s.text, "i": s.id, "d": d.id, "p": page_no})
    fig_dir = doc_dir(d) / "figures"
    fig_dir.mkdir(parents=True, exist_ok=True)
    for fg in res.get("figures") or []:
        seq = int(fg.get("seq", 0))
        rel = ""
        src = fg.get("image_path") or ""
        if src and Path(src).exists():
            dst = fig_dir / f"p{page_no:04d}_{seq:02d}{Path(src).suffix.lower() or '.jpg'}"
            shutil.copy2(src, dst)
            rel = dst.relative_to(settings.library_data_dir).as_posix()
        db.add(Figure(document_id=d.id, page_id=page.id, seq=seq,
                      bbox=[round(float(v), 5) for v in (fg.get("bbox") or [0, 0, 0, 0])],
                      image_relpath=rel, caption=str(fg.get("caption", "")), label=str(fg.get("label", "")),
                      caption_bbox=fg.get("caption_bbox")))
    page.text = str(res.get("text", ""))
    page.width = int(res.get("width") or page.width or 0)
    page.height = int(res.get("height") or page.height or 0)
    page.image_sha256 = str(res.get("image_sha256") or page.image_sha256 or "")
    page.engine = str(res.get("engine") or engine)
    page.status, page.error = "done", ""
    confs = [b.get("confidence") for b in blocks if b.get("confidence") is not None]
    page.stats = {"segments": len(blocks), "figures": len(res.get("figures") or []),
                  "confidence": round(sum(confs) / len(confs), 4) if confs else None,
                  "seconds": res.get("seconds")}
    page.ocr_at = datetime.now()
    db.commit()


# ================================================================ 校订与检索
def patch_segment(db: Session, s: Segment, text_edit: str | None, kind: str | None, review: str | None,
                  note: str | None, base_revision: int | None) -> Segment:
    if base_revision is not None and base_revision != s.revision:
        raise HTTPException(409, f"该文段已被修改（当前版本 {s.revision}），请刷新后再保存")
    changed = False
    if text_edit is not None and text_edit != s.text_edit:
        s.text_edit = text_edit
        changed = True
    if kind is not None:
        s.kind = kind
    if review is not None:
        s.review_status = review
    if note is not None:
        s.note = note
    if changed:
        s.revision += 1
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
