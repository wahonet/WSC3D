"""Derive the per-floor interior of the heritage centre from the extracted plan linework.

Input : resources/authoring/heritage-center/cad-20260925/views.json  (extract_center_cad.py)
Output: resources/authoring/heritage-center/cad-20260925/floors.json (build_center_blender.py, which clips the
        zones to the modelled storeys and writes them for the centre module)

The plans are exploded TArch drawings: a wall is only its two face lines. Walls are
recovered from pairs of parallel face lines; a level's extent is the area enclosed by
those walls and the window / door lines, and its slab is that extent less the voids
(上空) and the open sunken court.

Functional zones grow from the room names of each plan: all names spread at once through
the floor, walls, windows and door swings acting as barriers, so rooms joined by wide
openings are shared out between their names. Each storey has its own colour family
(负一层 cool, 一层 warm, 二层 violet); within it every exhibition hall and store has its own
colour and the other rooms one colour per function. Run with --preview DIR to write PNG overlays.
"""
from __future__ import annotations
import argparse, json, math, re
from collections import defaultdict
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / 'resources/authoring/heritage-center/cad-20260925'
OUT = WORK / 'floors.json'

THICK = (0.07, 0.72)   # wall thickness range on these drawings (m)
BRIDGE = 0.62          # a collinear break no wider than a wall is a T-junction, not an opening
CORNER = 0.75          # a face line running past its partner by up to one wall thickness turns a corner
CELL = 0.1             # raster size for extents and slabs (m)
CLOSE = 0.8            # door gaps up to twice this are sealed when finding a level's extent

