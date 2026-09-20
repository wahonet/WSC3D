"""MiniMax transport shared by the workbench and explicit preview tools."""
import re
import requests
from .model_gateway import load_config, _key

BASES = ('https://api.minimax.cn/v2', 'https://api.minimaxi.com/v2', 'https://api.minimax.io/v2')
VIDEO_MODES = {
    'multimodal': {'label': '多模态生成', 'model': 'MiniMax-H3', 'resolution': '768P', 'price_per_second': .5, 'durations': [4, 5], 'image_role': 'reference_image'},
    'fast': {'label': '极速生成', 'model': 'MiniMax-H3-Max', 'resolution': '480P', 'price_per_second': .33, 'durations': [5], 'image_role': 'first_frame'},
}


class APIError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def client():
    cfg = load_config()
    profile = cfg['online']['profiles'][cfg.get('video', {}).get('credential_profile', 'custom')]
    base = profile['api_base'].rstrip('/')
    if base not in BASES:
        raise ValueError('请在 API配置中填写 MiniMax 官方 V2 地址')
    key = _key(profile)
    if not key:
        raise ValueError('请先在 API配置中保存 MiniMax 密钥')
    session = requests.Session()  # No automatic retry of paid POST requests.
    session.headers['Authorization'] = 'Bearer ' + key
    return session, base


def response_json(response):
    try:
        data = response.json()
    except ValueError:
        raise RuntimeError(f'接口返回非 JSON，HTTP {response.status_code}') from None
    if not 200 <= response.status_code < 300:
        error = data.get('error') or {}
        message = error.get('message', '请求失败') if isinstance(error, dict) else str(error)
        message = re.sub(r'sk-[\w-]+', '[redacted]', message)
        raise APIError(response.status_code, f'HTTP {response.status_code}: {message[:250]}')
    return data
