"""Rear hall placements: absolute transforms, immutable catalogue identities."""
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import shutil
import threading
from fastapi import APIRouter, HTTPException

from ..config import settings
FOLDER = settings.layouts_dir
CURRENT = FOLDER / 'rear.json'
DEFAULT = FOLDER / 'rear-default.json'
LOCK = threading.Lock()
router = APIRouter()


def read_layout():
    return json.loads((CURRENT if CURRENT.exists() else DEFAULT).read_text(encoding='utf-8'))


def validate_layout(payload):
    defaults = json.loads(DEFAULT.read_text(encoding='utf-8'))['stones']
    identities = {r['id']: r for r in defaults}
    rows = payload.get('stones') if isinstance(payload, dict) else None
    if not isinstance(rows, list) or len(rows) != len(defaults):
        raise ValueError('布局必须包含后展厅全部46件石刻。')
    result, seen = [], set()
    for row in rows:
        sid = row.get('id') if isinstance(row, dict) else None
        if sid not in identities or sid in seen:
            raise ValueError('文物编号缺失、重复或不属于后展厅。')
        seen.add(sid)
        item = identities[sid].copy()
        for key, (low, high) in dict(x=(-5.22, 5.22), y=(.3, 4.3), z=(-9.95, 9.95),
                                     rx=(-100, 100), ry=(-100, 100), rz=(-100, 100)).items():
            value = row.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
                raise ValueError(f'{sid} 的 {key} 无效（允许 {low}—{high}）。')
            item[key] = round(float(value), 6)
        result.append(item)
    return dict(version='rear-layout-1', coordinateSystem='rear-hall-local-metres',
                updated_at=datetime.now(timezone.utc).isoformat(), stones=sorted(result, key=lambda r:r['id']))


@router.get('/api/layouts/rear')
def get_layout():
    with LOCK:
        return read_layout()


@router.post('/api/layouts/rear')
def apply_layout(payload: dict):
    try:
        result = validate_layout(payload)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    with LOCK:
        current = read_layout()
        if payload.get('base_updated_at') != current['updated_at']:
            raise HTTPException(status_code=409, detail='主平台布局已更新，请先导出当前调整作备份，再重新载入平台布局。')
        history = FOLDER / 'history'
        history.mkdir(exist_ok=True)
        shutil.copy2(CURRENT if CURRENT.exists() else DEFAULT,
                     history / f'rear-{datetime.now():%Y%m%d-%H%M%S-%f}.json')
        temp = CURRENT.with_suffix('.tmp')
        temp.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        os.replace(temp, CURRENT)
    return {'ok': True, 'count': len(result['stones']), 'updated_at': result['updated_at']}
