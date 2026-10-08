"""Blender 5.2: rebuild 武氏祠汉文化保护传承中心 from the 2026-09-25 construction drawings.

Run: blender --background --factory-startup --python tools/authoring/build_center_blender.py

Inputs
  resources/authoring/heritage-center/cad-20260925/views.json  (tools/authoring/extract_center_cad.py)
  resources/authoring/heritage-center/cad-20260925/floors.json (tools/authoring/derive_center_floors.py)
  resources/authoring/heritage-center/textures/*               (tools/authoring/prepare_center_textures.py)
  resources/authoring/heritage-center/v2/hanwenhua-center-v2.glb  (site ground and tree positions of V2)
Output
  resources/scenes/models/hanwenhua-center-20260925.glb and an editable .blend
  src/frontend/src/center/centerZones.json  (functional zones as modelled: colours, areas, label points)

Frame: centre local metres (origin = main axis × SA, X east, Y north, Z relative to ±0.000).
Plan outlines, eave / ridge polygons and levels are taken from 建施 1F / 2F / 屋顶 / 立面 / 剖面;
facade finishes follow 02.pdf pages 2-3 while dimensions retain the construction drawings.
Interior walls, columns, stair treads and slabs of the
basement, 1F and 2F come from the plans (floors.json); rooms have no finishes or furniture.
Every mesh carries center_level (B1 / F1 / F2 / RF roofs / site) for the storey views of the web scene;
the coloured floors of the functional zones (center_role = zone) are shown only by the centre module.
"""
import bpy, bmesh, math, json, random, sys
from pathlib import Path
from mathutils import Vector, Matrix, geometry

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / 'resources/authoring/heritage-center'
TEX = WORK / 'textures'
VIEWS = json.loads((WORK / 'cad-20260925/views.json').read_text(encoding='utf-8'))['views']
FLOORS = json.loads((WORK / 'cad-20260925/floors.json').read_text(encoding='utf-8'))
V2 = WORK / 'v2/hanwenhua-center-v2.glb'
OUT_GLB = ROOT / 'resources/scenes/models/hanwenhua-center-20260925.glb'
OUT_BLEND = WORK / 'blender/传承中心_施工图重建_20260925.blend'
ZONES_OUT = ROOT / 'src/frontend/src/center/centerZones.json'
random.seed(20260925)

GRADE = -0.45
S_X = {'S1': -54.6, 'S2': -46.5, 'S3': -38.4, 'S4': -31.8, 'S5': -25.2, 'S6': -19.2, 'S7': -18.3, 'S8': -11.4,
       'S9': -8.7, 'S10': -4.5, 'S11': 4.5, 'S12': 8.7, 'S13': 11.4, 'S14': 18.3, 'S15': 19.2, 'S16': 25.2,
       'S17': 31.8, 'S18': 38.4, 'S19': 46.5, 'S20': 54.6}
S_Y = [0, 4.8, 13.8, 22.8, 27.0, 38.4, 46.8, 56.7, 65.7, 74.7, 83.7, 89.7, 98.7, 104.4]
GRID_X = sorted(set(S_X.values()))

# 2026-09-25 F1 / basement plans and basement sections 1-1, 2-2.
CORE_UPPER = (-19.425, -0.225, 19.425, 26.625, 2.4)
COURT_X = 27.6
BRIDGE_HALF = 4.4
COURT_NORTH = 34.21
GALLERY_FRONT = 30.1
TERRACE_Z, COURT_Z, CORE_Z, CORE_B1_Z = .6, -5.1, 2.4, -3.6

# ---------------------------------------------------------------- materials
def srgb(c):
    c = c / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

MATS = {}
def material(key, name, rgb=(200, 200, 200), rough=0.85, tex=None, metal=0.0, alpha=1.0, normal=0.6, emit=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree; p = nt.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*(srgb(v) for v in rgb), 1)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    if alpha < 1:
        p.inputs['Alpha'].default_value = alpha
        m.surface_render_method = 'BLENDED'
    if emit:
        p.inputs['Emission Color'].default_value = (*(srgb(v) for v in emit[0]), 1)
        p.inputs['Emission Strength'].default_value = emit[1]
    if tex:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = bpy.data.images.load(str(TEX / f'{tex}-color.jpg'), check_existing=True)
        nt.links.new(t.outputs['Color'], p.inputs['Base Color'])
        nimg = TEX / f'{tex}-normal.jpg'
        if nimg.exists() and normal:
            n = nt.nodes.new('ShaderNodeTexImage')
            n.image = bpy.data.images.load(str(nimg), check_existing=True)
            n.image.colorspace_settings.name = 'Non-Color'
            nm = nt.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = normal
            nt.links.new(n.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], p.inputs['Normal'])
    m.diffuse_color = (*(srgb(v) for v in rgb), alpha)
    MATS[key] = m
    return m

# (texture metres per repeat) keeps joints at true size
UVSCALE = {}
def define_materials():
    for key, name, rgb, rough, tex, size in [
        ('brown', '棕色石材幕墙', (255, 255, 255), .78, 'stone-brown', 2.4),
        ('darkbrown', '深褐色石材幕墙', (255, 255, 255), .74, 'stone-darkbrown', 2.4),
        ('gray', '灰色石材幕墙', (255, 255, 255), .72, 'stone-gray', 2.4),
        ('light', '浅色石材幕墙', (255, 255, 255), .7, 'stone-light', 2.4),
        ('paint', '浅色质感涂料', (255, 255, 255), .92, 'paint-light', 3.0),
        ('tile', '陶土筒瓦', (255, 255, 255), .78, 'roof-tile', 1.0),
        ('ridge', '同色系陶土脊瓦', (255, 255, 255), .74, 'ridge-tile', 1.2),
        ('wood', '深褐色檐口与斗栱', (255, 255, 255), .7, 'wood-dark', 1.5),
        ('granite', '花岗岩台基', (255, 255, 255), .86, 'granite', 3.6),
        ('paving', '庭院石材铺装', (255, 255, 255), .9, 'paving', 4.8),
        ('paving_dark', '深色石材铺装', (255, 255, 255), .9, 'paving-dark', 4.8),
        ('membrane', '平屋面', (255, 255, 255), .95, 'roof-membrane', 6.0),
        ('facade_stone', '效果图_浅米色竖纹石材', (216, 204, 181), .82, 'facade-ivory', 2.4),
        ('facade_trim', '效果图_暖棕色柱框', (145, 104, 76), .78, 'facade-brown', 2.4),
        ('facade_frieze', '效果图_深色竖纹檐下带', (69, 62, 53), .82, 'facade-frieze', 2.4),
    ]:
        material(key, name, rgb, rough, tex)
        UVSCALE[key] = size
    material('glass', '幕墙玻璃', (58, 74, 84), .04, metal=.55)
    material('frame', '深灰铝合金框', (58, 58, 56), .45, metal=.6)
    material('facade_fascia', '效果图_暖棕色檐口', (174, 132, 106), .76)
    UVSCALE['facade_fascia'] = 2.4
    material('dark', '室内暗部', (24, 24, 24), 1.0)
    material('bronze', '铜饰', (120, 92, 58), .45, metal=.7)
    material('water', '水景', (60, 80, 84), .08, metal=.2)
    material('soil', '种植土', (92, 84, 66), 1.0)
    material('lawn', '草坪', (96, 124, 70), .95)
    material('leaf0', '乔木叶簇_0', (76, 104, 60), .9)
    material('leaf1', '乔木叶簇_1', (92, 118, 62), .9)
    material('leaf2', '乔木叶簇_2', (110, 124, 70), .9)
    material('leaf3', '乔木叶簇_3', (136, 118, 70), .9)
    material('bark', '树干', (78, 66, 54), .95)
    # Invisible in the web scene: marks below-grade openings in the stencil buffer (hanwenhuaCenter.ts).
    material('mask', '遮罩_下沉开口', (0, 0, 0), 1.0)
    # the whole basement extent, used only while the basement is shown in place
    material('mask_b1', '遮罩_负一层范围', (0, 0, 0), 1.0)
    material('int_wall', '室内墙体', (232, 228, 219), .9)
    material('int_cut', '墙体剖切面', (84, 77, 70), .9)
    material('int_column', '结构柱', (188, 184, 176), .85)
    material('slab', '楼板', (212, 206, 194), .92)
    # darker, so the basement shown in place reads below the surrounding ground
    material('slab_b1', '负一层楼板', (150, 143, 132), .92)
    material('stair', '楼梯踏步', (152, 144, 130), .88)
    for k in ('glass', 'frame', 'dark', 'bronze', 'water', 'soil', 'lawn', 'leaf0', 'leaf1', 'leaf2', 'leaf3', 'bark', 'mask',
              'mask_b1', 'int_wall', 'int_cut', 'int_column', 'slab', 'slab_b1', 'stair'):
        UVSCALE[k] = 2.0

# ---------------------------------------------------------------- batched mesh builder
BUF = {}
LEVEL = ['F1']

class at:
    """Batch the enclosed geometry into a storey: B1, F1, F2, RF (roofs, eaves, brackets) or site."""
    def __init__(self, level): self.level = level
    def __enter__(self): LEVEL.append(self.level)
    def __exit__(self, *exc): LEVEL.pop()

def buf(group, mat):
    return BUF.setdefault((group, LEVEL[-1], mat), ([], [], []))

def add_face(group, mat, pts, uvs=None):
    vs, fs, us = buf(group, mat)
    base = len(vs)
    vs.extend(tuple(p) for p in pts)
    fs.append(tuple(range(base, base + len(pts))))
    if uvs is None:
        uvs = planar_uv(pts, mat)
    us.append(uvs)

def planar_uv(pts, mat):
    s = UVSCALE.get(mat, 2.0)
    a, b, c = Vector(pts[0]), Vector(pts[1]), Vector(pts[2 if len(pts) > 2 else 1])
    n = (b - a).cross(c - a)
    if n.length < 1e-9:
        return [(p[0] / s, p[1] / s) for p in pts]
    n.normalize()
    if abs(n.z) > 0.7:     # horizontal-ish: world XY
        return [(p[0] / s, p[1] / s) for p in pts]
    # vertical-ish: horizontal tangent + height
    t = Vector((-n.y, n.x, 0)).normalized()
    return [(Vector(p).dot(t) / s, p[2] / s) for p in pts]

def quad(group, mat, a, b, c, d, uvs=None):
    add_face(group, mat, [a, b, c, d], uvs)

def up_face(group, mat, pts, uvs=None):
    """Roof faces always face the sky, whatever the source polygon winding."""
    a, b, c = Vector(pts[0]), Vector(pts[1]), Vector(pts[2])
    if (b - a).cross(c - a).z < 0:
        pts = pts[::-1]
        uvs = uvs[::-1] if uvs else uvs
    add_face(group, mat, pts, uvs)

def polygon_top(group, mat, pts2d, z, up=True, holes=()):
    loops = [list(pts2d)] + [list(h) for h in holes]
    flat = [p for loop in loops for p in loop]
    tris = geometry.tessellate_polygon([[Vector((x, y, 0)) for x, y in loop] for loop in loops])
    for t in tris:
        p = [(flat[i][0], flat[i][1], z) for i in t]
        a, b, c = (Vector(q) for q in p)
        if ((b - a).cross(c - a).z > 0) != up:
            p = p[::-1]
        add_face(group, mat, p)

def ccw(poly):
    area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]))
    return poly if area > 0 else poly[::-1]

def box(group, mat, cx, cy, z0, sx, sy, sz, angle=0.0, top=True, bottom=False):
    ca, sa = math.cos(angle), math.sin(angle)
    def P(x, y, z): return (cx + x * ca - y * sa, cy + x * sa + y * ca, z)
    hx, hy = sx / 2, sy / 2
    c = [P(-hx, -hy, 0), P(hx, -hy, 0), P(hx, hy, 0), P(-hx, hy, 0)]
    lo = [(x, y, z0) for x, y, _ in c]; hi = [(x, y, z0 + sz) for x, y, _ in c]
    for i in range(4):
        j = (i + 1) % 4
        quad(group, mat, lo[i], lo[j], hi[j], hi[i])
    if top: add_face(group, mat, hi)
    if bottom: add_face(group, mat, lo[::-1])