SUNKEN_COURTS = [(-27.6, 30.1, -4.6, 34.21), (4.6, 30.1, 27.6, 34.21)]
LEVELS = {
    # plan view, finished floor, top of interior walls, raster window, extra outdoor seeds, openings to seal, voids.
    # clip: walls, columns and stairs are kept inside the derived extent; the ground floors instead are
    # clipped by build_center_blender.py to the modelled buildings (their porches and terraces are open).
    'B1': dict(view='site', floor=-4.8, top=-0.65, box=(-62, -8, 62, 113), outdoor=[], clip=True,
               # the garage ramp leaves the drawing at its north end
               seals=[((44.66, 108.99), (51.02, 108.99))], voids=SUNKEN_COURTS),
    'F1': dict(view='f1', floor=0.0, top=5.2, box=(-62, -8, 62, 112), outdoor=[(0, 45)], clip=False, seals=[], voids=[]),
    'F2': dict(view='f2', floor=5.4, top=7.8, box=(-62, -8, 62, 112), outdoor=[(0, 45)], clip=True, seals=[],
               voids=[(-12.2, 84.4, 12.2, 98.3),      # 序厅上空
                      (-54.7, 43.6, -38.3, 83.8),     # 演艺舞台及观演席上空 (west wing)
                      (-6.9, 59.9, 6.9, 63.2)]),      # 自动扶梯
    'M1': dict(view='mgmt_f1', floor=0.0, top=4.2, box=(-48, 118, 48, 166), outdoor=[], clip=False, seals=[], voids=[]),
}
# The core hall's lower level (画像石核心展厅, -3.600) lies south of the basement's SE line.
CORE_LOWER = (-31.6, -3.0, 31.6, 30.1, -3.6)
ZONE_BARRIER = 0.4     # barriers grow by this much, sealing gaps up to twice as wide between rooms
ZONE_REACH = 45.0      # no zone spreads further than this from its name (m)
# Small rooms stop sooner, so a tea room or lift named beside an unnamed corridor keeps to its room.
ROOM_REACH = {'service': 6.0, 'traffic': 8.0, 'equipment': 14.0}
NAME_REACH = {'管井': 3.0, '披檐廊': ZONE_REACH}
MIN_ZONE = 3.0         # m2; a name boxed in by its own wall hatch leaves a sliver, not a room
REGION_CLOSE = 3.0     # the unclipped ground floors: porches up to 6 m wide are sealed to bound their zones
# Extra starting points for a room whose one name would lose most of its area to a smaller neighbour
# opening onto it (the loading bay onto the garage); they join the zone of the same name.
EXTRA_SEEDS = {'B1': [('地下车库', 'parking', -19.0, 96.0), ('地下车库', 'parking', 24.0, 95.0)]}
# Zone boundaries across open fronts: the loading bay faces the garage along grid SM.
ZONE_SEALS = {'B1': [((-4.5, 89.7), (12.0, 89.7))]}
# plan text -> (zone name, function). Voids (上空), outdoor terraces and small shaft tags are left out.
ROOM_NAMES = {
    '序厅': ('序厅', 'exhibit'), '展厅': ('展厅', 'exhibit'), '画像石核心展厅': ('画像石核心展厅', 'exhibit'),
    '预留展厅': ('预留展厅', 'exhibit'), '文创展区': ('文创展区', 'exhibit'), '展厅、办公': ('展厅、办公', 'exhibit'),
    '中剧场': ('中剧场', 'perform'), '演艺舞台': ('演艺舞台', 'perform'), '观演席': ('观演席', 'perform'), '化妆间': ('化妆间', 'perform'),
    '藏品库房': ('藏品库房', 'collection'), '非文物库房': ('非文物库房', 'collection'), '研究室': ('研究室', 'collection'),
    '暂存': ('暂存', 'collection'), '卸货': ('卸货', 'collection'),
    '办公': ('办公', 'office'), '管理': ('管理', 'office'), '消控室、监控室': ('消控室、监控室', 'office'),
    '会议室': ('会议室', 'office'), '值班室': ('值班室', 'office'), '服务中心': ('服务中心', 'office'), '票务': ('票务', 'office'),
    '咨询': ('咨询', 'office'), '收银服务台': ('服务中心', 'office'), '自助服务': ('服务中心', 'office'), '休息区': ('休息区', 'office'),
    '设备机房': ('设备机房', 'equipment'), '空调机房': ('空调机房', 'equipment'), '排烟机房': ('排烟机房', 'equipment'),
    '电气设备间': ('电气设备间', 'equipment'), '展厅机房': ('展厅机房', 'equipment'), '弱电机房': ('弱电机房', 'equipment'),
    '安防设备机房': ('安防设备机房', 'equipment'), '电话网络机房': ('电话网络机房', 'equipment'), '配电小间': ('配电间', 'equipment'),
    '配电间': ('配电间', 'equipment'), '变配电室': ('变配电室', 'equipment'), '消防水池': ('消防水池', 'equipment'),
    '水泵房': ('水泵房', 'equipment'), '生活泵房': ('生活泵房', 'equipment'),
    '弱电井': ('管井', 'equipment'), '强电井': ('管井', 'equipment'), '水井': ('管井', 'equipment'), '电缆井': ('管井', 'equipment'),
    '弱电间': ('管井', 'equipment'),
    '男卫': ('卫生间', 'service'), '女卫': ('卫生间', 'service'), '卫': ('卫生间', 'service'), '第三卫生间': ('卫生间', 'service'),
    '卫生间': ('卫生间', 'service'), '开水': ('开水间', 'service'), '开水房': ('开水间', 'service'), '工具间': ('工具间', 'service'),
    '杂物': ('杂物间', 'service'), '清洁间': ('工具间', 'service'), '厨房': ('厨房', 'service'),
    '电梯厅': ('电梯厅', 'traffic'), '客梯': ('电梯', 'traffic'), '货梯': ('电梯', 'traffic'), '无障碍电梯': ('电梯', 'traffic'),
    '楼梯': ('楼梯', 'traffic'), '披檐廊': ('披檐廊', 'traffic'),
    '地下地库（': ('地下车库', 'parking'),
}
FUNCTIONS = {'exhibit': '展陈', 'perform': '演艺', 'collection': '藏品与研究', 'office': '办公管理', 'equipment': '设备机房',
             'service': '卫生及服务', 'traffic': '交通', 'parking': '车库'}
