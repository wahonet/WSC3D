"""Paths shared by reproducible scene and texture authoring recipes."""
from pathlib import Path
import json
import os
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'src/backend'))
from app.resource_paths import resolve_resource

_stones = json.loads((ROOT/'config/catalogue/stones.json').read_text(encoding='utf-8'))
_identities = json.loads((ROOT/'config/catalogue/identities.json').read_text(encoding='utf-8'))
_projects_path=ROOT/'config/authoring-projects.json'
_projects=json.loads(_projects_path.read_text(encoding='utf-8')) if _projects_path.is_file() else {}

def stone_dir(identifier):
    """Accept a stable catalogue ID or an explicitly recorded historical scene ID."""
    rows = _stones.get('stones', _stones) if isinstance(_stones, dict) else _stones
    ids = _identities.get('items', _identities) if isinstance(_identities, dict) else _identities
    canonical = str(identifier)
    for row in ids:
        if isinstance(row,dict) and canonical in {row.get('legacy_id'), row.get('id'), row.get('catalogue_no')}:
            canonical = row.get('catalogue_no') or row.get('id'); break
    for row in rows:
        if row['id'] == canonical:
            return ROOT/'resources/stones'/row['directory']
    # B-3 remains an input to the original courtyard recipes, outside the live catalogue.
    if canonical == 'B-3':
        return ROOT/'resources/reference/unregistered/B-3'
    raise ValueError(f'Unregistered stone: {identifier}')

def stone_file(identifier, relative):
    parts = Path(str(relative).replace('\\','/')).parts
    names = {'meta.json':'metadata/catalogue.json', 'media.json':'metadata/media.json',
             'intro.md':'notes/intro.md', 'research.md':'notes/research.md',
             'photos':'images/photos', 'model':'models/gallery',
             'media':'images'}
    path = stone_dir(identifier)/names.get(parts[0],parts[0])
    for part in parts[1:]: path /= part
    if not path.resolve().is_relative_to(stone_dir(identifier).resolve()):
        raise ValueError('Invalid stone file')
    return resolve_resource(path)

def source_path(value):
    """Resolve provenance inputs from historical recipe manifests explicitly."""
    path = str(value).replace('\\','/')
    if Path(path).is_absolute():
        for marker in ('/wsc-inventory/','/wsc-rebuild/','/inventory/'):
            if marker in path: path=path.split(marker,1)[1]; break
    for prefix in ('inventory/','wsc-inventory/'):
        if path.startswith(prefix): path=path[len(prefix):]
    if path=='data/stones': return ROOT/'resources/stones'
    if path.startswith('data/stones/'):
        _,_,identifier,*parts=path.split('/')
        return stone_file(identifier,'/'.join(parts)) if parts else stone_dir(identifier)
    replacements = {
        'output/':'resources/authoring/', 'web/src/three/':'src/frontend/src/archive/three/',
        'web/public/models/':'resources/scenes/models/', 'web/public/textures/':'resources/scenes/textures/',
        'web/public/tools/':'tools/viewers/placement/', 'web/public/':'src/frontend/public/',
        'data/georeferencing/':'resources/georeferencing/', 'data/sources/':'resources/sources/',
        'data/related_objects/':'resources/related-objects/', 'data/books/':'resources/documents/extension/books/',
        'data/library/':'resources/documents/extension/library/', 'tools/legacy/':'resources/reference/viewers/',
        'scripts/':'tools/authoring/',
    }
    for before,after in replacements.items():
        if path==before.rstrip('/'):path=after.rstrip('/');break
        if path.startswith(before): path=after+path[len(before):]; break
    if path.startswith('resources/authoring/'):
        parts=path.split('/')
        parts[2]=_projects.get(parts[2],parts[2]);path='/'.join(parts)
    result=(ROOT/path).resolve()
    if not result.is_relative_to(ROOT): raise ValueError(f'External recipe input requires an explicit copy: {value}')
    return resolve_resource(result)

def node_binary():
    if os.environ.get('WSC_NODE_BINARY'): return os.environ['WSC_NODE_BINARY']
    sys.path.insert(0,str(ROOT/'tools'))
    from build_frontend import prepare
    return str(prepare()[0])
