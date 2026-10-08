"""Visitor routes for published themes and authenticated theme production.

Visitor routes read pre-rendered theme files and render local variants; none of
them calls a model. Production routes sit behind the workspace login.
"""
from __future__ import annotations
import base64
from collections import defaultdict, deque
from io import BytesIO
import secrets
import threading
import time
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.orm import Session
from ..db import get_db
from .workspace import require_workspace, same_origin
from ..services import creative_jobs as jobs, creative_render as render, creative_store as store, creative_themes as themes, seedream

router = APIRouter(prefix='/creative', tags=['电子文创'])
admin = APIRouter(prefix='/admin', dependencies=[Depends(require_workspace)])
COOKIE = 'wsc_creative'
ThemeId = Annotated[str, Path(pattern=r'^[a-z0-9-]{2,40}$')]
FileName = Annotated[str, Path(pattern=r'^[a-z0-9_-]{2,40}(\.[a-z0-9]{2,4}){1,2}$')]
_limits = defaultdict(deque)
_lock = threading.Lock()
MEDIA = {'.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.jpg': 'image/jpeg'}


def _hit(key, count, seconds):
    now = time.monotonic()
    with _lock:
        while _limits[key] and _limits[key][0] < now - seconds:
            _limits[key].popleft()
        if len(_limits[key]) >= count:
            raise HTTPException(429, '操作较频繁，请稍候')
        _limits[key].append(now)


def throttle(request, name, count, seconds, identity=''):
    """Per visitor identity, so a kiosk reset gives the next visitor a fresh allowance.

    A looser per-address ceiling still bounds a phone that keeps discarding cookies.
    """
    same_origin(request)
    host = request.client.host if request.client else ''
    _hit(('owner', identity or host, name), count, seconds)
    _hit(('host', host, name), count * 6, seconds)


def issue(request, response):
    token = secrets.token_urlsafe(32)
    response.set_cookie(COOKIE, token, httponly=True, samesite='strict', secure=request.url.scheme == 'https', max_age=30*86400)
    return jobs.digest(token)


def owner(request, response=None):
    token = request.cookies.get(COOKIE, '')
    if len(token) != 43:
        return issue(request, response) if response is not None else ''
    return jobs.digest(token)


