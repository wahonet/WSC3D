"""Blender 5.2: exhibition fit-out of 武氏祠汉文化保护传承中心, after the exhibition design (展陈设计文件 9.18改).

Run: blender --background --factory-startup --python tools/authoring/build_center_exhibition_blender.py

Inputs
  resources/authoring/heritage-center/textures/exhibit-*       (tools/authoring/prepare_exhibition_textures.py)
  resources/authoring/heritage-center/cad-20260925/floors.json (storey levels)
Output
  resources/scenes/models/hanwenhua-center-exhibition-20260927.glb and an editable .blend
  src/frontend/src/center/centerExhibition.json (halls: chapter, design pages, rooms, viewpoint and lights)

Same frame as hanwenhua-center-20260925.glb (centre local metres, glTF x = X, y = Z, z = -Y). The halls follow
the design's axonometric keys (p2, p36): 序厅 and 初影 in the 1F main hall, 铸影 / 立影 / 传影 east to west
in the basement 预留展厅, 尾厅 in the basement core hall, the 武氏祠专题展厅 in the 1F core hall, the medium
and large theatres in the east and west wings, the small theatre, VR halls and temporary hall on 2F.
Every mesh carries center_role = fitout, center_level and center_hall; ceilings add center_part = ceiling and
the members hung under them (canopies, trusses, the lantern ring) center_part = hung. Both stay out of the storey
plans and appear when a hall is entered; the ceilings can then be taken away on their own.
"""
import bpy, bmesh, math, json, random, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_center_blender as B

ROOT = B.ROOT
WORK = B.WORK
OUT_GLB = ROOT / 'resources/scenes/models/hanwenhua-center-exhibition-20260927.glb'
OUT_BLEND = WORK / 'blender/传承中心_展陈装修_20260927.blend'
HALLS_OUT = ROOT / 'src/frontend/src/center/centerExhibition.json'
PDF = '武氏祠汉文化保护传承中心项目展陈设计文件9.18改(2).pdf'
LEVELS = B.FLOORS['levels']
Z_B1, Z_CORE, Z_F2 = LEVELS['B1']['floor'], B.FLOORS['core_lower'][4], LEVELS['F2']['floor']
# finishes lie over the zone overlays (+0.03) of the building model
LIFT = 0.06
random.seed(20260927)

# ---------------------------------------------------------------- materials
def mat(key, name, rgb=(255, 255, 255), rough=0.8, tex=None, uv=2.0, metal=0.0, alpha=1.0, emit=None, glow=0.0):
    m = B.material(key, name, rgb, rough, tex=f'exhibit-{tex}' if tex else None, metal=metal, alpha=alpha, normal=0.5, emit=emit)
    B.UVSCALE[key] = uv
    if tex and glow:
        nt = m.node_tree; p = nt.nodes['Principled BSDF']
        img = next(n for n in nt.nodes if n.type == 'TEX_IMAGE')
        nt.links.new(img.outputs['Color'], p.inputs['Emission Color'])
        p.inputs['Emission Strength'].default_value = glow
    return m

# design image -> (glow, name); lit graphics (screens, lightboxes, lit case interiors) glow
IMAGES = {
    'scroll': (2.2, '序厅_金色光影长卷'), 'charwall': (0, '序厅_汉字石刻肌理墙'),
    'mural-chuying': (0.35, '初影_画像石拓片巨幅墙'), 'cloud': (0.15, '初影_云气纹立柱'), 'banner': (0.25, '初影_武氏祠题名幅'),
    'case-chuying': (0.45, '初影_通柜内景'), 'case-zhuying': (0.45, '铸影_通柜内景'), 'mural-chariot': (0.2, '铸影_车马出行壁画'),
    'sandtable': (0, '立影_沙盘木饰侧板'), 'strata': (0.35, '立影_考古地层长墙'), 'case-liying': (0.45, '立影_通柜内景'),
    'relief-mural': (0.25, '传影_车马出行画像石巨墙'), 'goldline': (1.6, '传影_金色线描发光顶'),
    'stele-gold': (0.3, '传影_双面画像石'), 'stele-white': (0.1, '车马画像石'), 'stone-relief': (0.1, '画像石残件'),
    'totem': (0.9, '尾厅_数字图腾墙'), 'archaeo-wall': (0.3, '尾厅_探方考古厅墙面'), 'poster': (0.4, '尾厅_考古展板'),
    'trench-box': (1.2, '尾厅_探方灯箱'), 'digital': (1.3, '尾厅_影像交互墙'), 'film': (1.2, '沉浸影像'),
    'lattice': (0.9, '中型剧场_格栅灯箱'), 'bamboo': (0.35, '大型剧场_水墨竹林背景'),
    'screen-gold': (1.5, '小型剧场_金色LED屏'), 'lantern': (1.5, '小型剧场_环形灯笼板'), 'vr': (1.8, 'VR展厅_光影立柱'),
    'rubbing': (0.15, '画像石拓片'), 'rubbing-wall': (0.3, '专题展厅_拓片墙'), 'shrine-stone': (0.3, '专题展厅_画像石'),
    'painting1': (0.12, '临时展厅_书画一'), 'painting2': (0.12, '临时展厅_书画二'), 'painting3': (0.12, '临时展厅_书画三'),
    'painting4': (0.12, '临时展厅_书画四'),
}

def define_materials():
    B.define_materials()
    for key, name, tex, rough, uv in [
        ('floor_dark', '展厅深色石材地面', 'floor-dark', .32, 2.4), ('carpet', '剧场地毯', 'carpet', .95, 3.0),
        ('sand', '沙土', 'sand', .95, 3.0), ('stone', '粗面石材墙', 'stone-rough', .85, 2.4),
    ]:
        mat(key, name, tex=tex, rough=rough, uv=uv)
    mat('stars', '星空顶', tex='stars', rough=.9, uv=6.0, glow=1.0)
    for key, name, rgb, rough, metal in [
        ('black', '黑色饰面', (18, 18, 18), .75, 0), ('wall_dark', '深灰墙面', (54, 52, 49), .9, 0),
        ('wall_gray', '灰色墙面', (96, 94, 90), .9, 0), ('rust', '锈红墙面', (112, 62, 40), .85, 0),
        ('ceiling', '深色吊顶', (30, 29, 28), .95, 0), ('timber', '木梁', (104, 66, 38), .6, 0),
        ('wood_light', '浅木饰面', (180, 132, 86), .55, 0), ('stage', '舞台木地板', (96, 62, 40), .45, 0),
        ('seat', '观众座椅', (150, 30, 32), .8, 0), ('truss', '灯光桁架', (178, 180, 184), .35, .8),
        ('pottery', '陶器', (150, 88, 52), .8, 0), ('gloss', '深色镜面地面', (20, 20, 22), .12, .1),
        ('monolith', '清水混凝土体块', (150, 146, 139), .7, 0),
    ]:
        mat(key, name, rgb, rough, metal=metal)
    for key, name, rgb, emit, strength in [
        ('led_warm', '暖光灯带', (255, 214, 160), (255, 188, 116), 3.0), ('led_white', '白光灯膜', (250, 244, 232), (255, 242, 222), 1.4),
        ('frost', '磨砂灯箱', (196, 180, 152), (255, 222, 178), 0.4), ('cyan', '青色光丝', (90, 225, 235), (80, 230, 240), 1.3),
    ]:
        mat(key, name, rgb, .5, emit=(emit, strength))
    mat('case_glass', '展柜超白玻璃', (215, 228, 232), .03, alpha=.14)
    mat('chariot_light', '铸影_沙台车马光影', tex='mural-chariot', rough=.95, uv=1.0, glow=0.9)
    for name, (glow, label) in IMAGES.items():
        mat(f'img_{name}', label, rough=.7, tex=name, glow=glow)

# ---------------------------------------------------------------- geometry
HALL = ['']
def G(): return f'30_展陈_{HALL[-1]}'
def GC(): return f'31_展陈吊顶_{HALL[-1]}'
def GH(): return f'32_展陈吊挂_{HALL[-1]}'

class room:
    """Batch the enclosed geometry into one hall of one storey."""
    def __init__(self, hall, level): self.hall, self.at = hall, B.at(level)
    def __enter__(self): HALL.append(self.hall); self.at.__enter__()
    def __exit__(self, *exc): self.at.__exit__(); HALL.pop()

def panel(m, a, b, z0, z1, rep=(1, 1), off=0.0, g=None):
    """Upright quad seen from the side where a -> b runs left to right; the image fills it rep times."""
    (ax, ay), (bx, by) = a, b
    L = math.hypot(bx - ax, by - ay); nx, ny = (by - ay) / L, -(bx - ax) / L
    ax, ay, bx, by = ax + nx * off, ay + ny * off, bx + nx * off, by + ny * off
    ru, rv = rep
    B.quad(g or G(), m, (ax, ay, z0), (bx, by, z0), (bx, by, z1), (ax, ay, z1), [(0, 0), (ru, 0), (ru, rv), (0, rv)])

def tiled(m, a, b, z0, z1, size, off=0.0, g=None):
    """Panel of a finish that repeats every `size` metres."""
    panel(m, a, b, z0, z1, (math.dist(a, b) / size, (z1 - z0) / size), off, g)

