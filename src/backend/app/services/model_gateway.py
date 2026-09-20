"""Online-first chat with a project-owned Ollama fallback and secret-safe settings."""
import base64
import copy
import ctypes
import http.client
import json
import os
from pathlib import Path
import socket
import threading
import time
from urllib.parse import urlsplit

from ..config import settings
BASE = settings.root
CONFIG_PATH = BASE / 'config' / 'rag_config.json'
PROVIDERS = {
    'deepseek': {'label': 'DeepSeek', 'api_base': 'https://api.deepseek.com',
                 'model': 'deepseek-v4-flash', 'models': ['deepseek-v4-flash', 'deepseek-v4-pro'],
                 'help_url': 'https://api-docs.deepseek.com/'},
    'siliconflow': {'label': '硅基流动', 'api_base': 'https://api.siliconflow.cn/v1',
                   'model': 'deepseek-ai/DeepSeek-V3.2', 'models': ['deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3.5-397B-A17B'],
                   'help_url': 'https://docs.siliconflow.cn/docs/userguide/quickstart'},
    'volcengine': {'label': '火山方舟', 'api_base': 'https://ark.cn-beijing.volces.com/api/v3',
                  'model': '', 'models': [], 'help_url': 'https://www.volcengine.com/docs/82379/1795150'},
    'custom': {'label': '其他兼容接口', 'api_base': '', 'model': '', 'models': [], 'help_url': ''},
}
_lock = threading.RLock()
_cooldown = {}  # Failed endpoints get a short pause; changing settings retries immediately.


def load_config():
    path = CONFIG_PATH if CONFIG_PATH.exists() else BASE / 'rag_config.json'
    cfg = {'api_base': 'http://127.0.0.1:11436/v1', 'api_key': 'ollama-local',
           'chat_model': '', 'temperature': .2, 'chat_context_length': 16384}
    if path.exists():
        cfg.update(json.loads(path.read_text(encoding='utf-8-sig')))
    for key, env in [('api_base', 'RAG_API_BASE'), ('api_key', 'RAG_API_KEY'), ('chat_model', 'RAG_CHAT_MODEL')]:
        if os.environ.get(env):
            cfg[key] = os.environ[env]
    online = cfg.setdefault('online', {})
    online.setdefault('mode', 'online_first')
    online.setdefault('provider', 'deepseek')
    profiles = online.setdefault('profiles', {})
    for key, preset in PROVIDERS.items():
        profile = profiles.setdefault(key, {})
        profile.setdefault('api_base', preset['api_base'])
        profile.setdefault('model', preset['model'])
    return cfg


