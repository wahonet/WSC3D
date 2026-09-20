"""Export reviewed annotation regions and run explicitly requested MiniMax H3 previews.

prepare never calls MiniMax. submit sends each selected job once; poll only retrieves it.
Run with tools/run.ps1 tools/preview_animations.py <prepare|submit|poll> <manifest.json>.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import sys
from datetime import datetime, timezone
from urllib.parse import urlsplit

import requests
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/backend'))
from app.config import settings
from app.services.minimax import client, response_json
from app.services.previews import _to_srgb
from app.services.resources import asset_path


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def validate(manifest):
    if manifest.get('model') != 'MiniMax-H3' or manifest.get('resolution') != '768P':
        raise ValueError('试片仅使用 MiniMax-H3 / 768P')
    if type(manifest.get('duration')) is not int or not 4 <= manifest['duration'] <= 6:
        raise ValueError('视频时长必须为 4–6 秒')
    jobs = manifest.get('jobs', [])
    if not 1 <= len(jobs) <= 2 or len({job['slug'] for job in jobs}) != len(jobs):
        raise ValueError('一次试片最多两条，名称不能重复')
    for job in jobs:
        if not re.fullmatch(r'[a-z0-9-]{1,50}', job['slug']) or not job.get('prompt', '').strip():
            raise ValueError('试片名称或动作描述无效')


def prepare(folder, manifest):
    with sqlite3.connect(f'file:{settings.db_path.as_posix()}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        for job in manifest['jobs']:
            slug = job['slug']
            if (folder / f'{slug}.job.json').exists():
                continue  # Submitted sources are immutable.
            row = db.execute('SELECT a.*, s.relpath, s.width, s.height, s.sha256 FROM annotations a '
                             'JOIN assets s ON a.asset_id=s.id WHERE a.id=?', (job['annotation_id'],)).fetchone()
            if not row or row['review_status'] not in ('reviewed', 'approved') or row['atype'] != 'rect':
                raise ValueError('试片需要已有的已审矩形区域')
            geometry = json.loads(row['geometry'])
            x, y, w, h = [geometry[key] for key in ('x', 'y', 'w', 'h')]
            if not all(math.isfinite(v) for v in (x, y, w, h)) or min(x, y) < 0 or min(w, h) <= 0 or max(x+w, y+h) > 1.001:
                raise ValueError('标注范围无效')
            source = asset_path(row['relpath'])
            with Image.open(source) as original:
                if original.size != (row['width'], row['height']):
                    raise ValueError('底图尺寸与标注不一致')
                box = (math.floor(x*original.width), math.floor(y*original.height),
                       math.ceil((x+w)*original.width), math.ceil((y+h)*original.height))
                # Coordinate export only: keep the original rubbing, with no AI redraw.
                frame = _to_srgb(original.crop(box))
                frame.thumbnail((1920, 1920), Image.Resampling.LANCZOS)
                min_height = math.ceil(frame.width / 2.4)
                min_width = math.ceil(frame.height / 2.4)
                if frame.height < min_height:
                    gap = min_height-frame.height
                    frame = ImageOps.expand(frame, (0, gap//2, 0, gap-gap//2), fill='white')
                if frame.width < min_width:
                    gap = min_width-frame.width
                    frame = ImageOps.expand(frame, (gap//2, 0, gap-gap//2, 0), fill='white')
                if min(frame.size) < 256:
                    raise ValueError('标注区域过小')
                frame.save(folder / f'{slug}.jpg', quality=95)
            references = [dict(r) for r in db.execute('SELECT id, document_id, page_id, segment_id FROM annotation_references WHERE annotation_id=?', (row['id'],))]
            write_json(folder / f'{slug}.source.json', {
                'annotation_id': row['id'], 'stone_id': row['stone_id'], 'asset_id': row['asset_id'],
                'label': row['label'], 'source_sha256': row['sha256'], 'geometry': geometry,
                'source_relpath': row['relpath'], 'pixel_box': box, 'references': references,
            })
            print(json.dumps({'source': slug, 'size': frame.size, 'annotation': row['id']}, ensure_ascii=False))


def submit(folder, manifest, only=None):
    validate(manifest)
    session, base = client()
    for job in manifest['jobs']:
        slug = job['slug']
        if only and slug != only:
            continue
        record_path = folder / f'{slug}.job.json'
        if record_path.exists():
            print(f'{slug}: 已提交过，使用 poll 查询；不重复付费生成')
            continue
        source_path = (folder / job.get('first_frame', f'{slug}.jpg')).resolve()
        if not source_path.is_relative_to(folder.resolve()):
            raise ValueError('首帧必须在当前试片目录内')
        with Image.open(source_path) as frame:
            mime = Image.MIME.get(frame.format)
            if mime not in ('image/jpeg', 'image/png', 'image/webp'):
                raise ValueError('首帧需要 JPEG、PNG 或 WebP')
            if not 256 <= min(frame.size) <= max(frame.size) <= 5760 or not .4 <= frame.width/frame.height <= 2.5:
                raise ValueError('首帧尺寸或比例超出 H3 范围')
        data = source_path.read_bytes()
        if len(data) > 30*1024*1024:
            raise ValueError('首帧不能超过 30 MB')
        body = {'model': manifest['model'], 'duration': manifest['duration'], 'resolution': manifest['resolution'],
                'ratio': 'adaptive', 'aigc_watermark': True, 'content': [
                    {'type': 'text', 'text': job['prompt']},
                    {'type': 'image_url', 'image_url': {'url': f'data:{mime};base64,' + base64.b64encode(data).decode()}, 'role': 'first_frame'},
                ]}
        record = {**job, 'model': body['model'], 'duration': body['duration'], 'resolution': body['resolution'],
                  'source_sha256': hashlib.sha256(data).hexdigest(), 'created_at': datetime.now(timezone.utc).isoformat(),
                  'status': 'submitting', 'base': base}
        # Exclusive claim remains even after a timeout; a lost response must not cause a second charge.
        with record_path.open('x', encoding='utf-8') as handle:
            json.dump(record, handle, ensure_ascii=False, indent=2)
        try:
            result = response_json(session.post(base+'/video_generation', json=body, timeout=(15,45), allow_redirects=False))
            if not result.get('task_id'):
                raise RuntimeError('返回结果缺少 task_id；请核对云端任务，勿再次提交')
            record.update(task_id=str(result['task_id']), status='queued')
        except Exception as error:
            record.update(status='submission_uncertain', error=str(error)[:300])
            write_json(record_path, record)
            raise
        write_json(record_path, record)
        print(json.dumps({'job':slug, 'task_id':record['task_id'], 'status':record['status']}, ensure_ascii=False))


def poll(folder, manifest):
    session, _ = client()
    for job in manifest['jobs']:
        slug = job['slug']
        path = folder / f'{slug}.job.json'
        if not path.exists():
            continue
        record = json.loads(path.read_text(encoding='utf-8'))
        if not record.get('task_id'):
            print(f'{slug}: 提交结果不确定，未重新生成')
            continue
        if not (folder / f'{slug}.mp4').exists():
            task = response_json(session.get(record['base']+'/query/video_generation/'+record['task_id'], timeout=(10,30), allow_redirects=False))['task']
            record.update(status=task['status'], result=task)
            write_json(path, record)
            if task['status'] == 'succeeded':
                url = task['content']['url']
                if urlsplit(url).scheme != 'https':
                    raise ValueError('结果下载地址需要 HTTPS')
                # A separate session prevents sending the API credential to the media CDN.
                with requests.get(url, timeout=(10,45), stream=True) as response:
                    response.raise_for_status()
                    temporary = folder / f'{slug}.mp4.part'
                    total = 0
                    with temporary.open('wb') as handle:
                        for chunk in response.iter_content(1024*1024):
                            total += len(chunk)
                            if total > 150*1024*1024:
                                raise ValueError('返回视频异常大，已停止下载')
                            handle.write(chunk)
                    with temporary.open('rb') as handle:
                        if handle.read(12)[4:8] != b'ftyp':
                            raise ValueError('返回文件不是 MP4')
                    temporary.replace(folder / f'{slug}.mp4')
        print(json.dumps({'job':slug,'status':record['status'],'local_video':(folder/f'{slug}.mp4').is_file(),
                          'usage':record.get('result',{}).get('usage',{}),'error':record.get('result',{}).get('error')},ensure_ascii=False))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare','submit','poll'])
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--only')
    args=parser.parse_args()
    manifest_path=args.manifest.resolve()
    if not manifest_path.is_relative_to((ROOT/'resources').resolve()):
        raise ValueError('试片文件应放在 resources 内')
    manifest=json.loads(manifest_path.read_text(encoding='utf-8-sig'))
    validate(manifest)
    if args.action == 'prepare': prepare(manifest_path.parent, manifest)
    elif args.action == 'submit': submit(manifest_path.parent, manifest, args.only)
    else: poll(manifest_path.parent, manifest)


if __name__ == '__main__':
    main()