def flat(m, x0, y0, x1, y1, z, up=True, rep=None, g=None):
    pts = [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]
    uvs = [(0, 0), (rep[0], 0), (rep[0], rep[1]), (0, rep[1])] if rep else None
    if not up:
        pts = pts[::-1]; uvs = uvs[::-1] if uvs else None
    B.add_face(g or G(), m, pts, uvs)

def ceiling(x0, y0, x1, y1, z, m='ceiling', holes=()):
    """Ceiling facing down, with openings (lightboxes, skylights) left for other finishes."""
    xs = sorted({x0, x1, *[h[0] for h in holes], *[h[2] for h in holes]})
    ys = sorted({y0, y1, *[h[1] for h in holes], *[h[3] for h in holes]})
    for xa, xb in zip(xs, xs[1:]):
        for ya, yb in zip(ys, ys[1:]):
            cx, cy = (xa + xb) / 2, (ya + yb) / 2
            if any(h[0] <= cx <= h[2] and h[1] <= cy <= h[3] for h in holes): continue
            flat(m, xa, ya, xb, yb, z, up=False, g=GC())

def box(m, cx, cy, z0, sx, sy, sz, ang=0.0, top=True, bottom=False, g=None):
    B.box(g or G(), m, cx, cy, z0, sx, sy, sz, ang, top, bottom)

def rot(cx, cy, ang):
    ca, sa = math.cos(ang), math.sin(ang)
    return lambda x, y: (cx + x * ca - y * sa, cy + x * sa + y * ca)

def slab(body, face, cx, cy, z0, w, d, h, ang=0.0, both=True, rep=(1, 1)):
    """Upright slab w x d x h with the image on its front (local -y) and back."""
    box(body, cx, cy, z0, w, d, h, ang)
    P = rot(cx, cy, ang)
    panel(face, P(-w / 2, -d / 2), P(w / 2, -d / 2), z0 + 0.02, z0 + h - 0.02, rep, 0.004)
    if both:
        panel(face, P(w / 2, d / 2), P(-w / 2, d / 2), z0 + 0.02, z0 + h - 0.02, rep, 0.004)

def wrap(face, cx, cy, z0, sx, sy, h, rep=(1, 1), body='black'):
    """Box with the image on all four sides (columns, table skirts)."""
    box(body, cx, cy, z0, sx, sy, h)
    c = [(cx - sx / 2, cy - sy / 2), (cx + sx / 2, cy - sy / 2), (cx + sx / 2, cy + sy / 2), (cx - sx / 2, cy + sy / 2)]
    for i in range(4):
        panel(face, c[i], c[(i + 1) % 4], z0, z0 + h, rep, 0.004)

def lathe(m, cx, cy, z0, prof, n=16, cap=True, urep=1.0, g=None):
    rings = [[(cx + r * math.cos(k * math.tau / n), cy + r * math.sin(k * math.tau / n), z0 + z) for k in range(n)] for r, z in prof]
    for A, C in zip(rings, rings[1:]):
        for k in range(n):
            j = (k + 1) % n
            B.quad(g or G(), m, A[k], A[j], C[j], C[k], [(k / n * urep, 0), ((k + 1) / n * urep, 0), ((k + 1) / n * urep, 1), (k / n * urep, 1)])
    if cap:
        B.add_face(g or G(), m, rings[-1])

def leaning(face, cx, cy, z0, w, d, h, ang, lean):
    """Thin slab whose top is pushed sideways by `lean` (m, in its own plane and out of it)."""
    P = rot(cx, cy, ang)
    lo = [(*P(x, y), z0) for x, y in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2))]
    hi = [(*P(x + lean[0], y + lean[1]), z0 + h) for x, y in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2))]
    fit = [(0, 0), (1, 0), (1, 1), (0, 1)]
    B.quad(G(), face, lo[0], lo[1], hi[1], hi[0], fit)
    B.quad(G(), face, lo[2], lo[3], hi[3], hi[2], fit)
    B.quad(G(), 'black', lo[1], lo[2], hi[2], hi[1]); B.quad(G(), 'black', lo[3], lo[0], hi[0], hi[3])
    B.add_face(G(), 'black', hi)

def wedge(m, lo, hi):
    """Solid between two quads (CCW from above), for the leaning stone monoliths."""
    for i in range(4):
        j = (i + 1) % 4
        B.quad(G(), m, lo[i], lo[j], hi[j], hi[i])
    B.add_face(G(), m, hi)

def frame(m, cx, cy, size, band, z0, z1, glow=None, g=None):
    """Square ring (canopies, ceiling rafts); its soffit can glow."""
    h = size / 2
    for sy in (-1, 1):
        box(m, cx, cy + sy * (h - band / 2), z0, size, band, z1 - z0, g=g)
    for sx in (-1, 1):
        box(m, cx + sx * (h - band / 2), cy, z0, band, size - 2 * band, z1 - z0, g=g)
    if glow:
        for sy in (-1, 1):
            flat(glow, cx - h, cy + sy * (h - band / 2) - band / 2, cx + h, cy + sy * (h - band / 2) + band / 2, z0 - 0.005, up=False, g=g)
        for sx in (-1, 1):
            flat(glow, cx + sx * (h - band / 2) - band / 2, cy - h + band, cx + sx * (h - band / 2) + band / 2, cy + h - band, z0 - 0.005, up=False, g=g)

def sheath(x, y, z0, z1, face='black', s=0.72):
    """Casing over a free-standing building column (centres from the building model's int_column)."""
    if face == 'black': box('black', x, y, z0, s, s, z1 - z0)
    else: wrap(face, x, y, z0, s, s, z1 - z0, (1, (z1 - z0) / (2 * s)))

def wall_case(a, b, z0, tex, h=3.0, depth=0.8, seg=3.0):
    """Full-height wall case along a wall, the visitor side on the right of a -> b."""
    (ax, ay), (bx, by) = a, b
    L = math.dist(a, b); tx, ty = (bx - ax) / L, (by - ay) / L; nx, ny = ty, -tx
    ang = math.atan2(ty, tx)
    mx, my = (ax + bx) / 2, (ay + by) / 2
    base, cap = 0.55, 0.32
    box('black', mx + nx * depth / 2, my + ny * depth / 2, z0, L, depth, base, ang)
    box('black', mx + nx * depth / 2, my + ny * depth / 2, z0 + h - cap, L, depth, cap, ang, bottom=True)
    panel(f'img_{tex}', a, b, z0 + base, z0 + h - cap, (max(1, round(L / seg)), 1), 0.02)
    fa, fb = (ax + nx * depth, ay + ny * depth), (bx + nx * depth, by + ny * depth)
    panel('case_glass', fa, fb, z0 + base, z0 + h - cap)
    panel('case_glass', a, fa, z0 + base, z0 + h - cap); panel('case_glass', fb, b, z0 + base, z0 + h - cap)
    n = max(1, round(L / seg))
    for k in range(1, n):
        px, py = ax + tx * L * k / n + nx * depth, ay + ty * L * k / n + ny * depth
        box('black', px, py, z0 + base, 0.05, 0.05, h - base - cap, ang)
    box('led_warm', mx + nx * (depth - 0.12), my + ny * (depth - 0.12), z0 + h - cap - 0.025, L - 0.1, 0.04, 0.025, ang)

def vessel(cx, cy, z0, s=1.0):
    r = s * random.uniform(0.09, 0.16); hgt = s * random.uniform(0.18, 0.34)
    lathe('pottery', cx, cy, z0, [(r * 0.55, 0), (r, hgt * 0.45), (r * 0.8, hgt * 0.8), (r * 0.45, hgt), (r * 0.55, hgt * 1.08)], n=10)

def plinth_case(cx, cy, z0, sx, sy, h=0.85, glass=0.5, ang=0.0, items=3):
    box('black', cx, cy, z0, sx, sy, h, ang)
    box('case_glass', cx, cy, z0 + h, sx - 0.04, sy - 0.04, glass, ang)
    P = rot(cx, cy, ang)
    for k in range(items):
        vessel(*P((k - (items - 1) / 2) * sx / (items + 0.5), random.uniform(-0.1, 0.1) * sy), z0 + h)

def vitrine(cx, cy, z0, w, d, h, tex, ang=0.0):
    """Tall glass case around a double-faced relief slab."""
    box('black', cx, cy, z0, w + 0.12, d + 0.12, 0.3, ang)
    slab('stone', f'img_{tex}', cx, cy, z0 + 0.3, w * 0.8, 0.22, h - 0.65, ang)
    box('case_glass', cx, cy, z0 + 0.3, w, d, h - 0.3, ang)
    box('black', cx, cy, z0 + h, w + 0.12, d + 0.12, 0.08, ang)

def seat(x, y, z, ang):
    """Theatre seat facing direction ang."""
    fx, fy = math.cos(ang), math.sin(ang); a = ang - math.pi / 2
    box('seat', x, y, z, 0.5, 0.46, 0.44, a)
    box('seat', x - fx * 0.24, y - fy * 0.24, z + 0.44, 0.5, 0.08, 0.5, a)

