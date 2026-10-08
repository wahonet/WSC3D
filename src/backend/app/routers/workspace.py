"""Workspace sessions and the default authentication boundary for API writes."""
import hashlib
import hmac
import math
import os
import secrets
import threading
import time

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field
from ..config import settings

router = APIRouter(prefix='/workspace', tags=['工作台'])
COOKIE = 'wsc_workspace'
_sessions: dict[str, float] = {}
_lock = threading.Lock()
_lifetime = 8 * 3600
_failures: dict[str, tuple[int, float]] = {}   # client -> (consecutive failures, locked until)
_max_failures, _lockout = 5, 60


def same_origin(request: Request):
    origin = request.headers.get('origin')
    if origin and origin.rstrip('/') not in {str(request.base_url).rstrip('/'), *settings.cors_origins}:
        raise HTTPException(403, '请从工作台提交请求')
    if request.headers.get('sec-fetch-site') == 'cross-site':
        raise HTTPException(403, '请从工作台提交请求')


def authenticated(request: Request) -> bool:
    token = request.cookies.get(COOKIE, '')
    digest = hashlib.sha256(token.encode()).hexdigest()
    with _lock:
        return bool(token and _sessions.get(digest, 0) > time.monotonic())


def require_workspace(request: Request):
    same_origin(request)
    if not authenticated(request):
        raise HTTPException(401, '请登录工作台')


_PUBLIC_POSTS = frozenset({
    '/api/workspace/login', '/api/workspace/logout', '/api/archive/ask',
    '/api/creative/preview', '/api/creative/works', '/api/creative/handoff', '/api/creative/session/reset',
    '/api/creative/stamps', '/api/creative/prints',
})


def protect_workspace_writes(request: Request):
    """New write routes are private unless explicitly part of a visitor workflow.

    Match the resolved route template, not a URL prefix: creative/admin and
    similarly named routes must not inherit the public creation exemption.
    Public handlers retain their own same-origin and owner-cookie checks.
    """
    if request.method in {'GET', 'HEAD', 'OPTIONS'}:
        return
    route = request.scope.get('route')
    if request.method == 'POST' and getattr(route, 'path', None) in _PUBLIC_POSTS:
        return
    require_workspace(request)


class Login(BaseModel):
    username: str = Field(max_length=80)
    password: str = Field(max_length=512)


@router.post('/login')
def login(body: Login, request: Request, response: Response):
    same_origin(request)
    expected = os.environ.get('WSC_WORKSPACE_PASSWORD', '123456')
    client = request.client.host if request.client else ''
    now = time.monotonic()
    # Check, compare and count under one lock so parallel guesses cannot bypass the limit.
    with _lock:
        failures, until = _failures.get(client, (0, 0))
        if until > now:
            raise HTTPException(429, f'登录失败次数过多，请 {math.ceil(until - now)} 秒后再试')
        if body.username.strip() != 'admin' or not hmac.compare_digest(body.password.encode(), expected.encode()):
            failures = 1 if until else failures + 1   # a served lockout starts a new count
            _failures[client] = (0, now + _lockout) if failures >= _max_failures else (failures, 0)
            raise HTTPException(401, '账号或密码不正确')
        _failures.pop(client, None)
        token = secrets.token_urlsafe(32)
        for key in [key for key, expiry in _sessions.items() if expiry <= now]:
            _sessions.pop(key, None)
        _sessions[hashlib.sha256(token.encode()).hexdigest()] = now + _lifetime
    response.set_cookie(COOKIE, token, max_age=_lifetime, httponly=True, samesite='strict', secure=request.url.scheme == 'https', path='/')
    response.headers['Cache-Control'] = 'no-store'
    return {'authenticated': True, 'username': 'admin'}


@router.get('/session')
def session(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    return {'authenticated': authenticated(request)}


@router.post('/logout')
def logout(request: Request, response: Response):
    same_origin(request)
    with _lock:
        _sessions.pop(hashlib.sha256(request.cookies.get(COOKIE, '').encode()).hexdigest(), None)
    response.delete_cookie(COOKIE, path='/')
    return {'authenticated': False}
