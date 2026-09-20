"""Build a separate Cycles photography scene from the current application assets.

blender --background --factory-startup --python tools/authoring/build_fine_renders.py -- --build --preview
blender --background --python tools/authoring/build_fine_renders.py -- --render 01 02 ...
Only resources/authoring/photography is written; live assets and layouts remain intact.
"""
import bpy
import json
import math
import sys
import time
import importlib.util
import random
import struct
from pathlib import Path
from mathutils import Matrix, Vector

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'resources/authoring/photography'
BLEND = OUT / 'blender/武氏祠_三馆精细摄影.blend'
for folder in ['blender', 'previews', 'renders', 'jpg']:
    (OUT / folder).mkdir(parents=True, exist_ok=True)
args = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
C = Matrix(((1,0,0,0),(0,0,-1,0),(0,1,0,0),(0,0,0,1)))
SQ = math.sqrt(.5)
GX, GZ = (423.1-687)*.17639, (124.6-314)*.17639

def world(a,b,h):
    return Vector((GX+SQ*(a-b), -GZ-SQ*(a+b), h))

def m4(v):
    return Matrix([v[i:i+4] for i in range(0,16,4)]).transposed()

def look_at(obj, target):
    obj.rotation_euler = (Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()

def relocate(obj, collection):
    for col in list(obj.users_collection):
        col.objects.unlink(obj)
    collection.objects.link(obj)

def import_glb(path, col, transform=None):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    new = set(bpy.data.objects)-before
    unused={o for o in new if any(c.name.startswith('Orphan Nodes') for c in o.users_collection)}
    for obj in unused:bpy.data.objects.remove(obj,do_unlink=True)
    new-=unused
    roots = [o for o in new if o.parent not in new]
    for obj in new: relocate(obj, col)
    if transform:
        for obj in roots: obj.matrix_world = transform @ obj.matrix_world
    bpy.context.view_layer.update()
    return list(new)

def clear_glass(material, amount=.35):
    nodes,links=material.node_tree.nodes,material.node_tree.links
    nodes.clear()
    output=nodes.new('ShaderNodeOutputMaterial')
    clear=nodes.new('ShaderNodeBsdfTransparent')
    reflection=nodes.new('ShaderNodeBsdfGlossy')
    reflection.inputs['Color'].default_value=(1,1,1,1)
    reflection.inputs['Roughness'].default_value=.035
    fresnel=nodes.new('ShaderNodeFresnel');fresnel.inputs['IOR'].default_value=1.46
    scale=nodes.new('ShaderNodeMath');scale.operation='MULTIPLY';scale.inputs[1].default_value=amount
    mix=nodes.new('ShaderNodeMixShader')
    links.new(fresnel.outputs[0],scale.inputs[0]);links.new(scale.outputs[0],mix.inputs[0])
    links.new(clear.outputs[0],mix.inputs[1]);links.new(reflection.outputs[0],mix.inputs[2])
    links.new(mix.outputs[0],output.inputs['Surface'])

def area(name, position, target, power, size, zone, color=(1,.95,.86)):
    data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size;data.color=color
    obj=bpy.data.objects.new(name,data);bpy.context.scene.collection.objects.link(obj)
    obj.location=position;look_at(obj,target);obj['light_zone']=zone
    obj.visible_glossy=False;data.specular_factor=0
    return obj

def install_rear_lights(scene, rear_matrix):
    # Appended objects need a depsgraph evaluation before matrix_world is read.
    # Otherwise all 58 lights acquire the hall origin instead of their local positions.
    for obj in list(scene.objects):
        if obj.type=='LIGHT' and obj.get('light_zone')=='rear':bpy.data.objects.remove(obj,do_unlink=True)
    with bpy.data.libraries.load(str(ROOT / 'resources/authoring/rear-hall/后展厅_展陈与石刻.blend'),link=False) as (src,dst):
        dst.collections=[name for name in src.collections if name=='后展厅_展柜照明']
    assert len(dst.collections)==1,'Missing reference case-light collection'
    col=dst.collections[0];scene.collection.children.link(col);col.hide_render=False
    bpy.context.view_layer.update()
    transforms={o:o.matrix_world.copy() for o in col.all_objects}
    for obj,transform in transforms.items():
        obj.matrix_world=rear_matrix@transform;obj['light_zone']='rear'
        if obj.type=='LIGHT':
            obj.visible_glossy=False;obj.data.specular_factor=0
            obj.data.energy=600 if obj.data.type=='AREA' else obj.data.energy*.8
    bpy.context.view_layer.update()
    assert all(o.matrix_world.translation.z>2 for o in col.all_objects if o.type=='LIGHT')
    scene['rear_lighting_revision']=2

def refine_photo_materials(scene):
    if scene.get('photo_finish_revision',0)>=1:return
    for mat in bpy.data.materials:
        if not mat.use_nodes:continue
        nodes,links=mat.node_tree.nodes,mat.node_tree.links
        bs=next((n for n in nodes if n.type=='BSDF_PRINCIPLED'),None)
        if mat.name.startswith('地砖_') and bs:
            noise=nodes.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=5
            noise.inputs['Detail'].default_value=7;noise.inputs['Roughness'].default_value=.72
            ramp=nodes.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].position=.2;ramp.color_ramp.elements[1].position=.8
            ramp.color_ramp.elements[0].color=(.014,.015,.014,1)
            ramp.color_ramp.elements[1].color=(.075,.070,.058,1)
            links.new(noise.outputs['Fac'],ramp.inputs['Fac']);links.new(ramp.outputs['Color'],bs.inputs['Base Color'])
            bs.inputs['Roughness'].default_value=.55
            bump=nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.33;bump.inputs['Distance'].default_value=.007
            links.new(noise.outputs['Fac'],bump.inputs['Height']);links.new(bump.outputs['Normal'],bs.inputs['Normal'])
        if mat.name=='展墙_朱红' and bs:bs.inputs['Base Color'].default_value=(.30,.045,.026,1)
        if mat.name=='展柜_透明玻璃':clear_glass(mat,.09)
        if mat.name.startswith('展床碎石_') and bs:
            i=int(mat.name.rsplit('_',1)[1]);v=.013+i*.006
            bs.inputs['Base Color'].default_value=(v*.90,v*.97,v,1);bs.inputs['Roughness'].default_value=.75
        if mat.name.startswith('现状_') and 'wood' in mat.name.lower() and bs:
            if not bs.inputs['Base Color'].is_linked:
                color=bs.inputs['Base Color'].default_value
                bs.inputs['Base Color'].default_value=(color[0]*.48,color[1]*.50,color[2]*.55,1)
    # Replace the presentation-only sparse pyramid gravel with a dense, rounded stone bed.
    # Both the bounds and top elevation stay inside the existing display-case bed.
    import bmesh
    bm=bmesh.new();bmesh.ops.create_icosphere(bm,subdivisions=1,radius=1)
    bm.verts.ensure_lookup_table();bm.verts.index_update()
    ico=[v.co.copy() for v in bm.verts];faces=[tuple(v.index for v in f.verts) for f in bm.faces];bm.free()
    rng=random.Random(20260911)
    for obj in list(scene.objects):
        if obj.type!='MESH' or '碎石展床' not in obj.name:continue
        old=obj.data;coords=[v.co for v in old.vertices]
        lo=[min(v[i] for v in coords) for i in range(3)];hi=[max(v[i] for v in coords) for i in range(3)]
        vertices=[];polygons=[];indices=[]
        nx=max(1,round((hi[0]-lo[0])/.023));ny=max(1,round((hi[1]-lo[1])/.023))
        for ix in range(nx):
            for iy in range(ny):
                x=lo[0]+(ix+.5+rng.uniform(-.25,.25))*(hi[0]-lo[0])/nx
                y=lo[1]+(iy+.5+rng.uniform(-.25,.25))*(hi[1]-lo[1])/ny
                rx,ry,rz=rng.uniform(.009,.014),rng.uniform(.007,.012),rng.uniform(.004,.008)
                angle=rng.random()*math.tau;ca,sa=math.cos(angle),math.sin(angle);start=len(vertices)
                vertices.extend((x+v.x*rx*ca-v.y*ry*sa,y+v.x*rx*sa+v.y*ry*ca,lo[2]+.005+v.z*rz) for v in ico)
                polygons.extend(tuple(start+i for i in face) for face in faces)
                indices.extend([rng.randrange(5)]*len(faces))
        mesh=bpy.data.meshes.new(obj.name+'_精细颗粒');mesh.from_pydata(vertices,[],polygons)
        for mat in old.materials:mesh.materials.append(mat)
        for face,index in zip(mesh.polygons,indices):face.material_index=index;face.use_smooth=True
        obj.data=mesh
        if old.users==0:bpy.data.meshes.remove(old)
    scene['photo_finish_revision']=1
    bpy.context.view_layer.update()

