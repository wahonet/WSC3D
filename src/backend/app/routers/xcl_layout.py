"""West-gallery placement, independent of catalogue identity and measured sizes."""
from pathlib import Path
from datetime import datetime, timezone
import json, math, os, shutil, threading
from fastapi import APIRouter, HTTPException

from ..config import settings
FOLDER = settings.layouts_dir
CURRENT = FOLDER/'xcl.json'
DEFAULT = FOLDER/'xcl-default.json'
LOCK = threading.Lock()
router = APIRouter()

def read_layout():
    return json.loads((CURRENT if CURRENT.exists() else DEFAULT).read_text(encoding='utf-8'))

def validate_layout(payload):
    defaults = json.loads(DEFAULT.read_text(encoding='utf-8'))['stones']
    by_id = {s['id']:s for s in defaults}
    rows = payload.get('stones') if isinstance(payload,dict) else None
    if not isinstance(rows,list) or len(rows)!=len(defaults):
        raise ValueError('布局必须包含西长廊全部40件石刻。')
    seen, result = set(), []
    for row in rows:
        sid = row.get('id') if isinstance(row,dict) else None
        if sid not in by_id or sid in seen:
            raise ValueError('编号缺失、重复或不属于西长廊，请使用当前摆放工具导出。')
        seen.add(sid)
        d = by_id[sid].copy()
        if row.get('wall',d['wall'])!=d['wall']:
            raise ValueError(f'{sid} 的所属墙面不符。')
        limits={'L':(.01,10),'H':(.01,10),'T':(.01,3),
                'along':(-.5,26.4 if d['wall']=='W' else 4.7),
                'off':(0,4.2 if d['wall']=='W' else 25.9),'y':(0,8),'rotY':(-100,100)}
        for key,(lo,hi) in limits.items():
            value = row.get(key,0 if key=='rotY' else None)
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not lo<=value<=hi:
                raise ValueError(f'{sid} 的 {key} 数值无效（允许 {lo}—{hi} 米，转角为弧度）。')
            if key in ('L','H','T') and d.get('sizeRevision') and row.get('sizeRevision')!=d['sizeRevision']:
                value=d[key]  # Old browser saves cannot restore superseded estimated dimensions.
            d[key]=round(float(value),6)
        result.append(d)
    result.sort(key=lambda s:s['id'])
    return dict(version='xcl-layout-2',updated_at=datetime.now(timezone.utc).isoformat(),stones=result)

@router.get('/api/layouts/xcl')
def get_layout():
    with LOCK:
        return read_layout()

@router.post('/api/layouts/xcl')
def apply_layout(payload: dict):
    try:
        value=validate_layout(payload)
    except ValueError as error:
        raise HTTPException(status_code=422,detail=str(error)) from error
    with LOCK:
        current = read_layout()
        if payload.get('base_updated_at') != current['updated_at']:
            raise HTTPException(status_code=409, detail='主平台布局已更新，请先导出当前调整作备份，再重新载入平台布局。')
        FOLDER.mkdir(parents=True,exist_ok=True)
        history=FOLDER/'history'; history.mkdir(exist_ok=True)
        stamp=datetime.now().strftime('%Y%m%d-%H%M%S-%f')
        shutil.copy2(CURRENT if CURRENT.exists() else DEFAULT,history/f'xcl-{stamp}.json')
        temp=CURRENT.with_suffix('.tmp')
        temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
        os.replace(temp,CURRENT)
    return {'ok':True,'count':len(value['stones']),'updated_at':value['updated_at']}
