"""Extract the structural, HVAC, plumbing and landscape drawings of the heritage centre.

Inputs (LibreDWG 0.14 dwg2dxf of resources/reference/测绘与CAD/施工图纸/, written to
resources/authoring/heritage-center/cad-20260925/):
  structure.dxf   结构施工图260925.dwg            columns, beams and basement walls per storey
  hvac.dxf        武氏祠暖通施工图.dwg             ducts, smoke extraction and air-conditioning units
  plumbing.dxf    …给排水施工图-W.dwg              water, drainage, rain and sprinkler pipes
  land-base.dxf   9.24武氏祠景观施工图/土建/底图base.dwg   planted areas, paving, 用地红线 (layer JZD)
  planting.dxf    9.24武氏祠景观施工图/绿化/P2.01…dwg      trees by species and shrub masses
Output: resources/authoring/heritage-center/cad-20260925/disciplines.json (build_center_project_blender.py)
        src/frontend/src/center/centerRedline.json (the module's red-line overlay)

The engineering plans are drawn on the same S grid as the architectural set and are registered by
their axis bubbles (extract_center_cad.py). The landscape drawings are in CGCS2000 3° zone 39
coordinates and are brought into the centre frame with the placement's world origin and rotation;
everything planted or paved is clipped to the centre's 用地红线, so the neighbouring plots stay empty.
Duct and pipe runs are rasterised per system and storey and returned as rectangles, so double-line
ducts become solid runs. Run with --preview DIR to write PNG overlays.
"""
from __future__ import annotations
import argparse, json, math, re
from collections import defaultdict
from pathlib import Path
import numpy as np
import ezdxf
from ezdxf import bbox as ezbbox
from ezdxf import path as ezpath
from PIL import Image, ImageDraw
from shapely.geometry import Point, Polygon
from extract_center_cad import S_X, S_Y, bubbles, explode, segments
from derive_center_floors import walls, dilate, rectangles

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / 'resources/authoring/heritage-center/cad-20260925'
PLACEMENT = json.loads((ROOT / 'resources/georeferencing/hanwenhua-center-placement.json').read_text(encoding='utf-8'))
OUT = WORK / 'disciplines.json'
REDLINE_OUT = ROOT / 'src/frontend/src/center/centerRedline.json'

# drawing windows (mm) of the registered plan views
STRUCTURE = {
    'found': (371000, 136000, 515000, 278000),     # 基础结构平面图: raft levels, basement walls
    'col_B1': (371000, -80000, 515000, 62000),     # 基础~一层楼面竖向构件
    'col_F1': (571000, -80000, 715000, 62000),     # 一层~二层楼面竖向构件
    'col_F2': (771000, -36000, 915000, 62000),     # 二层楼面~屋面竖向构件
    'beam_B1': (571000, 136000, 715000, 278000),   # 一层结构平面图: beams under the ground-floor slab
    'beam_F1': (771000, 136000, 915000, 278000),   # 二层结构平面图
    'beam_F2': (971000, 136000, 1117000, 278000),  # 屋面结构平面图
}
MEP_VIEWS = {
    'hvac': {'B1': (85000, 33000, 226000, 191000), 'F1': (347000, 37000, 511000, 182000), 'F2': (654000, 38000, 818000, 170000)},
    'plumbing': {'B1': (85000, 33000, 226000, 191000), 'F1': (347000, 37000, 511000, 182000), 'F2': (654000, 38000, 818000, 170000),
                 'spr_B1': (85000, -167000, 226000, -8000), 'spr_F1': (347000, -162000, 511000, -17000),
                 'spr_F2': (654000, -161000, 818000, -29000)},
}
# system: (drawing, layers, closing radius m, label). Closing fills double-line ducts; single lines stay pipes.
SYSTEMS = {
    'supply': ('hvac', {'DUCT-送风管'}, 0.5, '空调送风管'),
    'exhaust': ('hvac', {'L-排风'}, 0.5, '排风管'),
    'smoke': ('hvac', {'L-消防', 'L-正压送风'}, 0.5, '排烟及正压送风管'),
    'ac': ('hvac', {'L-空调设备'}, 0.2, '空调室内机及冷媒管'),
    'water': ('plumbing', {'WP_G', 'WP_S'}, 0.0, '给水管'),
    'drain': ('plumbing', {'WP_F', 'WP_YF', 'WP_P', 'WP_T'}, 0.0, '排水管'),
    'rain': ('plumbing', {'WP_Y'}, 0.0, '雨水管'),
    'sprinkler': ('plumbing', {'WP_L', 'WP_L1'}, 0.0, '消防喷淋管'),
}
MEP_CELL = 0.1
MEP_BOX = (-62, -8, 62, 112)

