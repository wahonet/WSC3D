"""Single-image Ark requests, with encrypted credentials and no paid retries."""
from __future__ import annotations
import base64
import hashlib
from io import BytesIO
import json
import os
import re
import threading
from uuid import UUID

from PIL import Image
import requests
from ..config import settings
from . import creative_store as store, model_gateway, video_sources

MODEL = 'doubao-seedream-5-0-260128'
ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'
STYLES = {
    'paper': ('汉画套色版画', '精致套色木刻与丝网印刷，平面剪纸轮廓，朱砂红、深靛蓝、青绿和浅米白，细微版画印痕，现代博物馆文创插画。'),
    'ink': ('青绿淡彩', '青绿、淡金与矿物蓝的平面装饰插画，精炼的汉画线条，细腻纸纹，现代博物馆画册质感。'),
    'night': ('星河汉梦', '深靛蓝夜色、金色线描、朱砂小色块，汉代星象与流云式抽象纹样，简洁而精美的平面艺术海报插画。'),
}
_threads = {}
_lock = threading.RLock()


class SubmissionUncertain(ValueError):
    pass


def config_path():
    return settings.root / 'config' / 'creative.json'


def config():
    p = config_path()
    return json.loads(p.read_text('utf-8')) if p.exists() else {}


def public_settings():
    return {'model': MODEL, 'api_base': ENDPOINT.rsplit('/', 2)[0], 'has_key': bool(config().get('key_ciphertext')),
            'price_per_image': .22, 'size': '2K', 'outputs': 1}


def save_settings(key='', clear=False):
    with _lock:
        value = config()
        if clear:
            value.pop('key_ciphertext', None)
        if key:
            if len(key) > 8192 or not key.isascii() or any(c.isspace() for c in key):
                raise ValueError('API Key 格式不正确')
            value['key_ciphertext'] = model_gateway._protect(key)
        path = config_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix('.tmp')
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', 'utf-8')
        os.replace(temp, path)
    return public_settings()


def prompt_for(item, style, context=None):
    theme = item['title'] if item else '汉代流云与星象'
    content = context if context is not None else (item.get('story') or '')[:1800] if item else ''
    return (f'创作一幅可用于博物馆电子文创的艺术插画，主题：{theme}。\n'
            + ('参考图是从画像石标注导出的图案。必须保持其中主要形象的数量、姿态、朝向和关键器物；转换色彩和绘画风格，勿凭空增加人物。\n' if item else '')
            + f'内容依据：{content}\n风格：{STYLES[style][1]}\n'
            '主体完整、居中，四周留适当空间供排版。平面化、非写实，避免摄影和三维游戏风。'
            '不要文字、字母、印章、标题、水印或边框；标题由排版工具添加。')


def source_dir(identifier):
    if not re.fullmatch('[a-f0-9]{64}', identifier):
        raise ValueError('标注底图编号无效')
    return settings.cache_dir / 'image_sources' / identifier


def prepare(db, ids, style='paper'):
    asset, nodes, path, snapshot = video_sources.selection(db, ids)
    title = '、'.join(video_sources.display_label(n) for n in nodes)[:80]
    context = video_sources.describe_source(snapshot)
    item = {'id': None, 'title': title, 'story': context, 'source': store.provenance(snapshot),
            'tags': list(dict.fromkeys(c for n in snapshot['annotations'] for c in n['concepts']))[:20]}
    # The snapshot pins the exact saved annotations and book passages shown in the preview.
    prompt = prompt_for(item, style, context)
    if len(prompt) > 5000:
        raise ValueError('所选标注与引文超过 5000 字，请减少本次选择的标注')
    payload = {'version': 1, 'source': snapshot, 'style': style, 'prompt': prompt, 'item': item}
    identifier = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    with _lock:
        folder = source_dir(identifier)
        if (folder / 'source.json').is_file():
            return load_source(identifier)
        image, dimensions = video_sources.export_image(asset, nodes, path)
        data = {**payload, **dimensions, 'id': identifier, 'title': title,
                'image_sha256': hashlib.sha256(image).hexdigest(),
                'image_url': f'/api/creative/admin/image-sources/{identifier}/image'}
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'base.jpg').write_bytes(image)
        (folder / 'source.json').write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        return data


def load_source(identifier):
    folder = source_dir(identifier)
    try:
        data = json.loads((folder / 'source.json').read_text('utf-8'))
        payload = {key: data[key] for key in ('version', 'source', 'style', 'prompt', 'item')}
        if (hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest() != identifier
                or data['id'] != identifier or data['style'] not in STYLES
                or hashlib.sha256((folder / 'base.jpg').read_bytes()).hexdigest() != data['image_sha256']):
            raise ValueError()
        return data
    except (OSError, KeyError, ValueError):
        raise ValueError('标注底图已失效，请重新选择标注') from None


def public_source(data):
    result = {key: data[key] for key in ('id', 'title', 'style', 'prompt', 'image_url', 'width', 'height')}
    result['source'] = data['item']['source']
    return result


