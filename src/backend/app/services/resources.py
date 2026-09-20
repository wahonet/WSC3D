"""Resolve catalogue assets and immutable research versions inside owned roots."""
from pathlib import Path
from fastapi import HTTPException
from ..config import settings
from ..resource_paths import resolve_resource


def within(root: Path, relative: str) -> Path:
    root = root.resolve()
    path = (root / relative).resolve()
    if root not in path.parents:
        raise HTTPException(404, "资源文件不存在或路径不合法")
    path = resolve_resource(path)
    if not path.is_file():
        raise HTTPException(404, "资源文件不存在或路径不合法")
    return path


def live_asset_path(relative: str) -> Path:
    return within(settings.assets_root, relative)


def asset_path(relative: str) -> Path:
    import sqlite3
    import json
    from contextlib import closing
    with closing(sqlite3.connect(settings.db_path)) as db:
        rows = db.execute('SELECT v.payload FROM asset_versions v JOIN assets a ON a.id=v.asset_id WHERE a.relpath=? ORDER BY v.id DESC', (relative,)).fetchall()
    from .resource_versions import snapshot_path
    for row in rows:
        data = json.loads(row[0])
        if data.get('kind') == 'research-base':
            root = settings.assets_root
            return within(root, str(snapshot_path(data).relative_to(root)))
    return live_asset_path(relative)