# landscape
LAND_BOX = (-150, -175, 160, 320)
TREE_LAYERS = {'02-乔木', '0', '02-灌木色块'}
SHRUB_MAX_AREA = 2500.0    # larger outlines on the shrub layer are planting-bed boundaries, not masses
# 界址点 polyline of the centre plot; the drawing holds shifted copies of it, the registered one starts at plot_nw
REDLINE_LAYER = 'JZD'


def grid_register(msp, windows):
    marks = list(bubbles(msp))
    out = {}
    for name, (x0, y0, x1, y1) in windows.items():
        xs = sorted(x / 1000 - S_X[v] for x, y, v in marks if x0 <= x <= x1 and y0 <= y <= y1 and v in S_X)
        ys = sorted(y / 1000 - S_Y[v] for x, y, v in marks if x0 <= x <= x1 and y0 <= y <= y1 and v in S_Y)
        if not xs or not ys:
            raise SystemExit(f'{name}: no axis bubbles in {x0, y0, x1, y1}')
        out[name] = {'window': [x0, y0, x1, y1], 'offset_m': [xs[len(xs) // 2], ys[len(ys) // 2]],
                     'spread_m': [round(xs[-1] - xs[0], 3), round(ys[-1] - ys[0], 3)], 'samples': [len(xs), len(ys)]}
    return out


def anchor(e):
    t = e.dxftype()
    try:
        if t == 'LINE': return e.dxf.start
        if t == 'LWPOLYLINE':
            p = next(iter(e.get_points('xy')), None)
            return ezdxf.math.Vec3(p[0], p[1], 0) if p else None
        if t in ('INSERT', 'TEXT', 'MTEXT'): return e.dxf.insert
        if t in ('ARC', 'CIRCLE'): return e.dxf.center
        if t == 'POLYLINE':
            return next(iter(e.vertices)).dxf.location
    except Exception:
        return None
    return None


def collect(msp, reg, keep):
    """Polylines per view and layer (local metres) for layers accepted by keep(layer)."""
    lines = {name: defaultdict(list) for name in reg}
    def locate(p):
        for name, r in reg.items():
            x0, y0, x1, y1 = r['window']
            if x0 <= p.x <= x1 and y0 <= p.y <= y1: return name
    for e in msp:
        t = e.dxftype()
        if t in ('TEXT', 'MTEXT', 'DIMENSION') or (t == 'INSERT' and e.dxf.name.upper().startswith('_AXIS')):
            continue
        a = anchor(e)
        name = locate(a) if a is not None else None
        if not name: continue
        ox, oy = reg[name]['offset_m']
        for sub in (explode(e) if t == 'INSERT' else [e]):
            if sub.dxftype() in ('TEXT', 'MTEXT', 'ATTRIB') or not keep(sub.dxf.layer): continue
            for seg in segments(sub):
                lines[name][sub.dxf.layer].append([(x / 1000 - ox, y / 1000 - oy) for x, y in seg])
    return lines


def boxes(polylines, lo=0.2, hi=1.6):
    out = []
    for pl in polylines:
        if len(pl) < 4 or math.dist(pl[0], pl[-1]) > 0.02: continue
        xs = [p[0] for p in pl]; ys = [p[1] for p in pl]
        b = [min(xs), min(ys), max(xs), max(ys)]
        if not (lo <= b[2] - b[0] <= hi and lo <= b[3] - b[1] <= hi): continue
        if any(abs(b[0] - o[0]) < 0.05 and abs(b[1] - o[1]) < 0.05 and abs(b[2] - o[2]) < 0.05 for o in out): continue
        out.append([round(v, 3) for v in b])
    return out


def flat(polylines):
    return [(x0, y0, x1, y1) for pl in polylines for (x0, y0), (x1, y1) in zip(pl, pl[1:]) if math.hypot(x1 - x0, y1 - y0) >= 0.03]


def structure():
    msp = ezdxf.readfile(WORK / 'structure.dxf').modelspace()
    reg = grid_register(msp, STRUCTURE)
    lines = collect(msp, reg, lambda L: L in ('COLU', 'COLU_HATCH', 'wall_DWQ', 'BEAM'))
    out = {'registration': reg, 'columns': {}, 'beams': {}}
    for level in ('B1', 'F1', 'F2'):
        v = lines[f'col_{level}']
        out['columns'][level] = boxes(v.get('COLU', []) + v.get('COLU_HATCH', []))
        out['beams'][level] = [b for b in walls(flat(lines[f'beam_{level}'].get('BEAM', []))) if 0.18 <= b[4] <= 0.72]
    out['basement_walls'] = walls(flat(lines['col_B1'].get('wall_DWQ', [])))
    return out


class Raster:
    def __init__(self, box, cell):
        self.x0, self.y0, self.x1, self.y1 = box
        self.cell = cell
        self.w, self.h = int((self.x1 - self.x0) / cell) + 3, int((self.y1 - self.y0) / cell) + 3
        self.im = Image.new('L', (self.w, self.h), 0); self.dr = ImageDraw.Draw(self.im)

    def px(self, x, y):
        return ((x - self.x0) / self.cell + 1, (self.y1 - y) / self.cell + 1)

    def rects(self, mask):
        return rectangles(self, mask, self.cell)


def mep():
    docs = {k: ezdxf.readfile(WORK / f'{k}.dxf').modelspace() for k in MEP_VIEWS}
    lines, reg = {}, {}
    wanted = set().union(*(s[1] for s in SYSTEMS.values()))
    for k, msp in docs.items():
        reg[k] = grid_register(msp, MEP_VIEWS[k])
        lines[k] = collect(msp, reg[k], lambda L: L in wanted)
    out = {'registration': reg, 'systems': {k: v[3] for k, v in SYSTEMS.items()}, 'runs': {}}
    for level in ('B1', 'F1', 'F2'):
        out['runs'][level] = {}
        for key, (doc, layers, close, _) in SYSTEMS.items():
            views = [level] + ([f'spr_{level}'] if key == 'sprinkler' else [])
            r = Raster(MEP_BOX, MEP_CELL)
            n = 0
            for view in views:
                for layer in layers:
                    for pl in lines[doc].get(view, {}).get(layer, []):
                        r.dr.line([r.px(x, y) for x, y in pl], fill=255, width=1); n += 1
            if not n: continue
            mask = np.asarray(r.im) > 0
            if close:
                k = round(close / MEP_CELL)
                mask = ~dilate(~dilate(mask, k), k)
            mask = dilate(mask, 1)
            out['runs'][level][key] = r.rects(mask)
    return out


# ---------------------------------------------------------------- landscape
ORIGIN = PLACEMENT['source']['worldOriginM']
ROT = math.radians(PLACEMENT['source']['worldRotationDeg'])
C, S = math.cos(ROT), math.sin(ROT)

def world_to_local(x, y):
    """CGCS2000 millimetres -> centre frame metres (world = origin + R(rotation) · local)."""
    dx, dy = x / 1000 - ORIGIN[0], y / 1000 - ORIGIN[1]
    return (round(C * dx + S * dy, 3), round(-S * dx + C * dy, 3))


def in_land(p):
    return LAND_BOX[0] <= p[0] <= LAND_BOX[2] and LAND_BOX[1] <= p[1] <= LAND_BOX[3]


def area(loop):
    return abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(loop, loop[1:] + loop[:1]))) / 2


