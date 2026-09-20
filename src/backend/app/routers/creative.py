"""Public creation endpoints and authenticated curation have separate routes."""
from __future__ import annotations
import base64
from collections import defaultdict, deque
import secrets
import threading
import time
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.orm import Session
from ..db import get_db
from .workspace import require_workspace, same_origin
from ..services import creative_jobs as jobs, creative_render as render, creative_store as store, seedream

router = APIRouter(prefix='/creative', tags=['电子文创'])
admin = APIRouter(prefix='/admin', dependencies=[Depends(require_workspace)])
COOKIE = 'wsc_creative'
_limits = defaultdict(deque)
_lock = threading.Lock()


def throttle(request, name, count, seconds):
    same_origin(request)
    key = (request.client.host if request.client else '', name)
    now = time.monotonic()
    with _lock:
        while _limits[key] and _limits[key][0] < now-seconds:
            _limits[key].popleft()
        if len(_limits[key]) >= count:
            raise HTTPException(429, '操作较频繁，请稍候')
        _limits[key].append(now)


def owner(request, response=None):
    token = request.cookies.get(COOKIE, '')
    if len(token) != 43:
        if response is None:
            return ''
        token = secrets.token_urlsafe(32)
        response.set_cookie(COOKIE, token, httponly=True, samesite='strict', secure=request.url.scheme == 'https', max_age=30*86400)
    return jobs.digest(token)