def prism(group, mat, poly, z0, z1, top_mat=None, bottom=False):
    poly = ccw(list(poly))
    for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]):
        quad(group, mat, (x0, y0, z0), (x1, y1, z0), (x1, y1, z1), (x0, y0, z1))
    if top_mat:
        polygon_top(group, top_mat, poly, z1, True)
    if bottom:
        polygon_top(group, mat, poly, z0, False)

def frustum(group, mat, cx, cy, z0, w0, d0, w1, d1, h, top=True):
    lo = [(cx - w0 / 2, cy - d0 / 2, z0), (cx + w0 / 2, cy - d0 / 2, z0), (cx + w0 / 2, cy + d0 / 2, z0), (cx - w0 / 2, cy + d0 / 2, z0)]
    hi = [(cx - w1 / 2, cy - d1 / 2, z0 + h), (cx + w1 / 2, cy - d1 / 2, z0 + h), (cx + w1 / 2, cy + d1 / 2, z0 + h), (cx - w1 / 2, cy + d1 / 2, z0 + h)]
    for i in range(4):
        j = (i + 1) % 4
        quad(group, mat, lo[i], lo[j], hi[j], hi[i])
    if top: add_face(group, mat, hi)

def offset_poly(poly, d):
    """Offset a rectilinear/convex CCW polygon inward by d (negative d grows)."""
    poly = ccw(list(poly)); n = len(poly); out = []
    for i in range(n):
        p0, p1, p2 = Vector(poly[i - 1]), Vector(poly[i]), Vector(poly[(i + 1) % n])
        e0 = (p1 - p0).normalized(); e1 = (p2 - p1).normalized()
        n0 = Vector((-e0.y, e0.x)); n1 = Vector((-e1.y, e1.x))
        a0 = p0 + n0 * d; a1 = p1 + n0 * d; b0 = p1 + n1 * d; b1 = p2 + n1 * d
        hit = geometry.intersect_line_line_2d(a0 - (a1 - a0) * 100, a1 + (a1 - a0) * 100, b0 - (b1 - b0) * 100, b1 + (b1 - b0) * 100)
        out.append(tuple(hit) if hit else tuple(a1))
    return out

# ---------------------------------------------------------------- roofs
def roof_ring(group, eave, rim, z_eave, z_rim, mat='tile'):
    """Sloped faces between an eave polygon and an inner polygon with the same vertex order
    (盝顶 / hip faces). Tile UV: u metres along the eave, v metres up the slope."""
    eave = ccw(list(eave)); rim = ccw(list(rim)); n = len(eave)
    assert len(rim) == n
    for i in range(n):
        j = (i + 1) % n
        e0, e1 = Vector((*eave[i], z_eave)), Vector((*eave[j], z_eave))
        r0, r1 = Vector((*rim[i], z_rim)), Vector((*rim[j], z_rim))
        t = (e1 - e0).normalized()
        slope_dir = ((r0 + r1) / 2 - (e0 + e1) / 2)
        slope_dir -= t * slope_dir.dot(t)
        s = slope_dir.normalized()
        def uv(p):
            q = p - e0
            return (q.dot(t), q.dot(s))
        pts = [e0, e1, r1, r0]
        if (r1 - r0).length < 1e-4:
            pts = [e0, e1, r1]
        up_face(group, mat, [tuple(p) for p in pts], [uv(p) for p in pts])

def ridge_line(group, a, b, width=0.36, height=0.34, mat='ridge'):
    """A rectangular ridge body along a→b (3D points on the roof)."""
    a, b = Vector(a), Vector(b)
    t = (b - a); L = t.length
    if L < 1e-3: return
    t.normalize(); side = Vector((-t.y, t.x, 0)).normalized() * width / 2
    up = Vector((0, 0, height))
    lo_a0, lo_a1, lo_b0, lo_b1 = a - side, a + side, b - side, b + side
    hi_a0, hi_a1, hi_b0, hi_b1 = lo_a0 + up, lo_a1 + up, lo_b0 + up, lo_b1 + up
    for f in [(lo_a0, lo_b0, hi_b0, hi_a0), (lo_b1, lo_a1, hi_a1, hi_b1), (hi_a0, hi_b0, hi_b1, hi_a1), (lo_a1, lo_a0, hi_a0, hi_a1), (lo_b0, lo_b1, hi_b1, hi_b0)]:
        pts = [tuple(p) for p in f]
        add_face(group, mat, pts, [(0, 0), (L / 1.2, 0), (L / 1.2, .3), (0, .3)])

def ridge_ornament(group, p, direction, scale=1.0):
    """Upturned ridge end (鸱尾-like) as seen at the ridge ends on the elevations."""
    p = Vector(p); d = Vector((direction[0], direction[1], 0)).normalized(); s = Vector((-d.y, d.x, 0)) * 0.2 * scale
    prof = [(0, 0), (0.25, 0), (0.45, 0.12), (0.55, 0.35), (0.5, 0.55), (0.38, 0.62), (0.3, 0.45), (0.12, 0.34), (0, 0.34)]
    pts = [p + d * (u * scale) + Vector((0, 0, w * scale)) for u, w in prof]
    front = [tuple(q - s) for q in pts]; back = [tuple(q + s) for q in pts]
    add_face(group, 'ridge', front[::-1]); add_face(group, 'ridge', back)
    for i in range(len(pts) - 1):
        quad(group, 'ridge', front[i], front[i + 1], back[i + 1], back[i])

def eave_band(group, eave, z0, z1, depth, mat='facade_fascia', soffit='wood'):
    """Fascia along the eave outline plus the soffit back to the wall."""
    eave = ccw(list(eave)); inner = offset_poly(eave, depth)
    for (a, b), (c, d) in zip(zip(eave, eave[1:] + eave[:1]), zip(inner, inner[1:] + inner[:1])):
        quad(group, mat, (*a, z0), (*b, z0), (*b, z1), (*a, z1))
        quad(group, soffit, (*d, z0), (*b, z0), (*a, z0), (*c, z0))

def rim_ridge(group, rim, z, width=0.5, height=0.45, ornaments=True):
    rim = ccw(list(rim)); n = len(rim)
    for i in range(n):
        a = Vector((*rim[i], z)); b = Vector((*rim[(i + 1) % n], z))
        ridge_line(group, a, b, width, height)
    if ornaments:
        for i in range(n):
            p0, p1, p2 = Vector(rim[i - 1]), Vector(rim[i]), Vector(rim[(i + 1) % n])
            cross = (p1 - p0).x * (p2 - p1).y - (p1 - p0).y * (p2 - p1).x
            if cross > 0:  # convex corner: ornament points diagonally outward
                out = ((p1 - p0).normalized() - (p2 - p1).normalized())
                ridge_ornament(group, (p1.x, p1.y, z + height * 0.6), (out.x, out.y), 0.9)

def luding(group, eave, z_eave, depth, z_rim, flat=True, ridge_h=0.45, ridge_w=0.5, ornaments=True, rim=None):
    """盝顶 roof: slope from the eave polygon to an inner rim (uniform offset unless given), flat top inside."""
    rim = ccw(list(rim)) if rim else offset_poly(eave, depth)
    roof_ring(group, eave, rim, z_eave, z_rim)
    if flat:
        polygon_top(group, 'membrane', ccw(list(rim)), z_rim - 0.02, True)
    rim_ridge(group, rim, z_rim - 0.05, ridge_w, ridge_h, ornaments)
    # hips: diagonals from eave corners to rim corners
    for e, r in zip(ccw(list(eave)), ccw(list(rim))):
        ridge_line(group, (*e, z_eave), (*r, z_rim - 0.05), 0.26, 0.22)
    return rim

def hip_rect(group, x0, y0, x1, y1, z_eave, slope, ridge_h=0.45, skylight=None):
    """庑殿: hip roof on a rectangle with the ridge along the long side."""
    w, d = x1 - x0, y1 - y0
    if w >= d:
        run = d / 2; zr = z_eave + run * slope; cy = (y0 + y1) / 2
        ra, rb = (x0 + run, cy), (x1 - run, cy)
        E = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        faces = [([E[0], E[1], rb, ra]), ([E[1], E[2], rb]), ([E[2], E[3], ra, rb]), ([E[3], E[0], ra])]
    else:
        run = w / 2; zr = z_eave + run * slope; cx = (x0 + x1) / 2
        ra, rb = (cx, y0 + run), (cx, y1 - run)
        E = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        faces = [([E[0], E[1], ra]), ([E[1], E[2], rb, ra]), ([E[2], E[3], rb]), ([E[3], E[0], ra, rb])]
    for f in faces:
        pts = [Vector((p[0], p[1], z_eave if p in E else zr)) for p in f]
        e0, e1 = pts[0], pts[1]; t = (e1 - e0).normalized()
        up = (pts[-1] - e0); up -= t * up.dot(t); up.normalize()
        add_face(group, 'tile', [tuple(p) for p in pts], [((p - e0).dot(t), (p - e0).dot(up)) for p in pts])
    ridge_line(group, (*ra, zr - 0.05), (*rb, zr - 0.05), 0.6, ridge_h)
    ridge_ornament(group, (ra[0], ra[1], zr + ridge_h * 0.5), (ra[0] - rb[0], ra[1] - rb[1]), 1.3)
    ridge_ornament(group, (rb[0], rb[1], zr + ridge_h * 0.5), (rb[0] - ra[0], rb[1] - ra[1]), 1.3)
    for e in E:
        r = ra if (Vector(e) - Vector(ra)).length < (Vector(e) - Vector(rb)).length else rb
        ridge_line(group, (*e, z_eave), (*r, zr - 0.05), 0.3, 0.25)
    return zr

def pyramid(group, cx, cy, half, z_eave, slope, ridge_h=0.3):
    apex = (cx, cy, z_eave + half * slope)
    E = [(cx - half, cy - half), (cx + half, cy - half), (cx + half, cy + half), (cx - half, cy + half)]
    for i in range(4):
        a, b = E[i], E[(i + 1) % 4]
        e0, e1 = Vector((*a, z_eave)), Vector((*b, z_eave)); t = (e1 - e0).normalized()
        up = Vector(apex) - e0; up -= t * up.dot(t); up.normalize()
        pts = [e0, e1, Vector(apex)]
        add_face(group, 'tile', [tuple(p) for p in pts], [((p - e0).dot(t), (p - e0).dot(up)) for p in pts])
        ridge_line(group, (*a, z_eave), (apex[0], apex[1], apex[2] - 0.05), 0.24, 0.2)
    frustum(group, 'ridge', cx, cy, apex[2] - 0.1, 0.7, 0.7, 0.3, 0.3, 0.6)
    frustum(group, 'bronze', cx, cy, apex[2] + 0.5, 0.18, 0.18, 0.02, 0.02, 0.8)

def lean_to(group, outer, z_outer, depth, z_inner):
    """Skirt eave (腰檐) around a wall: slopes from the outer eave up to the wall."""
    inner = offset_poly(outer, depth)
    roof_ring(group, outer, inner, z_outer, z_inner)
    return inner

# ---------------------------------------------------------------- walls, openings, brackets
def openings_for(view, polygon, z_floor, tol=0.75):
    """Door/window blocks of a plan view that sit on the given exterior wall polygon."""
    out = []
    poly = ccw(list(polygon)); n = len(poly)
    for o in VIEWS[view]['openings']:
        px, py = o['p']; rot = math.radians(o['rot']); w = abs(o['sx'])
        if w < 0.5 or w > 14: continue
        dx, dy = math.cos(rot), math.sin(rot)
        # Both DorLib single and double leaves are centred on the insertion point.
        # In 00000001 the jamb is at x=+0.5 and the swing ends at x=-0.5.
        for i in range(n):
            a, b = Vector(poly[i]), Vector(poly[(i + 1) % n])
            e = b - a; L = e.length
            if L < 0.5: continue
            t = e / L; rel = Vector((px, py)) - a
            along = rel.dot(t); dist = abs(rel.x * t.y - rel.y * t.x)
            if dist < tol and -0.2 < along < L + 0.2 and abs(t.x * dx + t.y * dy) > 0.9:
                door = o['block'].upper().startswith('$DORLIB2D')
                out.append({'edge': i, 'c': along, 'w': w, 'door': door, 'z': z_floor,
                            'leaves': 1 if o['block'].upper() == '$DORLIB2D$00000001' else 2})
                break
    return out

