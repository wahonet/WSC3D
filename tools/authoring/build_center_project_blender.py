"""Blender 5.2: companion model of the 武氏祠汉文化保护传承中心 project module.

Run: blender --background --factory-startup --python tools/authoring/build_center_project_blender.py

Inputs
  resources/authoring/heritage-center/cad-20260925/disciplines.json (tools/authoring/extract_center_disciplines.py)
  resources/authoring/heritage-center/cad-20260925/floors.json      (storey levels)
  resources/scenes/models/courtyard-architecture-20260910.glb       (the shrine, reduced to a massing model)
Output
  resources/scenes/models/hanwenhua-center-project-20260927.glb and an editable .blend

Same frame as hanwenhua-center-20260925.glb (centre local metres, glTF x = X, y = Z, z = -Y), so the
module loads both at the origin. Every mesh carries center_role:
  landscape  planted areas, paving, shrub masses and trees by species inside the 用地红线 (景观施工图)
  structure  columns, beams and basement walls per storey (结构施工图)
  mep        ducts, air-conditioning units and pipes per storey, with center_system (暖通 / 给排水施工图)
  massing    the Wushi Shrine courtyard as a plain massing model (院落建筑模型, moved into the centre frame)
  yard       the shrine courtyard's lawn and brick paving, which the surroundings model leaves open
and center_level (B1 / F1 / F2 / site) like the main model. The ground itself comes from the main
model's V2 site and the courtyard's surroundings model, as in the courtyard scene.
"""
import bpy, bmesh, math, json, random, sys
from pathlib import Path
from mathutils import Vector, Matrix

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_center_blender as B

ROOT = B.ROOT
WORK = B.WORK
DISC = json.loads((WORK / 'cad-20260925/disciplines.json').read_text(encoding='utf-8'))
PLACEMENT = json.loads((ROOT / 'resources/georeferencing/hanwenhua-center-placement.json').read_text(encoding='utf-8'))
COURTYARD = ROOT / 'resources/scenes/models/courtyard-architecture-20260910.glb'
OUT_GLB = ROOT / 'resources/scenes/models/hanwenhua-center-project-20260927.glb'
OUT_BLEND = WORK / 'blender/传承中心项目_景观结构机电_20260927.blend'
random.seed(20260927)

GRADE = B.GRADE
LEVELS = B.FLOORS['levels']
B1_FLOOR, F2_FLOOR = LEVELS['B1']['floor'], LEVELS['F2']['floor']
KX0, KY0, KX1, KY1, KZ = B.FLOORS['core_lower']
# courtyard floors up to this height (scene metres) are ground, not plinths or wall copings
YARD_TOP = 0.15

# storey structure: (column foot, column / beam top, beam depth)
STRUCT = {'B1': (B1_FLOOR, -0.3, 0.6), 'F1': (0.0, 5.2, 0.65), 'F2': (F2_FLOOR, 7.8, 0.6)}
# services hang under the beams of each storey: system -> (bottom, height) below the beam soffit
HANG = {'supply': (-0.95, 0.4), 'exhaust': (-0.95, 0.4), 'smoke': (-0.9, 0.42), 'ac': (-0.6, 0.22),
        'sprinkler': (-0.16, 0.08), 'water': (-1.1, 0.1), 'drain': (-1.2, 0.12), 'rain': (-1.1, 0.12)}
SYSTEM_RGB = {'supply': (51, 154, 240), 'exhaust': (148, 216, 45), 'smoke': (247, 103, 7), 'ac': (21, 170, 191),
              'water': (47, 158, 68), 'drain': (160, 82, 45), 'rain': (92, 124, 250), 'sprinkler': (224, 49, 49)}

# species -> (form, leaf material, height per crown radius, minimum height)
SPECIES = {
    '油松': ('pine', 'pine', 2.2, 5.0), '白皮松': ('pine', 'pine', 2.1, 5.0), '云杉': ('spruce', 'spruce', 3.2, 5.5),
    '高杆圆柏': ('column', 'juniper', 4.2, 5.0), '龙柏': ('column', 'juniper', 3.6, 4.0), '圆柏': ('column', 'juniper', 3.6, 4.0),
    '竹': ('bamboo', 'bamboo', 5.0, 5.5),
    '樱桃': ('round', 'blossom_pink', 1.7, 4.0), '杏树': ('round', 'blossom_pink', 1.7, 4.0), '梨树': ('round', 'blossom_white', 1.7, 4.5),
    '玉兰': ('round', 'blossom_white', 1.9, 5.0), '海棠': ('round', 'blossom_pink', 1.7, 4.0),
    '鸡爪槭': ('round', 'maple', 1.5, 3.5), '黄连木': ('round', 'autumn', 1.8, 6.0), '栾树': ('round', 'autumn', 1.8, 6.5),
    '大叶女贞': ('round', 'leaf0', 1.8, 5.0),
}