# Exhibition halls and stores are told apart one by one; other rooms share a colour per name.
EACH = {'exhibit', 'collection'}
NUMERALS = '一二三四五六七八九十'
# Colour family per storey (the management building's ground floor shares 一层's).
FAMILY = {'B1': ('冷色系', 'cool'), 'F1': ('暖色系', 'warm'), 'F2': ('紫色系', 'violet')}
PALETTE = {
    'warm': {'exhibit': ['#E8590C', '#F59F00', '#C92A2A', '#F76707', '#E03131', '#FAB005'],
             'perform': ['#D6336C', '#FF922B', '#F06595', '#FFA94D'],
             'collection': ['#B35C1E'],
             'office': ['#FCC419', '#E9B949', '#FFD43B', '#F4C875', '#EFB54A', '#FFE066', '#F2C14E', '#E0A526'],
             'equipment': ['#A0522D', '#B7794B', '#9C6644', '#8D5B3F', '#A47148', '#B08968', '#C49A6C', '#D4B08C', '#976A48'],
             'service': ['#F3D9B1', '#EED6C4', '#E6CCB2', '#F1C9A5', '#EBD2B4'],
             'traffic': ['#FFE8CC', '#F6DCC3', '#FBE3C8'], 'parking': ['#D9A066']},
    'cool': {'exhibit': ['#1864AB', '#339AF0', '#1C7ED6'],
             'collection': ['#3B5BDB', '#5C7CFA', '#22B8CF', '#66D9E8', '#0CA678', '#63E6BE', '#38D9A9', '#748FFC'],
             'perform': ['#4263EB'],
             'office': ['#5F8FB4', '#7EA6C4'],
             'equipment': ['#1098AD', '#0B7285', '#15AABF', '#3BC9DB', '#4A7A96', '#5E90A8', '#A5D8FF', '#6BA3BE'],
             'service': ['#D0EBFF', '#C5F6FA', '#E3FAFC', '#D3E4F5'],
             'traffic': ['#DBE4FF', '#99E9F2', '#C9D8F0'], 'parking': ['#74A9CF']},
    'violet': {'exhibit': ['#5F3DC4', '#9775FA', '#BE4BDB', '#862E9C', '#7950F2', '#DA77F2'],
               'perform': ['#9C36B5'], 'collection': ['#6741D9'],
               'office': ['#B197FC', '#C7A6F2'],
               'equipment': ['#8E7CC3', '#A99CD6', '#7C6BAE', '#9A8CC2', '#B8ADDF', '#CFC6EA', '#6F5FA3'],
               'service': ['#EEE3F7', '#E5DBF3', '#DCD0EE', '#E9D8FD'],
               'traffic': ['#F3F0FF', '#E6E0F8'], 'parking': ['#A58FD0']},
}


def segments(polylines, min_len=0.03):
    out = []
    for pl in polylines:
        for (x0, y0), (x1, y1) in zip(pl, pl[1:]):
            if math.hypot(x1 - x0, y1 - y0) >= min_len:
                out.append((x0, y0, x1, y1))
    return out


def walls(segs):
    """Wall pieces [x0, y0, x1, y1, thickness] (centre line) from parallel face lines."""
    groups = defaultdict(list)
    for s in segs:
        a = math.degrees(math.atan2(s[3] - s[1], s[2] - s[0])) % 180
        groups[round(a / 0.5) % 360].append(s)
    pieces = []
    for key, members in groups.items():
        th = math.radians(key * 0.5)
        d, n = (math.cos(th), math.sin(th)), (-math.sin(th), math.cos(th))
        lines = []
        for x0, y0, x1, y1 in members:
            u0, u1 = sorted((x0 * d[0] + y0 * d[1], x1 * d[0] + y1 * d[1]))
            v = ((x0 + x1) * n[0] + (y0 + y1) * n[1]) / 2
            lines.append([v, u0, u1])
        lines.sort()
        merged = []
        for v, u0, u1 in lines:
            for m in reversed(merged[-12:]):
                if abs(m[0] - v) < 0.012 and u0 <= m[2] + BRIDGE and u1 >= m[1] - BRIDGE:
                    m[1], m[2] = min(m[1], u0), max(m[2], u1)
                    break
            else:
                merged.append([v, u0, u1])
        merged.sort()
        for i, (va, a0, a1) in enumerate(merged):
            covered, partners = [], []
            for vb, b0, b1 in merged[i + 1:]:
                gap = vb - va
                if gap > THICK[1]: break
                if gap < THICK[0]: continue
                if min(a1, b1) - max(a0, b0) > 0.05: partners.append((gap, vb, b0, b1))
            for gap, vb, b0, b1 in sorted(partners):      # nearest partner first
                lo, hi = max(a0, b0), min(a1, b1)
                free = [(lo, hi)]
                for c0, c1 in covered:
                    free = [part for f0, f1 in free for part in ((f0, min(f1, c0)), (max(f0, c1), f1)) if part[1] - part[0] > 0.05]
                for f0, f1 in free:
                    if abs(f0 - lo) < 1e-6 and lo - min(a0, b0) <= CORNER: f0 = min(a0, b0)
                    if abs(f1 - hi) < 1e-6 and max(a1, b1) - hi <= CORNER: f1 = max(a1, b1)
                    covered.append((f0, f1))
                    vc = (va + vb) / 2
                    p0 = (d[0] * f0 + n[0] * vc, d[1] * f0 + n[1] * vc)
                    p1 = (d[0] * f1 + n[0] * vc, d[1] * f1 + n[1] * vc)
                    pieces.append([round(p0[0], 3), round(p0[1], 3), round(p1[0], 3), round(p1[1], 3), round(gap, 3)])
    return [p for p in pieces if math.hypot(p[2] - p[0], p[3] - p[1]) >= 0.1]


