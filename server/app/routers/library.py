# -*- coding: utf-8 -*-
"""文献库：文献扫描与元数据 / 页与页图 / OCR 作业 / 文段与插图校订 / 全文检索。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import Document, Figure, Page, Segment
from ..schemas import (
    DocumentOut, DocumentPatch, FigureOut, FigurePatch, LibraryScanReport, OcrJobOut, OcrStartIn, OcrStatusOut,
    OcrWorkerInfo, PageBrief, PageDetail, SearchHit, SegmentOut, SegmentPatch,
)
from ..services import library

router = APIRouter(prefix="/library", tags=["文献库"])
_CACHE = {"Cache-Control": "public, max-age=86400"}


def _iso(dt) -> str | None:
    return dt.isoformat(timespec="seconds") if dt else None


def _doc_out(db: Session, d: Document) -> DocumentOut:
    done = db.query(func.count(Page.id)).filter(Page.document_id == d.id, Page.status == "done").scalar() or 0
    err = db.query(func.count(Page.id)).filter(Page.document_id == d.id, Page.status == "error").scalar() or 0
    n_seg = db.query(func.count(Segment.id)).filter(Segment.document_id == d.id).scalar() or 0
    n_fig = db.query(func.count(Figure.id)).filter(Figure.document_id == d.id).scalar() or 0
    return DocumentOut(
        id=d.id, code=d.code, title=d.title, authors=d.authors, year=d.year, publisher=d.publisher, kind=d.kind,
        script=d.script, relpath=d.relpath, filename=d.relpath.rsplit("/", 1)[-1], bytes=d.bytes,
        page_count=d.page_count, has_text_layer=bool(d.has_text_layer), notes=d.notes or "",
        pages_done=done, pages_error=err, segments=n_seg, figures=n_fig, updated_at=_iso(d.updated_at))


def _seg_out(s: Segment, page_no: int) -> SegmentOut:
    return SegmentOut(id=s.id, document_id=s.document_id, page_id=s.page_id, page_no=page_no, seq=s.seq, kind=s.kind,
                      text=s.text or "", text_edit=s.text_edit or "", bbox=[float(v) for v in (s.bbox or [0, 0, 0, 0])],
                      confidence=s.confidence, review_status=s.review_status, revision=s.revision, note=s.note or "")


def _fig_out(f: Figure, page_no: int) -> FigureOut:
    return FigureOut(id=f.id, document_id=f.document_id, page_id=f.page_id, page_no=page_no, seq=f.seq,
                     bbox=[float(v) for v in (f.bbox or [0, 0, 0, 0])], caption=f.caption or "", label=f.label or "",
                     review_status=f.review_status, note=f.note or "", has_image=library.figure_image_path(f) is not None)


def get_document(doc_id: int, db: Session = Depends(get_db)) -> Document:
    d = db.get(Document, doc_id)
    if not d:
        raise HTTPException(404, "文献不存在")
    return d


def get_page(page_id: int, db: Session = Depends(get_db)) -> Page:
    p = db.get(Page, page_id)
    if not p:
        raise HTTPException(404, "页不存在")
    return p


# ---------------------------------------------------------------- 文献
@router.post("/scan", response_model=LibraryScanReport, summary="扫描 assets/library 下的 PDF 入库")
def scan(db: Session = Depends(get_db)):
    return library.scan(db)


@router.get("/documents", response_model=list[DocumentOut], summary="文献列表（含 OCR 进度）")
def list_documents(db: Session = Depends(get_db)):
    return [_doc_out(db, d) for d in db.query(Document).order_by(Document.code).all()]


@router.get("/documents/{doc_id}", response_model=DocumentOut, summary="文献详情")
def get_doc(d: Document = Depends(get_document), db: Session = Depends(get_db)):
    return _doc_out(db, d)


@router.patch("/documents/{doc_id}", response_model=DocumentOut, summary="编辑文献元数据（题名 / 作者 / 年份 / 类型 / 文字体例）")
def patch_doc(body: DocumentPatch, d: Document = Depends(get_document), db: Session = Depends(get_db)):
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(d, k, v)
    db.commit()
    return _doc_out(db, d)


@router.get("/documents/{doc_id}/pages", response_model=list[PageBrief], summary="分页列出物理页与 OCR 状态")
def list_pages(d: Document = Depends(get_document), offset: int = 0, limit: int = Query(60, le=500),
               db: Session = Depends(get_db)):
    rows = (db.query(Page).filter(Page.document_id == d.id).order_by(Page.page_no).offset(offset).limit(limit).all())
    ids = [p.id for p in rows]
    nseg = dict(db.query(Segment.page_id, func.count(Segment.id)).filter(Segment.page_id.in_(ids)).group_by(Segment.page_id).all()) if ids else {}
    nfig = dict(db.query(Figure.page_id, func.count(Figure.id)).filter(Figure.page_id.in_(ids)).group_by(Figure.page_id).all()) if ids else {}
    return [PageBrief(id=p.id, page_no=p.page_no, status=p.status, engine=p.engine or "", width=p.width, height=p.height,
                      segments=nseg.get(p.id, 0), figures=nfig.get(p.id, 0),
                      snippet=(p.text or "")[:60].replace("\n", " "), error=(p.error or "")[:200]) for p in rows]


@router.get("/documents/{doc_id}/file", summary="源 PDF（浏览器内嵌查看）")
def doc_file(d: Document = Depends(get_document)):
    p = library.doc_path(d)
    if not p.is_file():
        raise HTTPException(404, "PDF 文件不存在")
    return FileResponse(p, media_type="application/pdf", headers=_CACHE)


# ---------------------------------------------------------------- 页
@router.get("/pages/{page_id}", response_model=PageDetail, summary="页详情：文段与插图")
def page_detail(p: Page = Depends(get_page), db: Session = Depends(get_db)):
    d = p.document
    return PageDetail(
        id=p.id, document_id=d.id, document_code=d.code, document_title=d.title, page_no=p.page_no,
        page_count=d.page_count, status=p.status, engine=p.engine or "", width=p.width, height=p.height,
        text=p.text or "", error=p.error or "", stats=p.stats or {},
        segments=[_seg_out(s, p.page_no) for s in p.segments], figures=[_fig_out(f, p.page_no) for f in p.figures])


@router.get("/pages/{page_id}/image", summary="页图（默认浏览 DPI；dpi=300 为 OCR 输入页图）")
def page_image(p: Page = Depends(get_page), dpi: int = Query(0, ge=0, le=600)):
    dpi = dpi or settings.view_dpi
    fmt = "png" if dpi >= settings.ocr_dpi else "jpg"
    path = library.render_page_image(p.document, p.page_no, dpi, fmt)
    return FileResponse(path, media_type="image/png" if fmt == "png" else "image/jpeg", headers=_CACHE)


@router.get("/documents/{doc_id}/pages/{page_no}", response_model=PageDetail, summary="按物理页号取页详情")
def page_by_no(page_no: int, d: Document = Depends(get_document), db: Session = Depends(get_db)):
    p = db.query(Page).filter(Page.document_id == d.id, Page.page_no == page_no).one_or_none()
    if not p:
        raise HTTPException(404, "页不存在")
    return page_detail(p, db)


# ---------------------------------------------------------------- OCR 作业
@router.get("/ocr/status", response_model=OcrStatusOut, summary="OCR 工作进程与当前作业状态")
def ocr_status():
    return OcrStatusOut(workers=[OcrWorkerInfo(**w) for w in library.workers_status()],
                        job=OcrJobOut(**library.job_status()), log=str(settings.ocr_log))


@router.post("/documents/{doc_id}/ocr", response_model=OcrJobOut, summary="启动 OCR 作业（后台逐页落库）")
def start_ocr(body: OcrStartIn, d: Document = Depends(get_document), db: Session = Depends(get_db)):
    """engine 缺省按文献 script：现代横排 -> mineru，古籍竖排 -> ndl。同一时间只跑一个作业。"""
    return OcrJobOut(**library.start_job(db, d, body.engine, body.pages, body.redo, body.backend))


@router.post("/ocr/cancel", response_model=OcrJobOut, summary="请求取消当前作业（当前页完成后停止）")
def cancel_ocr():
    return OcrJobOut(**library.cancel_job())


# ---------------------------------------------------------------- 文段 / 插图
@router.patch("/segments/{segment_id}", response_model=SegmentOut, summary="校订文段（人工稿 / 类型 / 审核）")
def patch_segment(segment_id: int, body: SegmentPatch, db: Session = Depends(get_db)):
    s = db.get(Segment, segment_id)
    if not s:
        raise HTTPException(404, "文段不存在")
    s = library.patch_segment(db, s, body.text_edit, body.kind, body.review_status, body.note, body.base_revision)
    return _seg_out(s, s.page.page_no)


@router.patch("/figures/{figure_id}", response_model=FigureOut, summary="校订插图（图注 / 图号 / 审核）")
def patch_figure(figure_id: int, body: FigurePatch, db: Session = Depends(get_db)):
    f = db.get(Figure, figure_id)
    if not f:
        raise HTTPException(404, "插图不存在")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(f, k, v)
    db.commit()
    return _fig_out(f, f.page.page_no)


@router.get("/figures/{figure_id}/image", summary="插图裁片")
def figure_image(figure_id: int, db: Session = Depends(get_db)):
    f = db.get(Figure, figure_id)
    if not f:
        raise HTTPException(404, "插图不存在")
    p = library.figure_image_path(f)
    if p is None:
        raise HTTPException(404, "该插图没有裁片")
    return FileResponse(p, headers=_CACHE)


@router.get("/figures", response_model=list[FigureOut], summary="插图列表（可按文献 / 图号关键词筛选）")
def list_figures(document_id: int | None = None, q: str = "", limit: int = Query(200, le=1000),
                 db: Session = Depends(get_db)):
    query = db.query(Figure)
    if document_id:
        query = query.filter(Figure.document_id == document_id)
    if q.strip():
        like = f"%{q.strip()}%"
        query = query.filter((Figure.caption.like(like)) | (Figure.label.like(like)))
    rows = query.order_by(Figure.document_id, Figure.page_id, Figure.seq).limit(limit).all()
    return [_fig_out(f, f.page.page_no) for f in rows]


# ---------------------------------------------------------------- 检索
@router.get("/search", response_model=list[SearchHit], summary="全文检索文段（三字以上 FTS5，两字以内 LIKE）")
def search(q: str = Query(..., min_length=1), document_id: int | None = None, limit: int = Query(50, le=200),
           db: Session = Depends(get_db)):
    return [SearchHit(**h) for h in library.search(db, q, document_id, limit)]
