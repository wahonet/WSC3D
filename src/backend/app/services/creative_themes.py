"""Themes: one Han story with its evidence, curated art and pre-rendered products.

Staff move a theme through eight steps in the workbench. Visitors only read the
files rendered for a published theme, so the visitor side never calls a model
and never leaves the venue network.
"""
from __future__ import annotations
from datetime import date, datetime, timedelta, timezone
import hashlib
import hmac
from io import BytesIO
import json
import re
import secrets
import shutil
import socket
import threading
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import UUID

from PIL import Image, ImageDraw
from pydantic import BaseModel, ConfigDict, Field, model_validator
from ..config import settings
from ..models import Annotation, Stone
from . import creative_lineart as lineart, creative_render as render, creative_store as store, model_gateway, seedream

HALLS = (
    {'id': 'xuting', 'name': '序厅', 'chapter': '开篇 · 痕定汉影', 'seal': '序厅'},
    {'id': 'chuying', 'name': '初影', 'chapter': '第一章 · 初影（根）', 'seal': '初影'},
    {'id': 'zhuying', 'name': '铸影', 'chapter': '第二章 · 铸影（魂）', 'seal': '铸影'},
    {'id': 'liying', 'name': '立影', 'chapter': '第三章 · 立影（骨）', 'seal': '立影'},
    {'id': 'chuanying', 'name': '传影', 'chapter': '第四章 · 传影（脉）', 'seal': '传影'},
    {'id': 'weiting', 'name': '尾厅', 'chapter': '尾厅 · 厅中厅', 'seal': '尾厅'},
    {'id': 'zhuanti', 'name': '武氏祠专题展厅', 'chapter': '专题展厅', 'seal': '专题'},
)
HALL_IDS = tuple(h['id'] for h in HALLS)
HallId = Literal['xuting', 'chuying', 'zhuying', 'liying', 'chuanying', 'weiting', 'zhuanti']
RENDER_VERSION = 7  # Keep rubbing incisions visible on small stickers.
REVIEWED = {'reviewed', 'approved'}
CHECKLIST = {
    'count': '人物、动物数量与原石一致',
    'objects': '器物齐全，没有改成别的器物',
    'orientation': '朝向与姿态一致',
    'inscription': '榜题没有臆补文字',
    'nothing_added': '没有新增人物、器物或背景',
}
STORY_LENGTH = (100, 160)
PRODUCT_ORDER = ('wallpaper', 'postcard', 'postcard_video', 'card', 'emoji', 'avatar')
PRINTABLE = {'postcard': 'print_postcard.png', 'emoji': 'print_stickers.png'}
VENUE_DEFAULTS = {'base_url': '', 'idle_seconds': 90, 'wifi_ssid': '', 'wifi_password': '', 'wifi_security': 'WPA',
                  'print_enabled': False}
CANDIDATE_DAYS = 30
_lock = threading.RLock()
_stats_lock = threading.Lock()
_render_locks: dict[str, threading.Lock] = {}
_threads = {}


# ------------------------------------------------------------------ validation

def _plain(*values):
    for value in values:
        if value and any(ord(c) < 32 and c != '\n' for c in value):
            raise ValueError('文字中不能包含控制字符')


Fraction = Annotated[float, Field(ge=0, le=1)]


def _box(value):
    if value is not None and not (value[0] < value[2] and value[1] < value[3]):
        raise ValueError('裁切框无效')
    return value


class StoryRef(BaseModel):
    model_config = ConfigDict(extra='forbid')
    document_id: int = Field(gt=0)
    document_title: str = Field(min_length=1, max_length=120)
    page_no: int = Field(ge=1)
    text: str = Field(default='', max_length=400)