def column_boxes(view):
    boxes = [c['min'] + c['max'] for c in view['columns']]
    for layer in ('砼柱', 'COLU_HATCH', 'COLUMN', 'COLU'):
        for pl in view['lines'].get(layer, []):
            if len(pl) < 4 or math.dist(pl[0], pl[-1]) > 0.02: continue
            xs = [p[0] for p in pl]; ys = [p[1] for p in pl]
            boxes.append([min(xs), min(ys), max(xs), max(ys)])
    out = []
    for b in boxes:
        w, h = b[2] - b[0], b[3] - b[1]
        if not (0.2 <= w <= 1.6 and 0.2 <= h <= 1.6): continue
        if any(abs(b[0] - o[0]) < 0.05 and abs(b[1] - o[1]) < 0.05 and abs(b[2] - o[2]) < 0.05 for o in out): continue
        out.append([round(v, 3) for v in b])
    return out


# ---------------------------------------------------------------- raster extents
class Grid:
    def __init__(self, box):
        # the margin keeps the closed walls off the border, so the outside stays one region
        m = CLOSE + 1.0
        self.x0, self.y0, self.x1, self.y1 = box[0] - m, box[1] - m, box[2] + m, box[3] + m
        self.w, self.h = int((self.x1 - self.x0) / CELL) + 3, int((self.y1 - self.y0) / CELL) + 3

    def px(self, x, y):
        return ((x - self.x0) / CELL + 1, (self.y1 - y) / CELL + 1)

    def image(self):
        return Image.new('L', (self.w, self.h), 0)

    def at(self, mask, x, y):
        c, r = self.px(x, y)
        r, c = int(r), int(c)
        return 0 <= r < self.h and 0 <= c < self.w and bool(mask[r, c])


def dilate(a, r):
    """Square dilation by r cells (separable running maximum)."""
    k = 2 * r + 1
    c = np.cumsum(np.pad(a, ((0, 0), (r + 1, r))), axis=1, dtype=np.int32)
    a = (c[:, k:] - c[:, :-k]) > 0
    c = np.cumsum(np.pad(a, ((r + 1, r), (0, 0))), axis=0, dtype=np.int32)
    return (c[k:, :] - c[:-k, :]) > 0


def wall_polygon(p, grow=0.0):
    ax, ay, bx, by, t = p
    L = math.hypot(bx - ax, by - ay); ux, uy = (bx - ax) / L, (by - ay) / L
    nx, ny = -uy * (t / 2 + grow), ux * (t / 2 + grow)
    ax, ay, bx, by = ax - ux * grow, ay - uy * grow, bx + ux * grow, by + uy * grow
    return [(ax + nx, ay + ny), (bx + nx, by + ny), (bx - nx, by - ny), (ax - nx, ay - ny)]