def finish_source_cleanup(scene):
    if scene.get('source_cleanup_revision',0)>=1:return
    path=ROOT / 'resources/scenes/models/courtyard-architecture-20260910.glb'
    with path.open('rb') as f:
        f.seek(12);size=struct.unpack('<I',f.read(4))[0];f.read(4);doc=json.loads(f.read(size))
    active=set();pending=list(doc['scenes'][doc.get('scene',0)]['nodes'])
    while pending:
        i=pending.pop()
        if i in active:continue
        active.add(i);pending.extend(doc['nodes'][i].get('children',[]))
    unused={n['name'] for i,n in enumerate(doc['nodes']) if i not in active and 'mesh' in n}
    removed=[]
    for obj in list(scene.objects):
        if obj.name in unused:
            removed.append(obj.name);bpy.data.objects.remove(obj,do_unlink=True)
    # The interactive asset retains removed door buffers for compatibility. They are
    # imported by Blender as orphan nodes and must not be relinked into the photograph.
    print('UNUSED_SOURCE_NODES_EXCLUDED',len(removed),flush=True)
    rough=bpy.data.materials.new('后展厅_石质侧面');rough.use_nodes=True
    nodes,links=rough.node_tree.nodes,rough.node_tree.links;bs=nodes.get('Principled BSDF')
    noise=nodes.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=32;noise.inputs['Detail'].default_value=5
    ramp=nodes.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].color=(.08,.077,.066,1);ramp.color_ramp.elements[1].color=(.26,.25,.217,1)
    links.new(noise.outputs['Fac'],ramp.inputs['Fac']);links.new(ramp.outputs['Color'],bs.inputs['Base Color'])
    bump=nodes.new('ShaderNodeBump');bump.inputs['Distance'].default_value=.006;bump.inputs['Strength'].default_value=.4
    links.new(noise.outputs['Fac'],bump.inputs['Height']);links.new(bump.outputs['Normal'],bs.inputs['Normal']);bs.inputs['Roughness'].default_value=.93
    for obj in scene.objects:
        if obj.type!='MESH' or obj.get('zone')!='rear' or not obj.get('stone_id') or obj.get('is_photo'):continue
        if any(m.name.startswith('现状_') for m in obj.data.materials):
            obj.data=obj.data.copy()
            for i,mat in enumerate(obj.data.materials):
                if mat.name.startswith('现状_'):obj.data.materials[i]=rough
    scene['source_cleanup_revision']=1