def material(key, name, rgb, rough=0.85, metal=0.0, tex=None, uv=2.0):
    B.material(key, name, rgb, rough, tex=tex, metal=metal)
    B.UVSCALE[key] = uv


def define_materials():
    B.define_materials()
    material('ground', '场地硬质铺装', (205, 199, 188), 0.92)
    material('plaza', '景观石材铺装', (255, 255, 255), 0.9, tex='paving', uv=4.8)
    material('green', '景观绿地', (122, 150, 88), 0.95)
    material('shrub', '灌木色块', (70, 112, 62), 0.92)
    material('yard_paving', '武氏祠院落铺地', (184, 181, 172), 0.95)
    material('pine', '松类针叶', (58, 88, 60), 0.9)
    material('spruce', '云杉针叶', (46, 76, 62), 0.9)
    material('juniper', '圆柏针叶', (64, 92, 58), 0.9)
    material('bamboo', '竹丛', (122, 156, 84), 0.9)
    material('blossom_pink', '春花乔木_粉', (226, 170, 182), 0.9)
    material('blossom_white', '春花乔木_白', (232, 226, 210), 0.9)
    material('maple', '鸡爪槭', (176, 72, 52), 0.9)
    material('autumn', '秋色叶乔木', (196, 150, 66), 0.9)
    material('st_column', '结构柱', (92, 101, 112), 0.8)
    material('st_beam', '结构梁', (154, 164, 174), 0.8)
    material('st_wall', '地下室外墙', (122, 131, 140), 0.85)
    for key, rgb in SYSTEM_RGB.items():
        material(f'mep_{key}', f"机电_{DISC['mep']['systems'][key]}", rgb, 0.5, 0.25)
    material('clay', '武氏祠白模', (233, 228, 218), 0.9)


# ---------------------------------------------------------------- light-weight vegetation
ICO1 = None
def blob(group, mat, x, y, z, rx, rz):
    global ICO1
    if ICO1 is None:
        bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.0)
        ICO1 = ([tuple(v.co) for v in bm.verts], [[v.index for v in f.verts] for f in bm.faces]); bm.free()
    verts, faces = ICO1
    jit = [(vx * random.uniform(0.88, 1.08), vy * random.uniform(0.88, 1.08), vz * random.uniform(0.85, 1.05)) for vx, vy, vz in verts]
    for f in faces:
        B.add_face(group, mat, [(x + jit[i][0] * rx, y + jit[i][1] * rx, z + jit[i][2] * rz) for i in f], [(0, 0), (1, 0), (0.5, 1)])

def cone(group, mat, x, y, z0, r, h, sides=8):
    top = (x, y, z0 + h)
    ring = [(x + r * math.cos(k * math.tau / sides), y + r * math.sin(k * math.tau / sides), z0) for k in range(sides)]
    for k in range(sides):
        B.add_face(group, mat, [ring[k], ring[(k + 1) % sides], top], [(0, 0), (1, 0), (0.5, 1)])
    B.add_face(group, mat, ring[::-1])

def trunk(group, x, y, z, h, r=0.14):
    B.frustum(group, 'bark', x, y, z, 2 * r, 2 * r, r, r, h, top=False)

def plant(t):
    x, y = t['p']; r = max(0.8, t['r'])
    form, leaf, k, hmin = SPECIES.get(t['species'], ('round', random.choice(['leaf0', 'leaf1', 'leaf2', 'leaf3']), 1.8, 4.5))
    h = max(hmin, k * r) * random.uniform(0.92, 1.08)
    g = '20_景观乔木'
    z = GRADE
    if form == 'pine':
        trunk(g, x, y, z, h * 0.55)
        for i, (dz, rr) in enumerate(((0.5, 1.0), (0.68, 0.8), (0.84, 0.55))):
            a = random.uniform(0, math.tau); d = r * 0.18
            blob(g, leaf, x + math.cos(a) * d, y + math.sin(a) * d, z + h * dz, r * rr, r * 0.32)
    elif form == 'spruce':
        trunk(g, x, y, z, h * 0.2, 0.12)
        cone(g, leaf, x, y, z + h * 0.12, r, h * 0.62)
        cone(g, leaf, x, y, z + h * 0.45, r * 0.72, h * 0.55)
    elif form == 'column':
        trunk(g, x, y, z, h * 0.15, 0.1)
        blob(g, leaf, x, y, z + h * 0.52, r * 0.85, h * 0.46)
    elif form == 'bamboo':
        for _ in range(5):
            a = random.uniform(0, math.tau); d = random.uniform(0, r * 0.45)
            cx, cy = x + math.cos(a) * d, y + math.sin(a) * d
            B.frustum(g, 'bamboo', cx, cy, z, 0.07, 0.07, 0.04, 0.04, h * random.uniform(0.8, 1.0), top=False)
        blob(g, leaf, x, y, z + h * 0.72, r * 0.8, h * 0.3)
    else:
        trunk(g, x, y, z, h * 0.45)
        blob(g, leaf, x, y, z + h * 0.62, r, h * 0.3)
        for k in range(2):
            a = random.uniform(0, math.tau); d = r * 0.42
            blob(g, leaf, x + math.cos(a) * d, y + math.sin(a) * d, z + h * random.uniform(0.5, 0.7), r * 0.62, h * 0.22)