def extent(grid, pieces, barriers, outdoor, close=CLOSE):
    """Cells enclosed by walls and window / door lines: morphological closing, then flood fill from outside."""
    im = grid.image(); dr = ImageDraw.Draw(im)
    for p in pieces:
        dr.polygon([grid.px(*q) for q in wall_polygon(p)], fill=255)
    for (ax, ay), (bx, by) in barriers:
        dr.line([grid.px(ax, ay), grid.px(bx, by)], fill=255, width=2)
    r = round(close / CELL)
    closed = dilate(np.asarray(im) > 0, r)
    fill = Image.fromarray(np.where(closed, 255, 0).astype(np.uint8)).copy()   # fromarray images are read-only
    for x, y in [(grid.x0, grid.y0)] + list(outdoor):
        c, rr = grid.px(x, y)
        if fill.getpixel((int(c), int(rr))) == 0:
            ImageDraw.floodfill(fill, (int(c), int(rr)), 128)
    inside = np.asarray(fill) != 128
    return ~dilate(~inside, r)


def drop_islands(mask, min_area=20.0):
    """Remove enclosed specks (planters, pits drawn on the wall layer) outside the building."""
    img = Image.fromarray(np.where(mask, 1, 0).astype(np.uint8)).copy()
    keep = np.zeros_like(mask)
    while True:
        arr = np.asarray(img)
        seeds = np.argwhere(arr == 1)
        if not len(seeds): break
        r, c = seeds[0]
        ImageDraw.floodfill(img, (int(c), int(r)), 2)
        part = np.asarray(img) == 2
        if part.sum() * CELL * CELL >= min_area: keep |= part
        img = Image.fromarray(np.where(part, 3, np.asarray(img)).astype(np.uint8)).copy()
    return keep


def rectangles(grid, mask, cell=None):
    """Axis-aligned rectangles [x0, y0, x1, y1] covering the mask: row runs merged downwards."""
    CELL = cell or globals()['CELL']
    rects, open_runs = [], {}
    for r in range(mask.shape[0] + 1):
        row = mask[r] if r < mask.shape[0] else np.zeros(mask.shape[1], bool)
        edges = np.flatnonzero(np.diff(np.concatenate(([0], row.view(np.int8), [0]))))
        runs = set(zip(edges[::2], edges[1::2]))
        for run in list(open_runs):
            if run not in runs:
                r0 = open_runs.pop(run)
                c0, c1 = run
                rects.append([round(grid.x0 + (c0 - 1) * CELL, 3), round(grid.y1 - (r - 1) * CELL, 3),
                              round(grid.x0 + (c1 - 1) * CELL, 3), round(grid.y1 - (r0 - 1) * CELL, 3)])
        for run in runs:
            open_runs.setdefault(run, r)
    return rects


# ---------------------------------------------------------------- functional zones
def shifted(a, dr, dc):
    """a moved by (dr, dc) cells, the vacated border filled with zeros."""
    out = np.zeros_like(a)
    h, w = a.shape
    out[max(dr, 0):h + min(dr, 0), max(dc, 0):w + min(dc, 0)] = a[max(-dr, 0):h + min(-dr, 0), max(-dc, 0):w + min(-dc, 0)]
    return out


def grow(labels, allowed, steps, limit=None):
    """Spread the labels step by step into allowed, unlabelled cells (4-neighbourhood).
    limit[k] is the number of steps label k may take (all of them if omitted)."""
    for step in range(steps):
        before = labels
        labels = labels.copy()
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nb = shifted(labels, dr, dc)
            take = (labels == 0) & allowed & (nb > 0)
            if limit is not None: take &= limit[nb] > step
            labels[take] = nb[take]
        if np.array_equal(before, labels): break
    return labels


def room_seeds(level, texts):
    """(zone name, function, x, y) at the middle of each room name of the plan."""
    seeds = []
    for t in texts:
        s = t['t'].strip()
        if s not in ROOM_NAMES: continue
        name, function = ROOM_NAMES[s]
        rot = t['rot'] % 180
        if min(rot, 180 - rot) < 1: x, y = t['p'][0] + len(s) * t['h'] / 2, t['p'][1] + t['h'] / 2
        elif abs(rot - 90) < 1: x, y = t['p'][0] - t['h'] / 2, t['p'][1] + len(s) * t['h'] / 2
        else: continue
        if any(q[0] == name and math.dist(q[2:], (x, y)) < 6 for q in seeds): continue
        seeds.append((name, function, x, y))
    return seeds


