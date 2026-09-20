"""Durable annotation video jobs. Only explicit creation submits a paid task."""
import base64
from datetime import datetime, timezone
import hashlib
import json
import logging
import re
import threading
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator
import requests
from ..config import settings
from . import minimax, video_sources

log = logging.getLogger('stonelab.video')
_lock = threading.RLock()
_running: set[str] = set()
_stop = threading.Event()
ACTIVE = {'pending', 'submitting', 'queued', 'running', 'downloading'}
RESUMABLE = {'queued', 'running', 'downloading', 'download_failed', 'query_paused'}


class VideoRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    source_id: str = Field(pattern=r'^[a-f0-9]{64}$')
    prompt: str | None = Field(default=None, min_length=1, max_length=7000)

    @field_validator('prompt')
    @classmethod
    def nonblank(cls, value):
        if value is not None and not value.strip():
            raise ValueError('提示词不能为空')
        return value.strip() if value is not None else None


class Conflict(ValueError):
    pass


def jobs_root():
    return settings.data_dir / 'video_jobs'


def output_root(job_id):
    return settings.resources_dir / 'videos' / str(UUID(str(job_id)))


def _path(job_id):
    return jobs_root() / (str(UUID(str(job_id))) + '.json')


def _now():
    return datetime.now(timezone.utc).isoformat()


def _save(record):
    path = _path(record['id'])
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def get(job_id):
    with _lock:
        path = _path(job_id)
        if not path.is_file():
            raise FileNotFoundError('未找到生成任务')
        return json.loads(path.read_text(encoding='utf-8'))


def records():
    with _lock:
        result = []
        for path in jobs_root().glob('*.json'):
            try:
                result.append(json.loads(path.read_text(encoding='utf-8')))
            except (ValueError, OSError):
                log.warning('Unreadable video job: %s', path.name)
        return sorted(result, key=lambda job: job['created_at'], reverse=True)


def public(record):
    fields = ('id', 'title', 'prompt', 'duration', 'ratio', 'style', 'status', 'created_at', 'error', 'actual_duration', 'width', 'height', 'usage')
    value = {key: record.get(key) for key in fields}
    mode = record.get('mode', 'multimodal')
    preset = minimax.VIDEO_MODES[mode]
    value.update(mode=mode, mode_label=preset['label'], model=record.get('model', 'MiniMax-H3'),
                 resolution=record.get('resolution', '768P'), estimated_cny=round(record['duration'] * preset['price_per_second'], 2))
    source = record.get('source')
    value['source'] = {key: source[key] for key in ('stone_id', 'stone_name', 'asset_id', 'annotation_ids')} if source else None
    value['video_url'] = f"/api/videos/jobs/{record['id']}/file" if record['status'] == 'succeeded' else None
    value['poster_url'] = f"/api/videos/jobs/{record['id']}/cover" if record['status'] == 'succeeded' else None
    return value


def policy():
    try:
        session, _ = minimax.client()
        session.close()
        ready, error = True, ''
    except Exception as exc:
        ready, error = False, str(exc)
    modes = [{'id': key, **{field: value[field] for field in ('label', 'model', 'resolution', 'durations', 'price_per_second')}} for key, value in minimax.VIDEO_MODES.items()]
    return {'configured': ready, 'error': error, 'modes': modes, 'default_mode': 'fast', 'max_duration': 6}


def create(body: VideoRequest):
    spec = body.model_dump(mode='json')
    job_id = spec.pop('request_id')
    fingerprint = hashlib.sha256(json.dumps(spec, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    with _lock:
        if _path(job_id).exists():
            existing = get(job_id)
            if existing['fingerprint'] != fingerprint:
                raise Conflict('同一提交编号不能用于另一份标注或提示词')
            return existing
        if any(job['status'] in ACTIVE for job in records()):
            raise Conflict('已有视频正在生成，请完成后再提交')
        prepared = video_sources.load(body.source_id)
        options = video_sources.PrepareRequest.model_validate(prepared['options'])
        preset = minimax.VIDEO_MODES[options.mode]
        prompt = body.prompt or prepared['prompt']
        if not 1 <= len(prompt) <= 7000:
            raise ValueError('提示词须在 7000 字以内')
        session, _ = minimax.client()  # Validate the saved credential before claiming a job.
        session.close()
        record = {'id': job_id, 'source_id': body.source_id, 'title': prepared['title'], 'prompt': prompt,
                  'mode': options.mode, 'model': preset['model'], 'resolution': preset['resolution'],
                  'duration': options.duration, 'style': options.style, 'ratio': 'adaptive',
                  'source': prepared['source'], 'image_sha256': prepared['image_sha256'],
                  'fingerprint': fingerprint, 'status': 'pending', 'created_at': _now(), 'error': ''}
        folder = output_root(job_id)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'base.jpg').write_bytes((video_sources.source_dir(body.source_id) / 'base.jpg').read_bytes())
        (folder / 'source.json').write_text(json.dumps({**prepared, 'job_id': job_id, 'submitted_prompt': prompt}, ensure_ascii=False, indent=2), encoding='utf-8')
        _save(record)
        start(job_id)
        return record


def start(job_id):
    with _lock:
        if job_id in _running:
            return
        _running.add(job_id)
        threading.Thread(target=_worker, args=(job_id,), name='video-'+job_id[:8], daemon=True).start()


def refresh(job_id):
    record = get(job_id)
    if record.get('task_id') and record['status'] in RESUMABLE:
        start(record['id'])
    return record


def _update(job_id, **patch):
    with _lock:
        record = get(job_id)
        record.update(patch, updated_at=_now())
        _save(record)
        return record


def _download(record, url):
    if urlsplit(url).scheme != 'https':
        raise ValueError('视频下载地址无效')
    folder = output_root(record['id'])
    folder.mkdir(parents=True, exist_ok=True)
    temporary = folder / 'video.mp4.part'
    # Do not send the model credential to the media CDN.
    with requests.get(url, stream=True, timeout=(10, 60)) as response:
        response.raise_for_status()
        total = 0
        with temporary.open('wb') as handle:
            for chunk in response.iter_content(1024 * 1024):
                total += len(chunk)
                if total > 150 * 1024 * 1024:
                    raise ValueError('视频文件超出保存上限')
                handle.write(chunk)
    with temporary.open('rb') as handle:
        if handle.read(12)[4:8] != b'ftyp':
            raise ValueError('返回文件不是 MP4')
    import cv2
    capture = cv2.VideoCapture(str(temporary))
    try:
        fps = capture.get(cv2.CAP_PROP_FPS)
        duration = capture.get(cv2.CAP_PROP_FRAME_COUNT) / fps if fps else 0
        if not 0 < duration <= 6:
            raise ValueError('返回的视频时长超出 6 秒上限，原件已保留')
        ok, frame = capture.read()
        if not ok:
            raise ValueError('视频无法解码')
        cv2.imencode('.jpg', frame)[1].tofile(str(folder / 'cover.jpg'))
        size = {'width': int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), 'height': int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)), 'actual_duration': duration}
    finally:
        capture.release()
    temporary.replace(folder / 'video.mp4')
    if not record.get('source_id'):
        (folder / 'source.json').write_text(json.dumps({key: record[key] for key in ('id', 'title', 'prompt', 'style', 'duration', 'ratio', 'created_at', 'task_id', 'compiled_prompt')}, ensure_ascii=False, indent=2), encoding='utf-8')
    return size


