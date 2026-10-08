"""Visitor works, take-away codes, stamps and print requests.

Visitor identities are cookie digests and never enter research tables. Works
are rendered one at a time by a single worker and kept for three days.
"""
from __future__ import annotations
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import queue
import re
import secrets
import shutil
import threading
from uuid import UUID, uuid4

from PIL import Image
from . import creative_render as render, creative_store as store, creative_themes as themes

WORK_DAYS, HANDOFF_HOURS, VISITOR_DAYS = 3, 24, 30
QUEUE_LIMIT, OWNER_PENDING = 12, 2
_lock = threading.RLock()
_queue: queue.Queue = queue.Queue()
_worker = None


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _now():
    return datetime.now(timezone.utc)


def _pending():
    return [w for w in store.records('works') if w['status'] in ('queued', 'rendering')]


def create(identifier, owner, design):
    identifier = str(UUID(str(identifier)))
    spec = design.model_dump(mode='json')
    fingerprint = digest(json.dumps(spec, sort_keys=True, ensure_ascii=False))
    with _lock:
        try:
            existing = store.get('works', identifier)
        except FileNotFoundError:
            existing = None
        if existing:
            if existing['owner'] != owner or existing['fingerprint'] != fingerprint:
                raise ValueError('制作编号已用于另一件作品')
            return existing
        theme = themes.published(design.theme)
        if design.motion and not theme['assets'].get('video'):
            raise ValueError('这个主题没有动态画面')
        pending = _pending()
        if sum(1 for w in pending if w['owner'] == owner) >= OWNER_PENDING:
            raise ValueError('上一件作品还在制作，请稍候')
        if len(pending) >= QUEUE_LIMIT:
            raise ValueError('现在制作的人较多，请稍候再试')
        works_dir = store.settings.data_dir / 'creative' / 'works'
        size = sum(p.stat().st_size for p in works_dir.rglob('*') if p.is_file()) if works_dir.exists() else 0
        if size > 2 * 1024**3:
            cleanup()
            raise ValueError('作品存储已满，请联系工作人员')
        record = {'id': identifier, 'owner': owner, 'fingerprint': fingerprint, 'status': 'queued', 'design': spec,
                  'theme': theme['id'], 'title': theme['title'], 'created_at': store.now()}
        store.save('works', record)
        _queue.put(identifier)
        _start()
        return record


def _start():
    global _worker
    with _lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run, daemon=True, name='creative-works')
            _worker.start()


def _run():
    while True:
        identifier = _queue.get()
        try:
            record = store.get('works', identifier)
        except FileNotFoundError:
            continue
        if record['status'] == 'queued':
            store.save('works', {**record, 'status': 'rendering'})
            render_work(record)


def render_work(record):
    try:
        theme = themes.published(record['theme'])
        ctx = themes.context(theme)
        design = render.Design.model_validate(record['design'])
        dest = store.folder('works', record['id'])
        image = render.render(ctx, design.product, record['design'])
        render.save(image, dest / 'image.png')
        preview = image.copy()
        preview.thumbnail((720, 720), Image.Resampling.LANCZOS)
        preview.save(dest / 'thumb.webp', 'WEBP', quality=86)
        if design.motion:
            cover = render.video(ctx, dest, record['design'])
            render.save(cover, dest / 'cover.png')
            record['video'] = True
        record.update(status='succeeded', width=image.width, height=image.height, finished_at=store.now())
        themes.count('work', f"{theme['id']}:{design.product}")
    except Exception as exc:
        record.update(status='failed', error=str(exc)[:300])
    finally:
        store.save('works', record)


def owned(identifier, owner):
    item = store.get('works', str(identifier))
    if not owner or not secrets.compare_digest(item['owner'], owner) or not item.get('theme'):
        raise FileNotFoundError('作品不存在')
    return item


def work_files(item, prefix):
    files = [{'name': 'image.png', 'kind': 'image', 'width': item.get('width'), 'height': item.get('height')}]
    if item.get('video'):
        files = [{'name': 'video.mp4', 'kind': 'video', 'width': item.get('width'), 'height': item.get('height')},
                 {'name': 'cover.png', 'kind': 'image', 'width': item.get('width'), 'height': item.get('height')}]
    for f in files:
        f['url'] = prefix + f['name']
        f['thumb_url'] = prefix + ('thumb.webp' if f['kind'] == 'image' else 'cover.png')
    return files