def zones(grid, pieces, barriers, columns, region, seeds):
    """Zone masks grown from the room names; region limits where floors can be."""
    im = grid.image(); dr = ImageDraw.Draw(im)
    for p in pieces:
        dr.polygon([grid.px(*q) for q in wall_polygon(p)], fill=255)
    for (ax, ay), (bx, by) in barriers:
        dr.line([grid.px(ax, ay), grid.px(bx, by)], fill=255, width=2)
    for x0, y0, x1, y1 in columns:
        dr.rectangle([grid.px(x0, y1), grid.px(x1, y0)], fill=255)
    rz = round(ZONE_BARRIER / CELL)
    blocked = dilate(np.asarray(im) > 0, rz)
    free = region & ~blocked
    labels = np.zeros(free.shape, np.int32)
    placed = []
    for k, (name, function, x, y) in enumerate(seeds, 1):
        c, r = grid.px(x, y); r, c = int(r), int(c)
        # a name drawn across a wall line starts from the nearest free cell
        win = free[max(r - 10, 0):r + 11, max(c - 10, 0):c + 11]
        hits = np.argwhere(win)
        if not len(hits): continue
        dr_, dc_ = hits[np.argmin(((hits - [min(r, 10), min(c, 10)]) ** 2).sum(1))]
        labels[max(r - 10, 0) + dr_, max(c - 10, 0) + dc_] = k
        placed.append(k)
    reach = [0] + [NAME_REACH.get(name, ROOM_REACH.get(function, ZONE_REACH)) for name, function, *_ in seeds]
    labels = grow(labels, free, round(ZONE_REACH / CELL), np.round(np.array(reach) / CELL).astype(np.int32))
    # back out to the wall faces under the grown barriers
    labels = grow(labels, region & blocked, rz + 2)
    return {k: labels == k for k in placed}