def landscape():
    land = DISC['landscape']
    # just proud of the V2 site ground they are laid over
    with B.at('site'):
        for loops in land['green']:
            B.polygon_top('20_景观绿地', 'green', loops[0], GRADE + 0.08, True, holes=loops[1:])
        for loop in land['paving']:
            B.polygon_top('20_景观铺装', 'plaza', loop, GRADE + 0.06, True)
        for loop in land['shrubs']:
            B.prism('20_景观灌木', 'shrub', loop, GRADE, GRADE + 0.75, top_mat='shrub')
        for t in land['trees']:
            plant(t)
    return {'green': len(land['green']), 'paving': len(land['paving']), 'shrubs': len(land['shrubs']),
            'trees': len(land['trees'])}


# ---------------------------------------------------------------- structure and services
def foot(level, x, y):
    if level == 'B1' and KX0 <= x <= KX1 and KY0 <= y <= KY1: return KZ
    return STRUCT[level][0]

def structure():
    s = DISC['structure']; n = {}
    for level in ('B1', 'F1', 'F2'):
        z0, top, depth = STRUCT[level]
        with B.at(level):
            # slightly larger than the architectural members they coincide with, so they read in colour
            for x0, y0, x1, y1 in s['columns'][level]:
                cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
                zf = foot(level, cx, cy)
                B.box('21_结构柱', 'st_column', cx, cy, zf, x1 - x0 + 0.04, y1 - y0 + 0.04, top - zf)
            for x0, y0, x1, y1, w in s['beams'][level]:
                B.box('21_结构梁', 'st_beam', (x0 + x1) / 2, (y0 + y1) / 2, top - depth, math.hypot(x1 - x0, y1 - y0), w,
                      depth, math.atan2(y1 - y0, x1 - x0), bottom=True)
            if level == 'B1':
                for x0, y0, x1, y1, t in s['basement_walls']:
                    zf = foot(level, (x0 + x1) / 2, (y0 + y1) / 2)
                    B.box('21_地下室外墙', 'st_wall', (x0 + x1) / 2, (y0 + y1) / 2, zf, math.hypot(x1 - x0, y1 - y0) + 0.04,
                          t + 0.04, top - zf, math.atan2(y1 - y0, x1 - x0))
        n[level] = {'columns': len(s['columns'][level]), 'beams': len(s['beams'][level])}
    n['basement_walls'] = len(s['basement_walls'])
    return n

def services():
    n = {}
    for level, runs in DISC['mep']['runs'].items():
        z0, top, depth = STRUCT[level]
        soffit = top - depth
        with B.at(level):
            for key, rects in runs.items():
                dz, h = HANG[key]
                for x0, y0, x1, y1 in rects:
                    B.box(f'22_机电_{key}', f'mep_{key}', (x0 + x1) / 2, (y0 + y1) / 2, soffit + dz, x1 - x0, y1 - y0, h, bottom=True)
                n[f'{level}_{key}'] = len(rects)
    return n