def public(item):
    result = {k: item.get(k) for k in ('id', 'status', 'design', 'theme', 'title', 'created_at', 'width', 'height', 'error')}
    prefix = f"/api/creative/works/{item['id']}/"
    result['files'] = work_files(item, prefix) if item['status'] == 'succeeded' else []
    if item['status'] == 'queued':
        result['ahead'] = sum(1 for w in _pending() if w['created_at'] < item['created_at'])
    return result


def work_file(item, name):
    allowed = {'image.png', 'thumb.webp'} | ({'video.mp4', 'cover.png'} if item.get('video') else set())
    path = store.folder('works', item['id']) / name
    if item['status'] != 'succeeded' or name not in allowed or not path.is_file():
        raise FileNotFoundError('作品文件不存在')
    return path


# ------------------------------------------------------------------ take-away

def handoff(owner, work_id=None, theme_id=None, product=None):
    """A 24-hour code that lets a phone on the venue Wi-Fi fetch what the kiosk made."""
    if work_id:
        item = owned(work_id, owner)
        if item['status'] != 'succeeded':
            raise ValueError('作品尚未完成')
        target, key = {'work': item['id']}, f"{item['theme']}:{item['design']['product']}"
    else:
        theme = themes.published(theme_id)
        themes.product_files(theme, product, '')
        target, key = {'theme': theme['id'], 'product': product}, f"{theme['id']}:{product}"
    token = secrets.token_urlsafe(18)
    expires = _now() + timedelta(hours=HANDOFF_HOURS)
    store.save('handoffs', {'id': digest(token), 'target': target, 'created_at': store.now(), 'expires_at': expires.isoformat()})
    themes.count('handoff', key)
    return {'token': token, 'url': themes.venue()['base_url'] + '/#section=creative&take=' + token, 'expires_at': expires.isoformat()}


def take(token):
    if not re.fullmatch(r'[A-Za-z0-9_-]{24}', token or ''):
        raise FileNotFoundError('取件码无效')
    try:
        record = store.get('handoffs', digest(token))
    except FileNotFoundError:
        raise FileNotFoundError('取件码无效或已过期') from None
    if record['expires_at'] < _now().isoformat():
        raise FileNotFoundError('取件码已过期，请回到文创展区重新制作')
    prefix = f'/api/creative/take/{token}/'
    target = record['target']
    if 'work' in target:
        item = store.get('works', target['work'])
        if item['status'] != 'succeeded':
            raise FileNotFoundError('作品已清理')
        theme, product, files = themes.get(item['theme']), item['design']['product'], work_files(item, prefix)
    else:
        theme, product = themes.published(target['theme']), target['product']
        files = [{**f, 'url': prefix + f['name'], 'thumb_url': prefix + f['name']} for f in themes.product_files(theme, product, '')]
    return record, {'title': theme['title'], 'product': product, 'product_title': render.PRODUCTS[product]['title'],
                    'theme': {'id': theme['id'], 'title': theme['title'], 'stone_id': theme['stone_id'], 'stone_name': theme['stone_name']},
                    'files': files, 'expires_at': record['expires_at']}


def take_file(token, name):
    record, value = take(token)
    if name not in {f['name'] for f in value['files']}:
        raise FileNotFoundError('文件不存在')
    target = record['target']
    if 'work' in target:
        return work_file(store.get('works', target['work']), name)
    return themes.file_path(themes.published(target['theme']), name)


# ------------------------------------------------------------------ stamps

def visitor(owner):
    try:
        return store.get('visitors', owner)
    except FileNotFoundError:
        return {'id': owner, 'stamps': {}, 'created_at': store.now()}


def stamps(owner):
    record = visitor(owner) if owner else {'stamps': {}}
    collected = [h for h in themes.HALL_IDS if h in record['stamps']]
    return {'halls': list(themes.HALLS), 'collected': collected, 'complete': len(collected) == len(themes.HALLS),
            'card_url': '/api/creative/stamps/card' if len(collected) == len(themes.HALLS) else None}


