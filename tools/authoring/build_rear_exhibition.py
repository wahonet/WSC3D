"""Blender: photo-referenced rear exhibition, with authentic niche scans.

Run: blender --background --python tools/authoring/build_rear_exhibition.py
The GLB uses rear-hall local metres; the editable Blend includes all 46 exhibits.
"""
import importlib.util
import json
import math
from pathlib import Path
import random
import sys
import bpy
from mathutils import Matrix, Vector

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'resources/authoring/rear-hall'
PUBLIC = ROOT / 'resources/scenes/models'
PUBLIC.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
interior = bpy.data.collections.new('后展厅_展陈装修')
stones_col = bpy.data.collections.new('后展厅_46件石刻')
lights_col = bpy.data.collections.new('后展厅_展柜照明')
for col in [interior, stones_col, lights_col]: scene.collection.children.link(col)
random.seed(910)


def material(name, color, roughness=.7, alpha=1):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, alpha)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Alpha'].default_value = alpha
    if alpha < 1:
        mat.surface_render_method = 'DITHERED'
        bsdf.inputs['IOR'].default_value = 1.45
    return mat


red = material('展墙_朱红', (.40, .052, .027), .87)
black = material('展柜_黑色烤漆', (.013, .015, .017), .42)
ceiling = material('顶棚_炭黑', (.027, .026, .024), .91)
white = material('展台_暖白', (.73, .72, .68), .85)
glass = material('展柜_透明玻璃', (.72, .86, .88), .16, .025)
led = material('展柜_灯珠', (.92, .89, .77), .3)
led.node_tree.nodes.get('Principled BSDF').inputs['Emission Color'].default_value = (1, .92, .77, 1)
led.node_tree.nodes.get('Principled BSDF').inputs['Emission Strength'].default_value = 3
tile_mats = [material(f'地砖_{i}', (.095+i*.005, .087+i*.0045, .073+i*.004), .73) for i in range(6)]
pebble_mats = [material(f'展床碎石_{i}', (.035+i*.014, .04+i*.014, .041+i*.014), .92) for i in range(5)]


def box(name, position, size, mat, role='furniture', collection=interior):
    x, y, z = position  # Three coordinates: X / height / Z
    w, h, d = size
    verts = [(sx*w/2, -sz*d/2, sy*h/2) for sx, sy, sz in
             [(-1,-1,-1),(-1,-1,1),(-1,1,-1),(-1,1,1),(1,-1,-1),(1,-1,1),(1,1,-1),(1,1,1)]]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], [tuple(reversed(face)) for face in
                               [(0,4,6,2),(1,3,7,5),(0,1,5,4),(2,6,7,3),(0,2,3,1),(4,5,7,6)]])
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.location = (x, -z, y)
    obj['rear_role'] = role
    obj['showcase'] = role in ['furniture', 'glass', 'case_top']
    return obj


def spot(name, position, target, energy=55, angle=70):
    data = bpy.data.lights.new(name, 'SPOT')
    data.energy = energy
    data.color = (1, .93, .81)
    data.spot_size = math.radians(angle)
    data.spot_blend = .65
    data.shadow_soft_size = .075
    obj = bpy.data.objects.new(name, data)
    lights_col.objects.link(obj)
    obj.location = (position[0], -position[2], position[1])
    obj.rotation_euler = (Vector((target[0], -target[2], target[1]))-obj.location).to_track_quat('-Z','Y').to_euler()


def pebbles(name, cx, cz, w, d):
    verts, faces, mids = [], [], []
    for _ in range(int(w*d*650)):
        x, z = cx+random.uniform(-w/2+.03,w/2-.03), cz+random.uniform(-d/2+.03,d/2-.03)
        r = random.uniform(.006,.013)
        start = len(verts)
        verts.extend([(x+r,-z,.805),(x,-z+r,.803),(x-r,-z,.806),(x,-z-r,.804),(x,-z,.815+r*.4)])
        faces.extend([(start+i,start+(i+1)%4,start+4) for i in range(4)])
        mids.extend([random.randrange(5)]*4)
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    for mat in pebble_mats: mesh.materials.append(mat)
    for p, mid in zip(mesh.polygons,mids): p.material_index = mid
    obj = bpy.data.objects.new(name,mesh);interior.objects.link(obj)
    obj['rear_role']='furniture';obj['showcase']=True