class Sticker(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    phrase: str = Field(min_length=1, max_length=6)
    crop: list[Fraction] = Field(min_length=4, max_length=4)
    accent: bool = False

    @model_validator(mode='after')
    def valid(self):
        _plain(self.phrase)
        _box(self.crop)
        return self


class ThemeUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    title: str | None = Field(default=None, min_length=2, max_length=18)
    hook: str | None = Field(default=None, max_length=14)
    story: str | None = Field(default=None, max_length=400)
    subject: str | None = Field(default=None, max_length=600)
    story_refs: list[StoryRef] | None = Field(default=None, max_length=8)
    annotation_ids: list[Annotated[int, Field(strict=True, gt=0)]] | None = Field(default=None, min_length=1, max_length=20)
    source_rotation: int | None = Field(default=None, ge=0, le=3, strict=True)
    hall: HallId | None = None
    order: int | None = Field(default=None, ge=0, le=999)
    greetings: list[Annotated[str, Field(min_length=1, max_length=48)]] | None = Field(default=None, max_length=6)
    emoji: list[Sticker] | None = Field(default=None, max_length=6)
    avatar_crop: list[Fraction] | None = Field(default=None, min_length=4, max_length=4)
    palette: Literal['cinnabar', 'jade', 'midnight', 'white'] | None = None

    @model_validator(mode='after')
    def valid(self):
        _plain(self.title, self.hook, self.story, self.subject, *(self.greetings or []))
        _box(self.avatar_crop)
        return self


class ThemeCreate(ThemeUpdate):
    id: str = Field(pattern=r'^[a-z0-9-]{2,40}$')
    title: str = Field(min_length=2, max_length=18)
    annotation_ids: list[Annotated[int, Field(strict=True, gt=0)]] = Field(min_length=1, max_length=20)


class Approval(BaseModel):
    model_config = ConfigDict(extra='forbid')
    role: Literal['line', 'rubbing', 'color', 'video']
    material_id: UUID | None = None
    selected: bool = True
    checklist: dict[Literal['count', 'objects', 'orientation', 'inscription', 'nothing_added'], bool] = {}
    reviewer: str = Field(default='', max_length=40)
    note: str = Field(default='', max_length=300)


class Venue(BaseModel):
    model_config = ConfigDict(extra='forbid')
    base_url: str = Field(default='', max_length=120, pattern=r'^(|https?://[A-Za-z0-9.\-\[\]:]+)$')
    idle_seconds: int = Field(default=90, ge=30, le=600)
    wifi_ssid: str = Field(default='', max_length=32)
    wifi_password: str = Field(default='', max_length=63)
    wifi_security: Literal['WPA', 'WEP', 'nopass'] = 'WPA'
    print_enabled: bool = False

    @model_validator(mode='after')
    def valid(self):
        _plain(self.wifi_ssid, self.wifi_password)
        return self


# ------------------------------------------------------------------ venue

def lan_address():
    """The address phones on the venue network use; connecting UDP sends no packet."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(('10.255.255.255', 1))
            return probe.getsockname()[0]
    except OSError:
        return '127.0.0.1'


def venue():
    value = {**VENUE_DEFAULTS, **{k: v for k, v in (seedream.config().get('venue') or {}).items() if k in VENUE_DEFAULTS}}
    value['auto_base_url'] = not value['base_url']
    value['base_url'] = (value['base_url'] or f'http://{lan_address()}:{settings.port}').rstrip('/')
    return value


def save_venue(body: Venue):
    def change(config):
        current = config.get('venue') or {}
        config['venue'] = {**current, **body.model_dump()}
    seedream.update_config(change)
    return venue()


def wifi_payload(value):
    if not value.get('wifi_ssid'):
        return None
    escape = lambda text: re.sub(r'([\\;,:"])', r'\\\1', text)
    security = value.get('wifi_security', 'WPA')
    return f"WIFI:T:{security};S:{escape(value['wifi_ssid'])};" + (f"P:{escape(value['wifi_password'])};" if security != 'nopass' else '') + ';'


def public_venue():
    value = venue()
    return {'idle_seconds': value['idle_seconds'], 'print_enabled': value['print_enabled'], 'wifi_ssid': value['wifi_ssid'],
            'wifi': wifi_payload(value), 'base_url': value['base_url'], 'halls': list(HALLS),
            'palettes': {k: {key: p[key] for key in ('title', 'bg', 'ink', 'accent')} for k, p in render.PALETTES.items()},
            'products': {k: {key: p[key] for key in ('title', 'use', 'width', 'height')} for k, p in render.PRODUCTS.items()}}


def stamp_secret():
    secret = (seedream.config().get('venue') or {}).get('stamp_secret')
    if secret:
        return secret
    def change(config):
        config.setdefault('venue', {}).setdefault('stamp_secret', secrets.token_hex(24))
    return seedream.update_config(change)['venue']['stamp_secret']


def stamp_code(hall):
    return hmac.new(stamp_secret().encode(), hall.encode(), hashlib.sha256).hexdigest()[:12]


def stamp_url(hall):
    return venue()['base_url'] + f'/#section=creative&stamp={hall}&code={stamp_code(hall)}'


def theme_url(identifier):
    return venue()['base_url'] + '/#section=creative&theme=' + identifier


def archive_url(stone_id):
    return venue()['base_url'] + '/#section=archive&stone=' + quote(stone_id)


# ------------------------------------------------------------------ records

def now():
    return store.now()


def get(identifier):
    if not re.fullmatch(r'[a-z0-9-]{2,40}', str(identifier)):
        raise FileNotFoundError('主题不存在')
    try:
        return store.get('themes', identifier)
    except FileNotFoundError:
        raise FileNotFoundError('主题不存在') from None


def records():
    return sorted(store.records('themes'), key=lambda t: (t.get('order', 100), t['created_at']))


def published(identifier):
    theme = get(identifier)
    if theme.get('status') != 'published':
        raise FileNotFoundError('主题尚未上架')
    return theme


def materials(identifier):
    return [m for m in store.records('materials') if m.get('theme') == identifier]


def material(identifier):
    return store.get('materials', identifier) if identifier else None


def evidence(db, ids):
    nodes = db.query(Annotation).filter(Annotation.id.in_(ids)).order_by(Annotation.id).all()
    if len(nodes) != len(set(ids)):
        raise ValueError('所选标注不存在')
    if len({n.stone_id for n in nodes}) != 1:
        raise ValueError('一个主题的标注须来自同一块原石')
    stone = db.get(Stone, nodes[0].stone_id)
    return stone, [{'id': n.id, 'label': n.label, 'status': n.review_status} for n in nodes]


def _apply(theme, body, db):
    values = body.model_dump(exclude_unset=True, exclude={'id'})
    if 'annotation_ids' in values:
        stone, theme['annotations'] = evidence(db, values['annotation_ids'])
        theme.update(stone_id=stone.id, stone_name=stone.name)
    for key, value in values.items():
        if key in ('title', 'hook', 'story', 'subject') and value is not None:
            value = value.strip()
        if value is not None or key in ('hall', 'avatar_crop'):
            theme[key] = value
    theme['updated_at'] = now()
    return theme


def create(db, body: ThemeCreate):
    with _lock:
        try:
            get(body.id)
            raise ValueError('主题编号已存在')
        except FileNotFoundError:
            pass
        theme = {'id': body.id, 'title': body.title, 'hook': '', 'story': '', 'subject': '', 'story_refs': [],
                 'annotation_ids': [], 'annotations': [], 'stone_id': '', 'stone_name': '', 'hall': None, 'order': 100,
                 'greetings': [], 'emoji': [], 'avatar_crop': None, 'palette': 'cinnabar', 'line_kind': 'line',
                 'assets': {'original': None, 'line': None, 'colors': [], 'video': None}, 'approvals': {},
                 'status': 'draft', 'created_at': now()}
        return store.save('themes', _apply(theme, body, db))


def update(db, identifier, body: ThemeUpdate):
    with _lock:
        theme = _apply(get(identifier), body, db)
        store.save('themes', theme)
    refresh_later(theme)
    return theme


def refresh_evidence(db, theme):
    """Annotation review status is read live; the stored copy only serves the visitor side."""
    try:
        _, theme['annotations'] = evidence(db, theme['annotation_ids'])
    except ValueError:
        theme['annotations'] = [a for a in theme.get('annotations', []) if db.get(Annotation, a['id'])]
    return theme


def remove(identifier):
    with _lock:
        theme = get(identifier)
        if theme.get('status') == 'published':
            raise ValueError('请先下架主题')
        for item in materials(identifier):
            if item.get('role') == 'candidate' and not item.get('adopted'):
                store.remove_material(item['id'])
            else:
                item.pop('theme', None)
                item.pop('role', None)
                store.save('materials', item)
        shutil.rmtree(store.root() / 'themes' / identifier, ignore_errors=True)
        store.delete('themes', identifier)


def touch(theme):
    theme['updated_at'] = now()
    store.save('themes', theme)
    refresh_later(theme)
    return theme


def source(theme):
    return {'stone_id': theme['stone_id'], 'stone_name': theme['stone_name'], 'annotation_ids': theme['annotation_ids'],
            'references': [{k: r.get(k) for k in ('document_id', 'document_title', 'page_no', 'text')} for r in theme.get('story_refs', [])]}


def set_original(db, identifier):
    with _lock:
        theme = get(identifier)
        item = store.from_annotations(db, theme['annotation_ids'], theme.get('source_rotation', 0))
        item.update(theme=identifier, role='original')
        store.save('materials', item)
        theme['assets']['original'] = item['id']
        return touch(theme)


def adopt(identifier, material_id, role):
    """Put an existing library item into this theme's candidate box; adopted items are never auto-deleted."""
    with _lock:
        theme = get(identifier)
        item = store.get('materials', str(material_id))
        if item.get('theme') not in (None, identifier):
            raise ValueError('素材已属于另一个主题')
        if role == 'line' and not (store.folder('materials', item['id']) / 'ink.png').is_file():
            raise ValueError('线描候选须有透明线稿')
        if role == 'video' and item['kind'] != 'video':
            raise ValueError('请选择视频素材')
        item.update(theme=identifier, candidate_for=role, adopted=True, candidate_at=now())
        item.setdefault('role', 'candidate')
        if item.get('role') not in ('line', 'color', 'video', 'original'):
            item['role'] = 'candidate'
        store.save('materials', item)
        return theme, item


# ------------------------------------------------------------------ candidates

def add_candidate(theme, role, image, *, prompt, size, usage=None, style=None, cleaned=None, limit=3000):
    if role == 'line':
        white, stencil = cleaned or lineart.clean(image)
        item = store.add_image(white, f"{theme['title']} · 线描候选", origin='seedream', source=source(theme),
                               tags=[theme['title'], '线描'], stencil=stencil, limit=limit)
        item['coverage'] = round(lineart.coverage(stencil), 4)
    else:
        item = store.add_image(image, f"{theme['title']} · {seedream.STYLES[style][0]}", origin='seedream',
                               source=source(theme), tags=[theme['title'], '艺术演绎'])
    item.update(theme=theme['id'], role='candidate', candidate_for=role, candidate_at=now(),
                generation={'model': seedream.MODEL, 'prompt': prompt, 'size': size, 'style': style or 'line', 'usage': usage or {}})
    return store.save('materials', item)


def candidate_request(theme, role, style):
    if role == 'line':
        original = material(theme['assets'].get('original'))
        if not original:
            raise ValueError('请先导出原图')
        with Image.open(store.material_file(original)) as image:
            reference, size = lineart.reference(image)
        subject = theme.get('subject') or theme['title']
        return reference, lineart.size_for(*size), lineart.LINE_PROMPT.format(subject=subject)
    line = material(theme['assets'].get('line'))
    if not line:
        raise ValueError('请先选定线描')
    if style not in seedream.STYLES:
        raise ValueError('画风无效')
    with Image.open(store.material_file(line)) as image:
        reference, size = lineart.reference(image, pad=.06)
    return reference, lineart.size_for(*size), lineart.COLOR_PROMPT.format(subject=theme.get('subject') or theme['title'],
                                                                           style=seedream.STYLES[style][1])


def start_candidates(identifier, theme_id, role, style=None, count=2):
    """One paid request per image, sequentially; an uncertain submission stops the batch."""
    identifier = str(UUID(str(identifier)))
    theme = get(theme_id)
    reference, size, prompt = candidate_request(theme, role, style)
    fingerprint = hashlib.sha256(json.dumps([theme_id, role, style, count, prompt, hashlib.sha256(reference).hexdigest()]).encode()).hexdigest()
    with seedream._lock:
        try:
            old = store.get('image_jobs', identifier)
        except FileNotFoundError:
            old = None
        if old:
            if old.get('fingerprint') != fingerprint:
                raise ValueError('任务编号已用于另一项生图请求')
            return old
        if not seedream.public_settings()['has_key']:
            raise ValueError('请先配置 Seedream API Key')
        if any(j['status'] == 'running' for j in store.records('image_jobs')):
            raise ValueError('请等待当前生图完成')
        record = {'id': identifier, 'kind': 'theme_batch', 'status': 'running', 'theme': theme_id, 'role': role,
                  'style': style, 'count': count, 'done': 0, 'results': [], 'prompt': prompt, 'size': size,
                  'model': seedream.MODEL, 'fingerprint': fingerprint, 'created_at': now()}
        store.save('image_jobs', record)
        worker = threading.Thread(target=_batch, args=(record, reference), daemon=True)
        _threads[identifier] = worker
        worker.start()
        return record


def _batch(record, reference):
    try:
        for _ in range(record['count']):
            image, usage = seedream.generate(record['prompt'], reference, record['size'])
            item = add_candidate(get(record['theme']), record['role'], image, prompt=record['prompt'],
                                 size=record['size'], usage=usage, style=record['style'])
            record['results'].append(item['id'])
            record['done'] += 1
            store.save('image_jobs', record)
        record['status'] = 'succeeded'
    except seedream.SubmissionUncertain as exc:
        record.update(status='submission_uncertain', error=str(exc))
    except Exception as exc:
        record.update(status='failed', error=str(exc)[:400])
    finally:
        store.save('image_jobs', record)
        with seedream._lock:
            _threads.pop(record['id'], None)


def approve(identifier, body: Approval):
    with _lock:
        theme = get(identifier)
        assets, approvals = theme['assets'], theme.setdefault('approvals', {})
        stamp = {'reviewer': body.reviewer.strip(), 'at': now(), 'note': body.note.strip()}
        if body.role in ('line', 'rubbing', 'color') and not stamp['reviewer']:
            raise ValueError('请填写核对人')
        item = store.get('materials', str(body.material_id)) if body.material_id else None
        if item and item.get('theme') != identifier:
            raise ValueError('素材不属于这个主题')

        def release(material_id):
            if material_id and material_id != (item or {}).get('id'):
                try:
                    old = store.get('materials', material_id)
                except FileNotFoundError:
                    return
                if old.get('role') in ('line', 'color'):
                    store.save('materials', {**old, 'role': 'candidate', 'candidate_at': now()})

        if body.role == 'line':
            if not item or item.get('candidate_for') != 'line' or not (store.folder('materials', item['id']) / 'ink.png').is_file():
                raise ValueError('请选择一张线描候选')
            missing = [CHECKLIST[k] for k in CHECKLIST if not body.checklist.get(k)]
            if missing:
                raise ValueError('核对未全部通过：' + '、'.join(missing))
            if assets.get('line') != assets.get('original'):
                release(assets.get('line'))
            review = {'status': 'approved', **stamp, 'checklist': {k: True for k in CHECKLIST}}
            store.save('materials', {**item, 'role': 'line', 'review': review})
            assets['line'], theme['line_kind'] = item['id'], 'line'
            approvals['line'] = {**review, 'material_id': item['id']}
        elif body.role == 'rubbing':
            if not assets.get('original'):
                raise ValueError('请先导出原图')
            if assets.get('line') != assets['original']:
                release(assets.get('line'))
            assets['line'], theme['line_kind'] = assets['original'], 'rubbing'
            approvals['line'] = {'status': 'fallback', **stamp, 'material_id': assets['original']}
        elif body.role == 'color':
            if not item or item.get('candidate_for') != 'color' or item['kind'] != 'image':
                raise ValueError('请选择一张演绎候选')
            colors = [c for c in assets.get('colors', []) if c != item['id']]
            if body.selected:
                if len(colors) >= 2:
                    raise ValueError('每个主题最多选定两张演绎图')
                colors.append(item['id'])
                store.save('materials', {**item, 'role': 'color', 'review': {'status': 'approved', **stamp}})
            else:
                store.save('materials', {**item, 'role': 'candidate', 'candidate_at': now()})
            assets['colors'] = colors
            approvals['colors'] = {**stamp, 'count': len(colors)}
        else:
            if item and item['kind'] != 'video':
                raise ValueError('请选择视频素材')
            if item:
                store.save('materials', {**item, 'role': 'video'})
            assets['video'] = item['id'] if item else None
        return touch(theme)


# ------------------------------------------------------------------ steps

def story_length(text):
    return len(re.sub(r'\s', '', text or ''))


def steps(theme):
    assets, approvals = theme['assets'], theme.get('approvals', {})
    notes = theme.get('annotations', [])
    reviewed = sum(1 for n in notes if n['status'] in REVIEWED)
    line = approvals.get('line') or {}
    length, hook = story_length(theme.get('story')), theme.get('hook') or ''
    rendered = manifest(theme).get('key') == cache_key(theme)
    colors = len(assets.get('colors') or [])
    result = [
        ('project', '立项', bool(theme['title'] and reviewed), f'{reviewed}/{len(notes)} 条标注已审核'),
        ('original', '原图', bool(assets.get('original')), '已导出标注局部图' if assets.get('original') else '尚未导出'),
        ('line', '线描', bool(assets.get('line')) and line.get('status') in ('approved', 'fallback'),
         '暂用拓片底稿（待线描）' if line.get('status') == 'fallback' else f"{line['reviewer']} 核对通过" if line else '尚未选定'),
        ('color', '演绎', colors >= 1, f'已选定 {colors} 张' if colors else '尚未选定'),
        ('video', '动态', True, '已关联短片' if assets.get('video') else '可选，未关联'),
        ('story', '文案', STORY_LENGTH[0] <= length <= STORY_LENGTH[1] and 0 < len(hook) <= 14 and bool(theme.get('story_refs')),
         f"{length} 字 · 引子 {len(hook)} 字 · 出处 {len(theme.get('story_refs') or [])} 条"),
        ('products', '成品', rendered, '成品已是最新' if rendered else '需要渲染'),
        ('publish', '上架', theme.get('status') == 'published' and bool(theme.get('hall')),
         '已上架' if theme.get('status') == 'published' else '未上架'),
    ]
    return [{'key': k, 'title': t, 'done': d, 'detail': x, 'optional': k == 'video'} for k, t, d, x in result]


# ------------------------------------------------------------------ rendering

def product_dir(identifier):
    if not re.fullmatch(r'[a-z0-9-]{2,40}', identifier):
        raise ValueError('主题编号无效')
    return store.root() / 'themes' / identifier / 'products'


def cache_key(theme):
    return hashlib.sha256(json.dumps([RENDER_VERSION, theme['updated_at'], venue()['base_url']]).encode()).hexdigest()[:20]


def manifest(theme):
    try:
        return json.loads((product_dir(theme['id']) / 'manifest.json').read_text('utf-8'))
    except (OSError, ValueError):
        return {}


def context(theme):
    assets = theme['assets']
    line = material(assets.get('line'))
    colors = [store.material_file(material(i)) for i in assets.get('colors') or []]
    ctx = {'title': theme['title'], 'hook': theme.get('hook', ''), 'greetings': theme.get('greetings') or [],
           'stone_id': theme['stone_id'], 'stone_name': theme['stone_name'], 'archive_url': archive_url(theme['stone_id']),
           'palette': theme.get('palette', 'cinnabar'), 'halls': list(HALLS), 'avatar_crop': theme.get('avatar_crop'),
           'line_kind': theme.get('line_kind', 'line'), 'colors': colors}
    if line:
        ctx['line'] = store.material_file(line, 'ink')
    video = material(assets.get('video'))
    if video:
        ctx['video'], ctx['cover'] = store.material_file(video, 'video'), store.material_file(video)
    return ctx


def _lock_for(identifier):
    with _lock:
        return _render_locks.setdefault(identifier, threading.Lock())


def _webp(image, path, edge, background=None):
    image = image.convert('RGBA')
    image.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    if background:
        flat = Image.new('RGBA', image.size, background)
        flat.alpha_composite(image)
        image = flat
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    image.save(temp, 'WEBP', quality=88, method=5)
    temp.replace(path)
    return image.size


def render_all(theme):
    """Every visitor file for a theme, written in place and listed in a manifest last."""
    with _lock_for(theme['id']):
        key, ctx, folder = cache_key(theme), context(theme), product_dir(theme['id'])
        if not ctx.get('line') and not ctx['colors']:
            raise ValueError('主题尚未选定线描或演绎图')
        folder.mkdir(parents=True, exist_ok=True)
        files = {}

        def image_file(name, image, dpi=None, thumb=True):
            render.save(image, folder / name, dpi)
            files[name] = {'width': image.width, 'height': image.height}
            if thumb:
                files[name + '.webp'] = dict(zip(('width', 'height'), _webp(image, folder / (name + '.webp'), 720)))

        original = material(theme['assets'].get('original'))
        if original:
            with Image.open(store.material_file(original)) as image:
                files['original.webp'] = dict(zip(('width', 'height'), _webp(image, folder / 'original.webp', 1800, '#ffffff')))
        if ctx.get('line'):
            line = render.tint(render.trim(render.load(ctx['line'])), render.PALETTES['cinnabar']['ink'])
            line.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
            image_file('line.png', line, thumb=False)
        for i, path in enumerate(ctx['colors']):
            with Image.open(path) as image:
                files[f'color-{i}.webp'] = dict(zip(('width', 'height'), _webp(image, folder / f'color-{i}.webp', 1800)))
        cover = folder / ('color-0.webp' if ctx['colors'] else 'line.png')
        with Image.open(cover) as image:
            files['cover.webp'] = dict(zip(('width', 'height'), _webp(image, folder / 'cover.webp', 720,
                                                                     None if ctx['colors'] else render.PALETTES['cinnabar']['bg'])))
        if ctx.get('video'):
            shutil.copy2(ctx['video'], folder / 'clip.mp4')
            files['clip.mp4'] = {}
        for product in ('wallpaper', 'postcard', 'card', 'avatar'):
            image_file(product + '.png', render.render(ctx, product))
        image_file('print_postcard.png', render.render(ctx, 'print_postcard'), dpi=300, thumb=False)
        if ctx.get('line') and theme.get('emoji'):
            stickers = [{**spec, 'line': ctx['line'], 'palette': ctx['palette']} for spec in theme['emoji']]
            for i, spec in enumerate(stickers):
                image_file(f'emoji-{i+1}.png', render.emoji(ctx, spec), thumb=False)
            image_file('print_stickers.png', render.sticker_sheet(ctx, stickers), dpi=300, thumb=False)
        if ctx.get('video'):
            work = folder / 'motion'
            still = render.video(ctx, work)
            (work / 'video.mp4').replace(folder / 'postcard_video.mp4')
            shutil.rmtree(work, ignore_errors=True)
            files['postcard_video.mp4'] = {'width': still.width, 'height': still.height}
            image_file('postcard_video.png', still)
        for path in folder.iterdir():
            if path.is_file() and path.name not in files and path.name != 'manifest.json':
                path.unlink(missing_ok=True)
        value = {'key': key, 'rendered_at': now(), 'card_date': date.today().isoformat(), 'files': files}
        temp = folder / 'manifest.tmp'
        temp.write_text(json.dumps(value, ensure_ascii=False), 'utf-8')
        temp.replace(folder / 'manifest.json')
        return value


def ensure(theme):
    """Products follow the theme and the venue address; the dated card follows the calendar."""
    value = manifest(theme)
    if value.get('key') != cache_key(theme):
        return render_all(theme)
    if value.get('card_date') != date.today().isoformat():
        with _lock_for(theme['id']):
            value = manifest(theme)
            if value.get('card_date') != date.today().isoformat():
                folder = product_dir(theme['id'])
                image = render.render(context(theme), 'card')
                render.save(image, folder / 'card.png')
                _webp(image, folder / 'card.png.webp', 720)
                value['card_date'] = date.today().isoformat()
                temp = folder / 'manifest.tmp'
                temp.write_text(json.dumps(value, ensure_ascii=False), 'utf-8')
                temp.replace(folder / 'manifest.json')
    return value


def refresh_later(theme):
    if theme.get('status') == 'published':
        threading.Thread(target=lambda: _quiet(ensure, get(theme['id'])), daemon=True).start()


def _quiet(fn, *args):
    try:
        fn(*args)
    except Exception:
        pass


def file_path(theme, name, refresh=True):
    files = (ensure(theme) if refresh else manifest(theme)).get('files', {})
    if name not in files:
        raise FileNotFoundError('文件不存在')
    return product_dir(theme['id']) / name


def product_files(theme, product, prefix, value=None):
    value = value or manifest(theme)
    files, version = value.get('files', {}), value.get('key', '')[:10]
    names = {'emoji': sorted((n for n in files if re.fullmatch(r'emoji-\d\.png', n)), key=lambda n: int(n[6:-4])),
             'postcard_video': ['postcard_video.mp4', 'postcard_video.png']}.get(product, [product + '.png'])
    names = [n for n in names if n in files]
    if not names or product not in render.PRODUCTS:
        raise FileNotFoundError('成品不存在')
    suffix = '?v=' + version + (value.get('card_date', '') if product == 'card' else '')
    return [{'name': n, 'url': prefix + n + suffix, 'kind': 'video' if n.endswith('.mp4') else 'image',
             'thumb_url': prefix + n + '.webp' + suffix if n + '.webp' in files else prefix + n + suffix,
             **{k: files[n].get(k) for k in ('width', 'height')}} for n in names]


def public(theme, internal=False):
    value = manifest(theme)
    files, version = value.get('files', {}), value.get('key', '')[:10]
    prefix = f"/api/creative/{'admin/' if internal else ''}themes/{theme['id']}/files/"
    url = lambda name: prefix + name + '?v=' + version if name in files else None
    hall = next((h for h in HALLS if h['id'] == theme.get('hall')), None)
    products = []
    for product in PRODUCT_ORDER:
        try:
            entries = product_files(theme, product, prefix, value)
        except FileNotFoundError:
            continue
        spec = render.PRODUCTS[product]
        products.append({'id': product, 'title': spec['title'], 'use': spec['use'], 'files': entries,
                         'thumb_url': entries[-1 if product == 'postcard_video' else 0]['thumb_url'],
                         'customizable': product in render.CUSTOM, 'printable': product in PRINTABLE})
    result = {
        'id': theme['id'], 'title': theme['title'], 'hook': theme.get('hook', ''), 'story': theme.get('story', ''),
        'story_refs': theme.get('story_refs', []), 'stone_id': theme['stone_id'], 'stone_name': theme['stone_name'],
        'hall': hall, 'order': theme.get('order', 100), 'greetings': theme.get('greetings', []),
        'palette': theme.get('palette', 'cinnabar'), 'line_kind': theme.get('line_kind', 'line'),
        'color_count': len(theme['assets'].get('colors') or []), 'has_video': bool(theme['assets'].get('video')),
        'art': {'original': url('original.webp'), 'line': url('line.png'),
                'colors': [url(f'color-{i}.webp') for i in range(len(theme['assets'].get('colors') or [])) if url(f'color-{i}.webp')],
                'clip': url('clip.mp4')},
        'cover_url': url('cover.webp'), 'products': products, 'published_at': theme.get('published_at'),
    }
    if internal:
        result.update({k: theme.get(k) for k in ('status', 'subject', 'annotation_ids', 'source_rotation', 'annotations', 'emoji', 'avatar_crop',
                                                 'assets', 'approvals', 'created_at', 'updated_at')})
        result.update(steps=steps(theme), rendered_at=value.get('rendered_at'), theme_url=theme_url(theme['id']))
    return result


def links(db):
    """Published themes in brief, for entries from the archive, graph, Q&A and hall guide.

    Graph story nodes come only from explicit annotation links, never from title guesses.
    """
    from sqlalchemy import inspect
    from ..knowledge_graph_models import AnnotationKnowledgeLink, KnowledgeGraphBinding
    items = [t for t in records() if t.get('status') == 'published']
    ids = {a for t in items for a in t.get('annotation_ids') or []}
    nodes = {}
    tables = inspect(db.connection())
    for model in (AnnotationKnowledgeLink, KnowledgeGraphBinding):
        if ids and tables.has_table(model.__tablename__):
            for annotation_id, node_id, story_id in db.query(model.annotation_id, model.node_id, model.story_id).filter(model.annotation_id.in_(ids)):
                nodes.setdefault(annotation_id, set()).update(n for n in (node_id, story_id) if n)
    result = []
    for theme in items:
        value = manifest(theme)
        cover = f"/api/creative/themes/{theme['id']}/files/cover.webp?v={value.get('key', '')[:10]}" if 'cover.webp' in value.get('files', {}) else None
        result.append({'id': theme['id'], 'title': theme['title'], 'hook': theme.get('hook', ''), 'stone_id': theme['stone_id'],
                       'hall': theme.get('hall'), 'cover_url': cover,
                       'nodes': sorted({n for a in theme.get('annotation_ids') or [] for n in nodes.get(a, ())})})
    return result


def render_theme(identifier):
    theme = get(identifier)
    render_all(theme)
    return theme


def publish(identifier, value, db=None):
    with _lock:
        theme = get(identifier)
        if value:
            if db is not None:
                # Annotations reviewed after the theme was set up count without another edit.
                refresh_evidence(db, theme)
            pending = [s['title'] for s in steps(theme)[:6] if not s['done']]
            if pending:
                raise ValueError('以下步骤尚未完成：' + '、'.join(pending))
            if not theme.get('hall'):
                raise ValueError('请先指定所属展厅')
            ensure(theme)
            theme.update(status='published', published_at=theme.get('published_at') or now())
        else:
            theme['status'] = 'draft'
        return store.save('themes', theme)


# ------------------------------------------------------------------ story draft

def story_draft(db, identifier):
    theme = get(identifier)
    nodes = db.query(Annotation).filter(Annotation.id.in_(theme['annotation_ids'])).all()
    evidence_text = []
    for node in nodes:
        semantics = node.semantics or {}
        parts = [semantics.get('iconographic'), semantics.get('pre_iconographic'), node.desc_text]
        evidence_text.append(f"标注「{node.label}」：" + '；'.join(p for p in parts if p))
    for ref in theme.get('story_refs', []):
        evidence_text.append(f"《{ref['document_title']}》第 {ref['page_no']} 页：{ref.get('text', '')}")
    system = ('你是博物馆展陈文案编辑，为汉画像石的现场观众写故事。只使用给出的标注和文献中能支持的内容，'
              '不编造人名、年代和情节。语气平实亲切，避免空泛的赞美。'
              f'故事 {STORY_LENGTH[0]}–{STORY_LENGTH[1]} 个汉字，另写一句不超过 14 个字的引子。'
              '只输出 JSON：{"hook": "引子", "story": "故事"}')
    user = f"主题：{theme['title']}\n原石：{theme['stone_id']} {theme['stone_name']}\n\n" + '\n'.join(evidence_text)
    result = model_gateway.answer([{'role': 'system', 'content': system}, {'role': 'user', 'content': user[:6000]}])
    answer = (result.get('answer') or '').strip()
    draft = {'hook': '', 'story': answer}
    match = re.search(r'\{.*\}', answer, re.S)
    if match:
        try:
            data = json.loads(match.group(0))
            draft = {'hook': str(data.get('hook', ''))[:14], 'story': str(data.get('story', ''))[:400]}
        except ValueError:
            pass
    if not draft['story']:
        raise ValueError(result.get('notice') or '文案模型暂不可用')
    return {**draft, 'length': story_length(draft['story']), 'model': result.get('model'), 'provider': result.get('provider'),
            'notice': result.get('notice', '')}


# ------------------------------------------------------------------ stats

def count(event, key=None):
    day = date.today().isoformat()
    with _stats_lock:
        try:
            record = store.get('stats', day)
        except FileNotFoundError:
            record = {'id': day, 'events': {}, 'keys': {}}
        record['events'][event] = record['events'].get(event, 0) + 1
        if key:
            bucket = record['keys'].setdefault(event, {})
            bucket[key] = bucket.get(key, 0) + 1
        store.save('stats', record)


def stats(days=30):
    since = (date.today() - timedelta(days=days - 1)).isoformat()
    rows = sorted((r for r in store.records('stats') if r['id'] >= since), key=lambda r: r['id'])
    totals, keys = {}, {}
    for row in rows:
        for event, n in row['events'].items():
            totals[event] = totals.get(event, 0) + n
        for event, bucket in row.get('keys', {}).items():
            target = keys.setdefault(event, {})
            for key, n in bucket.items():
                target[key] = target.get(key, 0) + n
    titles = {t['id']: t['title'] for t in store.records('themes')}
    ranked = lambda event: [{'key': k, 'title': titles.get(k.split(':')[0], k), 'count': n}
                            for k, n in sorted(keys.get(event, {}).items(), key=lambda kv: -kv[1])[:10]]
    return {'days': [{'date': r['id'], **r['events']} for r in rows], 'totals': totals,
            'views': ranked('view'), 'downloads': ranked('download'), 'works': ranked('work'), 'stamps': keys.get('stamp', {})}


# ------------------------------------------------------------------ posters

A4 = (1240, 1754)


def _poster_base(palette='cinnabar'):
    p = render.PALETTES[palette]
    page = Image.new('RGBA', A4, p['bg'])
    draw = ImageDraw.Draw(page)
    draw.rectangle((40, 40, A4[0]-41, A4[1]-41), outline=p['accent'], width=3)
    draw.rectangle((54, 54, A4[0]-55, A4[1]-55), outline=render.rgba(p['accent'], 90), width=1)
    return page, draw, p


def _wifi_block(page, draw, p, value, y):
    payload = wifi_payload(value)
    if not payload:
        draw.text((A4[0]/2, y + 40), '请先连接场馆 Wi-Fi', font=render.font('serif', 34), fill=p['ink'], anchor='mm')
        return
    page.alpha_composite(render.qr_tile(payload, 250, 'cinnabar'), (170, y))
    draw.text((460, y + 60), '① 连接场馆 Wi-Fi', font=render.font('serif', 36, 600), fill=p['ink'])
    draw.text((460, y + 118), f"名称：{value['wifi_ssid']}", font=render.font('serif', 30), fill=p['ink'])
    draw.text((460, y + 168), '用相机扫左侧二维码可自动连接', font=render.font('serif', 24), fill=render.rgba(p['ink'], 170))


LAUNCHERS = {
    'kiosk': ('文创自助屏', '#section=creative&kiosk=1', '触摸一体机：观众自己浏览、定制，扫码带走'),
    'screen': ('文创大屏', '#section=creative&screen=1', '展示大屏：自动轮播主题，观众扫屏上二维码'),
}


def launcher(kind):
    """Windows start script for a venue screen, with this venue's address written in.

    It waits for the platform host, then opens Edge (or Chrome) full screen in its own profile so the
    screen never shows first-run pages, translation bars or the staff member's own browser.
    """
    title, fragment, use = LAUNCHERS[kind]
    base = venue()['base_url']
    lines = [
        '@echo off', 'chcp 65001 >nul', 'setlocal',
        f'rem {title}启动脚本：{use}。由工作台“电子文创 → 场馆与现场”生成。',
        'rem 第一次双击时询问是否开机自动打开；也可加参数 /install 或 /uninstall 运行。',
        f'set "URL={base}/{fragment}"',
        f'set "PING={base}/api/creative/links"',
        rf'set "PROFILE=%LOCALAPPDATA%\WSC-Creative-{kind}"',
        r'set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"',
        'if /i "%~1"=="/install" (call :enable & pause & exit /b)',
        'if /i "%~1"=="/uninstall" goto uninstall',
        'set "BROWSER="',
        r'for %%P in ("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"'
        r' "%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe")'
        ' do if not defined BROWSER if exist %%P set "BROWSER=%%~P"',
        'if not defined BROWSER (echo 没有找到 Edge 或 Chrome 浏览器。& pause & exit /b 1)',
        # Asked once on the screen's own PC; the answer defaults to no, so a test run elsewhere changes nothing.
        r'if exist "%STARTUP%\%~nx0" goto ready',
        f'choice /c YN /t 15 /d N /m "把这台电脑设为开机自动全屏打开{title}，并关闭屏幕休眠？15 秒不选按“否”"',
        'if %errorlevel%==1 call :enable',
        ':ready',
        'where curl >nul 2>nul || goto open',
        'echo 正在等待平台主机 %PING% ……',
        ':wait',
        # ping as the pause: `timeout` refuses to run without a console and would spin this loop.
        'curl -s -f -o nul -m 5 "%PING%" || (ping -n 6 127.0.0.1 >nul & goto wait)',
        ':open',
        'start "" "%BROWSER%" --kiosk "%URL%" --edge-kiosk-type=fullscreen --user-data-dir="%PROFILE%" --no-first-run'
        ' --no-default-browser-check --noerrdialogs --disable-pinch --overscroll-history-navigation=0 --disable-features=Translate',
        'exit /b 0',
        ':enable',
        r'copy /y "%~f0" "%STARTUP%\%~nx0" >nul || (echo 加入开机启动失败。& exit /b 1)',
        'powercfg /change monitor-timeout-ac 0 >nul',
        'powercfg /change standby-timeout-ac 0 >nul',
        f'echo 已加入开机启动，并关闭了接通电源时的屏幕休眠。下次开机会自动全屏打开{title}。',
        'echo 退出全屏按 Alt+F4；取消开机启动：Win+R 输入 shell:startup，删除其中的 %~nx0。',
        'exit /b 0',
        ':uninstall',
        r'del "%STARTUP%\%~nx0" 2>nul',
        'echo 已取消开机启动。', 'pause', 'exit /b 0',
    ]
    # cmd needs CRLF: with bare LF, labels and goto misbehave.
    return title + '.bat', ('\r\n'.join(lines) + '\r\n').encode('utf-8')


def posters():
    value = venue()
    pages = []
    live = [t for t in records() if t.get('status') == 'published']
    for hall in HALLS:
        page, draw, p = _poster_base()
        draw.text((A4[0]/2, 150), '汉 画 寻 踪 · 集 章', font=render.font('serif', 44, 600), fill=p['accent'], anchor='mm')
        page.alpha_composite(render.hall_stamp(hall, 300), ((A4[0]-300)//2, 220))
        draw.text((A4[0]/2, 590), hall['name'], font=render.fitted(draw, hall['name'], 'serif', 76, A4[0]-200, 700), fill=p['ink'], anchor='mm')
        draw.text((A4[0]/2, 670), hall['chapter'], font=render.font('kai', 38), fill=p['ink'], anchor='mm')
        _wifi_block(page, draw, p, value, 760)
        page.alpha_composite(render.qr_tile(stamp_url(hall['id']), 400, 'cinnabar'), ((A4[0]-400)//2, 1070))
        draw.text((A4[0]/2, 1515), '② 用手机相机扫码，盖下本厅印章', font=render.font('serif', 36, 600), fill=p['ink'], anchor='mm')
        draw.text((A4[0]/2, 1570), '集齐七枚，可在文创展区领取集章纪念卡', font=render.font('serif', 28), fill=render.rgba(p['ink'], 180), anchor='mm')
        names = [t['title'] for t in live if t.get('hall') == hall['id']]
        if names:
            draw.text((A4[0]/2, 1640), '本厅文创：' + '、'.join(names), font=render.fitted(draw, '本厅文创：' + '、'.join(names), 'serif', 26, A4[0]-200), fill=p['accent'], anchor='mm')
        pages.append(page)
    for theme in live:
        page, draw, p = _poster_base(theme.get('palette', 'cinnabar'))
        ctx = context(theme)
        art, kind = render.art(ctx, 'color' if ctx['colors'] else 'line', theme.get('palette', 'cinnabar'))
        render.paste_center(page, render.placed(art, kind, theme.get('palette', 'cinnabar'), A4[0]-240, 700), (120, 110, A4[0]-120, 830))
        draw.text((A4[0]/2, 910), theme['title'], font=render.fitted(draw, theme['title'], 'serif', 92, A4[0]-200, 700), fill=p['ink'], anchor='mm')
        if theme.get('hook'):
            draw.text((A4[0]/2, 1000), theme['hook'], font=render.font('kai', 42), fill=p['ink'], anchor='mm')
        _wifi_block(page, draw, p, value, 1070)
        page.alpha_composite(render.qr_tile(theme_url(theme['id']), 300, theme.get('palette', 'cinnabar')), ((A4[0]-300)//2, 1350))
        draw.text((A4[0]/2, 1690), '② 扫码把壁纸、明信片带回手机', font=render.font('serif', 32, 600), fill=p['ink'], anchor='mm')
        draw.text((A4[0]/2, 1325), render.provenance(ctx, kind), font=render.font('serif', 22), fill=render.rgba(p['ink'], 170), anchor='mm')
        pages.append(page)
    out = BytesIO()
    rgb = [page.convert('RGB') for page in pages]
    rgb[0].save(out, 'PDF', resolution=150, save_all=True, append_images=rgb[1:])
    return out.getvalue()


# ------------------------------------------------------------------ upkeep

def cleanup():
    """Unselected AI candidates leave after 30 days; adopted library items stay."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=CANDIDATE_DAYS)).isoformat()
    for item in store.records('materials'):
        if (item.get('role') == 'candidate' and item.get('theme') and not item.get('adopted')
                and (item.get('candidate_at') or item['created_at']) < cutoff):
            store.remove_material(item['id'])


def recover():
    _quiet(cleanup)
    live = [t for t in store.records('themes') if t.get('status') == 'published']
    # A new venue address or a new day re-renders in the background, before the first visitor.
    threading.Thread(target=lambda: [_quiet(ensure, t) for t in live], daemon=True).start()
