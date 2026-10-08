"""Refine the delivered courtyard architecture after comparison with the site photos.

The palette is brought closer to 现场参考照片 (weathered dark-grey tiles, darker grey brick
with white joints, faded vermilion) and ridge-end ornaments (鸱尾) plus hip-end beasts
are appended to every main ridge. Existing buffers, nodes, UVs and door extras are left
byte-for-byte; only material factors change and new roof nodes are appended, so the web
loader, roof toggling and interactive doors work as before. Rerunning is a no-op.

Input/Output: resources/scenes/models/courtyard-architecture-20260910.glb
Backup: resources/authoring/courtyard-refine/before/
"""
from __future__ import annotations
from pathlib import Path
import hashlib
import json
import math
import shutil
import struct
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
ASSET = ROOT / 'resources/scenes/models/courtyard-architecture-20260910.glb'
WORK = ROOT / 'resources/authoring/courtyard-refine'
MANIFEST = ROOT / 'src/frontend/src/archive/three/courtyardArchitectureManifest.json'
REVISION = 'refine-20260927-v1'

# sRGB targets for untextured materials, linear multipliers for textured ones.
ABSOLUTE = {'灰陶瓦_0': (72, 76, 75), '灰陶瓦_1': (78, 81, 80), '灰陶瓦_2': (66, 70, 69), '灰陶瓦_3': (84, 87, 85),
            '灰陶瓦_4': (75, 78, 76), '椽下_深棕木': (52, 36, 27)}
MULTIPLY = {'现状_细灰砖_白灰勾缝': (0.74, 0.72, 0.69), '西廊_青砖白缝': (0.86, 0.86, 0.86), '现状_暗朱红木作': (0.88, 0.84, 0.84),
            '阙室_浅灰石柱': (0.95, 0.95, 0.93), '台基_灰色块石': (0.9, 0.9, 0.89)}
# The rear hall (陈列室) is faced with much darker brick than the front hall on the photos.
REAR_BRICK = ('02_后展厅', '现状_细灰砖_白灰勾缝', '后展厅_深灰砖_白灰勾缝', (0.48, 0.48, 0.47))
ROUGHNESS = {'灰陶瓦_': 0.82, '现状_细灰砖_白灰勾缝': 0.9, '西廊_青砖白缝': 0.92, '现状_暗朱红木作': 0.6, '椽下_深棕木': 0.85}

TAIL = [(0, 0), (0.32, 0), (0.4, 0.22), (0.4, 0.5), (0.32, 0.8), (0.16, 1.0), (-0.06, 1.1), (-0.2, 1.02),
        (-0.14, 0.92), (-0.02, 0.84), (0.1, 0.62), (0.08, 0.4), (-0.06, 0.3), (-0.34, 0.28), (-0.4, 0)]
BEAST = [(0, 0), (0.55, 0), (0.62, 0.22), (0.5, 0.5), (0.32, 0.62), (0.18, 0.5), (0.05, 0.42), (-0.2, 0.38), (-0.3, 0)]


def linear(c: float) -> float:
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def read_glb(raw: bytes):
    size = struct.unpack_from('<I', raw, 12)[0]
    doc = json.loads(raw[20:20 + size])
    blob = bytearray(raw[28 + size:])
    return doc, blob


def accessor(doc, blob, index):
    types = {5126: '<f4', 5125: '<u4', 5123: '<u2', 5121: 'u1'}
    width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
    a = doc['accessors'][index]; v = doc['bufferViews'][a['bufferView']]
    dt = np.dtype(types[a['componentType']]); w = width[a['type']]
    return np.ndarray((a['count'], w), dtype=dt, buffer=blob, offset=v.get('byteOffset', 0) + a.get('byteOffset', 0),
                      strides=(v.get('byteStride', dt.itemsize * w), dt.itemsize)).copy()


def append(doc, blob, values, kind, component=5126, target=None):
    values = np.ascontiguousarray(values, dtype={5126: '<f4', 5125: '<u4'}[component])
    blob.extend(b'\0' * ((-len(blob)) % 4))
    offset = len(blob); blob.extend(values.tobytes())
    view = dict(buffer=0, byteOffset=offset, byteLength=values.nbytes)
    if target: view['target'] = target
    doc['bufferViews'].append(view)
    acc = dict(bufferView=len(doc['bufferViews']) - 1, componentType=component, count=len(values), type=kind)
    if kind == 'VEC3':
        acc.update(min=values.min(axis=0).tolist(), max=values.max(axis=0).tolist())
    doc['accessors'].append(acc)
    return len(doc['accessors']) - 1