def case(name, x, z, w, d, height=3.75, backed=False):
    box(name+'_黑色底座',(x,.55,z),(w,.5,d),black)
    box(name+'_顶框',(x,height+.3,z),(w,.18,d),black,'case_top')
    gh = height-.59
    for side in [-1,1]:
        obj=box(name+'_长面玻璃',(x,.80+gh/2,z+side*(d/2-.012)),(w-.03,gh,.008),glass,'glass')
        obj.visible_shadow=False
        obj=box(name+'_端面玻璃',(x+side*(w/2-.012),.80+gh/2,z),(.008,gh,d-.03),glass,'glass')
        obj.visible_shadow=False
        for other in [-1,1]:
            box(name+'_细立框',(x+side*(w/2-.018),.80+gh/2,z+other*(d/2-.018)),(.018,gh,.018),black)
    pebbles(name+'_碎石展床',x,z,w,d)
    along_z = d>w
    length = max(w,d)
    n = max(3,math.ceil(length/1.25))
    for i in range(n):
        u = (i+.5)/n*length-length/2
        px,pz = (x,z+u) if along_z else (x+u,z)
        box(name+'_照明灯珠',(px,height+.18,pz),(.045,.018,.055),led,'case_top')
        spot(name+'_展品射灯',(px,height+.13,pz),(px,.9,pz),80 if backed else 45,85)


# Internal opaque lining conceals the architectural windows; only the two doorways remain open.
for side in [-1,1]:
    for end in [-1,1]:
        box('檐墙红色展衬',(side*5.225,2.39,end*5.785),(.09,4.18,8.41),red,'wall')
    box('门洞上方展衬',(side*5.225,3.96,0),(.09,1.04,3.16),red,'wall')
    box('山墙红色展衬',(0,2.39,side*9.98),(10.49,4.18,.09),red,'wall')
box('封闭黑色吊顶',(0,4.51,0),(10.52,.15,20.06),ceiling,'ceiling')
for z in [-6.65,0,6.65]:box('顶棚横梁',(0,4.36,z),(10.5,.19,.30),ceiling,'ceiling')
box('室内地坪',(0,.303,0),(10.5,.022,20.06),black,'floor')
for i in range(13):
    for j in range(25):
        box('灰色方砖',(-4.8+i*.8,.325,-9.6+j*.8),(.794,.035,.794),random.choice(tile_mats),'floor')
for side in [-1,1]:
    for end in [-1,1]:case(f'沿墙展柜_{side}_{end}',side*4.52,end*5.70,1.36,7.84,3.75,True)
    case(f'山墙展柜_{side}',0,side*9.50,9.94,.96,3.75,True)
case('中央南展柜',0,5,1.55,4.35,2.7)
case('中央综合展柜',0,0,2.85,2.95,2.7)
case('中央北展柜',0,-5,1.55,4.35,2.7)


def export_glb(path, objects):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects: obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,
                              export_extras=True,export_lights=False,export_cameras=False,
                              export_image_format='AUTO')


export_glb(PUBLIC/'rear-exhibition-20260910.glb',list(interior.objects))

# Use the archive's measured scan surface instead of inventing the two damaged outlines.
scan_objects={}
report={'scans':[], 'interior_objects':len(interior.objects)}
for number, legacy in [('023','16 前石室后壁小龛西壁'),('024','17 前石室后壁小龛东壁')]:
    source=next((stone_file(legacy, 'model')).glob('*.gltf'))
    before=set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(source))
    mesh=next(o for o in set(bpy.data.objects)-before if o.type=='MESH')
    bpy.context.view_layer.objects.active=mesh
    bpy.ops.object.select_all(action='DESELECT');mesh.select_set(True)
    bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
    coords=[v.co for v in mesh.data.vertices]
    low=Vector(tuple(min(v[i] for v in coords) for i in range(3)))
    high=Vector(tuple(max(v[i] for v in coords) for i in range(3)))
    factor=.7/(high.z-low.z)
    center=(low+high)*.5
    for vertex in mesh.data.vertices: vertex.co=(vertex.co-center)*factor
    mesh.location=(0,0,0)
    initial=len(mesh.data.polygons)
    mod=mesh.modifiers.new('保留真实轮廓的展览简模','DECIMATE')
    mod.ratio=min(1,18000/initial)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    for mat in mesh.data.materials:
        mat.name='小龛原始扫描纹理_'+number
        for node in mat.node_tree.nodes:
            if node.type=='TEX_IMAGE' and node.image:
                im=node.image
                if max(im.size)>2048:
                    ratio=2048/max(im.size);im.scale(int(im.size[0]*ratio),int(im.size[1]*ratio))
                im.pack()
    mesh.name='小龛真实扫描_'+number
    mesh['scan_catalogue_no']='武'+number
    for col in list(mesh.users_collection):col.objects.unlink(mesh)
    stones_col.objects.link(mesh)
    export_glb(PUBLIC/f'rear-niche-{number}.glb',[mesh])
    scan_objects['武'+number]=mesh
    report['scans'].append(dict(id='武'+number,source=str(source.relative_to(ROOT)),
                                triangles_before=initial,triangles_after=len(mesh.data.polygons),
                                height_m=.7))