def hatch_loops(e):
    loops = []
    for path in e.paths:
        pts = []
        if hasattr(path, 'vertices') and path.vertices:
            pts = [(v[0], v[1]) for v in path.vertices]
        elif hasattr(path, 'edges'):
            for edge in path.edges:
                if hasattr(edge, 'start') and hasattr(edge, 'end') and not hasattr(edge, 'radius'):
                    pts.append((edge.start[0], edge.start[1]))
                elif hasattr(edge, 'radius'):     # arc edge
                    c, r = edge.center, edge.radius
                    a0, a1 = math.radians(edge.start_angle), math.radians(edge.end_angle)
                    if not edge.ccw: a0, a1 = -a0, -a1
                    if a1 <= a0: a1 += math.tau
                    n = max(4, int((a1 - a0) / (math.pi / 12)))
                    sgn = 1 if edge.ccw else -1
                    pts += [(c[0] + r * math.cos(sgn * (a0 + (a1 - a0) * i / n)), c[1] + r * math.sin(sgn * (a0 + (a1 - a0) * i / n))) for i in range(n)]
        loop = [world_to_local(x, y) for x, y in pts]
        if len(loop) >= 3 and all(in_land(p) for p in loop):
            loops.append(loop)
    return loops


def simplify(loop, tol=0.05):
    out = [loop[0]]
    for p in loop[1:]:
        if math.dist(p, out[-1]) >= tol: out.append(p)
    return out if len(out) >= 3 else []