def seating(s0, s1, front, rows, pitch, rise, z, ang, spacing=0.56):
    """Tiered rows facing ang (a multiple of 90°): seats from s0 to s1 along the row, row 0 on the line `front`
    nearest the stage, later rows stepping back and up."""
    fx, fy = round(math.cos(ang)), round(math.sin(ang))
    n = int((s1 - s0) / spacing)
    for r in range(rows):
        zr = z + r * rise
        d = front - (fy or fx) * r * pitch
        if r:
            if fy: box('black', (s0 + s1) / 2, d, z, s1 - s0 + 0.6, pitch, r * rise)
            else: box('black', d, (s0 + s1) / 2, z, pitch, s1 - s0 + 0.6, r * rise)
        for k in range(n + 1):
            s = s0 + k * (s1 - s0) / max(1, n)
            seat(s, d, zr, ang) if fy else seat(d, s, zr, ang)

# ---------------------------------------------------------------- halls
HALLS = []
def hall(**entry):
    HALLS.append(entry)

def xuting():
    """序厅 (p3–5): the gold scroll between two leaning monoliths on the display wall facing the entrance."""
    z, top, low = 0.0, 7.5, 5.0
    f = z + LIFT
    with room('xuting', 'F1'):
        flat('floor_dark', -12.2, 83.9, 11.0, 96.0, f)
        flat('floor_dark', -16.0, 81.3, -12.2, 89.9, f); flat('floor_dark', 11.0, 81.3, 14.4, 89.9, f)
        # clear of the building's wall and column faces (up to y 83.95)
        y = 84.0
        tiled('wall_dark', (11.0, y), (-12.2, y), z, top, 2.4)
        panel('img_charwall', (8.8, y + 0.03), (1.9, y + 0.03), 0.3, 6.9, (2, 2))
        panel('img_charwall', (-1.9, y + 0.03), (-8.8, y + 0.03), 0.3, 6.9, (2, 2))
        box('black', 0, 85.6, z, 15.0, 3.4, 0.16)
        box('led_warm', 0, 87.32, z + 0.05, 15.0, 0.04, 0.05)
        box('black', 0, y + 0.18, z + 0.16, 4.1, 0.3, top - z - 0.16)
        panel('img_scroll', (1.8, y + 0.335), (-1.8, y + 0.335), z + 0.3, top - 0.02)
        flat('img_scroll', -1.8, y + 0.34, 1.8, y + 4.6, top - 0.03, up=False, rep=(1, 0.6), g=GC())
        for s in (-1, 1):
            X = lambda v: s * v
            lo = [(X(2.3), 84.3, z + 0.16), (X(5.9), 84.3, z + 0.16), (X(5.9), 86.0, z + 0.16), (X(2.3), 86.0, z + 0.16)]
            hi = [(X(2.1), 84.1, z + 6.8), (X(3.9), 84.1, z + 6.8), (X(3.9), 84.75, z + 6.8), (X(2.1), 84.75, z + 6.8)]
            if s < 0: lo, hi = [lo[1], lo[0], lo[3], lo[2]], [hi[1], hi[0], hi[3], hi[2]]
            wedge('monolith', lo, hi)
            box('led_white', X(3.0), 84.43, z + 6.8, 1.8, 0.6, 0.03)
        # the tall walls above the 2F slab line are storey F2 in the building model, so they are closed here;
        # dark timber slats on the side walls beyond the openings to the low side bays
        for x, a, b in ((-12.18, 83.9, 96.0), (10.98, 96.0, 83.9)):
            tiled('wall_dark', (x, a), (x, b), low, top, 3.0)
            s0, s1 = (89.9, 96.0) if a < b else (96.0, 89.9)
            tiled('wall_dark', (x, s0), (x, s1), z, low, 3.0)
            n = int(abs(s1 - s0 - 0.6) / 0.22)
            for k in range(n + 1):
                box('timber', x + (0.05 if x < 0 else -0.05), s0 + (s1 - s0) * (0.05 + 0.9 * k / n), z + 2.4, 0.08, 0.06, 4.4)
        tiled('wall_dark', (-12.2, 95.98), (11.0, 95.98), low, top, 3.0)
        ceiling(-12.2, 83.9, 11.0, 96.0, top, holes=[(-3.0, 89.5, 3.0, 94.5)])
        flat('led_white', -3.0, 89.5, 3.0, 94.5, top + 0.02, up=False, g=GC())
        for k in range(21):
            box('wood', -0.6, 84.2 + k * 0.58, top - 0.14, 23.0, 0.08, 0.14, g=GC())
        ceiling(-16.0, 81.3, -12.2, 89.9, low); ceiling(11.0, 81.3, 14.4, 89.9, low)
    hall(id='xuting', name='序厅', chapter='开篇 · 痕定汉影', level='F1', zones=['F1-03'], pages=[3, 4, 5],
         floor=z, ceiling=top,
         text='主展线开篇。从天而降的金色光影长卷浮现伏羲女娲等始祖形象，两侧斜立粗犷石质体块，背景为汉字石刻肌理墙；深色木格栅吊顶，中央天光。',
         eye=[0, 95.2, 1.65], target=[0, 84.6, 3.4],
         lights=[[0, 88.5, 6.9, 70, '#ffd9a8'], [-7.5, 90, 6.6, 40, '#ffe3c0'], [7.0, 90, 6.6, 40, '#ffe3c0'], [0, 94.5, 6.6, 30, '#fff1dc']])

def chuying():
    """第一章 初影（根） (p6–16): 汉式木构“亭”, rubbing mural wall, wall cases, cloud columns, 武氏祠 banner and craft tables."""
    z, top = 0.0, 5.0
    f = z + LIFT
    with room('chuying', 'F1'):
        flat('floor_dark', -25.0, 65.95, 25.0, 81.05, f); flat('floor_dark', -11.2, 81.05, 11.0, 83.55, f)
        tiled('wall_dark', (-11.2, 83.56), (11.0, 83.56), z, top, 3.0)
        for a, b in (((25.0, 65.95), (-25.0, 65.95)), ((-25.0, 65.95), (-25.0, 81.05)), ((25.0, 81.05), (25.0, 65.95)),
                     ((-25.0, 81.05), (-11.2, 81.05)), ((11.0, 81.05), (25.0, 81.05))):
            tiled('wall_dark', a, b, z, top, 3.0, 0.005)
        box('black', -0.1, 83.44, z + 0.25, 21.6, 0.2, 4.35)
        panel('img_mural-chuying', (-10.7, 83.335), (10.5, 83.335), z + 0.45, z + 4.4)
        box('led_warm', -0.1, 83.22, z + 4.55, 21.2, 0.05, 0.04)
        # the pavilion: posts on the column line y 74.7 and one bay south, beams overhanging, frosted frieze
        cx, cy, hx, hy = 0.0, 72.15, 4.5, 2.55
        for sx in (-1, 1):
            for sy in (-1, 1):
                box('timber', cx + sx * hx, cy + sy * hy, z, 0.72, 0.72, 4.3)
                box('black', cx + sx * hx, cy + sy * hy, z, 0.84, 0.84, 0.35)
        for sy in (-1, 1): box('timber', cx, cy + sy * hy, z + 3.95, 2 * hx + 2.4, 0.36, 0.42)
        for sx in (-1, 1): box('timber', cx + sx * hx, cy, z + 3.95, 0.36, 2 * hy + 2.4, 0.42)
        for sy in (-1, 1): box('frost', cx, cy + sy * hy, z + 2.95, 2 * hx - 0.72, 0.14, 0.95)
        for sx in (-1, 1): box('frost', cx + sx * hx, cy, z + 2.95, 0.14, 2 * hy - 0.72, 0.95)
        slab('stone', 'img_stele-white', cx, cy - 0.9, z, 1.7, 0.32, 2.4)
        for sx in (-1, 1):
            plinth_case(cx + sx * 2.5, cy + 1.25, z, 1.9, 0.9)
            vitrine(cx + sx * 3.2, cy - 1.3, z, 1.1, 0.6, 2.3, 'case-chuying')
        # red cloud-pattern columns on the other column stations
        for x in (-18.3, -11.4, 11.4, 18.3):
            wrap('img_cloud', x, 74.7, z, 0.9, 0.9, 4.45)
        # wall cases all round
        wall_case((-24.95, 66.6), (-24.95, 80.4), z, 'case-chuying')
        wall_case((24.95, 80.4), (24.95, 66.6), z, 'case-chuying')
        wall_case((-13.0, 65.95), (-23.9, 65.95), z, 'case-chuying')
        wall_case((23.9, 65.95), (13.0, 65.95), z, 'case-chuying')
        wall_case((-24.4, 81.0), (-16.8, 81.0), z, 'case-chuying')
        wall_case((15.0, 81.0), (24.4, 81.0), z, 'case-chuying')
        # west end: 武氏祠 banner between cloud columns, craft tables under a hung lightbox
        for y in (70.9, 75.7): wrap('img_cloud', -15.0, y, z, 0.9, 0.9, 4.45)
        slab('black', 'img_banner', -15.0, 73.3, z, 1.4, 0.14, 3.9, ang=math.pi / 2)
        for y in (71.4, 75.2):
            box('wood_light', -19.6, y, z, 2.8, 1.3, 0.78)
            for sx in (-1, 1):
                for k in (-1, 0, 1): box('wood_light', -19.6 + k * 0.9, y + sx * 1.0, z, 0.4, 0.4, 0.45)
        box('frost', -19.6, 73.3, z + 3.3, 5.0, 5.4, 0.28, bottom=True)
        for sx in (-1, 1):
            for sy in (-1, 1): box('black', -19.6 + sx * 2.3, 73.3 + sy * 2.5, z + 3.58, 0.03, 0.03, top - z - 3.58)
        ceiling(-25.0, 65.95, 25.0, 81.05, top); ceiling(-11.2, 81.05, 11.0, 83.55, top)
        for x in (-18.3, -11.4, -4.5, 4.5, 11.4, 18.3):
            y1 = 83.5 if abs(x) < 11 else 81.0
            box('wood', x, (66.0 + y1) / 2, top - 0.5, 0.45, y1 - 66.0, 0.5, g=GC())
        box('wood', 0, 74.7, top - 0.5, 50.0, 0.45, 0.5, g=GC())
        for x in (-21.75, -14.85, -7.95, 0.0, 7.95, 14.85, 21.75):
            box('led_warm', x, 73.5, top - 0.04, 0.06, 14.0, 0.035, g=GC())
    hall(id='chuying', name='初影', chapter='第一章 · 初影（根）', level='F1', zones=['F1-01'], pages=list(range(6, 17)),
         floor=z, ceiling=top,
         text='“寻根”之旅。深色木构梁架与格栅天花下，汉式木构“亭”内设数字展柜、台座展柜与题名碑；北墙为带投影光斑的画像石拓片巨幅墙，四周通高展柜，红色云气纹立柱，西端为“武氏祠”题名与画像石制作体验区。',
         eye=[14.5, 68.0, 1.65], target=[-2.0, 78.5, 2.3],
         lights=[[-19.6, 73.3, 4.2, 22, '#ffe0b8'], [-10, 78, 4.3, 22, '#ffe0b8'], [0, 79, 4.3, 30, '#ffd9a8'],
                 [0, 72.2, 2.6, 10, '#fff0dc'], [10, 78, 4.3, 22, '#ffe0b8'], [19, 72, 4.3, 22, '#ffe0b8']])