# Import the latest shared web exhibit meshes and images when the snapshot is available.
snapshot=OUT/'scene/scene.json'
if snapshot.exists():
    spec=importlib.util.spec_from_file_location('shared_scene',ROOT / 'tools/authoring/build_blender_scene.py')
    shared=importlib.util.module_from_spec(spec);spec.loader.exec_module(shared)
    shared.SCENE_FILE=snapshot;shared.PREFIX='后展厅_'
    payload=json.loads(snapshot.read_text(encoding='utf-8'))
    geo={r['id']:r for r in payload['geometries']}
    mats={r['id']:r for r in payload['materials']}
    textures={r['id']:r for r in payload['textures']}
    catalogue=json.loads((ROOT / 'src/frontend/src/archive/three/catalogueMap.json').read_text(encoding='utf-8'))
    identity={r['legacy_id']:r['catalogue_no'] for r in catalogue['items']}
    layout_file=ROOT/'data/layouts/rear.json'
    if not layout_file.exists():layout_file=ROOT/'data/layouts/rear-default.json'
    layout=json.loads(layout_file.read_text(encoding='utf-8'))['stones']
    layout={r['id']:r for r in layout}
    cache={};mat_cache={}
    records=[r for r in payload['objects'] if r.get('hps',{} ) and r['hps'].get('face')=='IN' and r.get('geometryId') and r['visible']]
    anchors={r['hps']['id']:r for r in records if not r['userData'].get('isStoneTexture')}
    def m4(values):return Matrix([values[i:i+4] for i in range(0,16,4)]).transposed()
    for record in records:
        sid=identity.get(record['hps']['id'])
        if sid not in layout or sid in scan_objects:continue
        row=layout[sid]
        anchor=m4(anchors[record['hps']['id']]['matrixWorld'])
        local=anchor.inverted()@m4(record['matrixWorld'])
        from mathutils import Euler
        transform=Matrix.Translation(Vector((row['x'],row['y'],row['z']))) @ Euler((row['rx'],row['ry'],row['rz']),'XYZ').to_matrix().to_4x4()
        # Three Euler XYZ is intrinsic (Rx*Ry*Rz); Blender Euler is extrinsic.
        transform=Matrix.Translation(Vector((row['x'],row['y'],row['z']))) @ Matrix.Rotation(row['rx'],4,'X') @ Matrix.Rotation(row['ry'],4,'Y') @ Matrix.Rotation(row['rz'],4,'Z')
        for mid in record['materialIds']:
            if mid not in mat_cache:mat_cache[mid]=shared.make_material(mats[mid],textures,cache)
        mesh=shared.make_mesh(geo[record['geometryId']],record['materialIds'],mat_cache)
        obj=bpy.data.objects.new(record['name'],mesh);stones_col.objects.link(obj)
        obj.matrix_world=shared.C@transform@local
        obj['stone_id']=sid
        if record['userData'].get('isStoneTexture'):
            obj.visible_shadow=False
            # Avoid coplanar ray artifacts in Cycles, preserving the existing face UV.
            normal=record['userData'].get('stoneTexture',{}).get('normal',[0,0,1])
            obj.location += (shared.C@transform).to_3x3()@Vector(normal)*.0015
    for sid,mesh in scan_objects.items():
        row=layout[sid]
        c=shared.C
        transform=Matrix.Translation(Vector((row['x'],row['y'],row['z']))) @ Matrix.Rotation(row['rx'],4,'X') @ Matrix.Rotation(row['ry'],4,'Y') @ Matrix.Rotation(row['rz'],4,'Z')
        mesh.matrix_world=c@transform@c.inverted()
        mesh['stone_id']=sid
    bpy.context.view_layer.update()
    stone_bounds={}
    for sid,row in layout.items():
        objs=[o for o in stones_col.objects if o.get('stone_id')==sid]
        bounds=[o.matrix_world@Vector(v) for o in objs for v in o.bound_box]
        low=[min(v[i] for v in bounds) for i in range(3)]
        high=[max(v[i] for v in bounds) for i in range(3)]
        stone_bounds[sid]=(low,high)
    for sid,(low,high) in stone_bounds.items():
        bottom=low[2]
        if bottom>.83:
            lower=any(other!=sid and a[2]<bottom-.15 and b[2]<=bottom+.03 and b[0]>low[0] and a[0]<high[0] and b[1]>low[1] and a[1]<high[1] for other,(a,b) in stone_bounds.items())
            height=.07 if lower else bottom-.802
            box('白色托台_'+sid,((low[0]+high[0])/2,bottom-height/2,-(low[1]+high[1])/2),
                (high[0]-low[0]+.015,height,high[1]-low[1]+.015),white,collection=stones_col)
    report['niche_clearance_m']={}
    for sid in scan_objects:
        low,high=stone_bounds[sid]
        report['niche_clearance_m'][sid]={'front_glass':round(low[0]-3.852,4),'back_panel':round(5.18-high[0],4)}
        assert low[0]>3.902 and high[0]<5.16, ('Niche clearance',sid,low,high)
    report['stone_count']=len({o.get('stone_id') for o in stones_col.objects if o.get('stone_id')})
    assert report['stone_count']==46