def redline(msp):
    """The centre's 用地红线 in the centre frame (closed, counter-clockwise, bulges flattened)."""
    for e in msp.query(f'LWPOLYLINE[layer=="{REDLINE_LAYER}"]'):
        if not e.closed: continue
        loop = [world_to_local(v.x, v.y) for v in ezpath.make_path(e).flattening(50)]
        if loop[0] == loop[-1]: loop.pop()
        if all(in_land(p) for p in loop):
            ring = Polygon(loop)
            return [list(p) for p in (loop if ring.exterior.is_ccw else loop[::-1])]
    raise SystemExit(f'no registered {REDLINE_LAYER} polyline inside {LAND_BOX}')


def clip(loops, plot):
    """Planted or paved outline (outer loop, holes) cut to the plot: a list of the same."""
    part = Polygon(loops[0], loops[1:]).buffer(0).intersection(plot)
    out = []
    for g in getattr(part, 'geoms', [part]):
        if g.geom_type != 'Polygon' or g.area < 0.5: continue
        rings = [simplify([(round(x, 3), round(y, 3)) for x, y in r.coords[:-1]]) for r in (g.exterior, *g.interiors)]
        if rings[0]: out.append([r for r in rings if r])
    return out


def landscape():
    base = ezdxf.readfile(WORK / 'land-base.dxf').modelspace()
    red = redline(base)
    plot = Polygon(red)
    green, paving = [], []
    for e in base:
        t, L = e.dxftype(), e.dxf.layer
        if t == 'HATCH' and L == '00-绿化填充':
            loops = [simplify(l) for l in hatch_loops(e)]
            loops = [l for l in loops if l]
            if loops: green += clip(loops, plot)
        elif t == 'LWPOLYLINE' and e.closed and L == '01-铺装内廓线':
            loop = simplify([world_to_local(x, y) for x, y in e.get_points('xy')])
            if loop and all(in_land(p) for p in loop) and area(loop) >= 0.5:
                paving += [parts[0] for parts in clip([loop], plot)]
    planting = ezdxf.readfile(WORK / 'planting.dxf')
    blocks = {}
    def crown(name):
        if name not in blocks:
            try:
                ext = ezbbox.extents(planting.blocks[name], fast=True)
                blocks[name] = max(ext.size.x, ext.size.y) / 2 if ext.has_data else 0
            except Exception:
                blocks[name] = 0
        return blocks[name]
    trees, shrubs = [], []
    for e in planting.modelspace():
        t, L = e.dxftype(), e.dxf.layer
        if t == 'INSERT' and L in TREE_LAYERS:
            p = world_to_local(e.dxf.insert.x, e.dxf.insert.y)
            r = crown(e.dxf.name) * abs(e.dxf.xscale) / 1000
            if 0.3 <= r <= 8 and plot.contains(Point(p)):
                trees.append({'species': re.sub(r'[A-Z]$', '', e.dxf.name), 'p': list(p), 'r': round(r, 2)})
        elif t == 'LWPOLYLINE' and e.closed and L == '02-灌木色块':
            loop = simplify([world_to_local(x, y) for x, y in e.get_points('xy')], 0.1)
            if loop and all(in_land(p) for p in loop) and 2 <= area(loop) <= SHRUB_MAX_AREA:
                shrubs += [parts[0] for parts in clip([loop], plot) if area(parts[0]) >= 2]
    return {'frame': 'CGCS2000 → centre frame via hanwenhua-center-placement.json worldOriginM / worldRotationDeg',
            'redline': red, 'redline_area_m2': round(plot.area, 1),
            'green': green, 'paving': paving, 'trees': trees, 'shrubs': shrubs}