def extrude(profile, origin, direction, height, half):
    """Profile (u outward along the ridge, w up) extruded sideways; glTF Y-up frame."""
    d = np.array([direction[0], 0, direction[1]], float); d /= np.linalg.norm(d)
    side = np.array([-d[2], 0, d[0]])
    up = np.array([0, 1.0, 0])
    ring = [origin + d * u * height + up * w * height for u, w in profile]
    n = len(ring)
    tris, verts, normals, uvs = [], [], [], []
    def face(pts):
        a, b, c = pts[0], pts[1], pts[2]
        nrm = np.cross(b - a, c - a); nrm /= (np.linalg.norm(nrm) or 1)
        base = len(verts)
        for p in pts:
            verts.append(p); normals.append(nrm); uvs.append((p[0] * 0.8, p[1] * 0.8))
        for k in range(1, len(pts) - 1):
            tris.append((base, base + k, base + k + 1))
    left = [p - side * half for p in ring]; right = [p + side * half for p in ring]
    # side walls are concave; fan from the base midpoint keeps the outline filled
    for pts, flip in ((left, True), (right, False)):
        c = (pts[0] + pts[-1]) / 2
        for k in range(n - 1):
            tri = [c, pts[k], pts[k + 1]]
            face(tri[::-1] if flip else tri)
    for k in range(n):
        j = (k + 1) % n
        face([left[k], left[j], right[j], right[k]])
    return np.array(verts, np.float32), np.array(normals, np.float32), np.array(uvs, np.float32), np.array(tris, np.uint32).reshape(-1, 1)


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    before = WORK / 'before' / ASSET.name
    if not before.exists():
        doc0, _ = read_glb(ASSET.read_bytes())
        if any(n.get('extras', {}).get('ornament') for n in doc0['nodes']):
            raise SystemExit('Refined asset without backup; restore the door-prepared GLB first')
        before.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(ASSET, before)
    # Always regenerate from the door-prepared asset so reruns stay deterministic.
    raw = before.read_bytes()
    doc, blob = read_glb(raw)
    changed = {}
    building, src_name, new_name, factor = REAR_BRICK
    src = next(i for i, m in enumerate(doc['materials']) if m.get('name') == src_name)
    dark = json.loads(json.dumps(doc['materials'][src])); dark['name'] = new_name
    f = dark.setdefault('pbrMetallicRoughness', {}).get('baseColorFactor', [1, 1, 1, 1])
    dark['pbrMetallicRoughness']['baseColorFactor'] = [f[0] * factor[0], f[1] * factor[1], f[2] * factor[2], f[3]]
    doc['materials'].append(dark); dark_index = len(doc['materials']) - 1
    for node in doc['nodes']:
        if node.get('extras', {}).get('building') == building and 'mesh' in node:
            for prim in doc['meshes'][node['mesh']]['primitives']:
                if prim.get('material') == src: prim['material'] = dark_index
    changed[new_name] = dark['pbrMetallicRoughness']['baseColorFactor']
    for m in doc['materials']:
        name = m.get('name', ''); pbr = m.setdefault('pbrMetallicRoughness', {})
        if name in ABSOLUTE:
            pbr['baseColorFactor'] = [*(linear(float(c)) for c in ABSOLUTE[name]), 1.0]
        elif name in MULTIPLY:
            f = pbr.get('baseColorFactor', [1, 1, 1, 1])
            pbr['baseColorFactor'] = [f[0] * MULTIPLY[name][0], f[1] * MULTIPLY[name][1], f[2] * MULTIPLY[name][2], f[3]]
        else:
            continue
        for prefix, rough in ROUGHNESS.items():
            if name.startswith(prefix): pbr['roughnessFactor'] = rough
        changed[name] = pbr['baseColorFactor']
    tile = next(i for i, m in enumerate(doc['materials']) if m.get('name') == '灰陶瓦_0')
    new_nodes, report = [], []
    def add_mesh(label, building, parts):
        verts = np.concatenate([p[0] for p in parts]); normals = np.concatenate([p[1] for p in parts])
        uvs = np.concatenate([p[2] for p in parts]); offset = 0; idx = []
        for p in parts:
            idx.append(p[3] + offset); offset += len(p[0])
        prim = {'attributes': {'POSITION': append(doc, blob, verts, 'VEC3', target=34962),
                               'NORMAL': append(doc, blob, normals, 'VEC3', target=34962),
                               'TEXCOORD_0': append(doc, blob, uvs, 'VEC2', target=34962)},
                'indices': append(doc, blob, np.concatenate(idx), 'SCALAR', 5125, target=34963), 'material': tile}
        doc['meshes'].append({'name': label, 'primitives': [prim]})
        doc['nodes'].append({'name': label, 'mesh': len(doc['meshes']) - 1,
                             'extras': {'building': building, 'arch_role': 'roof', 'ornament': True,
                                        'source': '现场参考照片：正脊两端起翘鸱尾、庑殿垂脊走兽（示意）'}})
        new_nodes.append(len(doc['nodes']) - 1)
    for node in list(doc['nodes']):
        name = node.get('name', '')
        if 'mesh' not in node or ('正脊_砖砌脊座' not in name and '四角垂脊' not in name):
            continue
        assert not any(k in node for k in ('matrix', 'translation', 'rotation', 'scale')), name
        building = node.get('extras', {}).get('building', name.split('_')[0])
        pts = np.concatenate([accessor(doc, blob, p['attributes']['POSITION']) for p in doc['meshes'][node['mesh']]['primitives']])
        xz = pts[:, [0, 2]]; c = xz.mean(axis=0)
        if '正脊_砖砌脊座' in name:
            cov = np.cov((xz - c).T); w, vec = np.linalg.eigh(cov); axis = vec[:, np.argmax(w)]
            proj = (xz - c) @ axis; top = pts[:, 1].max()
            length = proj.max() - proj.min(); height = max(0.55, min(1.25, length * 0.055))
            parts = []
            for end, sgn in ((proj.min(), -1), (proj.max(), 1)):
                direction = axis * sgn
                p = c + axis * end - direction * 0.18 * height
                parts.append(extrude(TAIL, np.array([p[0], top - 0.02, p[1]]), direction, height, 0.13 * height))
            add_mesh(f'{building}_正脊鸱尾_tile0', building, parts)
            report.append({'building': building, 'kind': '鸱尾', 'ridge_length_m': round(float(length), 2), 'height_m': round(height, 2)})
        else:
            parts = []
            for dx, dz in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
                k = np.argmax((xz[:, 0] - c[0]) * dx + (xz[:, 1] - c[1]) * dz)
                foot = pts[k]; out = np.array([foot[0] - c[0], foot[2] - c[1]]); out /= np.linalg.norm(out)
                origin = np.array([foot[0] - out[0] * 1.1, foot[1] + 0.05, foot[2] - out[1] * 1.1])
                parts.append(extrude(BEAST, origin, -out, 0.55, 0.16 * 0.55))
            add_mesh(f'{building}_垂脊走兽_tile0', building, parts)
            report.append({'building': building, 'kind': '垂兽', 'count': 4})
    for scene in doc['scenes']:
        scene['nodes'] = scene['nodes'] + new_nodes
    doc['buffers'][0]['byteLength'] = len(blob)
    encoded = json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8'); encoded += b' ' * ((-len(encoded)) % 4)
    blob.extend(b'\0' * ((-len(blob)) % 4))
    out = struct.pack('<III', 0x46546C67, 2, 28 + len(encoded) + len(blob)) + struct.pack('<I4s', len(encoded), b'JSON') + encoded + struct.pack('<I4s', len(blob), b'BIN\0') + blob
    ASSET.write_bytes(out)
    result = {'revision': REVISION, 'original_sha256': hashlib.sha256(raw).hexdigest(), 'sha256': hashlib.sha256(out).hexdigest(),
              'materials': changed, 'ornaments': report,
              'references': ['resources/reference/现场参考照片/前展厅/武氏墓群石刻阙室展厅外景.JPG',
                             'resources/reference/现场参考照片/后展厅/博物馆陈列室展厅外景.JPG']}
    (WORK / 'refine-report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    data = json.loads(MANIFEST.read_text(encoding='utf-8')); data['asset_revision'] = REVISION
    MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Refined {len(changed)} materials, appended {len(new_nodes)} ornament meshes ({len(out) - len(raw)} bytes).')


if __name__ == '__main__':
    main()
