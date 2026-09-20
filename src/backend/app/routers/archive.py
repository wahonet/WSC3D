from __future__ import annotations
import json
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from sqlalchemy import text
from ..config import settings
from ..db import get_db
from ..models import Stone
from ..services import catalogue, model_gateway
from ..services import retrieval
import threading
from ..services.resources import within

router = APIRouter(prefix="/api/archive", tags=["统一档案"])
files = APIRouter(tags=["馆藏资源"])


def stone_for(db, sid):
    stone = db.get(Stone, sid)
    if stone is None:
        raise HTTPException(404, "文物不存在，请使用馆藏编号")
    return stone


def same_origin(request: Request):
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "请从本系统页面修改配置")


@router.get("/stones")
def stones(db: Session = Depends(get_db)):
    return [catalogue.brief(s) for s in db.query(Stone).order_by(Stone.id).all()]


@router.get("/stones/{sid}")
def detail(sid: str, db: Session = Depends(get_db)):
    return catalogue.detail(stone_for(db, sid), db)


@router.patch("/stones/{sid}")
def patch(sid: str, body: dict, request: Request, db: Session = Depends(get_db)):
    same_origin(request)
    if set(body) - {"name", "condition", "note", "intro", "size_cm", "size_source"}:
        raise HTTPException(422, "包含不支持修改的档案字段")
    if any(not isinstance(v, str) for k, v in body.items() if k != 'size_cm'):
        raise HTTPException(422, "档案内容必须是文字")
    if 'size_cm' in body and (not isinstance(body['size_cm'], list) or len(body['size_cm']) != 3 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not 0 < v < 100000 for v in body['size_cm'])):
        raise HTTPException(422, '尺寸须为三个有效的厘米数值')
    if body.get('size_source', 'measured') not in {'measured','registry','estimated',''}:
        raise HTTPException(422, '尺寸来源无效')
    stone = stone_for(db, sid)
    value = dict(stone.archive)
    value.update(body)
    meta = catalogue.metadata(stone)
    for field in ('name','condition','note','size_cm','size_source'):
        if field in body:
            meta[field] = body[field]
    if "name" in body:
        if not body["name"].strip():
            raise HTTPException(422, "名称不能为空")
        stone.name = body["name"]
        meta["name"] = body["name"]
    value["metadata"] = json.dumps(meta, ensure_ascii=False)
    stone.archive = value
    db.commit()
    return {"ok": True, "stone": catalogue.detail(stone, db)}


@router.get("/stats")
def stats(db: Session = Depends(get_db)):
    return catalogue.statistics(db)


@router.get("/books")
def books(db: Session = Depends(get_db)):
    return [catalogue.book_view(b) for b in catalogue.all_books(db)]


@router.get("/books/{bid}")
def book(bid: str, db: Session = Depends(get_db)):
    row = db.execute(text("SELECT payload FROM extension_books WHERE id=:id"), {"id": bid}).fetchone()
    if not row:
        raise HTTPException(404, "扩展文献不存在")
    return catalogue.book_view(json.loads(row[0]))


@router.get("/search")
def search(q: str = "", scope: str = "all", limit: int = 8, stone_offset: int = 0, core_offset: int = 0, extension_offset: int = 0):
    if scope not in {"all", "stone", "core", "extension"} or not 1 <= limit <= 100 or min(stone_offset, core_offset, extension_offset) < 0:
        raise HTTPException(422, "检索范围或分页参数不合法")
    if len(q) > 1000:
        raise HTTPException(422, "检索词过长")
    return retrieval.search(q.strip(), scope, limit, {"stone": stone_offset, "core": core_offset, "extension": extension_offset}) if q.strip() else {"query": "", "groups": []}


@router.post("/ask")
def ask(body: dict, request: Request):
    same_origin(request)
    question = body.get("question")
    if not isinstance(question, str) or not question.strip() or len(question) > 2000:
        raise HTTPException(422, "请输入有效问题")
    return retrieval.ask(question.strip(), body.get("include_extension") is True)


@router.get("/rag/status")
def rag_status():
    return retrieval.status()


@router.post("/rag/rebuild")
def rebuild(request: Request):
    same_origin(request)
    def run():
        retrieval.build_index()
        retrieval.build_dense()
    threading.Thread(target=run, daemon=True).start()
    return {"ok": True}


@router.post("/rescan")
def resource_check(request: Request, db: Session = Depends(get_db)):
    same_origin(request)
    from ..services import scanner
    report = scanner.scan(db, additions_only=True, publish_archive=True)
    return {"ok": True, "count": report["stones"], "report": report}


@router.post('/stones/{sid}/rescan')
def rescan_stone(sid: str, request: Request, db: Session = Depends(get_db)):
    same_origin(request)
    stone_for(db, sid)
    from ..services import scanner
    report = scanner.scan(db, stone_id=sid, additions_only=True, publish_archive=True)
    return {'ok': True, 'count': report['stones'], 'report': report}


@router.get("/llm/settings")
def llm_settings():
    return model_gateway.public_settings(local_models=True)


@router.put("/llm/settings")
def save_settings(body: dict, request: Request):
    same_origin(request)
    try:
        return model_gateway.save_settings(body)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.post("/llm/test")
def test_settings(body: dict, request: Request):
    same_origin(request)
    try:
        return model_gateway.test_connection(body)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@files.get("/files/library/{name:path}")
def library_file(name: str):
    return FileResponse(within(settings.extension_root / "library", name))


@files.get("/files/books/{bid}/{name:path}")
def book_file(bid: str, name: str):
    return FileResponse(within(settings.extension_root / "books", bid + "/" + name))


@files.get("/files/imports/{name:path}")
def import_file(name: str):
    return FileResponse(within(settings.resources_dir / "imports", name))


@files.get("/files/related/{sid}/{name:path}")
def related_file(sid: str, name: str):
    return FileResponse(within(settings.resources_dir / "related-objects", sid + "/" + name))


@files.get("/files/{sid}/{name:path}")
def stone_file(sid: str, name: str, db: Session = Depends(get_db)):
    stone = stone_for(db, sid)
    return FileResponse(within(settings.assets_root / stone.dirname, name))


@files.get("/models/{name:path}")
def scene_file(name: str):
    return FileResponse(within(settings.scenes_dir / "models", name))


@files.get("/textures/{name:path}")
def texture_file(name: str):
    return FileResponse(within(settings.scenes_dir / "textures", name))


@files.get("/api/layouts/{area}")
def layout(area: str):
    if area not in {"xcl", "rear"}:
        raise HTTPException(404)
    return json.loads(within(settings.layouts_dir, area + ".json").read_text(encoding="utf-8"))


@files.get("/data/{name:path}")
def scene_data(name: str):
    if not (name.startswith("layouts/") or name in {"location-groups.json"}):
        raise HTTPException(404)
    return FileResponse(within(settings.layouts_dir, name.removeprefix("layouts/"))) if name.startswith("layouts/") else FileResponse(settings.locations_file)