def north_entrance_openings(polygon, openings):
    """F1 plan positions + S20-S1 elevation, 施工图_建筑20260925.dwg.

    Local Y=96.000 is the glazing plane. Four 1.000 m leaves span X=-2..2;
    sidelights come from WIN2D centres +/-3.1349, widths 2.1603. Their few cm
    difference from the elevation's +/-4.200 endpoints is resolved in favour of
    the plan. Elevation: door head 2.400, fanlight head 3.300, side-window sill .300.
    The 3.300 callout labels the glazing head, not an entrance canopy.
    """
    poly = ccw(list(polygon))
    edge = next(i for i, (a, b) in enumerate(zip(poly, poly[1:] + poly[:1]))
                if abs(a[1] - 96.1) < 1e-6 and abs(b[1] - 96.1) < 1e-6 and a[0] > 0 > b[0])
    x_start = poly[edge][0]
    result = [o for o in openings if o['edge'] != edge or o['z'] != 0.0]
    for o in result:
        a, b = poly[o['edge']], poly[(o['edge'] + 1) % len(poly)]
        if o['door'] and o['z'] == 0 and abs(a[0] - b[0]) < 1e-6 and abs(abs(a[0]) - 11.175) < .001:
            # Actual leaf planes: east X=11.295, west X=-11.275.
            o['reveal'] = .12 if a[0] > 0 else .1
    side = next(o for o in VIEWS['f1']['openings']
                if o['block'] == '$TCHSYS$WIN2D' and abs(o['p'][0] - 3.1349) < .001 and o['p'][1] == 96.0)
    inner, outer = side['p'][0] - abs(side['sx']) / 2, side['p'][0] + abs(side['sx']) / 2
    panels = []
    # Panel coordinates run along the facade edge (east to west).
    def panel(x0, x1, z0, z1, latch=None):
        panels.append({'s0': outer - x1, 's1': outer - x0, 'z0': z0, 'z1': z1,
                       **({'latch': outer - latch} if latch is not None else {})})
    for x0, x1, latch in [(-2, -1, -1.12), (-1, 0, -.12), (0, 1, .12), (1, 2, 1.12)]:
        panel(x0, x1, 0, 2.4, latch)
    for x0, x1 in [(-2, 0), (0, 2)]: panel(x0, x1, 2.4, 3.3)
    for x0, x1 in [(-outer, -inner), (inner, outer)]:
        mid = (x0 + x1) / 2
        panel(x0, mid, 0, 2.4); panel(mid, x1, 0, 2.4); panel(x0, x1, 2.4, 3.3)
    result.append({'edge': edge, 'c': x_start, 'w': 2 * outer, 'door': True, 'z': 0,
                   'sill': 0, 'head': 3.3, 'panels': panels, 'reveal': .1, 'surround': False, 'edge_clearance': 0})
    for o in VIEWS['f1']['openings']:
        if o['block'] != '$TCHSYS$WIN2D' or o['p'][1] != 96.0 or not 7 < abs(o['p'][0]) < 9: continue
        width = abs(o['sx'])
        panels = [{'s0': width * i / 8, 's1': width * (i + 1) / 8, 'z0': lo, 'z1': hi}
                  for i in range(8) for lo, hi in [(0.3, 2.4), (2.4, 3.3)]]
        result.append({'edge': edge, 'c': x_start - o['p'][0], 'w': width, 'door': False, 'z': 0,
                       'sill': .3, 'head': 3.3, 'panels': panels, 'reveal': .1, 'surround': False, 'edge_clearance': 0})
    return result


def facade(group, poly, z0, z1, mat, openings=(), base_mat='granite', base_h=0.45, reveal=0.22, split=None, cap=0.3, edges=None):
    """Outer wall skin with openings (dark backing behind the glass). Above `split` the skin belongs to
    the upper storey; a cut face `cap` deep closes the wall top of each storey for the storey views."""
    poly = ccw(list(poly)); n = len(poly)
    lower = LEVEL[-1]
    def level(z): return 'F2' if split is not None and z >= split - 1e-6 else lower
    by_edge = {}
    for o in openings: by_edge.setdefault(o['edge'], []).append(o)
    for i in range(n):
        if edges is not None and i not in edges: continue
        a, b = Vector((*poly[i], 0)), Vector((*poly[(i + 1) % n], 0))
        e = b - a; L = e.length
        if L < 1e-3: continue
        t = e / L; nrm = Vector((t.y, -t.x, 0))   # outward for CCW
        holes = []
        for o in sorted(by_edge.get(i, []), key=lambda o: o['c']):
            margin = o.get('edge_clearance', .15)
            w = min(o['w'], L - 2 * margin)
            c0, c1 = max(margin, o['c'] - w / 2), min(L - margin, o['c'] + w / 2)
            if c1 - c0 < 0.4: continue
            if o['door']:
                sill, head = o['z'], o['z'] + (3.0 if w >= 2.2 else 2.6)
            elif w >= 5.5:
                sill, head = o['z'] + 0.15, o['z'] + min(4.6, (z1 - o['z']) - 0.6)
            elif w >= 2.0:
                sill, head = o['z'] + 0.6, o['z'] + 3.6
            else:
                sill, head = o['z'] + 0.9, o['z'] + 2.7
            sill = max(z0, o.get('sill', sill))
            head = min(o.get('head', head), z1 - 0.3)
            if head <= sill: continue
            # Adjacent doors can share a jamb; openings on different floors can
            # share an X extent. Only overlapping rectangles are duplicates.
            if any(c0 < h[1] - 1e-4 and c1 > h[0] + 1e-4 and sill < h[3] - 1e-4 and head > h[2] + 1e-4 for h in holes): continue
            holes.append((c0, c1, sill, head, o['door'], o))
        def P(s, z): return tuple(a + t * s + Vector((0, 0, z)))
        cuts = sorted({0.0, L, *(v for h in holes for v in (h[0], h[1]))})
        for k in range(len(cuts) - 1):
            s0, s1 = cuts[k], cuts[k + 1]
            if s1 - s0 < 1e-4: continue
            active = sorted((h for h in holes if h[0] <= s0 + 1e-6 and h[1] >= s1 - 1e-6), key=lambda h: h[2])
            ends = [z0] + [v for h in active for v in (h[2], h[3])] + [z1]
            spans = list(zip(ends[::2], ends[1::2]))
            for za, zb in spans:
                if zb - za < 1e-3: continue
                frieze = z1 - 0.65
                cutz = sorted({za, zb, *([base_h + z0] if za < base_h + z0 < zb else []),
                               *([frieze] if mat == 'facade_stone' and za < frieze < zb else []),
                               *([split] if split is not None and za < split < zb else [])})
                for zz0, zz1 in zip(cutz, cutz[1:]):
                    m = base_mat if zz1 <= z0 + base_h + 1e-6 else mat
                    if m == 'facade_stone' and zz0 >= frieze - 1e-6: m = 'facade_frieze'
                    with at(level(zz0)):
                        quad(group, m, P(s0, zz0), P(s1, zz0), P(s1, zz1), P(s0, zz1))
        for hole in holes:
            with at(level(hole[2])):
                opening(group, a, t, nrm, z0, reveal, *hole)
        # A shallow lintel ties the warm piers together beneath the dark frieze.
        if mat == 'facade_stone':
            c = a + t * (L / 2) + nrm * 0.07
            with at(level(z1 - 0.22)):
                box(group, 'facade_trim', c.x, c.y, z1 - 0.22, L, 0.16, 0.22, math.atan2(t.y, t.x))
    inner = offset_poly(poly, cap)
    for z, lv in ([(split, lower)] if split is not None else []) + [(z1, level(z1))]:
        with at(lv):
            for i in range(n):
                if edges is not None and i not in edges: continue
                j = (i + 1) % n
                up_face(group, 'int_cut', [(*poly[i], z), (*poly[j], z), (*inner[j], z), (*inner[i], z)])

def opening(group, a, t, nrm, z0, reveal, s0, s1, sill, head, door, detail=None):
    detail = detail or {}
    reveal = detail.get('reveal', reveal)
    inset = -nrm * reveal
    def Q(s, z, back=False): return tuple(a + t * s + Vector((0, 0, z)) + (inset if back else Vector()))
    # reveals
    quad(group, 'light', Q(s0, sill), Q(s0, sill, True), Q(s0, head, True), Q(s0, head))
    quad(group, 'light', Q(s1, head), Q(s1, head, True), Q(s1, sill, True), Q(s1, sill))
    quad(group, 'light', Q(s0, head), Q(s0, head, True), Q(s1, head, True), Q(s1, head))
    if sill > z0 + 0.01:
        quad(group, 'light', Q(s1, sill), Q(s1, sill, True), Q(s0, sill, True), Q(s0, sill))
    # Warm stone surround outside the CAD opening; the glazing stays at its original size.
    ang = math.atan2(t.y, t.x)
    if detail.get('surround', True):
        for s in (s0 - 0.09, s1 + 0.09):
            g = a + t * s + nrm * 0.075
            box(group, 'facade_trim', g.x, g.y, sill, 0.18, 0.16, head - sill + 0.12, ang)
        for zz in ([head] if door else [sill - 0.12, head]):
            g = a + t * ((s0 + s1) / 2) + nrm * 0.10
            box(group, 'facade_trim', g.x, g.y, zz, s1 - s0 + 0.6, 0.22, 0.16, ang)
    if detail.get('panels'):
        # Door divisions stop at the transom; the fanlights have their own bays.
        fr = .05
        # Back the narrow joints between the door unit and fixed sidelights with
        # aluminium; don't leave an unframed slit into the interior dark backing.
        joiner = inset * 1.1
        quad(group, 'frame', tuple(Vector(Q(s0, sill)) + joiner), tuple(Vector(Q(s1, sill)) + joiner),
             tuple(Vector(Q(s1, head)) + joiner), tuple(Vector(Q(s0, head)) + joiner))
        for p in detail['panels']:
            lo, hi, bot, top = s0 + p['s0'], s0 + p['s1'], p['z0'], p['z1']
            quad(group, 'glass', Q(lo + fr, bot + fr, True), Q(hi - fr, bot + fr, True),
                 Q(hi - fr, top - fr, True), Q(lo + fr, top - fr, True))
            for s in (lo + fr / 2, hi - fr / 2):
                g = a + t * s + inset * .9
                box(group, 'frame', g.x, g.y, bot, fr, .09, top - bot, ang)
            for z in (bot, top - fr):
                g = a + t * ((lo + hi) / 2) + inset * .9
                box(group, 'frame', g.x, g.y, z, hi - lo, .09, fr, ang)
            if 'latch' in p:
                g = a + t * (s0 + p['latch']) + inset * .9 + nrm * .075
                box(group, 'bronze', g.x, g.y, bot + .9, .028, .035, .5, ang)
                for z in (bot + .94, bot + 1.34):
                    q = g - nrm * .035
                    box(group, 'bronze', q.x, q.y, z, .028, .09, .028, ang)
        back = inset * 4
        quad(group, 'dark', tuple(Vector(Q(s0, sill)) + back), tuple(Vector(Q(s1, sill)) + back),
             tuple(Vector(Q(s1, head)) + back), tuple(Vector(Q(s0, head)) + back))
        return
    # glazing with mullions
    quad(group, 'glass', Q(s0, sill, True), Q(s1, sill, True), Q(s1, head, True), Q(s0, head, True))
    bays = detail.get('leaves', 2) if door else max(1, round((s1 - s0) / 1.2))
    fr = 0.07
    for m_ in range(bays + 1):
        s = s0 + (s1 - s0) * m_ / bays
        g = a + t * s + inset * 0.9
        box(group, 'frame', g.x, g.y, sill, fr, fr, head - sill, math.atan2(t.y, t.x))
    for zz in ([sill, head] + ([sill + 2.4] if head - sill > 3.4 else [])):
        g = a + t * ((s0 + s1) / 2) + inset * 0.9
        box(group, 'frame', g.x, g.y, zz - fr / 2, s1 - s0, fr, fr, math.atan2(t.y, t.x))
    if door:
        for k in range(bays):
            latch = s0 + (s1 - s0) * (k + (1 if k % 2 == 0 else 0)) / bays
            latch += -.12 if k % 2 == 0 else .12
            g = a + t * latch + inset * .9 + nrm * .075
            box(group, 'bronze', g.x, g.y, sill + .9, .028, .035, .5, ang)
    # interior darkness keeps the glass from reading as a hole (hidden in the storey views)
    back = inset * 4
    quad(group, 'dark', tuple(Vector(Q(s0, sill)) + back), tuple(Vector(Q(s1, sill)) + back),
         tuple(Vector(Q(s1, head)) + back), tuple(Vector(Q(s0, head)) + back))