def _protect(text, decrypt=False):
    """DPAPI binds credentials to the current Windows account, not the browser."""
    if os.name != 'nt':
        raise ValueError('此版本的密钥保存需要 Windows DPAPI')
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    raw = base64.b64decode(text) if decrypt else text.encode('utf-8')
    buffer = ctypes.create_string_buffer(raw)
    source = Blob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    result = Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    fn = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    fn.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                   ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    fn.restype = wintypes.BOOL
    if not fn(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise ValueError('无法读取密钥，请在当前 Windows 账户下重新填写')
    try:
        value = ctypes.string_at(result.data, result.size)
        return value.decode('utf-8') if decrypt else base64.b64encode(value).decode('ascii')
    finally:
        kernel.LocalFree(ctypes.cast(result.data, ctypes.c_void_p))


def _key(profile):
    return _protect(profile['key_ciphertext'], True) if profile.get('key_ciphertext') else ''


def _base(value):
    value = str(value).strip().rstrip('/')
    if not value:
        return ''
    u = urlsplit(value)
    try:
        u.port
    except ValueError:
        raise ValueError('API 地址端口不正确') from None
    if u.scheme not in ('https', 'http') or not u.hostname or u.username or u.password or u.query or u.fragment:
        raise ValueError('请填写完整的 API Base URL，不能包含密钥、查询参数或账号密码')
    if u.scheme == 'http' and u.hostname not in ('localhost', '127.0.0.1', '::1'):
        raise ValueError('在线 API 地址必须使用 HTTPS')
    if u.path.endswith('/chat/completions'):
        value = value[:-len('/chat/completions')]
    return value


def public_settings(cfg=None, local_models=False):
    cfg = cfg or load_config()
    online = cfg['online']
    profiles = {key: {**preset, 'api_base': online['profiles'][key]['api_base'],
                     'model': online['profiles'][key]['model'],
                     'has_key': bool(online['profiles'][key].get('key_ciphertext'))}
                for key, preset in PROVIDERS.items()}
    local = {'model': cfg['chat_model'], 'api_base': cfg['api_base'], 'models': [], 'available': None}
    if local_models:
        try:
            data = _request(cfg['api_base'].removesuffix('/v1'), '/api/tags', None, '', 2)
            local['models'] = [m['name'] for m in data.get('models', [])]
            local['available'] = cfg['chat_model'] in local['models']
        except GatewayError:
            local['available'] = False
    return {'mode': online['mode'], 'provider': online['provider'], 'profiles': profiles, 'local': local}


def model_status(cfg=None):
    cfg = cfg or load_config()
    online = cfg['online']
    profile = online['profiles'][online['provider']]
    ready = bool(profile.get('key_ciphertext') and profile['model'] and profile['api_base'])
    active = online['mode'] == 'online_first' and ready
    return {'llm': active or bool(cfg['chat_model']), 'model': profile['model'] if active else cfg['chat_model'],
            'model_mode': online['mode'], 'online_configured': ready,
            'model_provider': PROVIDERS[online['provider']]['label'] if active else '本地 Ollama',
            'local_model': cfg['chat_model']}


def updated_config(body):
    cfg = copy.deepcopy(load_config())
    mode = body.get('mode', cfg['online']['mode'])
    provider = body.get('provider', cfg['online']['provider'])
    if mode not in ('online_first', 'local_only') or provider not in PROVIDERS:
        raise ValueError('无效的模型模式或平台')
    cfg['online'].update(mode=mode, provider=provider)
    changes = body.get('profiles', {})
    if not isinstance(changes, dict):
        raise ValueError('平台配置格式不正确')
    for name, change in changes.items():
        if name not in PROVIDERS or not isinstance(change, dict):
            raise ValueError('无效的平台配置')
        p = cfg['online']['profiles'][name]
        base = _base(change.get('api_base', p['api_base']))
        # Never reuse an existing key at a newly typed endpoint.
        if base != p['api_base'] or change.get('clear_key'):
            p.pop('key_ciphertext', None)
        p['api_base'] = base
        p['model'] = str(change.get('model', p['model'])).strip()[:200]
        secret = str(change.get('api_key', '')).strip()
        if secret:
            if len(secret) > 8192 or not secret.isascii() or any(c.isspace() for c in secret):
                raise ValueError('API Key 格式不正确')
            p['key_ciphertext'] = _protect(secret)
    if 'local_model' in body:
        name = str(body['local_model']).strip()
        installed = public_settings(cfg, local_models=True)['local']['models']
        if name not in installed:
            raise ValueError('请选择已安装的本地模型')
        cfg['chat_model'] = name
    return cfg


def save_settings(body):
    with _lock:
        cfg = updated_config(body)
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_PATH.with_suffix('.tmp')
        tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        os.replace(tmp, CONFIG_PATH)
        _cooldown.clear()
        return public_settings(cfg)


class GatewayError(Exception):
    pass


def _request(base, path, body, key, read_timeout=90):
    u = urlsplit(base)
    cls = http.client.HTTPSConnection if u.scheme == 'https' else http.client.HTTPConnection
    conn = cls(u.hostname, u.port, timeout=4)
    headers = {'Content-Type': 'application/json'}
    if key:
        headers['Authorization'] = 'Bearer ' + key
    try:
        conn.connect()
        conn.sock.settimeout(read_timeout)
        conn.request('POST' if body is not None else 'GET', u.path.rstrip('/') + path,
                     json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None, headers)
        response = conn.getresponse()
        if response.status >= 300:
            reason = {401: '密钥无效', 403: '接口权限不足', 404: '地址或模型不存在',
                      429: '额度不足或请求限流'}.get(response.status, '平台服务暂不可用')
            raise GatewayError(f'{reason}（HTTP {response.status}）')
        data = response.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise GatewayError('接口响应过大')
        return json.loads(data)
    except (TimeoutError, socket.timeout):
        raise GatewayError('连接或响应超时') from None
    except (OSError, http.client.HTTPException):
        raise GatewayError('网络连接不可用') from None
    except (ValueError, KeyError, TypeError):
        raise GatewayError('接口返回格式不正确') from None
    finally:
        conn.close()


def _chat(cfg, messages, online, test=False):
    if online:
        provider = cfg['online']['provider']
        profile = cfg['online']['profiles'][provider]
        try:
            secret = _key(profile)
        except ValueError as exc:
            raise GatewayError(str(exc)) from None
        if not secret or not profile['api_base'] or not profile['model']:
            raise GatewayError('在线平台尚未填写密钥、地址或模型')
        body = {'model': profile['model'], 'messages': messages, 'stream': False,
                'max_tokens': 128 if test else 2000, 'temperature': cfg.get('temperature', .2)}
        if provider in ('deepseek', 'volcengine'):
            body['thinking'] = {'type': 'disabled'}
        if provider == 'siliconflow':
            body['enable_thinking'] = False
        data = _request(profile['api_base'], '/chat/completions', body, secret)
        try:
            answer = data['choices'][0]['message']['content']
        except (KeyError, IndexError, TypeError):
            raise GatewayError('接口未返回回答正文') from None
        model, label = profile['model'], PROVIDERS[provider]['label']
    else:
        if not cfg['chat_model']:
            raise GatewayError('未安装本地问答模型')
        # Native Ollama explicitly disables hidden thinking and bounds the GPU context.
        body = {'model': cfg['chat_model'], 'messages': messages, 'stream': False, 'think': False,
                'keep_alive': '5m', 'options': {'temperature': cfg.get('temperature', .2),
                    'num_ctx': int(cfg.get('chat_context_length', 16384)), 'num_predict': 128 if test else 2000}}
        from .gpu import lease
        with lease('ollama'):
            data = _request(cfg['api_base'].removesuffix('/v1'), '/api/chat', body, cfg.get('api_key', ''), 180)
        answer = (data.get('message') or {}).get('content')
        model, label = cfg['chat_model'], '本地 Ollama'
    if not isinstance(answer, str) or not answer.strip():
        raise GatewayError('接口未返回回答正文')
    return {'answer': answer.strip(), 'model': model, 'provider': label, 'route': 'online' if online else 'local'}


def answer(messages, cfg=None):
    cfg = cfg or load_config()
    notice = ''
    if cfg['online']['mode'] == 'online_first':
        p = cfg['online']['profiles'][cfg['online']['provider']]
        endpoint = (cfg['online']['provider'], p['api_base'], p['model'])
        try:
            with _lock:
                until, previous = _cooldown.get(endpoint, (0, ''))
            if time.monotonic() < until:
                raise GatewayError(previous)
            result = _chat(cfg, messages, True)
            return {**result, 'notice': ''}
        except GatewayError as exc:
            notice = f'{exc}，已使用本地模型兜底。'
            with _lock:
                _cooldown[endpoint] = (time.monotonic() + 30, str(exc))
    try:
        return {**_chat(cfg, messages, False), 'notice': notice}
    except GatewayError as exc:
        return {'answer': None, 'model': cfg['chat_model'], 'provider': '本地 Ollama', 'route': 'unavailable',
                'notice': notice.replace('已使用本地模型兜底。', '正在尝试本地模型。') + f'本地模型不可用：{exc}。请查阅下方检索证据。'}


def test_connection(body):
    cfg = updated_config(body)
    started = time.monotonic()
    try:
        result = _chat(cfg, [{'role': 'user', 'content': '请只回复：连接成功'}], body.get('target') != 'local', True)
        with _lock:
            _cooldown.clear()
        return {'ok': True, 'model': result['model'], 'route': result['route'],
                'message': f"{result['provider']}连接成功", 'elapsed_ms': round((time.monotonic()-started)*1000)}
    except GatewayError as exc:
        return {'ok': False, 'message': str(exc), 'elapsed_ms': round((time.monotonic()-started)*1000)}
