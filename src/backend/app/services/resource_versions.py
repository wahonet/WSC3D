"""Pin geometry to a verified original file, independently of mutable filenames."""
from datetime import datetime
import hashlib
import json
from pathlib import Path
import shutil
from fastapi import HTTPException
from sqlalchemy import text
from ..config import settings

def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def snapshot_path(data) -> Path:
    """Snapshots use workspace-relative paths within each stone's folder."""
    path = (settings.root / str(data.get('path', ''))).resolve()
    if not path.is_relative_to(settings.assets_root.resolve()):
        raise HTTPException(409, '研究底图快照路径不合法')
    return path

def pin_asset(db, asset):
    row = db.execute(text("SELECT payload FROM asset_versions WHERE asset_id=:id ORDER BY id DESC"), {'id': asset.id}).fetchall()
    for saved in row:
        data = json.loads(saved[0])
        if data.get('kind') == 'research-base' and data.get('sha256') == asset.sha256:
            if snapshot_path(data).is_file():
                return data
            raise HTTPException(409, '研究底图快照缺失，请恢复资源备份后继续编辑')
    from .resources import live_asset_path
    original = live_asset_path(asset.relpath)
    sha = digest(original)
    if asset.sha256 and asset.sha256 != sha:
        raise HTTPException(409, '原文件已被替换，请先检查资源并建立新图像版本')
    target = settings.assets_root / asset.stone.dirname / 'versions' / str(asset.id) / sha / asset.filename
    target.parent.mkdir(parents=True, exist_ok=True)
    if asset.is_model:
        shutil.copytree(original.parent, target.parent, dirs_exist_ok=True)
    else:
        shutil.copy2(original, target)
    if digest(target) != sha:
        raise HTTPException(500, '研究底图备份校验失败')
    data = {'kind': 'research-base', 'sha256': sha, 'path': target.relative_to(settings.root).as_posix(), 'relpath': asset.relpath,
            'width': asset.width, 'height': asset.height, 'bytes': asset.bytes}
    db.execute(text('INSERT INTO asset_versions(asset_id,payload,created_at) VALUES(:id,:payload,:created)'),
               {'id': asset.id, 'payload': json.dumps(data,ensure_ascii=False), 'created': datetime.now().isoformat()})
    asset.sha256 = sha
    return data