def corner_piers(group, poly, z0, z1, mat='facade_trim', size=1.2, batter=0.35, split=None):
    """Battered corner piers (收分) at convex corners, as drawn on the elevations."""
    poly = ccw(list(poly)); n = len(poly)
    lower = LEVEL[-1]
    zs = [z0] + ([split] if split is not None else []) + [z1]
    def depth_at(z): return 0.12 + batter * (z1 - z) / (z1 - z0)
    for i in range(n):
        p0, p1, p2 = Vector(poly[i - 1]), Vector(poly[i]), Vector(poly[(i + 1) % n])
        e0 = (p1 - p0).normalized(); e1 = (p2 - p1).normalized()
        if e0.x * e1.y - e0.y * e1.x <= 0: continue
        o0 = Vector((e0.y, -e0.x)); o1 = Vector((e1.y, -e1.x))
        def ring(proj):
            # inner corner D, then along the incoming face (A), the corner (B), the outgoing face (C)
            return [p1 - e0 * size + e1 * size, p1 - e0 * size + o0 * proj, p1 + (o0 + o1) * proj, p1 + e1 * size + o1 * proj]
        for za, zb in zip(zs, zs[1:]):
            lo = [(v.x, v.y, za) for v in ring(depth_at(za))]; hi = [(v.x, v.y, zb) for v in ring(depth_at(zb))]
            with at('F2' if split is not None and za >= split - 1e-6 else lower):
                for k in range(4):
                    j = (k + 1) % 4
                    quad(group, mat, lo[k], lo[j], hi[j], hi[k])
                add_face(group, mat, hi)

def brackets(group, poly, z_top, depth=1.2, spacing=None, mat='wood', scale=1.0, grid=True):
    """斗栱 rows under the eave: stepped blocks cantilevering out of the wall."""
    poly = ccw(list(poly)); n = len(poly)
    for i in range(n):
        a, b = Vector(poly[i]), Vector(poly[(i + 1) % n])
        e = b - a; L = e.length
        if L < 2: continue
        t = e / L; o = Vector((t.y, -t.x))
        stations = []
        if grid:
            for gx in GRID_X:
                if abs(t.x) > 0.9:
                    s = (gx - a.x) / t.x
                    if 0.6 < s < L - 0.6: stations.append(s)
            for gy in S_Y:
                if abs(t.y) > 0.9:
                    s = (gy - a.y) / t.y
                    if 0.6 < s < L - 0.6: stations.append(s)
        if not stations:
            k = max(1, round(L / (spacing or 4.5)))
            stations = [L * (j + 0.5) / k for j in range(k)]
        ang = math.atan2(t.y, t.x)
        for s in stations:
            c = a + t * s
            sc = scale
            box(group, mat, c.x + o.x * 0.25 * sc, c.y + o.y * 0.25 * sc, z_top - 1.25 * sc, 0.5 * sc, 0.5 * sc, 0.32 * sc, ang)
            box(group, mat, c.x + o.x * 0.45 * sc, c.y + o.y * 0.45 * sc, z_top - 0.93 * sc, 1.7 * sc, 0.26 * sc, 0.24 * sc, ang)
            for q in (-0.7, 0, 0.7):
                box(group, mat, c.x + o.x * 0.5 * sc + t.x * q * sc, c.y + o.y * 0.5 * sc + t.y * q * sc, z_top - 0.69 * sc, 0.34 * sc, 0.34 * sc, 0.2 * sc, ang)
            box(group, mat, c.x + o.x * 0.7 * sc, c.y + o.y * 0.7 * sc, z_top - 0.49 * sc, 2.3 * sc, 0.3 * sc, 0.24 * sc, ang)
            box(group, mat, c.x + o.x * depth * 0.5, c.y + o.y * depth * 0.5, z_top - 0.25 * sc, 0.26 * sc, depth, 0.25 * sc, ang)

def pilasters(group, poly, z0, z1, mat='facade_trim', width=0.8, proj=0.18, skip=(), split=None, openings=()):
    """Shallow piers on the S-grid lines, the column rhythm drawn on the elevations."""
    poly = ccw(list(poly)); n = len(poly)
    spans = [(z0 + 0.45, split, LEVEL[-1]), (split, z1, 'F2')] if split is not None else [(z0 + 0.45, z1, LEVEL[-1])]
    for i in range(n):
        a, b = Vector(poly[i]), Vector(poly[(i + 1) % n])
        e = b - a; L = e.length
        if L < 3: continue
        t = e / L; o = Vector((t.y, -t.x))
        for gx in (GRID_X if abs(t.x) > 0.9 else S_Y):
            s = (gx - (a.x if abs(t.x) > 0.9 else a.y)) / (t.x if abs(t.x) > 0.9 else t.y)
            if not 1.2 < s < L - 1.2: continue
            if any(o['edge'] == i and abs(s - o['c']) < o['w'] / 2 + width / 2 + .03 for o in openings): continue
            c = a + t * s
            if any((c - Vector(p)).length < 1.5 for p in skip): continue
            for za, zb, lv in spans:
                with at(lv):
                    box(group, mat, c.x + o.x * proj / 2, c.y + o.y * proj / 2, za, width, proj, zb - za, math.atan2(t.y, t.x))

def podium(group, poly, grow=0.9):
    """Granite podium from grade to ±0.000 with a step band."""
    ring = offset_poly(poly, -grow)
    prism(group, 'granite', ring, GRADE, 0.0, top_mat='paving_dark')

def columns(group, pts, z0, z1, size=0.6, mat='light', cap=True):
    for x, y in pts:
        box(group, 'granite', x, y, z0, size + 0.2, size + 0.2, 0.3)
        box(group, mat, x, y, z0 + 0.3, size, size, z1 - z0 - 0.3)
        if cap:
            box(group, 'wood', x, y, z1 - 0.35, size + 0.3, size + 0.3, 0.35)

def mirror_x(poly):
    return [(-x, y) for x, y in poly][::-1]

# ---------------------------------------------------------------- storey footprints for the plan interiors
FOOTPRINTS = {'F1': [], 'F2': []}

def rect_cover(poly):
    """Rectangles covering a rectilinear polygon (vertical strips)."""
    edges = list(zip(poly, poly[1:] + poly[:1]))
    xs = sorted({x for x, _ in poly}); out = []
    for xa, xb in zip(xs, xs[1:]):
        xm = (xa + xb) / 2
        ys = sorted(y0 for (x0, y0), (x1, y1) in edges if abs(y0 - y1) < 1e-9 and min(x0, x1) < xm < max(x0, x1))
        out += [(xa, ys[k], xb, ys[k + 1]) for k in range(0, len(ys) - 1, 2)]
    return out

def footprint(level, poly, top):
    """Outer wall line of a modelled storey and the top of its interior walls (under the floor or roof above)."""
    poly = ccw(list(poly))
    FOOTPRINTS[level].append((poly, rect_cover(poly), top))

def edge_distance(poly, x, y):
    best = 1e9
    for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]):
        dx, dy = x1 - x0, y1 - y0; L2 = dx * dx + dy * dy
        k = max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / L2)) if L2 else 0.0
        best = min(best, math.hypot(x - x0 - k * dx, y - y0 - k * dy))
    return best

def storey_top(level, x, y, clear):
    """Interior wall top of the storey containing (x, y) at least `clear` inside its outer wall line.
    The plans' outer walls fall within the clearance: the facades already model them."""
    for poly, rects, top in FOOTPRINTS[level]:
        if any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1 in rects) and edge_distance(poly, x, y) >= clear:
            return top
    return None

def cut_box(group, mat, cx, cy, z0, sx, sy, sz, angle=0.0):
    """Box whose top is the storey's cut face (墙体剖切面), read from above like a plan."""
    box(group, mat, cx, cy, z0, sx, sy, sz, angle, top=False)
    ca, sa = math.cos(angle), math.sin(angle)
    add_face(group, 'int_cut', [(cx + x * ca - y * sa, cy + x * sa + y * ca, z0 + sz)
                                for x, y in ((-sx / 2, -sy / 2), (sx / 2, -sy / 2), (sx / 2, sy / 2), (-sx / 2, sy / 2))])

def plan_wall(group, x0, y0, x1, y1, t, z0, z1):
    cut_box(group, 'int_wall', (x0 + x1) / 2, (y0 + y1) / 2, z0, math.hypot(x1 - x0, y1 - y0), t, z1 - z0, math.atan2(y1 - y0, x1 - x0))

def tread(group, s, z):
    x0, y0, x1, y1 = s
    box(group, 'stair', (x0 + x1) / 2, (y0 + y1) / 2, z, math.hypot(x1 - x0, y1 - y0), 0.06, 0.05, math.atan2(y1 - y0, x1 - x0))

def slab(group, r, z, thickness, mat='slab'):
    x0, y0, x1, y1 = r
    box(group, mat, (x0 + x1) / 2, (y0 + y1) / 2, z - thickness, x1 - x0, y1 - y0, thickness)

def split_rect(r, xs, ys):
    xs = [r[0]] + [x for x in xs if r[0] < x < r[2]] + [r[2]]
    ys = [r[1]] + [y for y in ys if r[1] < y < r[3]] + [r[3]]
    return [(xa, ya, xb, yb) for xa, xb in zip(xs, xs[1:]) for ya, yb in zip(ys, ys[1:])]

def core_upper(x, y):
    return CORE_UPPER[0] <= x <= CORE_UPPER[2] and CORE_UPPER[1] <= y <= CORE_UPPER[3]


def court_node(x, y, margin=0):
    return abs(x) < COURT_X + margin and 26.625 - margin < y < COURT_NORTH + margin