def preview(data, folder):
    folder.mkdir(parents=True, exist_ok=True)
    S = 8
    x0, y0, x1, y1 = LAND_BOX
    im = Image.new('RGB', (int((x1 - x0) * S), int((y1 - y0) * S)), (236, 233, 226)); dr = ImageDraw.Draw(im)
    P = lambda x, y: ((x - x0) * S, (y1 - y) * S)
    for loops in data['landscape']['green']:
        for l in loops: dr.polygon([P(*p) for p in l], fill=(150, 190, 120))
    for l in data['landscape']['paving']: dr.polygon([P(*p) for p in l], outline=(150, 140, 120), fill=(214, 206, 190))
    for l in data['landscape']['shrubs']: dr.polygon([P(*p) for p in l], fill=(70, 130, 70))
    red = data['landscape']['redline']
    dr.line([P(*p) for p in red + red[:1]], fill=(224, 49, 49), width=3)
    for t in data['landscape']['trees']:
        cx, cy = P(*t['p']); r = t['r'] * S
        dr.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(20, 90, 30), width=2)
    im.save(folder / 'landscape.png')
    colours = {'supply': (51, 154, 240), 'exhaust': (148, 216, 45), 'smoke': (247, 103, 7), 'ac': (21, 170, 191),
               'water': (47, 158, 68), 'drain': (160, 82, 45), 'rain': (92, 124, 250), 'sprinkler': (224, 49, 49)}
    S = 10
    x0, y0, x1, y1 = MEP_BOX
    for level, runs in data['mep']['runs'].items():
        im = Image.new('RGB', (int((x1 - x0) * S), int((y1 - y0) * S)), 'white'); dr = ImageDraw.Draw(im)
        P = lambda x, y: ((x - x0) * S, (y1 - y) * S)
        for b in data['structure']['beams'][level]:
            dr.line([P(b[0], b[1]), P(b[2], b[3])], fill=(200, 200, 200), width=max(1, int(b[4] * S)))
        for c in data['structure']['columns'][level]:
            dr.rectangle([P(c[0], c[3]), P(c[2], c[1])], fill=(90, 90, 90))
        for key, rects in runs.items():
            for rx0, ry0, rx1, ry1 in rects:
                dr.rectangle([P(rx0, ry1), P(rx1, ry0)], fill=colours[key])
        im.save(folder / f'mep-{level}.png')


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--preview', type=Path)
    args = parser.parse_args()
    data = {'source': {'structure': '结构施工图260925.dwg', 'hvac': '武氏祠暖通施工图.dwg',
                       'plumbing': '武氏祠汉文化保护传承中心给排水施工图-W.dwg',
                       'landscape': '9.24武氏祠景观施工图（土建 底图base、绿化 P2.01）'},
            'structure': structure(), 'mep': mep(), 'landscape': landscape()}
    OUT.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    s, m, l = data['structure'], data['mep'], data['landscape']
    REDLINE_OUT.write_text(json.dumps({
        'source': f"9.24武氏祠景观施工图/土建/底图base.dwg，图层 {REDLINE_LAYER}（界址点连线）",
        'frame': 'centre local metres (X east, Y north)', 'areaM2': l['redline_area_m2'],
        'points': [[round(x, 2), round(y, 2)] for x, y in l['redline']]}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print('registration spread (m):', {k: v['spread_m'] for k, v in s['registration'].items()})
    print('columns', {k: len(v) for k, v in s['columns'].items()}, 'beams', {k: len(v) for k, v in s['beams'].items()},
          'basement walls', len(s['basement_walls']))
    print('mep rects', {lv: {k: len(v) for k, v in runs.items()} for lv, runs in m['runs'].items()})
    print('redline', len(l['redline']), 'points', l['redline_area_m2'], 'm2')
    print('landscape green', len(l['green']), 'paving', len(l['paving']), 'trees', len(l['trees']), 'shrubs', len(l['shrubs']))
    if args.preview: preview(data, args.preview)


if __name__ == '__main__':
    main()
