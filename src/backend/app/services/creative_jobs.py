"""Local exports. Visitor identities and designs never enter research tables."""
from __future__ import annotations
import hashlib
import json
import secrets
import threading
from uuid import UUID

from . import creative_render as render, creative_store as store

_lock = threading.RLock()


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


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
                raise ValueError('导出编号已用于另一件作品')
            return existing
        values = render.materials(design)
        jobs = store.records('works')
        if any(j['status'] == 'rendering' for j in jobs):
            raise ValueError('上一件作品仍在导出，请稍候')
        works_dir = store.settings.data_dir / 'creative' / 'works'
        size = sum(p.stat().st_size for p in works_dir.rglob('*') if p.is_file()) if works_dir.exists() else 0
        if len(jobs) >= 500 or size > 2 * 1024**3:
            raise ValueError('作品存储已满，请联系管理员整理')
        record = {'id': identifier, 'owner': owner, 'fingerprint': fingerprint, 'status': 'rendering',
                  'design': spec, 'sources': [store.public_material(m) for m in values],
                  'created_at': store.now(), 'share': None}
        store.save('works', record)
        threading.Thread(target=_worker, args=(record, design, values), daemon=True).start()
        return record


def _worker(record, design, values):
    try:
        result = render.export(design, store.folder('works', record['id']), values)
        record.update(status='succeeded', **result)
    except Exception as exc:
        record.update(status='failed', error=str(exc)[:300])
    finally:
        store.save('works', record)


def owned(identifier, owner):
    item = store.get('works', identifier)
    if not owner or not secrets.compare_digest(item['owner'], owner):
        raise FileNotFoundError('作品不存在')
    return item


def share(identifier, owner, enabled=True):
    with _lock:
        item = owned(identifier, owner)
        if item['status'] != 'succeeded':
            raise ValueError('作品尚未导出完成')
        if enabled:
            render.materials(render.Design.model_validate(item['design']))
        item['share'] = (item.get('share') or secrets.token_urlsafe(24)) if enabled else None
        return store.save('works', item)


def shared(token):
    if len(token) != 32:
        raise FileNotFoundError('分享不存在')
    item = next((w for w in store.records('works') if w.get('share') and secrets.compare_digest(w['share'], token)), None)
    if item is None:
        raise FileNotFoundError('分享不存在或已取消')
    try:
        render.materials(render.Design.model_validate(item['design']))
    except (ValueError, FileNotFoundError):
        raise FileNotFoundError('分享中的素材已下架') from None
    return item


def public(item, shared_view=False):
    result = {k: item[k] for k in ('id', 'status', 'design', 'created_at', 'sources')}
    result.update({k: item[k] for k in ('width', 'height', 'video', 'duration', 'error') if k in item})
    prefix = '/api/creative/' + ('share/' + item['share'] if shared_view else 'works/' + item['id'])
    result.update(image_url=prefix+'/image', cover_url=prefix+'/cover', video_url=prefix+'/video' if item.get('video') else None)
    if not shared_view:
        result['share'] = item.get('share')
    return result


def recover():
    for item in store.records('works'):
        if item['status'] == 'rendering':
            store.save('works', {**item, 'status': 'failed', 'error': '导出被服务重启中断，请重新导出'})