# ---------------------------------------------------------------- the shrine as a massing model
def shrine_massing():
    """Courtyard buildings, gates and walls moved into the centre frame, remeshed and reduced to a clay model."""
    t = PLACEMENT['transform']
    theta = math.radians(t['rotationYDeg'])
    # scene (glTF, courtyard) = Ry(theta) · centre + translation; Blender Z-up: y = -z
    move = Matrix.Rotation(-theta, 4, 'Z') @ Matrix.Translation((-t['translation'][0], t['translation'][2], -t['translation'][1]))
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(COURTYARD))
    new = [o for o in bpy.data.objects if o not in before]
    bpy.context.view_layer.update()
    groups, yard = {}, {'green': [], 'yard_paving': []}
    for o in new:
        b = o.get('building', '')
        if o.type != 'MESH' or not b[:2].isdigit() or b.startswith('10_'):
            continue
        if o.get('arch_role') == 'floor' and b.startswith('09_'):
            mat = o.active_material.name if o.active_material else ''
            top = max((o.matrix_world @ Vector(c)).z for c in o.bound_box)
            # the courtyard's 1.6 km neutral plane stays behind; the module has its own plinth
            if '场外' not in mat and top <= YARD_TOP:
                yard['green' if 'lawn' in mat else 'yard_paving'].append(o)
            continue
        groups.setdefault(b, []).append(o)
    out = []
    for key, objs in yard.items():
        if not objs: continue
        bm = bmesh.new()
        for o in objs:
            m = o.data.copy(); m.transform(move @ o.matrix_world)
            bm.from_mesh(m); bpy.data.meshes.remove(m)
        me = bpy.data.meshes.new(f'23_武氏祠院落地面_{key}'); bm.to_mesh(me); bm.free()
        me.materials.clear(); me.materials.append(B.MATS[key])
        ob = bpy.data.objects.new(me.name, me); bpy.context.scene.collection.objects.link(ob)
        ob['building'] = '23_武氏祠院落地面'; ob['center_level'] = 'site'; ob['center_role'] = 'yard'; ob['shrine_part'] = '09_院落地面'
        out.append(ob)
    for b, objs in sorted(groups.items()):
        bm = bmesh.new()
        for o in objs:
            m = o.data.copy(); m.transform(move @ o.matrix_world)
            bm.from_mesh(m); bpy.data.meshes.remove(m)
        me = bpy.data.meshes.new(f'23_武氏祠白模_{b}'); bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new(me.name, me); bpy.context.scene.collection.objects.link(ob)
        bpy.context.view_layer.objects.active = ob
        # a watertight shell at 0.3 m keeps roofs, walls and gates readable at a fraction of the tile geometry
        rm = ob.modifiers.new('remesh', 'REMESH'); rm.mode = 'VOXEL'; rm.voxel_size = 0.3 if not b.startswith('09_') else 0.2
        dec = ob.modifiers.new('decimate', 'DECIMATE'); dec.ratio = 0.12
        bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True)
        bpy.ops.object.modifier_apply(modifier='remesh'); bpy.ops.object.modifier_apply(modifier='decimate')
        me.materials.clear(); me.materials.append(B.MATS['clay'])
        for p in me.polygons: p.use_smooth = False
        ob['building'] = '23_武氏祠白模'; ob['center_level'] = 'site'; ob['center_role'] = 'massing'; ob['shrine_part'] = b
        out.append(ob)
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    return out


# ---------------------------------------------------------------- flush
def role(group):
    if group.startswith('20_'): return 'landscape'
    if group.startswith('21_'): return 'structure'
    if group.startswith('22_'): return 'mep'
    return 'massing'

def flush():
    objs = []
    for (group, level, mat), (vs, fs, us) in sorted(B.BUF.items()):
        if not fs: continue
        name = f'{group}_{level}_{mat}'
        me = bpy.data.meshes.new(name); me.from_pydata(vs, [], fs); me.update()
        uv = me.uv_layers.new(name='UVMap')
        for poly, coords in zip(me.polygons, us):
            for li, c in zip(poly.loop_indices, coords): uv.data[li].uv = c
        me.materials.append(B.MATS[mat])
        ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
        ob['building'] = group; ob['center_level'] = level; ob['center_role'] = role(group)
        if group.startswith('22_机电_'): ob['center_system'] = group[len('22_机电_'):]
        bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005); bm.to_mesh(me); bm.free()
        smooth = mat in ('pine', 'spruce', 'juniper', 'bamboo', 'blossom_pink', 'blossom_white', 'maple', 'autumn') or mat.startswith('leaf')
        for p in me.polygons: p.use_smooth = smooth
        objs.append(ob)
    return objs


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.name = '武氏祠汉文化保护传承中心项目_景观结构机电'
    define_materials()
    massing = shrine_massing()
    counts = {'landscape': landscape(), 'structure': structure(), 'mep': services()}
    objs = flush() + massing
    report = {'source': DISC['source'], 'frame': 'centre local metres; glTF x = X, y = Z, z = -Y', 'counts': counts,
              'massing_parts': [o['shrine_part'] for o in massing], 'meshes': len(objs),
              'triangles': sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)}
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(OUT_GLB), export_format='GLB', use_selection=True, export_extras=True,
                              export_apply=True, export_animations=False, export_cameras=False, export_lights=False,
                              export_image_format='JPEG', export_jpeg_quality=85)
    OUT_BLEND.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT_BLEND))
    report['glb_bytes'] = OUT_GLB.stat().st_size
    (WORK / 'blender/project-build-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