def interiors():
    """Basement, 1F and 2F interiors from floors.json, clipped to the modelled storeys."""
    g = '15_室内'
    levels = FLOORS['levels']
    kx0, ky0, kx1, ky1, kz = FLOORS['core_lower']
    b1 = levels['B1']
    def b1_floor(x, y): return kz if kx0 <= x <= kx1 and ky0 <= y <= ky1 else b1['floor']
    counts = {}
    with at('B1'):
        # This node owns its retaining walls, low gallery, bridge and stairs.
        walls = [w for w in b1['walls'] if not court_node((w[0] + w[2]) / 2, (w[1] + w[3]) / 2, .35)]
        for x0, y0, x1, y1, t in walls:
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            if core_upper(cx, cy) and storey_top('F1', cx, cy, .45) is None: continue
            plan_wall(g, x0, y0, x1, y1, t, b1_floor(cx, cy), CORE_Z - .2 if core_upper(cx, cy) else b1['wall_top'])
        for x0, y0, x1, y1 in b1['columns']:
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            if court_node(cx, cy, .35): continue
            z = b1_floor(cx, cy); top = CORE_Z - .2 if core_upper(cx, cy) else b1['wall_top']
            cut_box(g, 'int_column', cx, cy, z, x1 - x0, y1 - y0, top - z)
        for s in b1['stairs']:
            if court_node((s[0] + s[2]) / 2, (s[1] + s[3]) / 2, .35): continue
            tread(g, s, b1_floor((s[0] + s[2]) / 2, (s[1] + s[3]) / 2))
        for r in b1['slab']:
            for part in split_rect(r, sorted({kx0, -COURT_X, COURT_X, kx1}), sorted({ky0, 26.625, ky1, COURT_NORTH})):
                if court_node((part[0] + part[2]) / 2, (part[1] + part[3]) / 2): continue
                slab(g, part, b1_floor((part[0] + part[2]) / 2, (part[1] + part[3]) / 2), 0.3, 'slab_b1')
            up_face(g, 'mask_b1', [(r[0], r[1], 0.05), (r[2], r[1], 0.05), (r[2], r[3], 0.05), (r[0], r[3], 0.05)])
        counts['B1'] = {'walls': len(walls), 'columns': len(b1['columns']), 'stairs': len(b1['stairs']), 'slabs': len(b1['slab'])}
    for level, source in (('F1', 'F1'), ('F1', 'M1'), ('F2', 'F2')):
        lv = levels[source]; z0 = lv['floor']; n = {'walls': 0, 'columns': 0, 'stairs': 0, 'slabs': 0}
        with at(level):
            for x0, y0, x1, y1, t in lv['walls']:
                top = storey_top(level, (x0 + x1) / 2, (y0 + y1) / 2, 0.45)
                if top is None: continue
                floor = CORE_Z if level == 'F1' and core_upper((x0 + x1) / 2, (y0 + y1) / 2) else z0
                plan_wall(g, x0, y0, x1, y1, t, floor, min(lv['wall_top'], top)); n['walls'] += 1
            for x0, y0, x1, y1 in lv['columns']:
                # a column must sit wholly inside, or it would show through the facade skin
                tops = [storey_top(level, x, y, 0.05) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
                if None in tops: continue
                floor = CORE_Z if level == 'F1' and core_upper((x0 + x1) / 2, (y0 + y1) / 2) else z0
                cut_box(g, 'int_column', (x0 + x1) / 2, (y0 + y1) / 2, floor, x1 - x0, y1 - y0, min(lv['wall_top'], *tops) - floor)
                n['columns'] += 1
            for s in lv['stairs']:
                if storey_top(level, (s[0] + s[2]) / 2, (s[1] + s[3]) / 2, 0.2) is None: continue
                floor = CORE_Z if level == 'F1' and core_upper((s[0] + s[2]) / 2, (s[1] + s[3]) / 2) else z0
                tread(g, s, floor); n['stairs'] += 1
            for r in lv['slab']:
                for _, rects, _ in FOOTPRINTS[level]:
                    for x0, y0, x1, y1 in rects:
                        part = (max(r[0], x0), max(r[1], y0), min(r[2], x1), min(r[3], y1))
                        if part[2] - part[0] > 0.05 and part[3] - part[1] > 0.05:
                            floor = CORE_Z if level == 'F1' and core_upper((part[0] + part[2]) / 2, (part[1] + part[3]) / 2) else z0
                            slab(g, part, floor, 0.2); n['slabs'] += 1
        counts[source] = n
    return counts

# ---------------------------------------------------------------- functional zones (centre module only)
def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))

def zones():
    """Coloured floor overlays of the functional zones (floors.json), clipped like the slabs.
    Hidden in the courtyard scene; the centre module shows them in its storey views."""
    g = '16_功能分区'
    levels = FLOORS['levels']
    kx0, ky0, kx1, ky1, kz = FLOORS['core_lower']
    out = {}
    for level, source in (('B1', 'B1'), ('F1', 'F1'), ('F1', 'M1'), ('F2', 'F2')):
        lv = levels[source]
        with at(level):
            for z in lv['zones']:
                key = f"zone_{z['id']}"
                material(key, f"分区_{z['id']}_{z['name']}", hex_rgb(z['color']), 0.9)
                UVSCALE[key] = 2.0
                parts = []
                for r in z['rects']:
                    if source == 'B1':
                        parts += [p for p in split_rect(r, sorted({kx0, -COURT_X, COURT_X, kx1}), sorted({ky0, 26.625, ky1, COURT_NORTH}))
                                  if not court_node((p[0] + p[2]) / 2, (p[1] + p[3]) / 2)]
                    elif source == 'F2':
                        parts.append(r)
                    else:
                        for _, rects, _ in FOOTPRINTS[level]:
                            for x0, y0, x1, y1 in rects:
                                parts.append((max(r[0], x0), max(r[1], y0), min(r[2], x1), min(r[3], y1)))
                parts = [p for p in parts if p[2] - p[0] > 0.05 and p[3] - p[1] > 0.05]
                if not parts: continue
                zmin = None
                for x0, y0, x1, y1 in parts:
                    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
                    h = (kz if kx0 <= cx <= kx1 and ky0 <= cy <= ky1 else lv['floor']) if source == 'B1' else lv['floor']
                    if source == 'F1' and core_upper(cx, cy): h = CORE_Z
                    up_face(g, key, [(x0, y0, h + 0.03), (x1, y0, h + 0.03), (x1, y1, h + 0.03), (x0, y1, h + 0.03)])
                    zmin = h if zmin is None else min(zmin, h)
                px, py = z['p']
                label_z = (kz if kx0 <= px <= kx1 and ky0 <= py <= ky1 else lv['floor']) if source == 'B1' else lv['floor']
                if source == 'F1' and core_upper(px, py): label_z = CORE_Z
                entry = {'id': z['id'], 'name': z['name'], 'function': z['function'], 'color': z['color'],
                         'area': round(sum((x1 - x0) * (y1 - y0) for x0, y0, x1, y1 in parts)), 'p': z['p'], 'z': label_z}
                if source == 'M1': entry['building'] = '文物管理用房'
                out.setdefault(level, []).append(entry)
    return out

def write_zones(zones_by_level):
    titles = {'B1': ('负一层', FLOORS['levels']['B1']['floor']), 'F1': ('一层', 0.0), 'F2': ('二层', FLOORS['levels']['F2']['floor'])}
    payload = {'source': 'build_center_blender.py（施工图房间名分区，裁切到建模楼层；局部米制坐标 X 东 Y 北）',
               'functions': FLOORS['functions'],
               'levels': {lv: {'title': titles[lv][0], 'floor': titles[lv][1], 'family': FLOORS['families'][lv],
                               'zones': zones_by_level.get(lv, [])} for lv in ('B1', 'F1', 'F2')}}
    rows = json.dumps(payload, ensure_ascii=False, indent=1)
    ZONES_OUT.parent.mkdir(parents=True, exist_ok=True)
    ZONES_OUT.write_text(rows + '\n', encoding='utf-8')

# ---------------------------------------------------------------- building parts
def main_hall():
    g = '01_主馆'
    eave = [(-21.1, 101.5), (21.1, 101.5), (21.1, 98.8), (28, 98.8), (28, 59.9), (21.1, 59.9), (21.1, 57.2), (-21.1, 57.2), (-21.1, 59.9), (-28, 59.9), (-28, 98.8), (-21.1, 98.8)]
    envelope = [(-25.48, 62.42), (25.48, 62.42), (25.48, 96.28), (-25.48, 96.28)]
    # F1 WALL linework: service rooms project north of the recessed entrance.
    # The porch-facing 1.8 m doors belong on the short return walls.
    walls = [(-25.48, 62.42), (25.48, 62.42), (25.48, 96.225),
             (18.525, 96.225), (18.525, 98.925), (11.175, 98.925), (11.175, 96.1),
             (-11.175, 96.1), (-11.175, 98.925), (-18.525, 98.925), (-18.525, 96.225), (-25.48, 96.225)]
    # 2F rooms sit under the 盝顶 slopes, which start above 8.0 at the wall line
    footprint('F1', walls, 5.2); footprint('F2', walls, 7.8)
    podium(g, [(-26.4, 58.9), (26.4, 58.9), (26.4, 99.9), (-26.4, 99.9)], 0)
    ops = north_entrance_openings(walls, openings_for('f1', walls, 0.0) + openings_for('f2', walls, 5.4))
    facade(g, walls, 0.0, 6.58, 'facade_stone', ops, split=5.4)
    corner_piers(g, envelope, 0.0, 6.58, split=5.4)
    pilasters(g, walls, 0.0, 6.58, width=.5, split=5.4, openings=ops)
    # No extra row across the north entrance: the plan's columns lie in its
    # glazing plane. Retain the separate south courtyard porch.
    columns(g, [(x, 60.1) for x in (-17.7, -11.4, -4.5, 4.5, 11.4, 17.7)], 0.0, 6.2, 0.7, 'facade_trim')
    box(g, 'facade_frieze', 0, 97.0, 5.9, 37.2, 2.2, 0.7)
    box(g, 'facade_frieze', 0, 61.35, 5.9, 37.2, 2.2, 0.7)
    with at('RF'):
        brackets(g, envelope, 6.58, 1.9, scale=1.1)
        eave_band(g, eave, 6.58, 7.10, 2.6)
        luding(g, eave, 7.10, 11.0, 10.95, ridge_h=0.6, ridge_w=0.8)

def stair_towers():
    g = '02_北侧楼梯间'
    for sgn in (-1, 1):
        cx = sgn * 35.1
        walls = [(cx - 3.58, 98.41), (cx + 3.58, 98.41), (cx + 3.58, 104.69), (cx - 3.58, 104.69)]
        footprint('F1', walls, 4.45)
        podium(g, walls, 0.5)
        facade(g, walls, 0.0, 4.7, 'facade_stone', openings_for('f1', walls, 0.0))
        corner_piers(g, walls, 0.0, 4.7, size=0.9)
        with at('RF'):
            eave = offset_poly(walls, -0.6)
            eave_band(g, eave, 4.7, 5.165, 0.6)
            pyramid(g, cx, 101.55, 4.2, 5.165, 0.345)
        box(g, 'light', cx - sgn * 4.6, 101.9, 3.0, 2.0, 3.0, 0.19)   # 3.190 side canopy

def wings():
    for sgn, g in ((-1, '03_西翼_大剧场'), (1, '04_东翼_中剧场')):
        E = [(-36.4, 58.7), (-29.8, 58.7), (-29.8, 36.4), (-56.6, 36.4), (-56.6, 85.7), (-36.4, 85.7)]
        W = [(-38.11, 60.41), (-31.51, 60.41), (-31.51, 38.11), (-54.89, 38.11), (-54.89, 83.99), (-38.11, 83.99)]
        low = [(-38.11, 60.41), (-31.52, 60.41), (-31.52, 83.98), (-38.11, 83.98)]
        if sgn > 0:
            E, W, low = mirror_x(E), mirror_x(W), mirror_x(low)
        footprint('F1', W, 5.2); footprint('F2', W, 7.9)
        footprint('F1', low, 5.2); footprint('F2', low, 6.2)
        podium(g, offset_poly(W, -0.9), 0)
        ops = openings_for('f1', W, 0.0)
        facade(g, W, 0.0, 5.4, 'facade_stone', ops)
        with at('F2'):
            facade(g, W, 5.4, 8.18, 'facade_frieze', base_h=0)
            # waist eave: board at 5.40–5.85, short tiled skirt back to the clerestory
            eave_band(g, E, 5.40, 5.85, 1.72)
            lean_to(g, E, 5.85, 1.72, 6.25)
        corner_piers(g, W, 0.0, 5.4)
        with at('RF'):
            brackets(g, W, 7.73, 1.7, scale=1.0)
            eave_band(g, E, 7.73, 8.18, 1.72)
            luding(g, E, 8.18, 6.8, 10.53)
        # flat-roofed link block at the inner corner towards the main hall
        facade(g, low, 0.0, 6.58, 'facade_stone', openings_for('f1', low, 0.0), split=5.4)
        with at('RF'):
            prism(g, 'paint', offset_poly(low, -0.05), 6.3, 6.95, top_mat='membrane')

