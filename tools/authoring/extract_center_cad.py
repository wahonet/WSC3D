"""Extract registered linework from the 2026-09-25 construction drawings of the heritage centre.

Input : resources/authoring/heritage-center/cad-20260925/sg-20260925.dxf
        (LibreDWG 0.14 dwg2dxf of resources/reference/测绘与CAD/施工图纸/施工图_建筑20260925.dwg)
Output: resources/authoring/heritage-center/cad-20260925/views.json

Every plan view is registered to the centre's local metric frame used by the
V2 placement (origin = main axis × SA, X east, Y north). The S grid is read
from the axis bubbles of each view; the management building's N grid keeps the
V2 site relation (N-grid centre on the main axis, NA at Y = 122.70 m).
"""
from __future__ import annotations
import json, math, re, sys
from collections import Counter, defaultdict
from pathlib import Path
import ezdxf
from ezdxf.math import Vec3

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / 'resources/authoring/heritage-center/cad-20260925'
DXF = WORK / 'sg-20260925.dxf'

S_X = {'S1': -54.6, 'S2': -46.5, 'S3': -38.4, 'S4': -31.8, 'S5': -25.2, 'S6': -19.2, 'S7': -18.3, 'S8': -11.4,
       'S9': -8.7, 'S10': -4.5, 'S11': 4.5, 'S12': 8.7, 'S13': 11.4, 'S14': 18.3, 'S15': 19.2, 'S16': 25.2,
       'S17': 31.8, 'S18': 38.4, 'S19': 46.5, 'S20': 54.6}
S_Y = {'SA': 0, 'SB': 4.8, 'SC': 13.8, 'SD': 22.8, 'SE': 27.0, 'SF': 38.4, 'SG': 46.8, 'SH': 56.7, 'SJ': 65.7,
       'SK': 74.7, 'SL': 83.7, 'SM': 89.7, 'SN': 98.7, 'SP': 104.4}
N_X = {f'N{i}': v for i, v in enumerate([-42.3, -32.3, -21.0, -12.6, -4.5, 4.5, 12.6, 21.0, 27.3, 33.6, 42.3], 1)}
N_Y0 = 122.70
N_Y = {k: N_Y0 + v for k, v in {'NA': 0, 'NB': 8.4, 'NC': 16.8, 'ND': 25.2, 'NE': 33.6, 'NF': 38.4}.items()}

# name: (window in drawing mm x0, y0, x1, y1, grid)
VIEWS = {
    'site':   ((-45000, 15000, 100000, 175000), 'S'),   # -0.450 标高处平面图（地下室顶板）
    'f1':     ((355000, 45000, 505000, 175000), 'S'),
    'f2':     ((660000, 45000, 812000, 175000), 'S'),
    'roof':   ((660000, -228000, 812000, -98000), 'S'),
    'mgmt_f1': ((1012000, 88000, 1142000, 168000), 'N'),
    'mgmt_roof': ((1142000, 88000, 1262000, 168000), 'N'),
}


def bubbles(msp):
    for e in msp.query('INSERT'):
        if e.dxf.name.upper().startswith('_AXIS'):
            vals = [a.dxf.text.strip() for a in e.attribs]
            if vals:
                yield e.dxf.insert.x, e.dxf.insert.y, vals[0]