def zone_colours(level_zones):
    """Colour per zone from the storey's family: halls and stores one each, other rooms one per name."""
    used, by_name = defaultdict(int), {}
    for level, family, zlist in level_zones:
        for z in zlist:
            key = (family, z['name']) if z['function'] not in EACH else None
            if key and key in by_name:
                z['color'] = by_name[key]; continue
            colours = PALETTE[family][z['function']]
            z['color'] = colours[used[(family, z['function'])] % len(colours)]
            used[(family, z['function'])] += 1
            if key: by_name[key] = z['color']


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--preview', type=Path)
    args = parser.parse_args()
    views = json.loads((WORK / 'views.json').read_text(encoding='utf-8'))['views']
    result, level_zones = {}, []
    for level, cfg in LEVELS.items():
        v = views[cfg['view']]
        grid = Grid(cfg['box'])
        pieces = walls(segments(v['lines'].get('WALL', [])))
        barriers = [((s[0], s[1]), (s[2], s[3])) for layer in ('WINDOW', 'DOOR_FIRE')
                    for s in segments(v['lines'].get(layer, []))] + cfg['seals']
        inside = drop_islands(extent(grid, pieces, barriers, cfg['outdoor']))
        near = dilate(inside, 6)
        kept = lambda mask, x, y: not cfg['clip'] or grid.at(mask, x, y)
        pieces = [p for p in pieces if kept(near, (p[0] + p[2]) / 2, (p[1] + p[3]) / 2)]
        columns = [b for b in column_boxes(v) if kept(inside, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2)]
        stairs = [[round(c, 3) for c in s] for s in segments(v['lines'].get('STAIR', []), 0.25)
                  if kept(inside, (s[0] + s[2]) / 2, (s[1] + s[3]) / 2)]
        slab_mask = inside.copy() if cfg['clip'] else np.zeros_like(inside)
        for x0, y0, x1, y1 in cfg['voids']:
            c0, r0 = grid.px(x0, y1); c1, r1 = grid.px(x1, y0)
            slab_mask[int(r0):int(math.ceil(r1)), int(c0):int(math.ceil(c1))] = False
        # keep the slab inside the outer wall faces, so no edge shows on the facades
        slab_mask = ~dilate(~slab_mask, 1)
        slab = rectangles(grid, slab_mask)
        # zones: the clipped levels stay inside their extent; the ground floors are clipped to the
        # modelled buildings by build_center_blender.py, like their slabs
        region = inside.copy() if cfg['clip'] else extent(grid, pieces, barriers, cfg['outdoor'], REGION_CLOSE)
        for x0, y0, x1, y1 in cfg['voids']:
            c0, r0 = grid.px(x0, y1); c1, r1 = grid.px(x1, y0)
            region[int(r0):int(math.ceil(r1)), int(c0):int(math.ceil(c1))] = False
        seeds = [s for s in room_seeds(level, v['texts']) if grid.at(region, s[2], s[3])]
        extra = EXTRA_SEEDS.get(level, [])
        masks = zones(grid, pieces, barriers + ZONE_SEALS.get(level, []), columns, region, seeds + extra)
        zlist = []
        for k, mask in list(masks.items()):
            if k > len(seeds): continue
            name, function, x, y = seeds[k - 1]
            for j, (extra_name, *_) in enumerate(extra, len(seeds) + 1):
                if extra_name == name and j in masks: mask = mask | masks.pop(j)
            if mask.sum() * CELL * CELL < MIN_ZONE: continue
            zlist.append({'name': name, 'function': function, 'p': [round(x, 2), round(y, 2)], 'mask': mask})
        for name in {z['name'] for z in zlist if z['function'] in EACH}:
            same = sorted((z for z in zlist if z['name'] == name), key=lambda z: (-z['p'][1], z['p'][0]))
            if len(same) > 1:
                for i, z in enumerate(same): z['name'] = name + NUMERALS[i]
        order = list(FUNCTIONS)
        zlist.sort(key=lambda z: (order.index(z['function']), -int(z['mask'].sum())))
        for i, z in enumerate(zlist, 1):
            z['id'] = f'{level}-{i:02d}'
            z['rects'] = rectangles(grid, z.pop('mask'))
        level_zones.append((level, 'warm' if level == 'M1' else FAMILY[level][1], zlist))
        result[level] = {'view': cfg['view'], 'floor': cfg['floor'], 'wall_top': cfg['top'], 'walls': pieces,
                         'columns': columns, 'stairs': stairs, 'slab': slab, 'zones': zlist}
        print(level, f'walls {len(pieces)} columns {len(columns)} stairs {len(stairs)} slab rects {len(slab)}',
              f'area {slab_mask.sum() * CELL * CELL:.0f} m2 zones {len(zlist)} of {len(seeds)} names')
        if args.preview:
            args.preview.mkdir(parents=True, exist_ok=True)
            s = 26 if level != 'M1' else 40
            x0, y0, x1, y1 = cfg['box']
            im = Image.new('RGB', (int((x1 - x0) * s), int((y1 - y0) * s)), 'white'); dr = ImageDraw.Draw(im)
            P = lambda x, y: ((x - x0) * s, (y1 - y) * s)
            for rx0, ry0, rx1, ry1 in slab:
                dr.rectangle([P(rx0, ry1), P(rx1, ry0)], fill=(222, 214, 196))
            zone_colours([(level, 'warm' if level == 'M1' else FAMILY[level][1], zlist)])
            for z in zlist:
                col = tuple(int(z['color'][i:i + 2], 16) for i in (1, 3, 5))
                for rx0, ry0, rx1, ry1 in z['rects']:
                    dr.rectangle([P(rx0, ry1), P(rx1, ry0)], fill=col)
            for p in pieces:
                dr.polygon([P(*q) for q in wall_polygon(p)], fill=(30, 30, 30))
            for bx0, by0, bx1, by1 in columns:
                dr.rectangle([P(bx0, by1), P(bx1, by0)], fill=(210, 40, 40))
            for ax, ay, bx, by in stairs:
                dr.line([P(ax, ay), P(bx, by)], fill=(30, 140, 60), width=1)
            from PIL import ImageFont
            font = ImageFont.truetype(r'C:\Windows\Fonts\msyh.ttc', 22)
            for z in zlist:
                cx, cy = P(*z['p']); dr.ellipse([cx - 4, cy - 4, cx + 4, cy + 4], fill=(0, 0, 0))
                dr.text((cx + 6, cy - 14), z['name'], fill=(0, 0, 0), font=font)
            im.save(args.preview / f'{level}.png')
    zone_colours(level_zones)
    OUT.write_text(json.dumps({'source': 'views.json', 'cell_m': CELL, 'core_lower': CORE_LOWER, 'levels': result,
                               'functions': FUNCTIONS, 'families': {k: v[0] for k, v in FAMILY.items()}},
                              ensure_ascii=False), encoding='utf-8')


if __name__ == '__main__':
    main()