def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene=bpy.context.scene;scene.name='武氏祠_三馆精细摄影_20260911'
    scene.unit_settings.system='METRIC';scene.unit_settings.length_unit='METERS'
    columns={}
    for key,label in [('architecture','01_现状建筑与院落'),('que','02_阙室石刻'),('xcl','03_西长廊石刻'),('rear','04_后展厅石刻'),('other','05_其他石刻与北长廊'),('fitout','06_后展厅展陈')]:
        col=bpy.data.collections.new(label);scene.collection.children.link(col);col['zone']=key;columns[key]=col
    architecture=import_glb(ROOT / 'resources/scenes/models/courtyard-architecture-20260910.glb',columns['architecture'])
    payload=json.loads((OUT/'scene/scene.json').read_text(encoding='utf-8'))
    records={r['id']:r for r in payload['objects']}
    geos={r['id']:r for r in payload['geometries']}
    mats={r['id']:r for r in payload['materials']}
    textures={r['id']:r for r in payload['textures']}
    def ancestry(r):
        while r:
            yield r
            r=records.get(r.get('parentId'))
    def zone(r):
        names={a['name'] for a in ancestry(r)}
        if 'front_que_hall' in names:return 'que'
        if 'HPS_XCL_IN' in names:return 'xcl'
        if 'rear_exhibition_hall' in names and 'HPS_HALL_IN' in names:return 'rear'
        return 'other'
    spec=importlib.util.spec_from_file_location('shared',ROOT / 'tools/authoring/build_blender_scene.py')
    shared=importlib.util.module_from_spec(spec);spec.loader.exec_module(shared)
    shared.SCENE_FILE=OUT/'scene/scene.json';shared.PREFIX='现状_'
    image_cache={};mat_cache={};mesh_cache={};imported=[]
    anchors={r['userData']['hps']['catalogue_no']:r for r in records.values() if r['userData'].get('hps',{}).get('catalogue_no')}
    rear_record=next(r for r in records.values() if r['name']=='rear_exhibition_hall')
    rear_matrix=C@m4(rear_record['matrixWorld'])@C.inverted()
    for r in records.values():
        u=r['userData'];h=r.get('hps') or {}
        if not r.get('geometryId') or r.get('skipRender') or not r['visible'] or u.get('courtyardReplacement'):continue
        chain=list(ancestry(r));names={a['name'] for a in chain}
        if 'rear_exhibition_hall' in names and any(a['userData'].get('showcase') for a in chain):continue
        if u.get('photoModel') or h.get('catalogue_no') in ['武023','武024']:continue
        if all(mats[mid].get('opacity',1)==0 or not mats[mid].get('visible',True) for mid in r['materialIds']):continue
        for mid in r['materialIds']:
            if mid not in mat_cache:
                mat_cache[mid]=shared.make_material(mats[mid],textures,image_cache)
        key=(r['geometryId'],tuple(r['materialIds']))
        if key not in mesh_cache:mesh_cache[key]=shared.make_mesh(geos[r['geometryId']],r['materialIds'],mat_cache)
        obj=bpy.data.objects.new(r['name'],mesh_cache[key]);columns[zone(r)].objects.link(obj)
        obj.matrix_world=C@m4(r['matrixWorld']);obj['source_object_id']=r['id'];obj['zone']=zone(r)
        if h.get('catalogue_no'):obj['stone_id']=h['catalogue_no']
        if u.get('isStoneTexture'):
            obj['is_photo']=True;obj.visible_shadow=False
            # Keep the full archive photograph and its UV frame, with a tiny ray separation.
            normal=u.get('stoneTexture',{}).get('normal',[0,0,1])
            obj.location += obj.matrix_world.to_3x3()@Vector(normal)*.001
        imported.append(obj)
    for sid,r in anchors.items():
        photo=r['userData'].get('photoModel')
        if not photo:continue
        transform=C@m4(r['matrixWorld'])@Matrix.Translation((0,-photo['height']/2,0))@C.inverted()
        path=stone_file(photo['archiveId'], Path('model') / 'photo-reconstruction-20260910.glb')
        objs=import_glb(path,columns['que'],transform)
        for obj in objs:obj['stone_id']=sid;obj['zone']='que'
    for number in ['023','024']:
        sid='武'+number;r=anchors[sid]
        transform=C@m4(r['matrixWorld'])@C.inverted()
        objs=import_glb(source_path(f'resources/scenes/models/rear-niche-{number}.glb'),columns['rear'],transform)
        for obj in objs:obj['stone_id']=sid;obj['zone']='rear'
    fitout=import_glb(ROOT / 'resources/scenes/models/rear-exhibition-20260910.glb',columns['fitout'],rear_matrix)
    for obj in fitout:
        obj['zone']='rear'
        if obj.get('rear_role')=='glass':obj.visible_shadow=False
    # Keep the reference-derived case spotlights from the editable interior, in its registered hall frame.
    install_rear_lights(scene,rear_matrix)
    # Regenerate support blocks from the final stone bounds, matching the main platform.
    white=bpy.data.materials.new('暖白石刻托台');white.use_nodes=True
    bsdf=white.node_tree.nodes.get('Principled BSDF');bsdf.inputs['Base Color'].default_value=(.73,.72,.68,1);bsdf.inputs['Roughness'].default_value=.87
    stone_bounds={}
    inv=rear_matrix.inverted()
    for sid,r in anchors.items():
        if zone(r)!='rear':continue
        objects=[o for o in columns['rear'].all_objects if o.type=='MESH' and o.get('stone_id')==sid]
        vertices=[inv@o.matrix_world@Vector(v) for o in objects for v in o.bound_box]
        low=Vector(tuple(min(v[i] for v in vertices) for i in range(3)));high=Vector(tuple(max(v[i] for v in vertices) for i in range(3)))
        stone_bounds[sid]=(low,high)
    for sid,(low,high) in stone_bounds.items():
        if low.z<=.831:continue
        lower=any(other!=sid and a.z<low.z-.15 and b.z<=low.z+.03 and b.x>low.x and a.x<high.x and b.y>low.y and a.y<high.y for other,(a,b) in stone_bounds.items())
        height=.07 if lower else low.z-.802
        bpy.ops.mesh.primitive_cube_add(size=1)
        obj=bpy.context.object;obj.name='白色托台_'+sid;relocate(obj,columns['rear'])
        obj.matrix_world=rear_matrix@Matrix.Translation(((low.x+high.x)/2,(low.y+high.y)/2,low.z-height/2))@Matrix.Diagonal((high.x-low.x+.015,high.y-low.y+.015,height,1))
        obj.data.materials.append(white);obj['zone']='rear'
    for material in bpy.data.materials:
        if not material.use_nodes:continue
        if '玻璃' in material.name or material.name=='现状_glass':
            clear_glass(material,.18 if '展柜' in material.name else .4)
            continue
        bsdf=next((n for n in material.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)
        if not bsdf:continue
        if any(key in material.name for key in ['地砖','台基','灰砖','抹面','墙','托台']):
            bevel=material.node_tree.nodes.new('ShaderNodeBevel');bevel.inputs['Radius'].default_value=.0015;bevel.samples=4
            if bsdf.inputs['Normal'].is_linked:material.node_tree.links.new(bsdf.inputs['Normal'].links[0].from_socket,bevel.inputs['Normal'])
            material.node_tree.links.new(bevel.outputs['Normal'],bsdf.inputs['Normal'])
        if material.name.startswith('地砖_'):
            nodes,links=material.node_tree.nodes,material.node_tree.links
            noise=nodes.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=14;noise.inputs['Detail'].default_value=4
            bump=nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.20;bump.inputs['Distance'].default_value=.008
            links.new(noise.outputs['Fac'],bump.inputs['Height']);links.new(bump.outputs['Normal'],bsdf.inputs['Normal'])
    scene.world=bpy.data.worlds.new('清朗日光');scene.world.use_nodes=True
    nodes=scene.world.node_tree.nodes;links=scene.world.node_tree.links
    sky=nodes.new('ShaderNodeTexSky');sky.sky_type='MULTIPLE_SCATTERING';sky.sun_elevation=math.radians(35);sky.sun_rotation=math.radians(225);sky.sun_disc=False
    links.new(sky.outputs['Color'],nodes.get('Background').inputs['Color']);nodes.get('Background').inputs['Strength'].default_value=.28
    data=bpy.data.lights.new('斜入柔和日光','SUN');data.energy=2.2;data.angle=math.radians(3);data.color=(1,.91,.78)
    sun=bpy.data.objects.new('斜入柔和日光',data);scene.collection.objects.link(sun);sun.location=world(14,-40,54);look_at(sun,world(52,0,0))
    sun['light_zone']='daylight'
    for b in [-8,-4,4,8]:
        area('阙室窗光',world(35.5,b,2.9),world(40,b,1.8),170,1.65,'que')
    area('阙室顶面反射光',world(39.34,0,4.9),world(39.34,0,.5),800,7,'que')
    area('题记柔光',world(39.34,-6.5,3.7),world(39.34,-9.4,.8),280,4.5,'que')
    for a in [48,53,58,63,68]:
        area('西长廊格窗柔光',world(a,14.12,2.1),world(a,16.85,1.2),75,2,'xcl')
    scene['snapshot']='2026-09-11 主平台当前布局';scene['archive_count']=150
    scene['render_note']='实景建模与原照片纹理的Cy​cles可视化；独立摄影灯光，不更改主平台或文物尺寸。'
    scene['rear_matrix']=list(v for row in rear_matrix for v in row)
    report={'archiveIds':sorted({o.get('stone_id') for o in scene.objects if o.get('stone_id')}),'photoModels':4,'nicheScans':2,'snapshot':str(OUT/'scene/scene.json')}
    assert len(report['archiveIds'])==150,len(report['archiveIds'])
    (OUT/'build-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    for image in bpy.data.images:
        if image.source=='FILE' and not image.packed_file:image.pack()
    bpy.context.view_layer.update()
    return scene

VIEWS = [
    {'id':'01','name':'阙室_庭院斜景','zone':'que','outside':True,'position':[18,-21,4.1],'target':[39.34,0,3.7],'lens':35,'exposure':.25},
    {'id':'02','name':'阙室_石阙与石狮','zone':'que','position':[35.25,-1.5,2.25],'target':[40,4.5,2.35],'lens':26,'exposure':.35},
    {'id':'03','name':'阙室_题记沿墙','zone':'que','position':[35.6,-7.9,1.05],'target':[40.5,-9.55,.98],'lens':26,'exposure':.4},
    {'id':'04','name':'西长廊_檐下光影','zone':'xcl','outside':True,'position':[45.5,10.5,1.65],'target':[64,11.9,2.5],'lens':27,'exposure':.3},
    {'id':'05','name':'西长廊_石刻长卷','zone':'xcl','position':[46.7,14.8,1.65],'target':[66,16.4,1.45],'lens':27,'exposure':.75},
    {'id':'06','name':'西长廊_画像近景','zone':'xcl','position':[53.6,14.0,1.85],'target':[51.0,16.75,1.35],'lens':29,'exposure':.7},
    {'id':'07','name':'后展厅_中央展柜','zone':'rear','local':True,'position':[3.35,1.95,1.1],'target':[-.1,1.6,5.45],'lens':25,'exposure':.7},
    {'id':'08','name':'后展厅_红墙群像','zone':'rear','local':True,'position':[-2.5,1.85,-1.65],'target':[-4.92,1.55,-6.7],'lens':25,'exposure':.7},
    {'id':'09','name':'后展厅_小龛石刻','zone':'rear','local':True,'position':[1.6,1.8,-1.6],'target':[4.54,1.5,-5.7],'lens':29,'exposure':.7},
]
views_path=OUT/'views.json'
if views_path.exists():VIEWS=json.loads(views_path.read_text(encoding='utf-8'))
else:views_path.write_text(json.dumps(VIEWS,ensure_ascii=False,indent=2),encoding='utf-8')

scene=build() if '--build' in args else None
if scene is None:bpy.ops.wm.open_mainfile(filepath=str(BLEND));scene=bpy.context.scene
prefs=bpy.context.preferences.addons['cycles'].preferences;prefs.compute_device_type='OPTIX';prefs.get_devices()
for device in prefs.devices:device.use=device.type=='OPTIX'
scene.render.engine='CYCLES';scene.cycles.device='GPU';scene.cycles.use_denoising=True
scene.cycles.denoiser='OPENIMAGEDENOISE';scene.cycles.use_adaptive_sampling=True
scene.cycles.max_bounces=12;scene.cycles.diffuse_bounces=6;scene.cycles.glossy_bounces=6
scene.cycles.transmission_bounces=12;scene.cycles.transparent_max_bounces=24
scene.cycles.sample_clamp_indirect=4;scene.render.use_persistent_data=True
scene.render.resolution_percentage=100;scene.render.film_transparent=False
scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGB';scene.render.image_settings.color_depth='16'
scene.view_settings.view_transform='AgX';scene.view_settings.look='AgX - Medium High Contrast'
rear_values=scene['rear_matrix'];rear_matrix=Matrix([rear_values[i:i+4] for i in range(0,16,4)])
if scene.get('rear_lighting_revision',0)<2:install_rear_lights(scene,rear_matrix)
refine_photo_materials(scene)
finish_source_cleanup(scene)
scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value=.15
bpy.data.objects['斜入柔和日光'].data.energy=3.5
for view in VIEWS:
    name=view['id']+'_'+view['name'];cam=bpy.data.objects.get(name)
    if cam is None:
        cam=bpy.data.objects.new(name,bpy.data.cameras.new(name));scene.collection.objects.link(cam)
    if view.get('local'):
        cam.location=rear_matrix@(C@Vector(view['position']));target=rear_matrix@(C@Vector(view['target']))
    else:cam.location=world(*view['position']);target=world(*view['target'])
    look_at(cam,target);cam.data.lens=view['lens'];cam.data.sensor_width=36
    cam.data.clip_start=.06;cam.data.clip_end=1500
    cam.data.dof.use_dof=False
    cam['exposure']=view['exposure'];cam['view_zone']=view['zone']
names={v['id']+'_'+v['name'] for v in VIEWS}
for obj in list(scene.objects):
    if obj.type=='CAMERA' and obj.name not in names:bpy.data.objects.remove(obj,do_unlink=True)
scene.camera=bpy.data.objects[VIEWS[0]['id']+'_'+VIEWS[0]['name']]
scene.view_settings.exposure=VIEWS[0]['exposure']
scene['photography_views']=json.dumps(VIEWS,ensure_ascii=False)
scene.frame_start=1;scene.frame_end=9;scene.frame_set(1)
scene.timeline_markers.clear()
for index,view in enumerate(VIEWS,1):
    name=view['id']+'_'+view['name'];marker=scene.timeline_markers.new(name,frame=index)
    marker.camera=bpy.data.objects[name]
scene.cycles.samples=512;scene.cycles.adaptive_threshold=.006
scene.render.resolution_x=3840;scene.render.resolution_y=2400
if '--build' in args or '--save-scene' in args:
    bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND),compress=True)
    print('SCENE_SAVED',BLEND,flush=True)