def generate(prompt, image=None):
    key = model_gateway._key(config())
    if not key:
        raise ValueError('请先配置 Seedream API Key')
    body = {'model': MODEL, 'prompt': prompt, 'size': '2K', 'response_format': 'b64_json',
            'sequential_image_generation': 'disabled', 'stream': False, 'watermark': False}
    if image:
        with Image.open(BytesIO(image)) as original:
            rgba = original.convert('RGBA')
            rgba.thumbnail((1920, 1920), Image.Resampling.LANCZOS)
            reference = Image.new('RGB', rgba.size, 'white')
            reference.paste(rgba, mask=rgba.getchannel('A'))
            buffer = BytesIO()
            reference.save(buffer, 'JPEG', quality=94)
        body['image'] = 'data:image/jpeg;base64,' + base64.b64encode(buffer.getvalue()).decode('ascii')
    try:
        # POST is issued once, including after a timeout or process restart.
        with requests.Session() as session:
            session.trust_env = False
            response = session.post(ENDPOINT, headers={'Authorization': 'Bearer ' + key}, json=body,
                                    timeout=(10, 300), allow_redirects=False, stream=True)
            chunks, length = [], 0
            for chunk in response.iter_content(65536):
                length += len(chunk)
                if length > 48 * 1024 * 1024:
                    raise ValueError('生图响应超过大小限制')
                chunks.append(chunk)
            data = json.loads(b''.join(chunks))
            if response.status_code != 200 or data.get('error'):
                message = str((data.get('error') or {}).get('message', ''))
                message = message.replace(key, '[密钥]').replace('Bearer ', '')
                message = re.sub(r'(?:ark-|sk-)[A-Za-z0-9_-]+', '[密钥]', message)
                if 'has not activated the model' in message:
                    message = '账号尚未开通 Seedream 5.0，请在火山方舟控制台开通此模型'
                raise ValueError(f'Seedream HTTP {response.status_code}：{message[:300] or "请求未成功"}')
        entries = data.get('data') or []
        if len(entries) != 1 or not entries[0].get('b64_json'):
            raise ValueError('Seedream 未返回单张图片')
        raw = base64.b64decode(entries[0]['b64_json'], validate=True)
        with Image.open(BytesIO(raw)) as result:
            if result.width * result.height > 20_000_000:
                raise ValueError('生成图片尺寸超出限制')
            result.load()
            return result.convert('RGB'), data.get('usage', {})
    except requests.RequestException:
        raise SubmissionUncertain('生图连接中断，结果待核对；不会自动再次收费生成') from None


def create(identifier, material_id=None, style='paper', prompt=None, source_id=None):
    identifier = str(UUID(str(identifier)))
    if material_id and source_id:
        raise ValueError('请选择一种参考来源')
    prepared = load_source(source_id) if source_id else None
    if prepared and prepared['style'] != style:
        raise ValueError('画风已改变，请重新预览标注')
    item = prepared['item'] if prepared else store.get('materials', material_id) if material_id else None
    value = (prompt or (prepared['prompt'] if prepared else prompt_for(item, style))).strip()
    fingerprint = hashlib.sha256(json.dumps([material_id, style, value] + ([source_id] if source_id else [])).encode()).hexdigest()
    with _lock:
        try:
            old = store.get('image_jobs', identifier)
        except FileNotFoundError:
            old = None
        if old:
            if old['fingerprint'] != fingerprint:
                raise ValueError('任务编号已用于另一项生图请求')
            return old
        if not public_settings()['has_key']:
            raise ValueError('请先配置 Seedream API Key')
        if any(j['status'] == 'running' for j in store.records('image_jobs')):
            raise ValueError('请等待当前生图完成')
        record = {'id': identifier, 'status': 'running', 'material_id': material_id, 'prompt': value,
                  'source_id': source_id, 'style': style, 'model': MODEL, 'fingerprint': fingerprint, 'created_at': store.now()}
        store.save('image_jobs', record)
        worker = threading.Thread(target=_worker, args=(record, item), daemon=True)
        _threads[identifier] = worker
        worker.start()
        return record


def _worker(record, item):
    try:
        image = ((source_dir(record['source_id']) / 'base.jpg').read_bytes() if record.get('source_id')
                 else store.material_file(item).read_bytes() if item else None)
        output, usage = generate(record['prompt'], image)
        created = store.add_image(output, (item['title'] if item else '流云星河') + ' · ' + STYLES[record['style']][0],
                                  origin='seedream', source=item.get('source') if item else None,
                                  tags=item.get('tags') if item else ['流云', '星象'], story=item.get('story', '') if item else '')
        created.update(generation={'model': MODEL, 'prompt': record['prompt'], 'input_material_id': item['id'] if item else None,
                                   'annotation_source_id': record.get('source_id'), 'usage': usage})
        store.save('materials', created)
        record.update(status='succeeded', result_id=created['id'], usage=usage)
    except SubmissionUncertain as exc:
        record.update(status='submission_uncertain', error=str(exc))
    except Exception as exc:
        record.update(status='failed', error=str(exc)[:400])
    finally:
        store.save('image_jobs', record)
        with _lock:
            _threads.pop(record['id'], None)


def recover():
    for item in store.records('image_jobs'):
        if item['status'] == 'running':
            store.save('image_jobs', {**item, 'status': 'interrupted', 'error': '服务重启，生图结果待核对；未自动再次提交'})
