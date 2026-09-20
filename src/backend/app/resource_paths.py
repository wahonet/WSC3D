"""Physical files behind logical resource paths, including verified duplicates.

Two catalogue records may refer to identical bytes while keeping separate source
identities. Only the on-disk content is shared; research snapshots stay separate.
"""
from functools import lru_cache
import json
from pathlib import Path
from .config import ROOT

MANIFEST = ROOT / 'config/resource-aliases.json'

@lru_cache(maxsize=1)
def _aliases(stamp: int) -> dict[str, str]:
    if not stamp: return {}
    value = json.loads(MANIFEST.read_text(encoding='utf-8'))
    return {entry['path'].casefold(): entry['target'] for entry in value['aliases']}

def resolve_resource(path: Path) -> Path:
    """A newly supplied file takes precedence over an existing content alias."""
    path = path.resolve()
    root = (ROOT / 'resources').resolve()
    if not path.is_relative_to(root) or path.is_file(): return path
    stamp = MANIFEST.stat().st_mtime_ns if MANIFEST.is_file() else 0
    target = _aliases(stamp).get(path.relative_to(ROOT).as_posix().casefold())
    if not target: return path
    resolved = (ROOT / target).resolve()
    if not resolved.is_relative_to(root): raise ValueError('Invalid resource alias target')
    return resolved