def core_openings(view, walls, z):
    """The four 1.2 m leaves share one 4.8 m opening at Y=26.525.

    The doors at Y=22.8 belong to interior service rooms, not the north facade.
    Horizontal positions and widths are from the DorLib blocks; 3 m door height
    retains the model's door convention where this internal elevation has no tag.
    """
    poly = ccw(walls)
    edge = next(i for i, (a, b) in enumerate(zip(poly, poly[1:] + poly[:1]))
                if abs(a[1] - 26.625) < .001 and abs(b[1] - 26.625) < .001)
    ops = [o for o in openings_for(view, walls, z, tol=.25) if not (o['edge'] == edge and o['door'])]
    panels = [{'s0': k * 1.2, 's1': (k + 1) * 1.2, 'z0': z, 'z1': z + 3,
               'latch': (k + (1 if k % 2 == 0 else 0)) * 1.2 + (-.12 if k % 2 == 0 else .12)} for k in range(4)]
    ops.append({'edge': edge, 'c': poly[edge][0], 'w': 4.8, 'door': True, 'z': z,
                'sill': z, 'head': z + 3, 'panels': panels, 'reveal': .1, 'surround': False})
    for o in ops:
        if not o['door']:
            o.update(sill=z + 1.2, head=z + 3.0)
        elif o['edge'] != edge:
            o['reveal'] = .1
    return ops


def core_hall():
    g = '05_画像石核心展厅'
    walls = [(-19.425, 2.525), (-8.375, 2.525), (-8.375, -.225), (8.375, -.225),
             (8.375, 2.525), (19.425, 2.525), (19.425, 26.625), (-19.425, 26.625)]
    footprint('F1', walls, 6.2)
    # The ground-floor extractor intentionally supplies no slab for open plans;
    # this raised hall needs its own floor, just as the other halls have podiums.
    prism(g, 'slab', walls, CORE_Z - .2, CORE_Z, top_mat='paving_dark', bottom=True)
    ops = core_openings('f1', walls, CORE_Z)
    facade(g, walls, CORE_Z, 6.43, 'facade_stone', ops)
    corner_piers(g, walls, CORE_Z, 6.43)
    pilasters(g, walls, CORE_Z, 6.43, openings=ops)
    with at('B1'):
        facade(g, walls, CORE_B1_Z, CORE_Z - .2, 'facade_stone', core_openings('site', walls, CORE_B1_Z))
    with at('RF'):
        brackets(g, [(-19.425, 2.525), (19.425, 2.525), (19.425, 26.625), (-19.425, 26.625)], 6.43, 2.0, scale=1.1)
        eave = [(-22.0, 2.0), (22.0, 2.0), (22.0, 29.2), (-22.0, 29.2)]
        eave_band(g, eave, 6.43, 6.95, 2.52)
        zr = hip_rect(g, -22.0, 2.0, 22.0, 29.2, 6.95, 0.305, ridge_h=0.5)
        # skylights on both slopes (roof plan 8.600 → ridge)
        for y0, y1 in ((6.988, 15.4), (15.8, 24.212)):
            za = 6.95 + (min(abs(y0 - 2.0), abs(29.2 - y0))) * 0.305
            zb = 6.95 + (min(abs(y1 - 2.0), abs(29.2 - y1))) * 0.305
            quad(g, 'glass', (-8.9, y0, za + 0.06), (8.9, y0, za + 0.06), (8.9, y1, zb + 0.06), (-8.9, y1, zb + 0.06))
            for x in (-8.9, -4.45, 0, 4.45, 8.9):
                ridge_line(g, (x, y0, za + 0.06), (x, y1, zb + 0.06), 0.12, 0.1, 'frame')
    # The south bay belongs to the same +2.400 floor; its wall is in the polygon above.
    with at('RF'):
        pe = [(-9.7, -1.6), (9.7, -1.6), (9.7, 10.214), (-9.7, 10.214)]
        eave_band(g, pe, 6.43, 6.95, 1.3)
        luding(g, pe, 6.95, 4.107, 7.91, ridge_h=0.2, ridge_w=0.4)

def corridors():
    g = '06_庭院环廊'
    for sgn in (-1, 1):
        f = (lambda p: (sgn * p[0], p[1]))
        # L-shaped gable: eaves at outer / inner line, ridge in between (roof plan 22.0 / 24.6 / 27.2)
        z_e, z_r = 3.45, 4.35
        outer = [(-22.0, 22.0), (-37.7, 22.0), (-37.7, 36.4)]
        ridge = [(-22.0, 24.6), (-35.1, 24.6), (-35.1, 36.4)]
        inner = [(-22.0, 27.2), (-32.5, 27.2), (-32.5, 36.4)]
        with at('RF'):
            for A, B in ((outer, ridge), (inner, ridge)):
                for k in range(2):
                    a0, a1 = f(A[k]), f(A[k + 1]); r0, r1 = f(B[k]), f(B[k + 1])
                    pts = [(*a0, z_e), (*a1, z_e), (*r1, z_r), (*r0, z_r)]
                    e0 = Vector(pts[0]); t = (Vector(pts[1]) - e0).normalized(); up = Vector(pts[3]) - e0; up -= t * up.dot(t); up.normalize()
                    up_face(g, 'tile', pts, [((Vector(p) - e0).dot(t), (Vector(p) - e0).dot(up)) for p in pts])
            for k in range(2):
                ridge_line(g, (*f(ridge[k]), z_r - 0.04), (*f(ridge[k + 1]), z_r - 0.04), 0.3, 0.25)
            for A in (outer, inner):
                for k in range(2):
                    a0, a1 = Vector(f(A[k])), Vector(f(A[k + 1]))
                    t = (a1 - a0).normalized()
                    box(g, 'facade_fascia', (a0.x + a1.x) / 2, (a0.y + a1.y) / 2, z_e - 0.35, (a1 - a0).length, 0.2, 0.35, math.atan2(t.y, t.x), bottom=True)
        # outer wall (light stone) and inner colonnade
        wall_pts = [(-22.0, 22.55), (-37.15, 22.55), (-37.15, 36.4)]
        for k in range(2):
            a0, a1 = Vector(f(wall_pts[k])), Vector(f(wall_pts[k + 1]))
            t = (a1 - a0).normalized()
            box(g, 'facade_stone', (a0.x + a1.x) / 2, (a0.y + a1.y) / 2, 0.0, (a1 - a0).length, 0.35, z_e - 0.35, math.atan2(t.y, t.x))
        cols = [(-26.4, 26.65), (-30.8, 26.65), (-33.1, 26.65), (-33.1, 30.4), (-33.1, 34.2)]
        columns(g, [f(p) for p in cols], 0.0, z_e - 0.35, 0.45, 'facade_trim', cap=False)
        polygon_top(g, 'paving_dark', [f(p) for p in [(-22.0, 22.0), (-37.7, 22.0), (-37.7, 36.4), (-32.5, 36.4), (-32.5, 27.2), (-22.0, 27.2)]] if sgn < 0 else
                    [f(p) for p in [(-22.0, 22.0), (-22.0, 27.2), (-32.5, 27.2), (-32.5, 36.4), (-37.7, 36.4), (-37.7, 22.0)]], 0.01, True)
    # small flat links between the wing link blocks and the main hall (2F bridges inside)
    for sgn in (-1, 1):
        box(g, 'light', sgn * 28.5, 64.2, 0.0, 6.1, 2.8, 5.4)
        with at('F2'):
            box(g, 'light', sgn * 28.5, 64.2, 5.4, 6.1, 2.8, 0.9)
        # kept just inside the block, so the 2F slab never shares its outer faces
        footprint('F2', [(sgn * 28.5 - 3.0, 62.85), (sgn * 28.5 + 3.0, 62.85), (sgn * 28.5 + 3.0, 65.55), (sgn * 28.5 - 3.0, 65.55)], 6.2)
        with at('RF'):
            box(g, 'paint', sgn * 28.5, 64.2, 6.3, 6.3, 3.0, 0.5)

def straight_stair(group, half_width, north, bottom, count, rise=.15, going=.3):
    """A flight rising south, with a continuous sloping soffit (no ground-filled blocks)."""
    profile = [(north, bottom)]
    south, top = north - (count - 1) * going, bottom + count * rise
    # The upper landing supplies the final riser; stop at the preceding tread.
    for k in range(count - 1):
        y = north - k * going
        profile.append((y, bottom + (k + 1) * rise))
        profile.append((y - going, bottom + (k + 1) * rise))
    profile += [(south, top - .25), (north, bottom - .25)]
    for sign in [-1, 1]:
        pts = [(sign * half_width, y, z) for y, z in profile]
        add_face(group, 'granite', pts if sign > 0 else pts[::-1])
    for i, ((ya, za), (yb, zb)) in enumerate(zip(profile, profile[1:] + profile[:1])):
        # The landing slab supplies the last riser: overlapping faces there flicker.
        if i == len(profile) - 3: continue
        quad(group, 'granite', (half_width, ya, za), (-half_width, ya, za),
             (-half_width, yb, zb), (half_width, yb, zb))
    return south, top