# Thin clear glass for Cycles; its exported web counterpart keeps the same low opacity.
nodes,links=glass.node_tree.nodes,glass.node_tree.links
bsdf=nodes.new('ShaderNodeBsdfGlossy');bsdf.inputs['Color'].default_value=(1,1,1,1);bsdf.inputs['Roughness'].default_value=.025
transparent=nodes.new('ShaderNodeBsdfTransparent')
fresnel=nodes.new('ShaderNodeFresnel');fresnel.inputs['IOR'].default_value=1.45
multiply=nodes.new('ShaderNodeMath');multiply.operation='MULTIPLY';multiply.inputs[1].default_value=.12
links.new(fresnel.outputs[0],multiply.inputs[0])
mix=nodes.new('ShaderNodeMixShader');links.new(multiply.outputs[0],mix.inputs[0]);links.new(transparent.outputs[0],mix.inputs[1]);links.new(bsdf.outputs[0],mix.inputs[2])
links.new(mix.outputs[0],nodes.get('Material Output').inputs['Surface'])
for mat in tile_mats:
    nodes,links=mat.node_tree.nodes,mat.node_tree.links
    noise=nodes.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=14;noise.inputs['Detail'].default_value=3
    bump=nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.28;bump.inputs['Distance'].default_value=.015
    links.new(noise.outputs['Fac'],bump.inputs['Height']);links.new(bump.outputs['Normal'],nodes.get('Principled BSDF').inputs['Normal'])

world=bpy.data.worlds.new('暗色展厅环境');scene.world=world;world.use_nodes=True
world.node_tree.nodes.get('Background').inputs[0].default_value=(.11,.13,.16,1)
world.node_tree.nodes.get('Background').inputs[1].default_value=.22
# Soft reflected room fill, with the visible highlights coming from the case spots.
for z in [-6,0,6]:
    data=bpy.data.lights.new('室内柔光','AREA');data.energy=200;data.shape='DISK';data.size=5
    data.specular_factor=0
    obj=bpy.data.objects.new('室内柔光',data);lights_col.objects.link(obj);obj.location=(0,-z,4.2)
    obj.visible_glossy=False
scene.render.engine='CYCLES';scene.cycles.samples=40;scene.cycles.use_denoising=True
try:
    prefs=bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type='OPTIX';prefs.get_devices()
    for device in prefs.devices:device.use=device.type!='CPU'
    scene.cycles.device='GPU'
except Exception:pass
scene.render.resolution_x=1500;scene.render.resolution_y=1050;scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX';scene.view_settings.look='AgX - Medium High Contrast'
scene.view_settings.exposure=.35
camera_data=bpy.data.cameras.new('展厅核对相机');camera=bpy.data.objects.new('展厅核对相机',camera_data)
scene.collection.objects.link(camera);scene.camera=camera;camera_data.lens=22
scene['reference_photos']=str(OUT/'references')
scene['layout_source']='data/layouts/rear.json (fallback: rear-default.json)'
scene['reconstruction_note']='展陈按四张现场照片补建；文物位置仍可在摆放工具中校正。小龛使用原始扫描。'
views=[('01_后展厅_中央展柜',(-3.2,2.02,-3.1),(.9,1.6,5.7)),
       ('02_后展厅_小龛与红色展墙',(1.7,1.72,-1.0),(4.54,1.6,-5.0))]
for name,pos,target in views:
    camera.location=(pos[0],-pos[2],pos[1]);camera.rotation_euler=(Vector((target[0],-target[2],target[1]))-camera.location).to_track_quat('-Z','Y').to_euler()
    scene.render.filepath=str(OUT/(name+'.png'))
    bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'后展厅_展陈与石刻.blend'))
(OUT/'blender-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print('REAR_EXHIBITION_COMPLETE',report)
