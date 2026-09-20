"""Freeze existing placements and keep the supplied exhibition references."""
import ast
import json
import math
from pathlib import Path
import re
import shutil

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'resources/authoring/rear-hall'
OUT.mkdir(parents=True, exist_ok=True)
files = ['src/frontend/src/archive/three/buildSite.ts', 'src/frontend/src/archive/three/SiteStage.tsx',
         'src/frontend/src/archive/three/courtyardArchitecture.ts', 'src/frontend/vite.config.ts',
         'src/backend/app/routers/rear_layout.py', 'data/layouts/xcl.json']
for relative in files:
    dst = OUT / 'before' / relative
    if not dst.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path(relative), dst)
refs = OUT / 'references'
refs.mkdir(exist_ok=True)
for name in ['3e27298e22eaa5e1da6160aefa6f5b3a.jpg', 'f726b77728a5bc8d218e5e9bfaf60cfe.jpg',
             '31f714ec7b1d5b88904835688306f2f1.jpg', '6d916e36c13fd0ceb29e0273cf49d387.jpg']:
    if not (refs / name).is_file():
        raise FileNotFoundError(f'缺少原始展陈参考照片：{refs / name}')
source = (ROOT / 'src/frontend/src/archive/three/buildSite.ts').read_text(encoding='utf-8')
section = source[source.index("S.name = 'HPS_HALL_IN'"):]
literal = re.search(r'const L = (\[.*?\n    \]);', section, re.S)[1]
rows = ast.literal_eval(re.sub(r'/\*.*?\*/', '', literal, flags=re.S))
catalogue = json.loads((ROOT / 'src/frontend/src/archive/three/catalogueMap.json').read_text(encoding='utf-8'))
ids = {r['legacy_id']: r for r in catalogue['items']}
moves = json.loads((ROOT / 'src/frontend/src/archive/three/courtyardArchitectureManifest.json').read_text(encoding='utf-8'))['stone_movements']
stones = []
for row in rows:
    identity = ids.get(row[9])
    if not identity or row[9] in catalogue['removed']:
        continue
    dx, dy, dz = moves.get(identity['id'], {}).get('world_delta', [0, 0, 0])
    x = row[0] + (dx + dz) * math.sqrt(.5) / .9672
    z = row[2] + (dz - dx) * math.sqrt(.5) / .9672
    if identity['catalogue_no'] in ['武023', '武024']:
        x = 4.54
    stones.append(dict(id=identity['catalogue_no'], name=identity['name'], legacy_id=row[9],
                       x=round(x,6), y=round(row[1]+.3+dy/.9672,6), z=round(z,6),
                       rx=row[3], ry=row[4], rz=row[5], size=row[6:9]))
stones.sort(key=lambda r:r['id'])
assert len(stones) == 46
payload = dict(version='rear-layout-1', coordinateSystem='rear-hall-local-metres',
               updated_at='2026-09-10T16:00:00+00:00', stones=stones)
for relative in ['data/layouts/rear-default.json', 'src/frontend/src/archive/three/rearLayoutDefault.json']:
    (source_path(relative)).write_text(json.dumps(payload, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print('Prepared 46 rear placements; backed up current source and four reference photos.')
