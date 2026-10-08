"""Single-image Ark requests, with encrypted credentials and no paid retries.

Theme production (creative_themes) is the only caller; visitor routes never reach it.
"""
from __future__ import annotations
import base64
from io import BytesIO
import json
import os
import re
import threading

from PIL import Image
import requests
from ..config import settings
from . import creative_store as store, model_gateway

MODEL = 'doubao-seedream-5-0-260128'
ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'
STYLES = {
    'paper': ('汉画套色版画', '精致套色木刻与丝网印刷，平面剪纸轮廓，朱砂红、深靛蓝、青绿和浅米白，细微版画印痕，现代博物馆文创插画。'),
    'ink': ('青绿淡彩', '青绿、淡金与矿物蓝的平面装饰插画，精炼的汉画线条，细腻纸纹，现代博物馆画册质感。'),
    'night': ('星河汉梦', '深靛蓝夜色、金色线描、朱砂小色块，汉代星象与流云式抽象纹样，简洁而精美的平面艺术海报插画。'),
    'mineral': ('矿物彩', '汉代壁画式矿物颜料平涂：石青、石绿、朱砂、赭石与蛤粉白，保留清晰的黑色线描轮廓，微有颜料颗粒与墙面肌理，庄重典雅。'),
}
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


def update_config(change):
    """Read-modify-write of config/creative.json, which also holds the venue settings."""
    with _lock:
        value = config()
        change(value)
        path = config_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix('.tmp')
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', 'utf-8')
        os.replace(temp, path)
        return value


def save_settings(key='', clear=False):
    if key and (len(key) > 8192 or not key.isascii() or any(c.isspace() for c in key)):
        raise ValueError('API Key 格式不正确')
    def change(value):
        if clear:
            value.pop('key_ciphertext', None)
        if key:
            value['key_ciphertext'] = model_gateway._protect(key)
    update_config(change)
    return public_settings()


def generate(prompt, image=None, size='2K'):
    key = model_gateway._key(config())
    if not key:
        raise ValueError('请先配置 Seedream API Key')
    body = {'model': MODEL, 'prompt': prompt, 'size': size, 'response_format': 'b64_json',
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


def recover():
    for item in store.records('image_jobs'):
        if item['status'] == 'running':
            store.save('image_jobs', {**item, 'status': 'interrupted', 'error': '服务重启，生图结果待核对；未自动再次提交'})