def b1_partitions():
    """The 预留展厅 split into the three chapter rooms, open along the south aisle."""
    z, top = Z_B1, -1.0
    for x, hall_id in ((9.3, 'zhuying'), (-6.0, 'liying')):
        with room(hall_id, 'B1'):
            box('wall_dark', x, 53.3, z, 0.25, 11.6, top - z)
    # the building's north and end walls behind the cases
    for hall_id, walls in (('zhuying', (((9.43, 59.15), (24.05, 59.15)), ((24.05, 59.15), (24.05, 42.8)))),
                           ('liying', (((-5.87, 59.15), (9.17, 59.15)),)),
                           ('chuanying', (((-24.05, 59.15), (-6.13, 59.15)), ((-24.05, 42.8), (-24.05, 59.15))))):
        with room(hall_id, 'B1'):
            for a, b in walls: tiled('wall_dark', a, b, z, top, 3.0, 0.005)

def zhuying():
    """第二章 铸影（魂） (p17–21): two lit canopies letting down threads of light onto the 车马出行 procession."""
    z, top = Z_B1, -1.0
    f = z + LIFT
    with room('zhuying', 'B1'):
        flat('floor_dark', 9.43, 42.8, 24.05, 59.15, f)
        cx, cy = 16.7, 51.2
        box('black', cx, cy, z, 8.6, 8.6, 0.22)
        flat('sand', cx - 4.25, cy - 4.25, cx + 4.25, cy + 4.25, z + 0.225)
        for s in (-1, 1):
            box('led_warm', cx, cy + s * 4.31, z + 0.03, 8.6, 0.03, 0.05); box('led_warm', cx + s * 4.31, cy, z + 0.03, 0.03, 8.6, 0.05)
        frame('wood_light', cx, cy, 10.6, 1.1, top - 0.75, top - 0.3, glow='frost', g=GH())
        frame('wood_light', cx, cy, 8.2, 0.7, top - 1.15, top - 0.8, glow='frost', g=GH())
        for sx in (-1, 1):
            for sy in (-1, 1): box('black', cx + sx * 3.8, cy + sy * 3.8, top - 0.8, 0.04, 0.04, 0.8, g=GH())
        # the threads of light falling from the inner canopy, thinning out towards its edge
        n = 15
        for i in range(n):
            for j in range(n):
                x = cx - 3.6 + 7.2 * i / (n - 1) + random.uniform(-0.15, 0.15)
                y = cy - 3.6 + 7.2 * j / (n - 1) + random.uniform(-0.15, 0.15)
                if random.random() < 0.25: continue
                zb = z + 0.25 + random.uniform(0.5, 1.9)
                box('cyan', x, y, zb, 0.012, 0.012, top - 1.15 - zb, top=False)
        # the 车马出行 procession projected onto the sand in three bands
        for k, y in enumerate((cy - 2.6, cy, cy + 2.6)):
            flat('chariot_light', cx - 3.9, y - 0.65, cx + 3.9, y + 0.65, z + 0.235, rep=(1.5 + 0.5 * k, 1))
        sheath(14.25, 51.05, z, top)
        wall_case((24.0, 58.4), (24.0, 43.6), z, 'case-zhuying', h=2.9)
        wall_case((10.2, 59.1), (23.2, 59.1), z, 'case-zhuying', h=2.9)
        tiled('wall_dark', (9.44, 47.5), (9.44, 59.1), z, top, 3.0)
        panel('img_mural-chariot', (9.45, 48.2), (9.45, 58.6), z + 0.9, z + 3.0, (2, 1), 0.01)
        box('led_warm', 9.62, 53.4, z + 3.1, 0.05, 10.4, 0.04)
        ceiling(9.43, 42.8, 24.05, 59.15, top)
    hall(id='zhuying', name='铸影', chapter='第二章 · 铸影（魂）', level='B1', zones=['B1-01'], pages=list(range(17, 22)),
         floor=z, ceiling=top,
         text='两层发光顶棚垂下青色光丝，笼罩沙土台上以光影呈现的车马出行与人物，是展厅情绪的高潮；四周通柜陈列，西墙为车马出行壁画。',
         eye=[11.0, 44.0, z + 1.65], target=[17.0, 52.0, z + 1.2],
         lights=[[16.7, 51.2, top - 0.5, 24, '#ffe2bc'], [16.7, 51.2, z + 2.2, 12, '#8fe9ff'], [22.4, 51, top - 0.4, 12, '#ffe0b8'],
                 [16.5, 57.6, top - 0.4, 12, '#ffe0b8'], [11.0, 53.4, top - 0.4, 10, '#ffe0b8']])

def liying():
    """第三章 立影（骨） (p22–24): the site sand table under a starry ceiling, the strata wall and a dig pit."""
    z, top = Z_B1, -1.0
    f = z + LIFT
    with room('liying', 'B1'):
        flat('floor_dark', -5.87, 42.8, 9.17, 59.15, f)
        cx, cy = 1.6, 50.8
        # the sand table fits between the building columns at x ±4.5 on its centre line
        tx = 0.0
        wrap('img_sandtable', tx, cy, z, 7.8, 5.2, 0.95, (3, 1), body='wood_light')
        flat('sand', tx - 3.9, cy - 2.6, tx + 3.9, cy + 2.6, z + 0.955)
        for sx in (-1, 1): sheath(sx * 4.5, 51.05, z, top)
        # the shrine site in miniature: enclosure, the pair of 阙 at the gate, halls and steles
        t = z + 0.955
        for sy in (-1, 1): box('monolith', tx, cy + sy * 2.0, t, 6.8, 0.06, 0.12)
        for sx in (-1, 1): box('monolith', tx + sx * 3.4, cy, t, 0.06, 4.0, 0.12)
        for sx in (-1, 1):
            box('monolith', tx + sx * 0.6, cy - 2.25, t, 0.24, 0.2, 0.5)
            box('timber', tx + sx * 0.6, cy - 2.25, t + 0.5, 0.34, 0.28, 0.05)
        for hx, hy, w, d in ((-2.0, 0.6, 1.1, 0.8), (0.0, 1.0, 1.4, 0.9), (2.0, 0.6, 1.1, 0.8), (0.0, -0.8, 0.9, 0.6)):
            x0, x1, y0, y1 = tx + hx - w / 2, tx + hx + w / 2, cy + hy - d / 2, cy + hy + d / 2
            box('monolith', tx + hx, cy + hy, t, w, d, 0.26)
            wedge('timber', [(x0 - 0.08, y0 - 0.08, t + 0.26), (x1 + 0.08, y0 - 0.08, t + 0.26), (x1 + 0.08, y1 + 0.08, t + 0.26), (x0 - 0.08, y1 + 0.08, t + 0.26)],
                  [(x0 + 0.1, cy + hy - 0.02, t + 0.46), (x1 - 0.1, cy + hy - 0.02, t + 0.46), (x1 - 0.1, cy + hy + 0.02, t + 0.46), (x0 + 0.1, cy + hy + 0.02, t + 0.46)])
        for sx in (-2.6, -1.8, -1.0, 1.0, 1.8, 2.6):
            box('stone', tx + sx, cy - 1.35, t, 0.14, 0.05, 0.22)
        box('case_glass', tx + 1.95, cy, t, 3.9, 5.2, 0.62)
        box('black', cx, 59.0, z + 0.5, 13.8, 0.2, 2.25)
        panel('img_strata', (-5.2, 58.895), (8.4, 58.895), z + 0.6, z + 2.65, (1.7, 1))
        box('led_warm', cx, 58.78, z + 2.78, 13.6, 0.05, 0.04)
        box('black', cx, 57.4, z, 12.0, 1.1, 0.45)
        flat('sand', cx - 5.95, 56.9, cx + 5.95, 57.9, z + 0.455)
        box('case_glass', cx, 57.4, z + 0.45, 12.0, 1.1, 0.06)
        # 探方 dig pit (p24): a sunken sand square with a grid of cords
        px, py = -2.6, 45.2
        frame('stone', px, py, 3.6, 0.3, z, z + 0.35)
        flat('sand', px - 1.5, py - 1.5, px + 1.5, py + 1.5, z + 0.1)
        for vx, vy in ((-0.8, 0.5), (0.4, -0.6), (0.9, 0.8)): vessel(px + vx, py + vy, z + 0.1, 1.2)
        for k in (-0.75, 0, 0.75):
            box('led_white', px + k, py, z + 0.36, 0.015, 3.0, 0.015); box('led_white', px, py + k, z + 0.36, 3.0, 0.015, 0.015)
        wall_case((-5.87, 48.0), (-5.87, 58.3), z, 'case-liying', h=2.9)
        wall_case((9.17, 58.3), (9.17, 48.0), z, 'case-liying', h=2.9)
        flat('stars', -5.87, 42.8, 9.17, 59.15, top, up=False, g=GC())
    hall(id='liying', name='立影', chapter='第三章 · 立影（骨）', level='B1', zones=['B1-01'], pages=[22, 23, 24],
         floor=z, ceiling=top,
         text='连接汉代与当代的过渡章节。星空顶下，中央遗址沙盘展示武氏祠的布局巧思；北墙为考古地层长墙，前设探沟展柜；南侧设模拟考古发掘的探方体验场地，两侧通柜梳理保护与研究历程。',
         eye=[6.8, 44.0, z + 2.4], target=[0.0, 52.6, z + 0.8],
         lights=[[1.6, 50.8, top - 0.3, 22, '#ffe2bc'], [1.6, 57.2, top - 0.3, 14, '#ffd9a8'], [-4.2, 53, top - 0.3, 9, '#ffe0b8'],
                 [7.6, 53, top - 0.3, 9, '#ffe0b8'], [-2.6, 45.2, top - 0.3, 8, '#fff0dc']])