def invoke(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@router.get('/catalogue')
def catalogue(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    owner(request, response)
    return {'materials': [store.public_material(m) for m in store.records('materials') if m['published']],
            'templates': render.templates(), 'palettes': render.PALETTES}


@router.get('/templates/{identifier}/cover')
def template_cover(identifier: str):
    entry = next((t for t in render.templates() if t['id'] == identifier), None)
    if not entry or not entry.get('design'):
        raise HTTPException(404, '版式封面尚未设置')
    design = render.Design.model_validate(entry['design'])
    items = invoke(render.materials, design)
    image, _ = invoke(render.composition, design, items, preview=True)
    return Response(render.png(image), media_type='image/png', headers={'Cache-Control': 'no-store'})


def material_response(identifier, variant, internal=False):
    item = invoke(store.get, 'materials', identifier)
    if not internal and not item['published']:
        raise HTTPException(404, '素材未发布')
    path = invoke(store.material_file, item, variant)
    return FileResponse(path, media_type={'video': 'video/mp4', 'thumb': 'image/webp'}.get(variant, 'image/png'),
                        headers={'Cache-Control': 'no-store'})


@router.get('/materials/{identifier}/{variant}')
def material(identifier: UUID, variant: Literal['image', 'thumb', 'ink', 'video']):
    return material_response(identifier, variant)


@router.post('/preview')
def preview(body: render.Design, request: Request):
    throttle(request, 'preview', 150, 60)
    items = invoke(render.materials, body)
    image, video = invoke(render.composition, body, items, preview=True, omit_video=True)
    bx, by, bw, bh = render.media_box(body.template)
    return {'image': 'data:image/png;base64,'+base64.b64encode(render.png(image)).decode(),
            'width': render.TEMPLATES[body.template]['width'], 'height': render.TEMPLATES[body.template]['height'],
            'artwork': {'x': bx, 'y': by, 'width': bw, 'height': bh},
            'video': {**video, 'url': f'/api/creative/materials/{video["material_id"]}/video'} if video else None}


class Export(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    design: render.Design


@router.post('/works', status_code=202)
def create(body: Export, request: Request, response: Response):
    throttle(request, 'export', 30, 3600)
    identity = owner(request, response)
    return jobs.public(invoke(jobs.create, body.request_id, identity, body.design))


@router.get('/works')
def works(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    identity = owner(request)
    return [jobs.public(w) for w in store.records('works') if w['owner'] == identity][:40]


@router.get('/works/{identifier}')
def work(identifier: UUID, request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    return jobs.public(invoke(jobs.owned, identifier, owner(request)))


class Share(BaseModel):
    enabled: bool = True


@router.post('/works/{identifier}/share')
def share(identifier: UUID, body: Share, request: Request):
    same_origin(request)
    return jobs.public(invoke(jobs.share, identifier, owner(request), body.enabled))


def work_file(item, variant):
    path = store.folder('works', item['id']) / {'image': 'image.png', 'cover': 'cover.png', 'video': 'video.mp4'}[variant]
    if item['status'] != 'succeeded' or not path.is_file():
        raise HTTPException(404, '成品尚未生成')
    return FileResponse(path, media_type='video/mp4' if variant == 'video' else 'image/png',
                        headers={'Cache-Control': 'no-store'})


@router.get('/works/{identifier}/{variant}')
def download(identifier: UUID, variant: Literal['image', 'cover', 'video'], request: Request):
    return work_file(invoke(jobs.owned, identifier, owner(request)), variant)


@router.get('/share/{token}')
def shared(token: str, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    return jobs.public(invoke(jobs.shared, token), shared_view=True)


@router.get('/share/{token}/{variant}')
def shared_file(token: str, variant: Literal['image', 'cover', 'video']):
    return work_file(invoke(jobs.shared, token), variant)


@admin.get('/materials')
def admin_materials():
    return [store.public_material(m, True) for m in store.records('materials')]


@admin.get('/materials/{identifier}/{variant}')
def admin_file(identifier: UUID, variant: Literal['image', 'thumb', 'ink', 'video']):
    return material_response(identifier, variant, True)


class AnnotationSource(BaseModel):
    annotation_ids: list[Annotated[int, Field(strict=True, gt=0)]] = Field(min_length=1, max_length=20)


@admin.post('/annotations')
def import_annotations(body: AnnotationSource, db: Session = Depends(get_db)):
    return store.public_material(invoke(store.from_annotations, db, body.annotation_ids), True)


@admin.post('/videos/{identifier}')
def import_video(identifier: UUID):
    return store.public_material(invoke(store.from_video, identifier), True)


class Publish(BaseModel):
    published: bool
    title: str | None = Field(default=None, max_length=80)
    tags: list[Annotated[str, Field(max_length=30)]] | None = Field(default=None, max_length=20)


@admin.patch('/materials/{identifier}')
def publish(identifier: UUID, body: Publish):
    return store.public_material(invoke(store.publish, identifier, **body.model_dump()), True)


@admin.get('/templates')
def admin_templates():
    return render.templates(True)


class TemplateUpdate(BaseModel):
    published: bool
    design: render.Design | None = None


@admin.patch('/templates/{identifier}')
def publish_template(identifier: Literal['postcard', 'wallpaper', 'card', 'sticker'], body: TemplateUpdate):
    try:
        old = store.get('templates', identifier)
    except FileNotFoundError:
        old = {'id': identifier}
    if body.design:
        if body.design.template != identifier:
            raise HTTPException(400, '版式与样例不一致')
        old['design'] = body.design.model_dump(mode='json')
    if old.get('design'):
        items = invoke(render.materials, render.Design.model_validate(old['design']), internal=True)
        if body.published and any(not m['published'] for m in items):
            raise HTTPException(400, '请先发布版式引用的素材')
    return store.save('templates', {**old, 'published': body.published})


@admin.get('/image-settings')
def image_settings():
    return seedream.public_settings()


class ImageSettings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    api_key: str = Field(default='', max_length=8192)
    clear_key: bool = False


@admin.put('/image-settings')
def save_image_settings(body: ImageSettings):
    return invoke(seedream.save_settings, body.api_key.strip(), body.clear_key)


class ImageRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    material_id: UUID | None = None
    source_id: str | None = Field(default=None, pattern='^[a-f0-9]{64}$')
    style: Literal['paper', 'ink', 'night'] = 'paper'
    prompt: str | None = Field(default=None, min_length=10, max_length=5000)

    @model_validator(mode='after')
    def one_source(self):
        if self.material_id and self.source_id:
            raise ValueError('请选择一种参考来源')
        return self


class ImagePrepare(AnnotationSource):
    model_config = ConfigDict(extra='forbid')
    style: Literal['paper', 'ink', 'night'] = 'paper'


@admin.post('/image-prepare')
def prepare_image(body: ImagePrepare, db: Session = Depends(get_db)):
    return seedream.public_source(invoke(seedream.prepare, db, body.annotation_ids, body.style))


@admin.get('/image-sources/{source_id}/image')
def image_source(source_id: str):
    invoke(seedream.load_source, source_id)
    return FileResponse(seedream.source_dir(source_id) / 'base.jpg', media_type='image/jpeg',
                        headers={'Cache-Control': 'private, max-age=3600'})


@admin.post('/image-jobs', status_code=202)
def generate_image(body: ImageRequest):
    return invoke(seedream.create, body.request_id, str(body.material_id) if body.material_id else None,
                  body.style, body.prompt, body.source_id)


@admin.get('/image-jobs')
def image_jobs():
    return store.records('image_jobs')[:50]


router.include_router(admin)