def collect(owner, hall, code):
    if hall not in themes.HALL_IDS or not secrets.compare_digest(code, themes.stamp_code(hall)):
        raise ValueError('印章二维码无效')
    with _lock:
        record = visitor(owner)
        fresh = hall not in record['stamps']
        record['stamps'].setdefault(hall, store.now())
        record['last_at'] = store.now()
        store.save('visitors', record)
    if fresh:
        themes.count('stamp', hall)
        if len(record['stamps']) == len(themes.HALLS):
            themes.count('complete')
    return {**stamps(owner), 'hall': hall, 'fresh': fresh}


def stamp_card(owner):
    record = visitor(owner)
    if len([h for h in themes.HALL_IDS if h in record['stamps']]) != len(themes.HALLS):
        raise FileNotFoundError('集齐七枚印章后可领取')
    live = [t for t in themes.records() if t.get('status') == 'published' and t['assets'].get('line')]
    ctx = themes.context(live[0]) if live else None
    return render.stamp_card(ctx, record['stamps'], list(themes.HALLS))


# ------------------------------------------------------------------ printing

def request_print(owner, work_id=None, theme_id=None, product='postcard'):
    if not themes.venue()['print_enabled']:
        raise ValueError('本场馆暂未开放打印')
    if work_id:
        item = owned(work_id, owner)
        if item['status'] != 'succeeded' or item['design']['product'] != 'postcard':
            raise ValueError('只有明信片可以打印')
        target, title = {'work': item['id']}, item['title']
    else:
        theme = themes.published(theme_id)
        themes.file_path(theme, themes.PRINTABLE[product])
        target = {'theme': theme['id'], **({'product': product} if product != 'postcard' else {})}
        title = theme['title'] + (' · 表情贴纸' if product == 'emoji' else '')
    with _lock:
        prints = store.records('prints')
        if sum(1 for p in prints if p['owner'] == owner and p['status'] == 'queued') >= 2:
            raise ValueError('已有两张在排队打印，请先到服务台领取')
        today = date.today().isoformat()
        number = 1 + sum(1 for p in prints if p.get('day') == today)
        record = {'id': str(uuid4()), 'owner': owner, 'target': target, 'title': title, 'status': 'queued',
                  'number': number, 'day': today, 'created_at': store.now()}
        store.save('prints', record)
    themes.count('print', target.get('theme') or title)
    return public_print(record)


def public_print(record, internal=False):
    value = {k: record[k] for k in ('id', 'title', 'status', 'number', 'created_at')}
    if internal:
        value['image_url'] = f"/api/creative/admin/prints/{record['id']}/image"
    return value


def print_image(identifier):
    record = store.get('prints', str(identifier))
    target = record['target']
    if 'work' in target:
        item = store.get('works', target['work'])
        return render.render(themes.context(themes.get(item['theme'])), 'print_postcard', item['design'])
    with Image.open(themes.file_path(themes.get(target['theme']), themes.PRINTABLE[target.get('product', 'postcard')])) as image:
        return image.convert('RGBA')


def mark_print(identifier, status):
    with _lock:
        record = store.get('prints', str(identifier))
        record['status'] = status
        record['finished_at'] = store.now()
        return store.save('prints', record)


# ------------------------------------------------------------------ upkeep

def cleanup():
    """Visitor works and codes are short-lived; curated theme products are not touched."""
    moment = _now()
    works_cutoff = (moment - timedelta(days=WORK_DAYS)).isoformat()
    for item in store.records('works'):
        if item['created_at'] < works_cutoff or not item.get('theme'):
            if item['status'] in ('queued', 'rendering') and item.get('theme'):
                continue
            shutil.rmtree(store.folder('works', item['id']), ignore_errors=True)
            store.delete('works', item['id'])
    for item in store.records('handoffs'):
        if item['expires_at'] < moment.isoformat():
            store.delete('handoffs', item['id'])
    for item in store.records('prints'):
        if item['created_at'] < works_cutoff:
            store.delete('prints', item['id'])
    visitor_cutoff = (moment - timedelta(days=VISITOR_DAYS)).isoformat()
    for item in store.records('visitors'):
        if item.get('last_at', item['created_at']) < visitor_cutoff:
            store.delete('visitors', item['id'])
    for item in store.records('templates'):
        store.delete('templates', item['id'])


def recover():
    for item in store.records('works'):
        if item['status'] in ('queued', 'rendering'):
            store.save('works', {**item, 'status': 'failed', 'error': '制作被服务重启中断，请重新制作'})
    cleanup()