def invoke(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


def send(path, download_name=None, cache=True):
    headers = {'Cache-Control': 'public, max-age=86400' if cache else 'no-store'}
    return FileResponse(path, media_type=MEDIA.get(path.suffix, 'application/octet-stream'), headers=headers,
                        filename=download_name, content_disposition_type='attachment' if download_name else 'inline')


def png_response(image, cache=False):
    return Response(render.png(image), media_type='image/png', headers={'Cache-Control': 'no-store' if not cache else 'private, max-age=600'})


def qr_data(url, size=360):
    """QR codes are drawn here so the kiosk needs no script library and no network."""
    return 'data:image/png;base64,' + base64.b64encode(render.png(render.qr_tile(url, size, 'cinnabar'))).decode()


# ------------------------------------------------------------------ visitors

@router.get('/venue')
def venue(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    owner(request, response)
    value = themes.public_venue()
    value['home_qr'] = qr_data(value['base_url'] + '/#section=creative')
    value['wifi_qr'] = qr_data(value['wifi']) if value['wifi'] else None
    return value


@router.get('/themes')
def theme_list(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    owner(request, response)
    return [themes.public(t) for t in themes.records() if t.get('status') == 'published']


@router.get('/links')
def theme_links(response: Response, db: Session = Depends(get_db)):
    """Read by other modules' pages; it sets no visitor cookie."""
    response.headers['Cache-Control'] = 'no-store'
    return themes.links(db)


@router.get('/themes/{identifier}')
def theme_detail(identifier: ThemeId, request: Request, response: Response, view: bool = False):
    response.headers['Cache-Control'] = 'no-store'
    owner(request, response)
    theme = invoke(themes.published, identifier)
    invoke(themes.ensure, theme)
    if view:
        themes.count('view', identifier)
    return themes.public(theme)


@router.get('/themes/{identifier}/qr')
def theme_qr(identifier: ThemeId):
    invoke(themes.published, identifier)
    return png_response(render.qr_tile(themes.theme_url(identifier), 480, 'cinnabar'), cache=True)


@router.get('/themes/{identifier}/files/{name}')
def theme_file(identifier: ThemeId, name: FileName, download: bool = False):
    theme = invoke(themes.published, identifier)
    path = invoke(themes.file_path, theme, name)
    if download:
        themes.count('download', f'{identifier}:{name.split(".")[0].split("-")[0]}')
    return send(path, f'wsc-{identifier}-{name}' if download else None)


@router.post('/preview')
def preview(body: render.Design, request: Request):
    throttle(request, 'preview', 120, 60, owner(request))
    theme = invoke(themes.published, body.theme)
    image = invoke(render.render, themes.context(theme), body.product, body.model_dump())
    image.thumbnail((900, 900), render.Image.Resampling.LANCZOS)
    out = BytesIO()
    image.save(out, 'WEBP', quality=86)
    return {'image': 'data:image/webp;base64,' + base64.b64encode(out.getvalue()).decode(), 'width': image.width, 'height': image.height}


class Export(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    design: render.Design


@router.post('/works', status_code=202)
def create_work(body: Export, request: Request, response: Response):
    identity = owner(request, response)
    throttle(request, 'work', 20, 3600, identity)
    return jobs.public(invoke(jobs.create, body.request_id, identity, body.design))


@router.get('/works')
def works(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    identity = owner(request)
    return [jobs.public(w) for w in store.records('works') if identity and w['owner'] == identity and w.get('theme')][:30]


@router.get('/works/{identifier}')
def work(identifier: UUID, request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    return jobs.public(invoke(jobs.owned, identifier, owner(request)))


@router.get('/works/{identifier}/{name}')
def work_file(identifier: UUID, name: FileName, request: Request, download: bool = False):
    item = invoke(jobs.owned, identifier, owner(request))
    return send(invoke(jobs.work_file, item, name), f'wsc-{item["theme"]}-{name}' if download else None, cache=False)


class Target(BaseModel):
    model_config = ConfigDict(extra='forbid')
    work_id: UUID | None = None
    theme: str | None = Field(default=None, pattern=r'^[a-z0-9-]{2,40}$')
    product: Literal['wallpaper', 'postcard', 'postcard_video', 'card', 'emoji', 'avatar'] | None = None

    @model_validator(mode='after')
    def one(self):
        if bool(self.work_id) == bool(self.theme):
            raise ValueError('请选择作品或主题成品')
        if self.theme and not self.product:
            raise ValueError('请选择成品')
        return self


@router.post('/handoff')
def handoff(body: Target, request: Request, response: Response):
    identity = owner(request, response)
    throttle(request, 'handoff', 40, 3600, identity)
    value = invoke(jobs.handoff, identity, body.work_id and str(body.work_id), body.theme, body.product)
    return {**value, 'qr': qr_data(value['url'])}


@router.get('/take/{token}')
def take(token: str, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    return invoke(jobs.take, token)[1]


@router.get('/take/{token}/{name}')
def take_file(token: str, name: FileName, download: bool = False):
    path = invoke(jobs.take_file, token, name)
    return send(path, f'wsc-{name}' if download else None, cache=False)


@router.post('/session/reset')
def reset(request: Request, response: Response):
    """Kiosk idle reset: the next visitor gets a new identity, so earlier works are out of reach."""
    same_origin(request)
    issue(request, response)
    return {'ok': True}


@router.get('/stamps')
def stamp_book(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    return jobs.stamps(owner(request, response))


class Stamp(BaseModel):
    model_config = ConfigDict(extra='forbid')
    hall: themes.HallId
    code: str = Field(pattern=r'^[a-f0-9]{12}$')


@router.post('/stamps')
def collect(body: Stamp, request: Request, response: Response):
    identity = owner(request, response)
    throttle(request, 'stamp', 30, 600, identity)
    return invoke(jobs.collect, identity, body.hall, body.code)


@router.get('/stamps/card')
def stamp_card(request: Request):
    return png_response(invoke(jobs.stamp_card, owner(request)), cache=True)


@router.post('/prints')
def request_print(body: Target, request: Request, response: Response):
    identity = owner(request, response)
    throttle(request, 'print', 6, 3600, identity)
    if body.product not in (None, *themes.PRINTABLE):
        raise HTTPException(400, '只有明信片和表情贴纸可以打印')
    return invoke(jobs.request_print, identity, body.work_id and str(body.work_id), body.theme, body.product or 'postcard')


# ------------------------------------------------------------------ production

@admin.get('/themes')
def admin_themes(db: Session = Depends(get_db)):
    return [themes.public(themes.refresh_evidence(db, t), True) for t in themes.records()]


@admin.post('/themes')
def create_theme(body: themes.ThemeCreate, db: Session = Depends(get_db)):
    return themes.public(invoke(themes.create, db, body), True)


@admin.get('/themes/{identifier}')
def admin_theme(identifier: ThemeId, db: Session = Depends(get_db)):
    theme = invoke(themes.get, identifier)
    return themes.public(themes.refresh_evidence(db, theme), True)


@admin.patch('/themes/{identifier}')
def update_theme(identifier: ThemeId, body: themes.ThemeUpdate, db: Session = Depends(get_db)):
    return themes.public(invoke(themes.update, db, identifier, body), True)


@admin.delete('/themes/{identifier}')
def delete_theme(identifier: ThemeId):
    invoke(themes.remove, identifier)
    return {'ok': True}


@admin.post('/themes/{identifier}/original')
def export_original(identifier: ThemeId, db: Session = Depends(get_db)):
    return themes.public(invoke(themes.set_original, db, identifier), True)


@admin.get('/themes/{identifier}/materials')
def theme_materials(identifier: ThemeId):
    invoke(themes.get, identifier)
    return [{**store.public_material(m, True), 'candidate_for': m.get('candidate_for'), 'coverage': m.get('coverage'),
             'prompt': (m.get('generation') or {}).get('prompt')} for m in themes.materials(identifier)]


class Candidates(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    role: Literal['line', 'color']
    style: Literal['paper', 'ink', 'night', 'mineral'] | None = None
    count: int = Field(default=2, ge=1, le=4)

    @model_validator(mode='after')
    def styled(self):
        if self.role == 'color' and not self.style:
            raise ValueError('请选择画风')
        return self


@admin.post('/themes/{identifier}/candidates', status_code=202)
def candidates(identifier: ThemeId, body: Candidates):
    return invoke(themes.start_candidates, body.request_id, identifier, body.role, body.style, body.count)


class Adopt(BaseModel):
    model_config = ConfigDict(extra='forbid')
    material_id: UUID
    role: Literal['line', 'color', 'video']


@admin.post('/themes/{identifier}/adopt')
def adopt(identifier: ThemeId, body: Adopt):
    _, item = invoke(themes.adopt, identifier, body.material_id, body.role)
    return store.public_material(item, True)


@admin.post('/themes/{identifier}/approve')
def approve(identifier: ThemeId, body: themes.Approval):
    return themes.public(invoke(themes.approve, identifier, body), True)


@admin.post('/themes/{identifier}/render')
def render_theme(identifier: ThemeId):
    return themes.public(invoke(themes.render_theme, identifier), True)


class Publish(BaseModel):
    published: bool


@admin.post('/themes/{identifier}/publish')
def publish_theme(identifier: ThemeId, body: Publish, db: Session = Depends(get_db)):
    return themes.public(invoke(themes.publish, identifier, body.published, db), True)


@admin.post('/themes/{identifier}/story-draft')
def story_draft(identifier: ThemeId, db: Session = Depends(get_db)):
    return invoke(themes.story_draft, db, identifier)


@admin.get('/themes/{identifier}/files/{name}')
def admin_theme_file(identifier: ThemeId, name: FileName):
    theme = invoke(themes.get, identifier)
    return send(invoke(themes.file_path, theme, name, False), cache=False)


@admin.get('/venue')
def admin_venue():
    value = themes.venue()
    value.pop('stamp_secret', None)
    return {**value, 'wifi': themes.wifi_payload(value), 'stamps': [{**h, 'url': themes.stamp_url(h['id'])} for h in themes.HALLS]}


@admin.put('/venue')
def save_venue(body: themes.Venue):
    themes.save_venue(body)
    return admin_venue()


@admin.get('/posters.pdf')
def posters():
    data = invoke(themes.posters)
    return Response(data, media_type='application/pdf', headers={'Cache-Control': 'no-store',
                    'Content-Disposition': 'attachment; filename="wsc-creative-posters.pdf"'})


@admin.get('/launcher/{kind}')
def launcher(kind: Literal['kiosk', 'screen']):
    name, data = themes.launcher(kind)
    return Response(data, media_type='application/octet-stream', headers={'Cache-Control': 'no-store',
                    'Content-Disposition': f"attachment; filename=wsc-creative-{kind}.bat; filename*=UTF-8''{quote(name)}"})


@admin.get('/stats')
def stats(days: int = 30):
    return themes.stats(max(1, min(days, 365)))


@admin.get('/prints')
def prints():
    return [jobs.public_print(p, True) for p in store.records('prints')][:60]


class PrintStatus(BaseModel):
    status: Literal['printed', 'cancelled', 'queued']


@admin.post('/prints/{identifier}')
def mark_print(identifier: UUID, body: PrintStatus):
    return jobs.public_print(invoke(jobs.mark_print, identifier, body.status), True)


@admin.get('/prints/{identifier}/image')
def print_image(identifier: UUID):
    return Response(render.png(invoke(jobs.print_image, identifier), 300), media_type='image/png', headers={'Cache-Control': 'no-store'})


@admin.get('/materials')
def admin_materials():
    return [store.public_material(m, True) for m in store.records('materials')]


@admin.get('/materials/{identifier}/{variant}')
def admin_file(identifier: UUID, variant: Literal['image', 'thumb', 'ink', 'video']):
    item = invoke(store.get, 'materials', identifier)
    path = invoke(store.material_file, item, variant)
    return FileResponse(path, media_type={'video': 'video/mp4', 'thumb': 'image/webp'}.get(variant, 'image/png'),
                        headers={'Cache-Control': 'no-store'})


class AnnotationSource(BaseModel):
    annotation_ids: list[Annotated[int, Field(strict=True, gt=0)]] = Field(min_length=1, max_length=20)


@admin.post('/annotations')
def import_annotations(body: AnnotationSource, db: Session = Depends(get_db)):
    return store.public_material(invoke(store.from_annotations, db, body.annotation_ids), True)


@admin.post('/videos/{identifier}')
def import_video(identifier: UUID):
    return store.public_material(invoke(store.from_video, identifier), True)


class MaterialUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str | None = Field(default=None, max_length=80)
    tags: list[Annotated[str, Field(max_length=30)]] | None = Field(default=None, max_length=20)


@admin.patch('/materials/{identifier}')
def update_material(identifier: UUID, body: MaterialUpdate):
    item = invoke(store.get, 'materials', identifier)
    return store.public_material(invoke(store.publish, identifier, item['published'], body.title, body.tags), True)


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


@admin.get('/image-jobs')
def image_jobs():
    return store.records('image_jobs')[:50]


router.include_router(admin)