preview='--preview' in args
codes={a for a in args if len(a)==2 and a.isdigit()}
jobs=[v for v in VIEWS if not codes or v['id'] in codes] if preview or '--render' in args else []
status={'status':'rendering','completed':[],'started':time.strftime('%Y-%m-%d %H:%M:%S'),'preview':preview}
status_file=OUT/('preview-status.json' if preview else 'render-status.json')
if not preview and codes and status_file.exists():
    prior=json.loads(status_file.read_text(encoding='utf-8'))
    status['completed']=[r for r in prior.get('completed',[]) if r['name'][:2] not in codes and (OUT/'renders'/(r['name']+'.png')).exists() and (OUT/'jpg'/(r['name']+'.jpg')).exists()]
for view in jobs:
    # Rendering evaluates camera markers at the current frame, so the frame must
    # follow the selected view before assigning its camera.
    scene.frame_set(int(view['id']))
    name=view['id']+'_'+view['name'];scene.camera=bpy.data.objects[name];scene.view_settings.exposure=view['exposure']
    for col in scene.collection.children:
        if col.get('zone') in ['que','xcl','rear','fitout','other']:
            col.hide_render=col.get('zone') not in [view['zone'],'fitout' if view['zone']=='rear' else '', 'other' if view.get('outside') else '']
    for obj in scene.objects:
        if obj.type=='LIGHT' and obj.get('light_zone'):
            obj.hide_render=obj['light_zone'] not in ['daylight',view['zone'] if not view.get('outside') else '']
    scene.render.resolution_x=1200 if preview else 3840;scene.render.resolution_y=750 if preview else 2400
    scene.cycles.samples=32 if preview else 512;scene.cycles.adaptive_threshold=.04 if preview else .006
    scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_depth='8' if preview else '16'
    scene.render.filepath=str(OUT/('previews' if preview else 'renders')/(name+'.png'))
    status['current']=name;status_file.write_text(json.dumps(status,ensure_ascii=False,indent=2),encoding='utf-8')
    start=time.time();bpy.ops.render.render(write_still=True)
    assert scene.camera.name==name,('Render camera changed',name,scene.camera.name)
    if not preview:
        scene.render.image_settings.file_format='JPEG';scene.render.image_settings.quality=96
        bpy.data.images['Render Result'].save_render(str(OUT/'jpg'/(name+'.jpg')),scene=scene)
    status['completed'].append({'name':name,'camera':scene.camera.name,'frame':scene.frame_current,'seconds':round(time.time()-start,2)})
    status_file.write_text(json.dumps(status,ensure_ascii=False,indent=2),encoding='utf-8')
    print('RENDERED',name,round(time.time()-start,2),flush=True)
status['status']='complete';status['current']=None;status_file.write_text(json.dumps(status,ensure_ascii=False,indent=2),encoding='utf-8')
print('RENDER_QUEUE_COMPLETE',flush=True)
