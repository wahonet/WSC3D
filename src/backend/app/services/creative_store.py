"""Curated derivatives and visitor creations, separate from the research database."""
from __future__ import annotations
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import threading
from uuid import UUID, uuid4

from PIL import Image, ImageChops, ImageOps
from ..config import settings
from ..models import Annotation, Asset, Stone
from . import resources, video_jobs, video_sources

lock = threading.RLock()


def now():
    return datetime.now(timezone.utc).isoformat()


def root():
    return settings.resources_dir / 'creative'


def folder(kind, identifier):
    base = root() / 'materials' if kind == 'materials' else settings.data_dir / 'creative' / kind
    return base / str(UUID(str(identifier)))


@contextmanager
def connect():
    path = settings.data_dir / 'creative.sqlite3'
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=15)
    db.row_factory = sqlite3.Row
    try:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS records (
                kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
                PRIMARY KEY(kind,id));
        ''')
        yield db
        db.commit()
    finally:
        db.close()


def save(kind, record):
    with lock, connect() as db:
        db.execute('INSERT OR REPLACE INTO records VALUES(?,?,?)',
                   (kind, record['id'], json.dumps(record, ensure_ascii=False)))
    return record


def get(kind, identifier):
    with connect() as db:
        row = db.execute('SELECT data FROM records WHERE kind=? AND id=?', (kind, str(identifier))).fetchone()
    if row is None:
        raise FileNotFoundError('内容不存在')
    return json.loads(row['data'])


def records(kind):
    with connect() as db:
        rows = db.execute('SELECT data FROM records WHERE kind=? ORDER BY rowid DESC', (kind,)).fetchall()
    return [json.loads(row['data']) for row in rows]


def material_file(item, variant='image'):
    names = {'image': 'image.png', 'thumb': 'thumb.webp', 'ink': 'ink.png', 'video': 'video.mp4'}
    if variant not in names or (variant == 'video' and item['kind'] != 'video'):
        raise FileNotFoundError('素材文件不存在')
    path = folder('materials', item['id']) / names[variant]
    if not path.is_file():
        raise FileNotFoundError('素材文件不存在')
    return path


def public_material(item, internal=False):
    value = {k: item[k] for k in ('id', 'title', 'kind', 'tags', 'story', 'width', 'height', 'created_at', 'published', 'origin')}
    value['source'] = item.get('source', {})
    prefix = '/api/creative/' + ('admin/' if internal else '') + 'materials/' + item['id']
    value.update(image_url=prefix + '/image', thumb_url=prefix + '/thumb',
                 video_url=prefix + '/video' if item['kind'] == 'video' else None,
                 has_ink=(folder('materials', item['id']) / 'ink.png').is_file())
    return value


def provenance(source):
    refs = []
    for ref in source.get('references', []):
        if ref.get('source_missing'):
            continue
        refs.append({k: ref.get(k) for k in ('document_id', 'document_title', 'page_no', 'text')})
    return {'stone_id': source.get('stone_id'), 'stone_name': source.get('stone_name'),
            'asset_id': source.get('asset_id'), 'annotation_ids': source.get('annotation_ids', []),
            'references': refs}


def add_image(image, title, *, origin, source=None, tags=None, story='', ink=False, identifier=None):
    identifier = str(UUID(identifier)) if identifier else str(uuid4())
    dest = folder('materials', identifier)
    dest.mkdir(parents=True, exist_ok=True)
    image = image.convert('RGBA')
    image.thumbnail((3000, 3000), Image.Resampling.LANCZOS)
    image.save(dest / 'image.png', optimize=True)
    if ink:
        # Preserve the geometric mask, making the white rubbing paper transparent.
        alpha = ImageChops.multiply(ImageOps.invert(ImageOps.grayscale(image)), image.getchannel('A'))
        stencil = Image.new('RGBA', image.size, (31, 43, 43, 0))
        stencil.putalpha(alpha)
        stencil.save(dest / 'ink.png', optimize=True)
    thumb = Image.new('RGBA', image.size, '#f3f4f3')
    thumb.alpha_composite(image)
    thumb.thumbnail((520, 520), Image.Resampling.LANCZOS)
    thumb.convert('RGB').save(dest / 'thumb.webp', quality=86)
    record = {'id': identifier, 'title': title[:80], 'kind': 'image', 'origin': origin,
              'tags': list(dict.fromkeys(tags or []))[:20], 'story': story[:4000], 'source': source or {},
              'width': image.width, 'height': image.height, 'created_at': now(), 'published': False}
    return save('materials', record)


def from_annotations(db, ids):
    ids = sorted(set(ids))
    nodes = db.query(Annotation).filter(Annotation.id.in_(ids)).order_by(Annotation.id).all()
    if len(nodes) != len(ids) or any(not video_sources.eligible(n) for n in nodes):
        raise ValueError('请选择有效的图像标注')
    if len({n.asset_id for n in nodes}) != 1 or len({n.stone_id for n in nodes}) != 1:
        raise ValueError('请在同一张底图中选择图案')
    asset, stone = db.get(Asset, nodes[0].asset_id), db.get(Stone, nodes[0].stone_id)
    if asset is None or stone is None or asset.missing or asset.is_model:
        raise ValueError('标注底图不可用')
    snapshot = video_sources.snapshot(db, asset, stone, nodes)
    path = resources.asset_path(asset.relpath)
    fingerprint = hashlib.sha256(json.dumps([snapshot, path.stat().st_mtime_ns], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    with lock:
        previous = next((m for m in records('materials') if m.get('fingerprint') == fingerprint), None)
        if previous:
            return previous
        region, box = video_sources.export_region(asset, nodes, path, 2600)
        tags = [c for n in snapshot['annotations'] for c in n['concepts']]
        stories = [video_sources.plain(n['semantics'].get('iconographic') or n['semantics'].get('pre_iconographic') or n['desc_text']) for n in snapshot['annotations']]
        value = add_image(region, '、'.join(video_sources.display_label(n) for n in nodes), origin='annotation',
                          source=provenance(snapshot), tags=tags, story='\n'.join(dict.fromkeys(s for s in stories if s)), ink=True)
        value.update(fingerprint=fingerprint, snapshot=snapshot, pixel_box=box)
        return save('materials', value)


def from_video(job_id):
    job = video_jobs.get(job_id)
    if job['status'] != 'succeeded':
        raise ValueError('请选择已完成的视频')
    with lock:
        old = next((m for m in records('materials') if m.get('video_job_id') == str(job_id)), None)
        if old:
            return old
        path = video_jobs.output_root(job_id)
        source_path = path / 'source.json'
        data = json.loads(source_path.read_text('utf-8')) if source_path.exists() else {}
        source = data.get('source', data)
        with Image.open(path / 'cover.jpg') as image:
            value = add_image(image, job.get('title', '汉画故事'), origin='video', source=provenance(source))
        dest = folder('materials', value['id']) / 'video.mp4'
        # One durable curated copy; visitor cards all reuse it.
        shutil.copy2(path / 'video.mp4', dest)
        value.update(kind='video', video_job_id=str(job_id), snapshot=source)
        return save('materials', value)


def publish(identifier, published, title=None, tags=None):
    with lock:
        value = get('materials', identifier)
        if not material_file(value).is_file():
            raise ValueError('素材文件缺失')
        value['published'] = published
        if title is not None:
            value['title'] = title.strip() or value['title']
        if tags is not None:
            value['tags'] = tags
        return save('materials', value)