def chuanying():
    """第四章 传影（脉） (p25–29): the chariot relief wall, gold line-drawing ceiling, steles and rubbing tables."""
    z, top = Z_B1, -1.0
    f = z + LIFT
    with room('chuanying', 'B1'):
        flat('floor_dark', -24.05, 42.8, -6.13, 59.15, f)
        box('black', -23.95, 51.2, z + 0.2, 0.2, 15.0, 3.6)
        panel('img_relief-mural', (-23.845, 43.9), (-23.845, 58.5), z + 0.35, z + 3.65, (2, 1))
        box('led_warm', -23.6, 51.2, z + 3.72, 0.05, 14.6, 0.04)
        ceiling(-24.05, 42.8, -6.13, 59.15, top, holes=[(-20.5, 45.2, -9.5, 56.8)])
        flat('img_goldline', -20.5, 45.2, -9.5, 56.8, top + 0.15, up=False, rep=(1, 1), g=GC())
        frame('black', -15.0, 51.0, 11.6, 0.3, top - 0.05, top + 0.15, g=GC())
        vitrine(-16.0, 50.9, z, 1.6, 0.9, 2.9, 'stele-gold')
        sheath(-14.25, 51.05, z, top)
        for x in (-19.2, -10.8):
            box('stone', x, 53.9, z, 1.9, 0.9, 0.32)
            slab('stone', 'img_stele-white', x, 53.9, z + 0.32, 1.5, 0.3, 1.55)
        for x, y in ((-19.6, 47.2), (-10.4, 47.4), (-13.2, 56.9), (-17.2, 57.0)):
            box('stone', x, y, z, 1.3, 0.9, 0.35)
            slab('stone', 'img_stone-relief', x, y, z + 0.35, 0.95, 0.42, 0.95, random.uniform(-0.3, 0.3))
        for y in (47.0, 54.6):
            box('wood_light', -21.4, y, z, 1.3, 3.6, 0.82)
            flat('img_rubbing', -22.0, y - 1.75, -20.8, y + 1.75, z + 0.825, rep=(1, 1))
            box('wood_light', -20.3, y, z, 0.4, 3.0, 0.45)
        wall_case((-23.2, 59.1), (-7.0, 59.1), z, 'rubbing', h=2.9)
        wall_case((-6.13, 58.3), (-6.13, 48.0), z, 'stone-relief', h=2.9, seg=1.8)
    hall(id='chuanying', name='传影', chapter='第四章 · 传影（脉）', level='B1', zones=['B1-01'], pages=list(range(25, 30)),
         floor=z, ceiling=top,
         text='以情景复现诠释武氏祠画像石的历史、艺术与文化价值。西墙为车马出行画像石巨墙，顶部为金色线描发光顶，厅内立玻璃罩双面画像石、车马画像石与残件，另设可触摸的拓片制作体验台。',
         eye=[-8.0, 44.2, z + 1.65], target=[-18.5, 52.0, z + 1.4],
         lights=[[-15.0, 51.0, top - 0.3, 22, '#ffd79e'], [-21.2, 50.8, top - 0.3, 16, '#ffe0b8'], [-10.5, 55.5, top - 0.3, 10, '#ffe0b8'],
                 [-10.5, 46.5, top - 0.3, 10, '#ffe0b8']])

def weiting():
    """尾厅 (p30–34): hall within a hall — totem room, immersive cinema, interactive images, dig-site hall."""
    z, top = Z_CORE, -0.95
    f = z + LIFT
    with room('weiting', 'B1'):
        flat('floor_dark', -10.3, 2.8, 10.3, 26.35, f)
        flat('floor_dark', -19.1, 2.8, -10.3, 17.0, f); flat('floor_dark', 10.3, 2.8, 19.1, 17.0, f)
        for s in (-1, 1):
            box('wall_dark', s * 10.5, 5.7, z, 0.25, 5.8, top - z); box('wall_dark', s * 10.5, 14.5, z, 0.25, 5.0, top - z)
            box('wall_dark', s * 6.75, 13.8, z, 7.5, 0.25, top - z)
        # 数字图腾 totem room: gold relief tiles on every wall, starry ceiling
        tsz = 1.3
        def totem(a, b): panel('img_totem', a, b, z, top, (math.dist(a, b) / tsz, (top - z) / (2 * tsz)))
        totem((10.35, 2.95), (-10.35, 2.95))
        # the building's wall between the columns at y 4.8 stands inside the room
        totem((4.25, 4.97), (-4.25, 4.97))
        totem((-10.35, 3.0), (-10.35, 8.6)); totem((-10.35, 12.0), (-10.35, 13.65))
        totem((10.35, 13.65), (10.35, 12.0)); totem((10.35, 8.6), (10.35, 3.0))
        totem((-10.35, 13.66), (-3.0, 13.66)); totem((3.0, 13.66), (10.35, 13.66))
        for sx in (-1, 1):
            for x in (4.5, 10.05):
                for y in (4.8, 13.8): sheath(sx * x, y, z, top, 'img_totem')
            sheath(sx * 4.5, 22.8, z, top); sheath(sx * 10.05, 22.8, z, top)
        flat('stars', -10.5, 2.8, 10.5, 13.8, top, up=False, g=GC())
        # 影像交互厅: the interactive rubbing wall and its floor projection
        panel('img_digital', (-18.95, 3.3), (-18.95, 16.5), z + 0.1, top - 0.1, (2.5, 1))
        flat('img_digital', -17.6, 5.4, -12.2, 14.4, f + 0.005, rep=(1, 1.6))
        for y in (6.5, 13.3): box('black', -12.0, y, z, 0.5, 0.5, 1.1); box('led_white', -12.0, y, z + 1.1, 0.46, 0.46, 0.02)
        # 沉浸观影厅: screen on the east wall, benches facing it
        tiled('black', (18.97, 16.6), (18.97, 3.2), z, top, 3.0)
        panel('img_film', (18.94, 13.9), (18.94, 5.9), z + 0.3, top - 0.15)
        for x in (12.2, 13.6, 15.0): box('black', x, 9.9, z, 0.5, 7.0, 0.45)
        # 探方考古厅: a floor trench under glass, lit dig-site box on the north wall, posters on the side walls
        box('black', 0, 26.12, z, 5.6, 0.25, top - z)
        panel('img_trench-box', (-2.4, 25.99), (2.4, 25.99), z + 0.35, z + 2.35)
        for x0 in (-3.3, 2.5): panel('img_archaeo-wall', (x0, 25.99), (x0 + 0.8, 25.99), z, top - 0.05, (1, 0.8))
        frame('black', 0, 20.3, 5.0, 0.3, z, z + 0.3)
        flat('sand', -2.2, 18.1, 2.2, 22.5, z + 0.08)
        flat('case_glass', -2.2, 18.1, 2.2, 22.5, z + 0.31)
        for k in (-1.1, 0, 1.1):
            box('led_white', k, 20.3, z + 0.1, 0.015, 4.4, 0.015); box('led_white', 0, 20.3 + k, z + 0.1, 4.4, 0.015, 0.015)
        for y0 in (17.3, 20.3):
            panel('img_poster', (-10.14, y0), (-10.14, y0 + 2.0), z + 0.2, z + 2.45)
            panel('img_poster', (10.14, y0 + 2.0), (10.14, y0), z + 0.2, z + 2.45)
        ceiling(-10.3, 13.8, 10.3, 26.35, top)
        ceiling(-19.1, 2.8, -10.5, 17.0, top); ceiling(10.5, 2.8, 19.1, 17.0, top)
    hall(id='weiting', name='尾厅', chapter='尾厅 · 厅中厅', level='B1', zones=['B1-02'], pages=list(range(30, 35)),
         floor=z, ceiling=top,
         text='展览的升华。“厅中厅”布局：南部数字图腾厅四壁为画像石图腾墙、星空顶；东侧沉浸观影厅以新艺术形式演绎民族故事；北部探方考古厅复原考古现场；西侧影像交互厅让观众把个人形象铭刻于虚拟画像石，生成专属“数字图腾”。',
         eye=[6.0, 12.6, z + 1.6], target=[-5.0, 4.0, z + 1.2],
         lights=[[0, 8.3, top - 0.3, 16, '#ffd79e'], [0, 20.5, top - 0.3, 14, '#ffe0b8'], [-15.0, 10.0, top - 0.3, 6, '#9cc4ff'],
                 [14.5, 10.0, top - 0.3, 4, '#ffe0b8']])