def balustrade(group, a, b, z):
    dx, dy = b[0] - a[0], b[1] - a[1]; length = math.hypot(dx, dy)
    count = max(1, round(length / 1.6)); ang = math.atan2(dy, dx)
    for k in range(count + 1):
        box(group, 'light', a[0] + dx * k / count, a[1] + dy * k / count, z, .22, .22, 1.1)
    for h, depth, thick in [(1.0, .18, .1), (.25, .1, .08)]:
        box(group, 'light', (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z + h, length, depth, thick, ang)


def bridge_parapet(group, x, path):
    # 1-1 section: solid 1100 mm parapet, following the flight and landing.
    for (ya, za), (yb, zb) in zip(path, path[1:]):
        for xx in [x - .1, x + .1]:
            quad(group, 'light', (xx, ya, za), (xx, yb, zb), (xx, yb, zb + 1.1), (xx, ya, za + 1.1))
        up_face(group, 'granite', [(x - .12, ya, za + 1.1), (x + .12, ya, za + 1.1),
                                 (x + .12, yb, zb + 1.1), (x - .12, yb, zb + 1.1)])
    for y, z in (path[0], path[-1]):
        quad(group, 'light', (x - .1, y, z), (x + .1, y, z), (x + .1, y, z + 1.1), (x - .1, y, z + 1.1))


def courtyard():
    g = '07_屋顶平台与下沉庭院'
    # Roof of the reserved basement exhibition hall; +.600 finished / +.300 structure.
    terrace = [(-29.8, COURT_NORTH), (-29.8, 58.7), (-21.1, 58.7), (-21.1, 57.2),
               (21.1, 57.2), (21.1, 58.7), (29.8, 58.7), (29.8, COURT_NORTH)]
    prism(g, 'light', terrace, .3, TERRACE_Z, top_mat='paving', bottom=True)
    # Extend the landing to the first riser, without any railing across the walking route.
    slab(g, (-BRIDGE_HALF, 34.01, BRIDGE_HALF, COURT_NORTH), TERRACE_Z, .3, 'paving')
    upper_south, _ = straight_stair(g, BRIDGE_HALF, 34.01, TERRACE_Z, 12)
    slab(g, (-BRIDGE_HALF, 26.625, BRIDGE_HALF, upper_south), CORE_Z, .3, 'paving')
    for x in [-4.5, 4.5]:
        bridge_parapet(g, x, [(COURT_NORTH, TERRACE_Z), (upper_south, CORE_Z), (26.625, CORE_Z)])
    # Mark the whole connection, including the covered low gallery and bridge underside.
    polygon_top(g, 'mask', [(-COURT_X, 26.625), (COURT_X, 26.625),
                            (COURT_X, COURT_NORTH), (-COURT_X, COURT_NORTH)], .63)
    with at('B1'):
        lower_south, _ = straight_stair(g, BRIDGE_HALF, 34.2, -4.8, 8)
        slab(g, (-BRIDGE_HALF, 26.625, BRIDGE_HALF, lower_south), CORE_B1_Z, .25, 'paving_dark')
        slab(g, (-BRIDGE_HALF, 34.2, BRIDGE_HALF, 37.2), -4.8, .25, 'paving_dark')
    for sign in [-1, 1]:
        x0, x1 = (-COURT_X, -4.6) if sign < 0 else (4.6, COURT_X)
        balustrade(g, (x0, COURT_NORTH), (x1, COURT_NORTH), TERRACE_Z)
        balustrade(g, (sign * COURT_X, GALLERY_FRONT), (sign * COURT_X, COURT_NORTH), TERRACE_Z)
        gallery = [(x0, 26.625), (x1, 26.625), (x1, GALLERY_FRONT), (x0, GALLERY_FRONT)]
        retaining = [(x0, COURT_NORTH), (x1, COURT_NORTH), (x1, COURT_NORTH + .25), (x0, COURT_NORTH + .25)]
        with at('B1'):
            slab(g, (x0, GALLERY_FRONT, x1, COURT_NORTH), COURT_Z, .2, 'paving_dark')
            # The north retaining wall has the exits shown on the basement plan.
            exits = openings_for('site', retaining, -4.8, tol=.3)
            facade(g, retaining, COURT_Z, TERRACE_Z, 'light', exits, edges=[0], cap=.12)
            # Outer return and foundation below the gallery wall.
            box(g, 'light', sign * COURT_X, (GALLERY_FRONT + COURT_NORTH) / 2,
                COURT_Z, .2, COURT_NORTH - GALLERY_FRONT, TERRACE_Z - COURT_Z)
            box(g, 'light', (x0 + x1) / 2, GALLERY_FRONT, COURT_Z, x1 - x0, .2, CORE_B1_Z - COURT_Z)
            slab(g, (x0, 26.625, x1, GALLERY_FRONT), CORE_B1_Z, .25, 'paving_dark')
            openings = openings_for('site', gallery, CORE_B1_Z, tol=.3)
            for op in openings:
                if not op['door']: op.update(sill=-2.4, head=-.6)
            facade(g, gallery, CORE_B1_Z, .135, 'light', openings, edges=[2], cap=.18)
            # Small -4.800 landing and 1:12 ramp down to the -5.100 court bottom.
            inner = sorted((sign * 4.6, sign * 7.4))
            slab(g, (inner[0], 30.3, inner[1], COURT_NORTH), -4.8, .3, 'paving_dark')
            up_face(g, 'paving_dark', [(sign * 7.4, 30.7, -4.8), (sign * 11.0, 30.7, COURT_Z),
                                      (sign * 11.0, 31.9, COURT_Z), (sign * 7.4, 31.9, -4.8)])
            box(g, 'frame', sign * 19.1, 30.85, COURT_Z + .01, 14.2, .18, .02)
            box(g, 'frame', sign * 26.5, 31.3, COURT_Z + .01, 2, 1.2, .02)
            for k in range(11):
                box(g, 'granite', sign * 26.5, 30.76 + .108 * k, COURT_Z + .03, 1.98, .035, .025)
        # The gallery roof is below the +2.400 entrance landing, not an at-grade portico.
        with at('RF'):
            up_face(g, 'tile', [(x0, 26.625, 1.79), (x1, 26.625, 1.79),
                               (x1, 31.0, .135), (x0, 31.0, .135)])
            box(g, 'facade_fascia', (x0 + x1) / 2, 31.0, -.065, x1 - x0, .18, .2)
    # planting beds and a water basin on the terrace
    for sgn in (-1, 1):
        prism(g, 'granite', [(sgn * 6, 41), (sgn * 18, 41), (sgn * 18, 52), (sgn * 6, 52)], TERRACE_Z, TERRACE_Z + .45, top_mat='lawn')
        for x, y in ((sgn * 9, 44), (sgn * 15, 49), (sgn * 12, 46.5)):
            tree(g, x, y, TERRACE_Z + .45, random.uniform(5.5, 7.5), random.uniform(1.8, 2.6), leaf=random.choice(['leaf0', 'leaf1', 'leaf2']))
    prism(g, 'granite', [(-4.5, 42), (4.5, 42), (4.5, 53), (-4.5, 53)], TERRACE_Z, TERRACE_Z + .25)
    polygon_top(g, 'water', [(-4.2, 42.3), (4.2, 42.3), (4.2, 52.7), (-4.2, 52.7)], TERRACE_Z + .2, True)

def management():
    for sgn, g in ((-1, '08_管理用房_西'), (1, '09_管理用房_东')):
        W = [(-42.52, 122.47), (-26.175, 122.47), (-26.175, 156.53), (-42.52, 156.53)]
        if sgn > 0: W = mirror_x(W)
        footprint('F1', W, 4.2)
        podium(g, offset_poly(W, -0.8), 0)
        facade(g, W, 0.0, 6.0, 'facade_stone', openings_for('mgmt_f1', W, 0.0))
        corner_piers(g, W, 0.0, 6.0, size=1.0)
        skirt = offset_poly(W, -1.775)
        eave_band(g, skirt, 3.6, 4.0, 1.775)
        lean_to(g, skirt, 4.0, 1.775, 4.45)
        with at('RF'):
            brackets(g, W, 6.0, 1.0, spacing=4.2, scale=0.8, grid=False)
            E = offset_poly(W, -0.6)
            eave_band(g, E, 6.0, 6.45, 0.6)
            rim = luding(g, E, 6.45, 5.1 + 0.6, 8.40, flat=False, ridge_h=0.3, ridge_w=0.35)
            # shallow gable over the flat top up to the 8.870 ridge
            xs = sorted({p[0] for p in rim}); ys = sorted({p[1] for p in rim})
            cxm = (xs[0] + xs[-1]) / 2
            for xa in (xs[0], xs[-1]):
                up_face(g, 'tile', [(xa, ys[0], 8.4), (cxm, ys[0], 8.87), (cxm, ys[-1], 8.87), (xa, ys[-1], 8.4)],
                        [(0, 0), (abs(cxm - xa), 0), (abs(cxm - xa), ys[-1] - ys[0]), (0, ys[-1] - ys[0])])
            for yy, sg in ((ys[0], 1), (ys[-1], -1)):
                tri = [(xs[0], yy, 8.4), (xs[-1], yy, 8.4), (cxm, yy, 8.87)]
                add_face(g, 'paint', tri if sg < 0 else tri[::-1])
            ridge_line(g, (cxm, ys[0], 8.83), (cxm, ys[-1], 8.83), 0.45, 0.3)
            ridge_ornament(g, (cxm, ys[0], 9.0), (0, -1), 0.9); ridge_ornament(g, (cxm, ys[-1], 9.0), (0, 1), 0.9)
        # covered walk along the courtyard side
        xw0, xw1 = (-24.4, -21.3) if sgn < 0 else (21.3, 24.4)
        cols = [((xw1 if sgn < 0 else xw0) - sgn * 0.3, y) for y in (124.2, 130.2, 136.2, 142.2, 148.2, 154.2)]
        columns(g, cols, 0.0, 4.1, 0.4, 'facade_trim', cap=False)
        hi_x, lo_x = (xw0, xw1) if sgn < 0 else (xw1, xw0)
        with at('RF'):
            quad(g, 'tile', (hi_x, 123.0, 4.95), (lo_x, 123.0, 4.35), (lo_x, 156.0, 4.35), (hi_x, 156.0, 4.95))
            box(g, 'wood', lo_x, 139.5, 4.0, 0.25, 33.0, 0.35)
        # connectors to the service hall (flat roof 4.500)
        cx = sgn * 16.9
        cw = [(cx - 4.1, 147.9), (cx + 4.1, 147.9), (cx + 4.1, 156.4), (cx - 4.1, 156.4)]
        footprint('F1', cw, 3.95)
        facade(g, cw, 0.0, 4.2, 'facade_stone', openings_for('mgmt_f1', cw, 0.0))
        with at('RF'):
            prism(g, 'paint', offset_poly(cw, -0.3), 4.2, 4.6, top_mat='membrane')
    g = '10_管理用房_服务大厅'
    W = [(-12.7, 147.8), (12.7, 147.8), (12.7, 161.2), (-12.7, 161.2)]
    footprint('F1', W, 4.2)
    podium(g, offset_poly(W, -1.0), 0)
    facade(g, W, 0.0, 5.15, 'facade_stone', openings_for('mgmt_f1', W, 0.0))
    facade(g, W, 5.15, 8.5, 'facade_frieze', base_h=0)
    corner_piers(g, W, 0.0, 5.0)
    skirt = [(-14.6, 145.9), (14.6, 145.9), (14.6, 163.1), (-14.6, 163.1)]
    eave_band(g, skirt, 4.7, 5.15, 1.9)
    lean_to(g, skirt, 5.15, 1.9, 5.55)
    with at('RF'):
        brackets(g, W, 8.5, 1.2, spacing=4.0, scale=0.9, grid=False)
        E = [(-13.425, 147.075), (13.425, 147.075), (13.425, 161.925), (-13.425, 161.925)]
        eave_band(g, E, 8.5, 8.95, 0.9)
        # roof plan: eave ±13.425 → top ±6.40 × 152.4–156.6 (unequal runs, 10.830 top)
        luding(g, E, 8.95, 0, 10.83, ridge_h=0.45, ridge_w=0.6, rim=[(-6.4, 152.4), (6.4, 152.4), (6.4, 156.6), (-6.4, 156.6)])

def gate_que():
    """A pair of Han que at the north entrance (V2 site plan ±24.0, 208.9)."""
    g = '11_北入口汉阙'
    for sgn in (-1, 1):
        cx, cy = sgn * 24.0, 208.9
        box(g, 'granite', cx, cy, -0.45, 4.4, 3.0, 0.5)
        frustum(g, 'light', cx, cy, 0.05, 3.2, 2.0, 2.7, 1.6, 6.4)
        box(g, 'darkbrown', cx, cy, 5.3, 3.3, 2.2, 0.45)
        for k, (w, d) in enumerate(((3.6, 2.6), (3.2, 2.3))):
            z = 6.45 + k * 1.5
            frustum(g, 'light', cx, cy, z - 1.0 if k else z - 0.95, 2.6 - k * 0.5, 1.5 - k * 0.2, 2.4 - k * 0.5, 1.4 - k * 0.2, 0.9)
            eave = [(cx - w / 2, cy - d / 2), (cx + w / 2, cy - d / 2), (cx + w / 2, cy + d / 2), (cx - w / 2, cy + d / 2)]
            eave_band(g, eave, z, z + 0.2, 0.5)
            hip_rect(g, cx - w / 2, cy - d / 2, cx + w / 2, cy + d / 2, z + 0.2, 0.45, ridge_h=0.18)
        # 子阙
        ox = cx + sgn * 2.9
        frustum(g, 'light', ox, cy, 0.05, 1.8, 1.4, 1.5, 1.2, 4.2)
        eave = [(ox - 1.3, cy - 1.0), (ox + 1.3, cy - 1.0), (ox + 1.3, cy + 1.0), (ox - 1.3, cy + 1.0)]
        eave_band(g, eave, 4.25, 4.42, 0.4)
        hip_rect(g, ox - 1.3, cy - 1.0, ox + 1.3, cy + 1.0, 4.42, 0.45, ridge_h=0.15)

def gatehouse():
    """岗亭 (V2 site plan corner point -87.24, 239.11)."""
    g = '12_岗亭'
    x0, y0 = -87.24, 239.11
    W = [(x0, y0 - 3.6), (x0 + 4.8, y0 - 3.6), (x0 + 4.8, y0), (x0, y0)]
    podium(g, W, 0.3)
    facade(g, W, 0.0, 3.0, 'light', [{'edge': 0, 'c': 2.4, 'w': 3.0, 'door': False, 'z': 0.0}, {'edge': 2, 'c': 2.4, 'w': 1.0, 'door': True, 'z': 0.0}])
    E = offset_poly(W, -0.7)
    eave_band(g, E, 3.0, 3.3, 0.7)
    hip_rect(g, E[0][0], E[0][1], E[2][0], E[2][1], 3.3, 0.4, ridge_h=0.18)

def garage_ramp():
    """地下车库出入口: open ramp with side walls and a light canopy (V2 key node 47.94, 143.25)."""
    g = '13_车库出入口'
    x, y = 47.94, 143.25
    with at('B1'):
        for sgn in (-1, 1):
            box(g, 'light', x + sgn * 3.6, y - 8, -4.8, 0.4, 26, 5.6)
        quad(g, 'paving_dark', (x - 3.4, y + 5, -0.05), (x + 3.4, y + 5, -0.05), (x + 3.4, y - 21, -4.8), (x - 3.4, y - 21, -4.8))
        polygon_top(g, 'mask', [(x - 3.6, y - 21), (x + 3.6, y - 21), (x + 3.6, y + 4.45), (x - 3.6, y + 4.45)], GRADE + 0.02, True)
        # closed trench end, so nothing seen through the stencil opening is empty sky
        quad(g, 'light', (x + 3.4, y - 21, -4.8), (x - 3.4, y - 21, -4.8), (x - 3.4, y - 21, GRADE), (x + 3.4, y - 21, GRADE))
    for k in range(5):
        box(g, 'frame', x - 3.6, y + 4 - k * 3.2, 0.3, 0.15, 0.15, 2.6)
        box(g, 'frame', x + 3.6, y + 4 - k * 3.2, 0.3, 0.15, 0.15, 2.6)
    quad(g, 'glass', (x - 3.9, y + 5, 3.0), (x + 3.9, y + 5, 3.0), (x + 3.9, y - 9, 3.0), (x - 3.9, y - 9, 3.0))

# ---------------------------------------------------------------- vegetation
def tree(group, x, y, z, height, radius, leaf='leaf0'):
    trunk_h = height * 0.42
    frustum(group, 'bark', x, y, z, 0.3, 0.3, 0.16, 0.16, trunk_h + 0.6, top=False)
    for k in range(3):   # main scaffold branches
        a = k * 2.1 + random.uniform(-0.4, 0.4)
        p0 = Vector((x, y, z + trunk_h * 0.8)); p1 = p0 + Vector((math.cos(a) * radius * 0.5, math.sin(a) * radius * 0.5, radius * 0.6))
        ridge_line(group, tuple(p0), tuple(p1), 0.1, 0.1, 'bark')
    blobs = 7
    for k in range(blobs):
        a = k * 2.399 + random.uniform(-0.3, 0.3)
        rr = radius * random.uniform(0.5, 0.72)
        d = radius * random.uniform(0.35, 0.55) if k else 0
        cz = z + trunk_h + radius * (0.5 + 0.45 * random.random())
        blob(group, x + math.cos(a) * d, y + math.sin(a) * d, cz, rr, leaf)

ICO = None
def blob(group, x, y, z, r, mat):
    global ICO
    if ICO is None:
        bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0)
        ICO = ([tuple(v.co) for v in bm.verts], [[v.index for v in f.verts] for f in bm.faces]); bm.free()
    verts, faces = ICO
    jit = [(vx * random.uniform(0.86, 1.1), vy * random.uniform(0.86, 1.1), vz * random.uniform(0.72, 0.98)) for vx, vy, vz in verts]
    for f in faces:
        pts = [(x + jit[i][0] * r, y + jit[i][1] * r, z + jit[i][2] * r) for i in f]
        add_face(group, mat, pts, [(0, 0), (1, 0), (0.5, 1)])

