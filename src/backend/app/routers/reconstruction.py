"""Reviewed reconstruction packages, kept separate from collection originals/layouts."""
from __future__ import annotations

import json
import mimetypes
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse

from ..config import settings
from .workspace import require_workspace

ROOT = settings.resources_dir / 'authoring/reconstruction'
router = APIRouter(prefix='/api/reconstruction', tags=['三维复原'], dependencies=[Depends(require_workspace)])
CASE_ID = re.compile(r'^[a-z0-9][a-z0-9-]{0,79}$')


def case_folder(case_id: str) -> Path:
    if not CASE_ID.fullmatch(case_id):
        raise HTTPException(404, '复原项目不存在')
    path = (ROOT / case_id).resolve()
    if not path.is_relative_to(ROOT.resolve()) or not path.is_dir():
        raise HTTPException(404, '复原项目不存在')
    return path


def manifest(case_id: str) -> dict:
    folder = case_folder(case_id)
    path = (folder / 'manifest.json').resolve()
    if not path.is_relative_to(folder) or not path.is_file():
        raise HTTPException(404, '复原项目清单尚未就绪')
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        if (not isinstance(data, dict) or data.get('schemaVersion') != 1 or data.get('id') != case_id
                or not isinstance(data.get('publishedFiles'), list) or not isinstance(data.get('parts'), list)
                or not all(isinstance(f, str) for f in data['publishedFiles'])):
            raise ValueError('Invalid reconstruction manifest')
        return data
    except (OSError, ValueError) as exc:
        raise HTTPException(409, '复原项目清单损坏，请检查研究目录') from exc


@router.get('')
def list_cases():
    cases, errors = [], []
    if ROOT.is_dir():
        for folder in sorted(ROOT.iterdir(), reverse=True):
            if not folder.is_dir() or not CASE_ID.fullmatch(folder.name):
                continue
            try:
                data = manifest(folder.name)
                cases.append({k: data.get(k) for k in ('id', 'title', 'version', 'date', 'status', 'description', 'sortOrder')})
            except HTTPException:
                errors.append({'id': folder.name, 'message': '项目清单不可读'})
    cases.sort(key=lambda c: (c.get('sortOrder') or 0, c.get('date') or '', c['id']), reverse=True)
    return {'cases': cases, 'errors': errors}


@router.get('/{case_id}')
def get_case(case_id: str):
    return manifest(case_id)


@router.get('/{case_id}/files/{file_path:path}')
def get_file(case_id: str, file_path: str, download: bool = Query(False)):
    data = manifest(case_id)
    if file_path not in data['publishedFiles']:
        raise HTTPException(404, '该文件未列入复原成果')
    folder = case_folder(case_id)
    path = (folder / file_path).resolve()
    if not path.is_relative_to(folder) or not path.is_file():
        raise HTTPException(404, '复原文件缺失，请检查研究目录')
    media_type = {'glb': 'model/gltf-binary', 'md': 'text/plain', 'blend': 'application/octet-stream'}.get(path.suffix[1:])
    media_type = media_type or mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    return FileResponse(path, media_type=media_type, filename=path.name if download else None,
                        headers={'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})