def zhuanti():
    """武氏祠专题展厅 (p38): three stone rooms with rubbing walls and tall relief cases under skylights."""
    z, top = 0.0, 5.0
    f = z + LIFT
    with room('zhuanti', 'F1'):
        flat('floor_dark', -19.0, 2.7, 19.0, 22.3, f)
        # inner wall faces of the three rooms in the building model; the inner side walls have doors at y 6.72–8.3
        rooms = [(-16.98, -8.22, False, True), (-4.38, 4.38, True, True), (8.22, 16.98, True, False)]
        holes = []
        for x0, x1, door0, door1 in rooms:
            cx = (x0 + x1) / 2
            tiled('stone', (x1, 4.93), (x0, 4.93), z, top, 2.4)
            for spans, x, flip in ((door0, x0 + 0.01, False), (door1, x1 - 0.01, True)):
                for a, b in ((4.93, 6.48), (8.3, 13.69)) if spans else ((4.93, 13.69),):
                    tiled('stone', *(((x, b), (x, a)) if flip else ((x, a), (x, b))), z, top, 2.4)
                if spans:
                    tiled('stone', *(((x, 8.3), (x, 6.48)) if flip else ((x, 6.48), (x, 8.3))), z + 3.0, top, 2.4)
                    # the wall fin beside each door
                    box('stone', x + (-0.4 if flip else 0.4), 6.6, z, 0.9, 0.28, top - z)
            box('black', cx, 5.14, z, 3.4, 0.2, 3.9)
            panel('img_rubbing-wall', (cx + 1.5, 5.245), (cx - 1.5, 5.245), z + 0.15, z + 3.75)
            for s in (-1, 1):
                vitrine(cx + s * 2.6, 9.2, z, 1.5, 0.9, 3.0, 'shrine-stone')
                box('led_warm', cx + s * ((x1 - x0) / 2 - 0.12), 5.3, z, 0.08, 0.05, 4.6)
            holes.append((cx - 1.8, 7.6, cx + 1.8, 11.2))
            # the building's wall spurs either side of the rubbing wall
            for s in (-1, 1): box('stone', cx + s * 2.7, 5.34, z, 0.3, 0.87, top - z)
        for s in (-1, 1):
            box('stone', s * 15.3, 13.28, z, 0.3, 0.9, top - z)
            for y in (6.6, 12.0): box('stone', s * 16.55, y, z, 0.9, 0.28, top - z)
        for x in (-10.05, -4.5, 4.5, 11.09):
            for y in (4.8, 13.8): sheath(x, y, z, top, 'stone')
        for x in (-6.5, 6.5):
            box('stone', x, 18.6, z, 1.9, 0.9, 0.32)
            slab('stone', 'img_stele-white', x, 18.6, z + 0.32, 1.5, 0.3, 1.6)
        for x in (-2.2, 2.2): plinth_case(x, 19.6, z, 1.8, 0.9)
        holes.append((-3.0, 16.4, 3.0, 21.0))
        ceiling(-19.0, 2.7, 19.0, 22.3, top, holes=holes)
        for x0, y0, x1, y1 in holes:
            flat('led_white', x0, y0, x1, y1, top + 0.03, up=False, g=GC())
    hall(id='zhuanti', name='武氏祠专题展厅', chapter='专题展厅', level='F1', zones=['F1-02'], pages=[36, 38],
         floor=z, ceiling=top,
         text='三间石材展室，各以画像石拓片墙为背景，两侧立通高玻璃柜陈列双面画像石，顶部天光灯箱；北侧立车马画像石与台柜。',
         eye=[3.0, 14.0, 1.65], target=[-0.6, 5.5, 1.8],
         lights=[[-12.8, 9.4, 4.4, 16, '#fff0dc'], [0, 9.4, 4.4, 16, '#fff0dc'], [12.6, 9.4, 4.4, 16, '#fff0dc'], [0, 18.6, 4.4, 18, '#ffe7c8']])

def zhongjuchang():
    """中型剧场 (p37): square thrust stage, red seats on three sides, red lattice lightboxes."""
    z, top = 0.0, 5.0
    f = z + LIFT
    with room('zhongjuchang', 'F1'):
        flat('carpet', 38.5, 46.9, 54.6, 72.4, f)
        cx = 46.4
        # dark perimeter behind the lattice: the west side is open to the lobby but for the door at y 61.2–63.4
        tiled('wall_dark', (54.6, 46.93), (38.5, 46.93), z, top, 3.0)
        tiled('wall_dark', (38.5, 72.37), (54.6, 72.37), z, top, 3.0)
        tiled('wall_dark', (54.58, 72.37), (54.58, 46.93), z, top, 3.0)
        tiled('wall_dark', (38.52, 46.93), (38.52, 61.2), z, top, 3.0)
        tiled('wall_dark', (38.52, 63.4), (38.52, 72.37), z, top, 3.0)
        tiled('wall_dark', (38.52, 61.2), (38.52, 63.4), z + 3.0, top, 3.0)
        box('wall_dark', 39.7, 47.45, z, 2.4, 1.1, top - z)
        for x, y in ((38.4, 56.7), (46.5, 46.8), (54.55, 46.8), (54.55, 56.7), (54.55, 65.7)): sheath(x, y, z, top)
        box('stage', cx, 66.8, z, 9.0, 6.6, 0.5)
        box('led_warm', cx, 63.48, z + 0.06, 9.0, 0.04, 0.04)
        panel('img_lattice', (39.0, 72.2), (53.8, 72.2), z + 0.6, z + 4.4, (14.8, 1.9))
        for a, b in (((38.62, 47.6), (38.62, 56.4)), ((38.62, 66.3), (38.62, 71.8)), ((54.18, 71.8), (54.18, 47.6))):
            panel('img_lattice', a, b, z + 1.2, z + 4.4, (math.dist(a, b), 1.6))
        seating(40.6, 52.2, 61.6, 9, 1.0, 0.28, f, math.pi / 2)
        seating(64.2, 69.6, 41.2, 3, 0.95, 0.28, f, 0.0)
        seating(64.2, 69.6, 51.6, 3, 0.95, 0.28, f, math.pi)
        ceiling(38.5, 47.2, 54.3, 72.3, top)
        for y in (58.0, 62.0, 66.0, 70.0): box('truss', cx, y, top - 0.9, 14.0, 0.2, 0.2, g=GH())
        for x in (41.0, 51.8): box('truss', x, 64.0, top - 0.9, 0.2, 12.0, 0.2, g=GH())
    hall(id='zhongjuchang', name='中型剧场', chapter='演艺 · 中型剧场', level='F1', zones=['F1-04'], pages=[36, 37],
         floor=z, ceiling=top,
         text='方形伸出式舞台，三面阶梯式红色座椅，墙面为红色格栅灯箱，顶部灯光网架。',
         eye=[cx + 5.5, 54.0, 3.3], target=[cx - 1.0, 66.0, 0.9],
         lights=[[cx, 66.8, 4.2, 34, '#ffd9a8'], [cx, 56, 4.4, 20, '#ffe3c0'], [41, 52, 4.4, 10, '#ffe3c0'], [52, 52, 4.4, 10, '#ffe3c0']])