def register(msp):
    """Least-squares offsets (scale 1 mm) per view from bubble labels."""
    out = {}
    marks = list(bubbles(msp))
    for name, ((x0, y0, x1, y1), grid) in VIEWS.items():
        xs, ys = [], []
        gx, gy = (S_X, S_Y) if grid == 'S' else (N_X, N_Y)
        for x, y, v in marks:
            if not (x0 <= x <= x1 and y0 <= y <= y1):
                continue
            if v in gx:
                xs.append(x / 1000 - gx[v])
            if v in gy:
                ys.append(y / 1000 - gy[v])
        # Bubbles of the same axis at both ends of a grid line agree; take medians.
        ox = sorted(xs)[len(xs) // 2] if xs else None
        oy = sorted(ys)[len(ys) // 2] if ys else None
        spread = (max(xs) - min(xs) if xs else None, max(ys) - min(ys) if ys else None)
        out[name] = {'window': [x0, y0, x1, y1], 'grid': grid, 'offset_m': [ox, oy], 'samples': [len(xs), len(ys)],
                     'spread_m': spread}
    return out


def explode(entity, depth=0):
    t = entity.dxftype()
    if t == 'INSERT' and depth < 4:
        try:
            for v in entity.virtual_entities():
                if v.dxf.layer == '0':
                    v.dxf.layer = entity.dxf.layer
                yield from explode(v, depth + 1)
        except Exception:
            return
    else:
        yield entity


def segments(e):
    t = e.dxftype()
    if t == 'LINE':
        return [[(e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)]]
    if t == 'LWPOLYLINE':
        pts = [(p[0], p[1]) for p in e.get_points('xy')]
        if e.closed and pts:
            pts.append(pts[0])
        return [pts] if len(pts) > 1 else []
    if t == 'POLYLINE':
        pts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
        if e.is_closed and pts:
            pts.append(pts[0])
        return [pts] if len(pts) > 1 else []
    if t in ('ARC', 'CIRCLE'):
        c, r = e.dxf.center, e.dxf.radius
        a0, a1 = (math.radians(e.dxf.start_angle), math.radians(e.dxf.end_angle)) if t == 'ARC' else (0, math.tau)
        if a1 <= a0:
            a1 += math.tau
        n = max(6, int((a1 - a0) / (math.pi / 16)))
        return [[(c.x + r * math.cos(a0 + (a1 - a0) * i / n), c.y + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]]
    if t == 'HATCH':
        out = []
        for path in e.paths:
            try:
                verts = [(v[0], v[1]) for v in path.vertices] if hasattr(path, 'vertices') else []
                if not verts and hasattr(path, 'edges'):
                    for edge in path.edges:
                        if hasattr(edge, 'start') and hasattr(edge, 'end'):
                            verts.extend([(edge.start[0], edge.start[1]), (edge.end[0], edge.end[1])])
                if len(verts) > 1:
                    out.append(verts + [verts[0]])
            except Exception:
                pass
        return out
    if t == 'SOLID':
        pts = [e.dxf.vtx0, e.dxf.vtx1, e.dxf.vtx3, e.dxf.vtx2]
        return [[(p.x, p.y) for p in pts] + [(pts[0].x, pts[0].y)]]
    return []


def main():
    doc = ezdxf.readfile(DXF)
    msp = doc.modelspace()
    reg = register(msp)
    views = {k: {'registration': v, 'lines': defaultdict(list), 'texts': [], 'openings': [], 'columns': []} for k, v in reg.items()}

    def locate(x, y):
        for name, v in reg.items():
            x0, y0, x1, y1 = v['window']
            if x0 <= x <= x1 and y0 <= y <= y1:
                return name
        return None

    def to_local(name, x, y):
        ox, oy = reg[name]['offset_m']
        return [round(x / 1000 - ox, 4), round(y / 1000 - oy, 4)]

    for e in msp:
        t = e.dxftype()
        anchor = None
        if t == 'LINE':
            anchor = e.dxf.start
        elif t in ('LWPOLYLINE',):
            p = next(iter(e.get_points('xy')), None)
            anchor = Vec3(p[0], p[1], 0) if p else None
        elif t in ('INSERT', 'TEXT', 'MTEXT'):
            anchor = e.dxf.insert
        elif t in ('ARC', 'CIRCLE'):
            anchor = e.dxf.center
        elif t == 'HATCH':
            try:
                path = e.paths[0]
                v = path.vertices[0] if hasattr(path, 'vertices') and path.vertices else path.edges[0].start
                anchor = Vec3(v[0], v[1], 0)
            except Exception:
                anchor = None
        elif t == 'DIMENSION':
            anchor = e.dxf.defpoint
        if anchor is None:
            continue
        name = locate(anchor.x, anchor.y)
        if not name:
            continue
        view = views[name]
        layer = e.dxf.layer
        if t in ('TEXT', 'MTEXT'):
            s = e.dxf.text if t == 'TEXT' else e.plain_text()
            h = e.dxf.get('height', 0) if t == 'TEXT' else e.dxf.get('char_height', 0)
            view['texts'].append({'t': s.strip(), 'p': to_local(name, anchor.x, anchor.y), 'h': round(h / 1000, 3), 'layer': layer,
                                  'rot': round(e.dxf.get('rotation', 0), 1)})
            continue
        if t == 'INSERT' and layer in ('WINDOW', 'DOOR_FIRE') and e.dxf.name.upper().startswith(('$TCHSYS$WIN', '$DORLIB2D')):
            view['openings'].append({'block': e.dxf.name, 'layer': layer, 'p': to_local(name, anchor.x, anchor.y),
                                     'rot': round(e.dxf.rotation % 360, 2), 'sx': round(e.dxf.xscale / 1000, 4), 'sy': round(e.dxf.yscale / 1000, 4)})
        if t == 'INSERT' and layer in ('COLUMN', '砼柱', 'COL-S'):
            pts = [p for sub in explode(e) for seg in segments(sub) for p in seg]
            if pts:
                xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
                view['columns'].append({'min': to_local(name, min(xs), min(ys)), 'max': to_local(name, max(xs), max(ys)), 'block': e.dxf.name})
            continue
        if t == 'INSERT' and layer == 'AXIS':
            continue
        for sub in (explode(e) if t == 'INSERT' else [e]):
            if sub.dxftype() in ('TEXT', 'MTEXT', 'ATTRIB'):
                continue
            for seg in segments(sub):
                view['lines'][sub.dxf.layer].append([to_local(name, x, y) for x, y in seg])

    summary = {}
    for name, v in views.items():
        v['lines'] = dict(v['lines'])
        summary[name] = {'registration': v['registration'], 'layers': {k: len(s) for k, s in sorted(v['lines'].items(), key=lambda kv: -len(kv[1]))[:30]},
                         'texts': len(v['texts']), 'openings': len(v['openings']), 'columns': len(v['columns'])}
    payload = {'source': 'resources/reference/测绘与CAD/施工图纸/施工图_建筑20260925.dwg', 'converter': 'LibreDWG 0.14 dwg2dxf',
               'frame': 'centre local metres: origin main axis × SA, X east, Y north', 'n_grid_origin_y': N_Y0, 'views': views}
    (WORK / 'views.json').write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