# ---------------------------------------------------------------- V2 site ground and tree positions
# Openings below grade that the continuous V2 ground would otherwise cover (x0, y0, x1, y1).
SITE_HOLES = [(-COURT_X, 26.625, COURT_X, COURT_NORTH), (44.34, 122.25, 51.54, 147.7)]

def cut_site_holes(obj, holes):
    inv = obj.matrix_world.inverted()
    bm = bmesh.new(); bm.from_mesh(obj.data)
    for x0, y0, x1, y1 in holes:
        for co, no in (((x0, 0, 0), (1, 0, 0)), ((x1, 0, 0), (1, 0, 0)), ((0, y0, 0), (0, 1, 0)), ((0, y1, 0), (0, 1, 0))):
            p = inv @ Vector(co); n = (inv.to_3x3() @ Vector(no)).normalized()
            geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
            bmesh.ops.bisect_plane(bm, geom=geom, plane_co=p, plane_no=n)
        mw = obj.matrix_world
        doomed = [f for f in bm.faces if (lambda c: x0 < c.x < x1 and y0 < c.y < y1)(mw @ f.calc_center_median())]
        bmesh.ops.delete(bm, geom=doomed, context='FACES')
    bm.to_mesh(obj.data); bm.free()

def import_v2_site():
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(V2))
    new = [o for o in bpy.data.objects if o not in before]
    bpy.context.view_layer.update()
    keep, trees = [], []
    for o in new:
        name = o.name
        if o.type == 'MESH' and name == 'Site__site____common':
            keep.append(o)
        elif o.type == 'MESH' and name.startswith('Site__site____common.'):
            bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
            xs = [v.x for v in bb]; ys = [v.y for v in bb]; zs = [v.z for v in bb]
            trees.append(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs), max(zs) - min(zs), (max(xs) - min(xs)) / 2))
    for o in keep:
        mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
        for c in list(o.users_collection): c.objects.unlink(o)
        bpy.context.scene.collection.objects.link(o)
        cut_site_holes(o, SITE_HOLES)
    for o in new:
        if o not in keep:
            bpy.data.objects.remove(o, do_unlink=True)
    for o in keep:
        o.name = '00_场地_V2总图'
        o['building'] = '00_场地'
        o['center_level'] = 'site'
        o['center_role'] = 'site'
    return keep, trees

# ---------------------------------------------------------------- flush buffers to objects
def role(level, mat):
    """What the storey views need to know about a mesh (hanwenhuaCenter.ts, center/centerModel.ts)."""
    if mat == 'mask': return 'opening_mask'
    if mat == 'mask_b1': return 'b1_mask'
    if mat.startswith('zone_'): return 'zone'
    if mat == 'dark': return 'interior_dark'
    if mat.startswith(('leaf', 'bark')): return 'vegetation'
    if level == 'RF': return 'roof'
    if mat.startswith(('int_', 'slab')) or mat == 'stair': return 'interior'
    return 'shell'

def flush():
    col = bpy.data.collections.new('传承中心_施工图重建_20260925'); bpy.context.scene.collection.children.link(col)
    objs = []
    for (group, level, mat), (vs, fs, us) in sorted(BUF.items()):
        if not fs: continue
        name = f'{group}_{level}_{mat}'
        me = bpy.data.meshes.new(name)
        me.from_pydata(vs, [], fs); me.update()
        uv = me.uv_layers.new(name='UVMap')
        for poly, coords in zip(me.polygons, us):
            for li, c in zip(poly.loop_indices, coords):
                uv.data[li].uv = c
        me.materials.append(MATS[mat])
        ob = bpy.data.objects.new(name, me); col.objects.link(ob)
        ob['building'] = group
        ob['center_level'] = level
        ob['center_role'] = role(level, mat)
        if mat.startswith('zone_'): ob['zone_id'] = mat[5:]
        objs.append(ob)
    # merge by distance per object and recompute normals outward
    for ob in objs:
        bm = bmesh.new(); bm.from_mesh(ob.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
        bm.to_mesh(ob.data); bm.free()
        smooth = ob['center_role'] == 'vegetation'
        for p in ob.data.polygons: p.use_smooth = smooth
    return objs

def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = '武氏祠汉文化保护传承中心_施工图重建_20260925'
    scene.unit_settings.system = 'METRIC'
    define_materials()
    site, old_trees = import_v2_site() if V2.exists() else ([], [])
    main_hall(); stair_towers(); wings(); core_hall(); corridors(); courtyard(); management(); garage_ramp()
    with at('site'):
        gate_que(); gatehouse()
        # V2 landscape trees, rebuilt light-weight at the same stations
        for (x, y, z, h, r) in old_trees:
            tree('14_景观乔木', x, y, z, max(4.0, h), max(1.4, min(r, 3.2)), leaf=random.choice(['leaf0', 'leaf1', 'leaf2', 'leaf3']))
    interior_counts = interiors()
    zones_by_level = zones()
    write_zones(zones_by_level)
    objs = flush()
    per_level = {}
    for o in objs: per_level[o['center_level']] = per_level.get(o['center_level'], 0) + 1
    report = {
        'source': '施工图_建筑20260925.dwg（浙江省古建筑设计研究院，建施-01～20）',
        'facade_reference': '02.pdf 第2页鸟瞰、第3页立面：浅米色竖纹石材、暖棕色柱框与檐口、深色檐下带；平面与标高沿用施工图',
        'entrance_reference': {
            'drawing': '施工图_建筑20260925.dwg：一层平面、S20-S1轴立面',
            'glazing_y': 96.0, 'door_leaf_x': [-2.0, -1.0, 0.0, 1.0, 2.0],
            'door_head': 2.4, 'fanlight_head': 3.3, 'side_window_sill': .3,
            'side_window_bays': 8, 'return_door_centres': [[-11.275, 97.35], [11.295, 97.35]],
            'note': '插入点为门洞中心；水平位置沿用平面，分扇及竖向尺寸按立面；拉手仅作识别示意',
        },
        'courtyard_reference': {
            'drawing': '20260925 一层、地下层平面及地下室1-1、2-2剖面',
            'core_north_door_y': 26.525, 'door_leaf_x': [-2.4, -1.2, 0, 1.2, 2.4],
            'terrace': TERRACE_Z, 'core_upper': CORE_Z, 'core_lower': CORE_B1_Z, 'court_bottom': COURT_Z,
            'upper_risers': 12, 'lower_risers': 8, 'riser': .15, 'going': .3, 'bridge_clear_width': 8.8,
            'door_height_note': '该内庭立面未标门高，暂沿用3米门高；门洞位置、宽度和分扇按CAD。',
        },
        'frame': 'centre local metres, origin main axis × SA; glTF x = X, y = Z, z = -Y',
        'levels': {'grade': GRADE, 'main_eave': 7.10, 'main_flat': 10.95, 'main_ridge': 11.54, 'wing_waist_eave': 5.40,
                   'wing_eave': 8.18, 'wing_flat': 10.53, 'wing_ridge': 10.98, 'core_eave': 6.95, 'core_ridge': 11.54,
                   'stair_tower_eave': 5.165, 'mgmt_eave': 6.45, 'mgmt_ridge': 8.87, 'service_hall_ridge': 10.83},
        'storeys': {'B1': FLOORS['levels']['B1']['floor'], 'core_hall_lower': FLOORS['core_lower'][4], 'F1': 0.0,
                    'F2': FLOORS['levels']['F2']['floor']},
        'meshes': len(objs), 'meshes_per_level': per_level, 'interiors': interior_counts,
        'zones': {lv: len(z) for lv, z in zones_by_level.items()},
        'v2_site_meshes': len(site), 'trees': len(old_trees),
        'triangles': sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs),
    }
    OUT_BLEND.parent.mkdir(parents=True, exist_ok=True)
    (WORK / 'blender/build-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs + site: o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(OUT_GLB), export_format='GLB', use_selection=True, export_extras=True,
                              export_apply=True, export_animations=False, export_cameras=False, export_lights=False,
                              export_image_format='JPEG', export_jpeg_quality=85)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT_BLEND))
    report['glb_bytes'] = OUT_GLB.stat().st_size
    print(json.dumps(report, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    main()