def dajuchang():
    """大型剧场 (p39–40): an open immersive hall without seats, whatever the CAD's audience / stage split. Ink
    murals on every wall, curved glowing platforms and steel galleries along both sides and a bridge across the
    back for the performers, free-standing painted screens, and a low stage with light portals and trusses at
    the far end; visitors walk about the open floor between them."""
    z, top = 0.0, 7.6
    f = z + LIFT
    cx = -46.4
    xw, xe, ys, yn = -54.5, -38.4, 47.3, 83.3
    zg = z + 3.6
    with room('dajuchang', 'F1'):
        flat('floor_dark', -54.6, 47.2, -38.3, 83.8, f)
        # rust walls hung with ink murals below and above the galleries; the back wall column is at x −46.5 (face y 83.43)
        tiled('rust', (xw, yn + 0.06), (xe, yn + 0.06), z, top, 3.0)
        for a, b in (((xw - 0.02, ys), (xw - 0.02, 83.7)), ((xe + 0.02, 83.7), (xe + 0.02, ys)), ((xe, ys - 0.02), (xw, ys - 0.02))):
            tiled('rust', a, b, z, top, 3.0)
        for a, b in (((xw, 47.6), (xw, 83.0)), ((xe, 83.0), (xe, 47.6))):
            panel('img_bamboo', a, b, z + 0.35, zg - 0.35, (6, 1), 0.01)
            panel('img_bamboo', a, b, zg + 0.3, top - 0.15, (6, 1), 0.01)
        panel('img_bamboo', (xe - 0.3, ys), (xw + 0.3, ys), z + 0.35, top - 0.15, (3, 1), 0.01)
        panel('img_bamboo', (xw + 0.3, yn + 0.02), (xe - 0.3, yn + 0.02), zg + 0.3, top - 0.15, (4, 1))
        for y in (46.8, 56.7, 65.7, 74.7): sheath(-54.5, y, z, top)
        for y in (46.8, 56.7): sheath(-38.35, y, z, top)
        sheath(-46.5, 46.8, z, top)
        # low platforms along the side walls, their curved edges lit from below
        def reach(y, inset=0.0):
            t = min(1.0, max(0.0, (y - 49.0) / 27.0))
            return 1.0 + 2.8 * math.sin(math.pi * t) ** 0.7 - inset
        for wall, s in ((xw, 1), (xe, -1)):
            for inset, m, z0, z1 in ((0.14, 'led_warm', f, f + 0.08), (0.0, 'black', f + 0.08, f + 0.34)):
                ys_ = [49.0 + inset + k * (27.0 - 2 * inset) / 36 for k in range(37)]
                poly = [(wall, ys_[0])] + [(wall + s * reach(y, inset), y) for y in ys_] + [(wall, ys_[-1])]
                B.prism(G(), m, poly, z0, z1, top_mat='floor_dark' if m == 'black' else None, bottom=m == 'black')
        # steel galleries along both sides joined by a bridge over the stage, railed on the hall side
        def rail(a, b, z0):
            L = math.dist(a, b); n = max(1, round(L / 1.6)); ang = math.atan2(b[1] - a[1], b[0] - a[0])
            for k in range(n + 1):
                box('black', a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, z0, 0.04, 0.04, 1.05)
            for h in (0.5, 1.02):
                box('black', (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z0 + h, L, 0.05, 0.05, ang)
        for wall, s in ((xw, 1), (xe, -1)):
            edge = wall + s * 2.0
            box('black', wall + s * 1.0, (ys + 81.15) / 2, zg - 0.22, 2.0, 81.15 - ys, 0.22, bottom=True)
            box('led_warm', edge - s * 0.06, (ys + 81.15) / 2, zg - 0.25, 0.04, 81.15 - ys - 0.2, 0.03)
            rail((edge, ys + 0.2), (edge, 81.15), zg)
        box('black', cx, (81.15 + yn) / 2, zg - 0.22, xe - xw, yn - 81.15, 0.22, bottom=True)
        box('led_warm', cx, 81.21, zg - 0.25, xe - xw - 4.2, 0.04, 0.03)
        rail((xw + 2.0, 81.15), (xe - 2.0, 81.15), zg)
        # tall painted screens standing free on the platforms, turned towards the middle, clear of the view to the stage
        for x, ang in ((-51.6, math.pi / 2 - 0.5), (-41.2, math.pi / 2 + 0.5)):
            slab('rust', 'img_bamboo', x, 66.0, f + 0.34, 3.2, 0.3, 5.6, ang, rep=(0.55, 1))
        # low stage under the bridge: bamboo backdrop, stepped front with light lines, gold light portals
        box('stage', cx, 79.95, z, 13.2, 6.7, 0.45)
        box('black', cx, 76.3, z, 13.2, 0.6, 0.22)
        box('led_warm', cx, 76.02, z + 0.19, 13.2, 0.04, 0.03); box('led_warm', cx, 76.62, z + 0.42, 13.2, 0.04, 0.03)
        panel('img_bamboo', (-53.0, yn + 0.02), (-39.8, yn + 0.02), z + 0.5, zg - 0.3, (3, 1))
        for s in (-1, 1):
            base = cx + s * 5.0
            box('black', base + s * 0.45, 77.2, z + 0.45, 1.1, 0.5, zg - 0.3 - (z + 0.45))
            for k in range(3):
                x = base - s * k * 0.35; hgt = 2.8 - k * 0.4
                box('led_warm', x, 76.9, z + 0.45, 0.06, 0.06, hgt)
                box('led_warm', x - s * 0.4, 76.9, z + 0.45 + hgt, 0.8, 0.06, 0.06)
        for k in (-1, 0, 1):
            frame('truss', cx + k * 4.3, 78.8 + k * 0.5, 3.4, 0.25, top - 1.6, top - 1.35, g=GH())
            for sx in (-1, 1):
                for sy in (-1, 1): box('black', cx + k * 4.3 + sx * 1.3, 78.8 + k * 0.5 + sy * 1.3, top - 1.8, 0.18, 0.18, 0.2, g=GH())
            box('black', cx + k * 4.3, 78.8 + k * 0.5, top - 1.35, 0.03, 0.03, 1.35, g=GH())
        ceiling(-54.6, 47.2, -38.3, 83.8, top)
    hall(id='dajuchang', name='大型剧场', chapter='演艺 · 大型剧场', level='F1', zones=['F1-05', 'F1-06'], pages=[36, 39, 40],
         floor=z, ceiling=top,
         text='沉浸式开放剧场，不设座椅：四周墙面满铺水墨画卷，两侧曲线灯带展台与钢构挑廊、后部天桥均为演艺点位，观众在中部自由走动观演；尽端为低矮舞台，水墨竹林背景、金色光线门框，上空悬方形灯光桁架。',
         eye=[cx + 2.0, 50.2, 1.7], target=[cx, 76.0, 2.4],
         lights=[[cx, 79.5, 6.2, 70, '#ffd9a8'], [cx, 80.5, 3.0, 20, '#ffb070'], [cx, 72.0, 5.5, 26, '#ffcf98'], [cx, 60.0, 6.8, 40, '#ffe3c0'],
                 [cx, 51.0, 6.8, 18, '#ffe3c0'], [-52.8, 62.0, 3.0, 14, '#ffb070'], [-40.0, 62.0, 3.0, 14, '#ffb070']])

def xiaojuchang():
    """小型剧场 (p41): gold LED screen, round stage under a ring of lantern panels."""
    z, top = Z_F2, 7.6
    f = z + LIFT
    with room('xiaojuchang', 'F2'):
        flat('floor_dark', -11.2, 68.5, 8.3, 83.7, f)
        # the screen stands proud of the north wall's columns (face y 83.35)
        panel('img_screen-gold', (-10.9, 83.3), (8.0, 83.3), z + 0.2, top - 0.1, (2.3, 1))
        tiled('wall_dark', (8.3, 68.53), (-11.28, 68.53), z, top, 3.0)
        tiled('wall_dark', (-11.28, 68.53), (-11.28, 83.72), z, top, 3.0)
        box('wall_dark', 8.4, 76.1, z, 0.2, 15.2, top - z)
        panel('img_screen-gold', (-11.12, 76.5), (-11.12, 83.5), z + 0.2, top - 0.1, (0.85, 1))
        cx, cy = -1.4, 79.0
        lathe('black', cx, cy, f, [(3.6, 0), (3.6, 0.18)], n=48)
        lathe('led_warm', cx, cy, f, [(3.62, 0.05), (3.62, 0.09)], n=48, cap=False)
        lathe('stage', cx, cy, f, [(2.7, 0.18), (2.7, 0.3)], n=40)
        # the storey is only 2.2 m clear, so the ring is a slim band tight under the ceiling
        ring_z0, ring_z1 = top - 0.5, top - 0.1
        lathe('img_lantern', cx, cy, 0, [(5.2, ring_z0), (5.2, ring_z1)], n=48, cap=False, urep=24, g=GH())
        lathe('img_lantern', cx, cy, 0, [(5.02, ring_z1), (5.02, ring_z0)], n=48, cap=False, urep=24, g=GH())
        for k in range(48):
            a0, a1 = k * math.tau / 48, (k + 1) * math.tau / 48
            pts = lambda r, a: (cx + r * math.cos(a), cy + r * math.sin(a))
            for zz, m in ((ring_z0, 'led_warm'), (ring_z1, 'black')):
                B.add_face(GH(), m, [(*pts(5.02, a0), zz), (*pts(5.02, a1), zz), (*pts(5.2, a1), zz), (*pts(5.2, a0), zz)][::(-1 if zz == ring_z0 else 1)])
        for k in range(6):
            a = k * math.tau / 6
            box('black', cx + 5.1 * math.cos(a), cy + 5.1 * math.sin(a), ring_z1, 0.03, 0.03, top - ring_z1, g=GH())
        seating(-9.0, 6.2, 73.3, 4, 1.1, 0.12, f, math.pi / 2)
        ceiling(-11.2, 68.6, 8.3, 83.7, top)
    hall(id='xiaojuchang', name='小型剧场', chapter='演艺 · 小型剧场', level='F2', zones=['F2-02'], pages=[36, 41],
         floor=z, ceiling=top,
         text='北墙与西墙转角为金色 LED 长屏，圆形舞台上空悬挂环形灯笼顶，前方阶梯座椅。',
         eye=[-1.4, 68.9, z + 1.8], target=[-1.4, 81.5, z + 0.7],
         lights=[[cx, cy, top - 0.4, 24, '#ffc27a'], [cx, 72.5, top - 0.3, 12, '#ffe3c0'], [cx, 82.5, z + 1.2, 8, '#ffcf80']])

VR_COLUMNS = ((-18.3, 65.7), (-18.3, 74.7), (-25.17, 65.7), (-25.17, 74.7), (11.4, 74.7), (18.3, 74.7), (25.17, 74.7))

def vr():
    """A/VR 展厅 (p42–43): leaning gold light prisms in the dark, an immersive film wall."""
    z, top = Z_F2, 7.6
    f = z + LIFT
    with room('vr', 'F2'):
        for (x0, y0, x1, y1), film in (((-25.2, 62.8, -12.3, 81.16), ((-24.76, 66.0), (-24.76, 74.0))),
                                        ((11.3, 65.8, 25.2, 81.16), ((24.76, 78.0), (24.76, 70.0)))):
            flat('gloss', x0, y0, x1, y1, f)
            e = 0.04
            for a, b in (((x1, y0 + e), (x0, y0 + e)), ((x0, y1 - e), (x1, y1 - e)), ((x0 + e, y0), (x0 + e, y1)), ((x1 - e, y1), (x1 - e, y0))):
                tiled('black', a, b, z, top, 3.0)
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            for k in range(9):
                while True:
                    px = cx + random.uniform(-0.36, 0.36) * (x1 - x0); py = cy + random.uniform(-0.38, 0.38) * (y1 - y0)
                    if all(math.dist((px, py), c) > 1.4 for c in VR_COLUMNS): break
                leaning('img_vr', px, py, f, random.uniform(0.8, 1.3), 0.12, random.uniform(1.8, 2.05), random.uniform(0, math.pi),
                        (random.uniform(-0.45, 0.45), random.uniform(-0.12, 0.12)))
            panel('img_film', *film, z + 0.3, top - 0.25)
            ceiling(x0, y0, x1, y1, top)
        for x, y in VR_COLUMNS: sheath(x, y, z, top)
    hall(id='vr', name='A/VR 展厅', chapter='沉浸体验 · A/VR 展厅', level='F2', zones=['F2-03', 'F2-04'], pages=[36, 42, 43],
         floor=z, ceiling=top,
         text='东西两间暗场展厅。斜立的金色光影立柱在镜面地面上投下倒影，端墙播放“楼阁燕居”“车马出行”等数字复原场景的沉浸影像。',
         eye=[-13.2, 64.0, z + 1.65], target=[-20.0, 73.5, z + 1.2],
         lights=[[-18.8, 72.0, top - 0.3, 6, '#ffd79e'], [18.2, 73.5, top - 0.3, 6, '#ffd79e']])

def linshi():
    """临时展厅 (p44–45): timber slat ceiling, grey walls hung with paintings, table cases and a wall case."""
    z, top = Z_F2, 7.6
    f = z + LIFT
    paintings = ['painting1', 'painting2', 'painting3', 'painting4']
    with room('linshi', 'F2'):
        # an L: the south bay reaches west to x 38.5, north of y 56.6 the west wall is at x 41.35
        flat('floor_dark', 38.5, 46.9, 54.6, 56.6, f); flat('floor_dark', 41.35, 56.6, 54.6, 72.4, f)
        for a, b in (((54.6, 46.93), (38.5, 46.93)), ((38.52, 46.93), (38.52, 56.58)), ((38.5, 56.58), (41.37, 56.58)),
                     ((41.37, 56.6), (41.37, 72.37)), ((41.35, 72.37), (54.6, 72.37)), ((54.22, 72.37), (54.22, 46.93))):
            tiled('wall_gray', a, b, z, top, 3.0)
        box('wall_gray', 39.7, 47.45, z, 2.4, 1.1, top - z)
        for x, y in ((38.4, 56.7), (46.5, 46.8)): sheath(x, y, z, top, 'wall_gray')
        for k, (x, y) in enumerate(((38.52, 52.2), (38.52, 55.0), (41.37, 57.9), (41.37, 63.2), (41.37, 66.4), (41.37, 69.6))):
            box('timber', x + 0.06, y, z + 0.32, 0.06, 1.0, 1.66)
            panel(f'img_{paintings[k % 4]}', (x + 0.095, y - 0.44), (x + 0.095, y + 0.44), z + 0.36, z + 1.94)
        for k in range(7):
            y = 51.0 + k * 3.3
            box('timber', 54.16, y, z + 0.32, 0.06, 1.0, 1.66)
            panel(f'img_{paintings[(k + 2) % 4]}', (54.125, y + 0.44), (54.125, y - 0.44), z + 0.36, z + 1.94)
        for y in (52.5, 58.5, 64.5): plinth_case(47.75, y, z, 1.8, 0.9)
        wall_case((42.0, 72.2), (53.5, 72.2), z, 'case-liying', h=2.1, seg=2.8)
        ceiling(41.2, 46.9, 54.6, 72.4, top); ceiling(38.5, 46.9, 41.2, 56.6, top)
        for k in range(32):
            box('timber', 41.55 + k * 0.4, 59.75, top - 0.12, 0.09, 25.0, 0.12, g=GC())
    hall(id='linshi', name='临时展厅', chapter='临时展厅', level='F2', zones=['F2-01'], pages=[36, 44, 45],
         floor=z, ceiling=top,
         text='木格栅吊顶，灰色墙面悬挂书画，中部为台式展柜，北墙为通柜。',
         eye=[44.2, 48.4, z + 1.65], target=[49.8, 63.0, z + 1.0],
         lights=[[47.75, 52, top - 0.3, 12, '#fff0dc'], [47.75, 60, top - 0.3, 12, '#fff0dc'], [47.75, 68, top - 0.3, 12, '#fff0dc']])

# ---------------------------------------------------------------- flush
def flush():
    col = bpy.data.collections.new('传承中心_展陈装修_20260927'); bpy.context.scene.collection.children.link(col)
    objs = []
    for (group, level, m), (vs, fs, us) in sorted(B.BUF.items()):
        if not fs: continue
        name = f'{group}_{level}_{m}'
        me = bpy.data.meshes.new(name); me.from_pydata(vs, [], fs); me.update()
        uv = me.uv_layers.new(name='UVMap')
        for poly, coords in zip(me.polygons, us):
            for li, c in zip(poly.loop_indices, coords): uv.data[li].uv = c
        me.materials.append(B.MATS[m])
        ob = bpy.data.objects.new(name, me); col.objects.link(ob)
        ob['building'] = group; ob['center_level'] = level; ob['center_role'] = 'fitout'
        ob['center_hall'] = group.split('_', 2)[2]
        if group.startswith('31_'): ob['center_part'] = 'ceiling'
        elif group.startswith('32_'): ob['center_part'] = 'hung'
        bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005); bm.to_mesh(me); bm.free()
        for p in me.polygons: p.use_smooth = m in ('pottery',)
        objs.append(ob)
    return objs