def _worker(job_id):
    session = None
    try:
        record = get(job_id)
        session, base = minimax.client()
        if record['status'] == 'pending':
            prompt = record['prompt']
            content = [{'type': 'text', 'text': prompt}]
            if record.get('source_id'):
                preset = minimax.VIDEO_MODES[record['mode']]
                video_sources.PrepareRequest(annotation_ids=record['source']['annotation_ids'], mode=record['mode'], duration=record['duration'], style=record['style'])
                image = (output_root(job_id) / 'base.jpg').read_bytes()
                if hashlib.sha256(image).hexdigest() != record['image_sha256']:
                    _update(job_id, status='failed', error='标注底图已变化，未提交生成')
                    return
                content.append({'type': 'image_url', 'image_url': {'url': 'data:image/jpeg;base64,' + base64.b64encode(image).decode()}, 'role': preset['image_role']})
            else:
                # Resume older text-only jobs using their original request format.
                prompt = '\n'.join(filter(None, (prompt, video_sources.STYLES[record['style']], f"视频时长 {record['duration']} 秒；无字幕、无对白、无配乐，保持角色和器物数量稳定。")))
                content[0]['text'] = prompt
            record = _update(job_id, status='submitting', base=base, compiled_prompt=prompt)
            try:
                reply = minimax.response_json(session.post(base+'/video_generation', json={
                    'model': record.get('model', 'MiniMax-H3'), 'resolution': record.get('resolution', '768P'), 'duration': record['duration'], 'ratio': record['ratio'],
                    'aigc_watermark': True, 'content': content,
                }, timeout=(10,45), allow_redirects=False))
                if not reply.get('task_id'):
                    raise RuntimeError('Missing task id')
            except Exception as exc:
                if isinstance(exc, minimax.APIError) and 400 <= exc.status < 500 and exc.status != 408:
                    _update(job_id, status='failed', error='提交被拒绝：' + str(exc))
                else:
                    _update(job_id, status='submission_uncertain', error='提交结果未确认，未重复生成。请在 MiniMax 任务记录中核对。')
                return
            record = _update(job_id, status='queued', task_id=str(reply['task_id']), error='')
        if not record.get('task_id'):
            return
        if record.get('base') not in minimax.BASES:
            raise ValueError('任务接口地址无效')
        for attempt in range(480):
            if _stop.is_set():
                return
            try:
                task = minimax.response_json(session.get(record['base']+'/query/video_generation/'+record['task_id'], timeout=(10,30), allow_redirects=False))['task']
            except Exception:
                _update(job_id, error='状态查询暂时失败，正在继续查询')
                if _stop.wait(30):
                    return
                continue
            status = task['status']
            if status == 'succeeded':
                record = _update(job_id, status='downloading', error='', usage=task.get('usage', {}))
                try:
                    result = _download(record, task['content']['url'])
                    _update(job_id, status='succeeded', error='', **result)
                except Exception as exc:
                    error = re.sub(r'https?://\S+|sk-[\w-]+', '[redacted]', str(exc))[:180]
                    _update(job_id, status='download_failed', error='视频已生成，保存失败：'+error)
                return
            if status in ('failed', 'cancelled'):
                _update(job_id, status=status, error='云端生成失败' if status == 'failed' else '任务已取消')
                return
            record = _update(job_id, status=status if status in ('queued', 'running') else 'running', error='')
            if _stop.wait(15):
                return
        _update(job_id, status='query_paused', error='查询已暂停，可继续查询原任务')
    except Exception:
        record = get(job_id)
        _update(job_id, status='query_paused' if record.get('task_id') else 'failed', error='服务暂不可用，请检查 MiniMax 配置')
    finally:
        if session:
            session.close()
        with _lock:
            _running.discard(job_id)


def recover():
    _stop.clear()
    for record in records():
        if record['status'] == 'submitting' and not record.get('task_id'):
            _update(record['id'], status='submission_uncertain', error='服务中断前提交结果未确认，未重复生成')
        elif record['status'] == 'pending' or record['status'] in RESUMABLE:
            start(record['id'])


def shutdown():
    _stop.set()
