"""Physical files behind logical resource paths, including verified duplicates.

Two catalogue records may refer to identical bytes while keeping separate source
identities. Only the on-disk content is shared; research snapshots stay separate.
"""
from functools import lru_cache
import json
from pathlib import Path
from .config import ROOT
from . import resource_archives

MANIFEST = ROOT / 'config/resource-aliases.json'

@lru_cache(maxsize=1)
def _aliases(stamp: int) -> dict[str, str]:
    if not stamp: return {}
    value = json.loads(MANIFEST.read_text(encoding='utf-8'))
    return {entry['path'].casefold(): entry['target'] for entry in value['aliases']}

def canonical_resource_path(path: Path) -> Path:
    """Resolve aliases without materializing archived originals."""
    path = path.resolve()
    root = (ROOT / 'resources').resolve()
    if not path.is_relative_to(root) or path.is_file(): return path
    stamp = MANIFEST.stat().st_mtime_ns if MANIFEST.is_file() else 0
    target = _aliases(stamp).get(path.relative_to(ROOT).as_posix().casefold())
    if not target: return path
    resolved = (ROOT / target).resolve()
    if not resolved.is_relative_to(root): raise ValueError('Invalid resource alias target')
    return resolved


def resolve_resource(path: Path) -> Path:
    """Physical originals override aliases and losslessly packed originals."""
    return resource_archives.extract_resource(canonical_resource_path(path), ROOT)


def logical_resource_path(path: Path) -> Path:
    return resource_archives.logical_resource_path(path, ROOT)


def resource_metadata(path: Path) -> dict | None:
    return resource_archives.archive_entry(canonical_resource_path(path), ROOT)


def verify_resource_archives(paths) -> None:
    resource_archives.verify_archives((canonical_resource_path(path) for path in paths), ROOT)


def resource_exists(path: Path) -> bool:
    path = canonical_resource_path(path)
    try:
        return path.is_file() or resource_archives.archive_entry(path, ROOT) is not None
    except FileNotFoundError:
        return False


def iter_resource_files(directory: Path):
    directory = directory.resolve()
    seen = set()
    if directory.is_dir():
        for path in sorted(directory.rglob('*')):
            if path.is_file():
                seen.add(str(path.resolve()).casefold())
                yield path
    try:
        prefix = directory.relative_to(ROOT.resolve()).as_posix().casefold() + '/'
    except ValueError:
        return
    for name in sorted(resource_archives.archived_entries(ROOT)):
        if not name.casefold().startswith(prefix):
            continue
        path = (ROOT / name).resolve()
        if path.is_relative_to(directory) and str(path).casefold() not in seen:
            resource_archives.archive_entry(path, ROOT)
            yield path