def write_halls():
    order = ['xuting', 'chuying', 'zhuying', 'liying', 'chuanying', 'weiting', 'zhuanti', 'zhongjuchang', 'dajuchang',
             'xiaojuchang', 'vr', 'linshi']
    halls = sorted(HALLS, key=lambda h: order.index(h['id']))
    for h in halls:
        for key in ('eye', 'target'): h[key] = [round(v, 2) for v in h[key]]
        h['lights'] = [[round(v, 2) if isinstance(v, float) else v for v in light] for light in h['lights']]
    payload = {'source': f'{PDF}（主展线 p2、剧场及专题展厅 p36 轴测图对位到施工图房间）',
               'builder': 'tools/authoring/build_center_exhibition_blender.py',
               'route': ['xuting', 'chuying', 'zhuying', 'liying', 'chuanying', 'weiting'], 'halls': halls}
    HALLS_OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.name = '武氏祠汉文化保护传承中心_展陈装修'
    define_materials()
    xuting(); chuying(); b1_partitions(); zhuying(); liying(); chuanying(); weiting(); zhuanti()
    zhongjuchang(); dajuchang(); xiaojuchang(); vr(); linshi()
    objs = flush()
    write_halls()
    per_hall = {}
    for o in objs:
        tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
        per_hall[o['center_hall']] = per_hall.get(o['center_hall'], 0) + tris
    report = {'source': PDF, 'frame': 'centre local metres; glTF x = X, y = Z, z = -Y', 'halls': [h['id'] for h in HALLS],
              'meshes': len(objs), 'triangles_per_hall': per_hall, 'triangles': sum(per_hall.values())}
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(OUT_GLB), export_format='GLB', use_selection=True, export_extras=True,
                              export_apply=True, export_animations=False, export_cameras=False, export_lights=False,
                              export_image_format='JPEG', export_jpeg_quality=85)
    OUT_BLEND.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT_BLEND))
    report['glb_bytes'] = OUT_GLB.stat().st_size
    (WORK / 'blender/exhibition-build-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    main()
