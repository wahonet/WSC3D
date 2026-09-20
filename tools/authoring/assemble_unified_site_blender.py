"""Assemble the existing archive scene, centre and new Blender surroundings.

blender --background --python tools/authoring/assemble_unified_site_blender.py [-- --render]
Keeps the existing photography file intact and saves a new complete editable scene.
"""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Matrix,Vector

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT / 'resources/authoring/site-context'
BASE=ROOT / 'resources/authoring/photography/blender/武氏祠_三馆精细摄影.blend'
OUTPUT=OUT/'blender/武氏祠_周边环境及传承中心_统一场景.blend'
args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
def import_glb(path,col,transform=None):
    before=set(bpy.data.objects);bpy.ops.import_scene.gltf(filepath=str(path));new=set(bpy.data.objects)-before
    for ob in list(new):
        if any(c.name.startswith('Orphan Nodes') for c in ob.users_collection):new.remove(ob);bpy.data.objects.remove(ob,do_unlink=True)
    roots=[o for o in new if o.parent not in new]
    for ob in new:
        for c in list(ob.users_collection):c.objects.unlink(ob)
        col.objects.link(ob)
    if transform:
        for ob in roots:ob.matrix_world=transform@ob.matrix_world
    bpy.context.view_layer.update();return new
def camera(name,position,target,lens):
    ob=bpy.data.objects.new(name,bpy.data.cameras.new(name));bpy.context.scene.collection.objects.link(ob)
    ob.location=(position[0],-position[2],position[1]);target=Vector((target[0],-target[2],target[1]))
    ob.rotation_euler=(target-ob.location).to_track_quat('-Z','Y').to_euler();ob.data.lens=lens
    ob.data.clip_start=.2;ob.data.clip_end=2200;return ob

if '--reuse' in args:
    bpy.ops.wm.open_mainfile(filepath=str(OUTPUT));scene=bpy.context.scene
    scene.timeline_markers.clear();scene.camera=bpy.data.objects['区域全景']
    bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT),compress=True)
else:
    bpy.ops.wm.open_mainfile(filepath=str(BASE));scene=bpy.context.scene
    scene.name='武氏祠_周边环境及传承中心_统一场景'
    before={o.name:list(v for row in o.matrix_world for v in row) for o in scene.objects if o.get('stone_id')}
    ids={o.get('stone_id') for o in scene.objects if o.get('stone_id')};assert len(ids)==150
    for c in scene.collection.children:c.hide_render=False;c.hide_viewport=False
    for ob in scene.objects:
        if ob.type=='LIGHT':ob.hide_render=ob.get('light_zone')!='daylight'
    with bpy.data.libraries.load(str(OUT/'blender/周边环境_黄线范围.blend'),link=False) as (src,dst):
        dst.collections=['周边环境_黄线范围']
    scene.collection.children.link(dst.collections[0])
    cc=bpy.data.collections.new('08_拟建汉文化保护传承中心');scene.collection.children.link(cc)
    placement=json.loads((ROOT / 'resources/georeferencing/hanwenhua-center-placement.json').read_text('utf-8'))
    t=placement['transform'];x,y,z=t['translation']
    transform=Matrix.Translation((x,-z,y))@Matrix.Rotation(math.radians(t['rotationYDeg']),4,'Z')
    import_glb(ROOT / 'resources/scenes/models/hanwenhua-center.glb',cc,transform)
    after={o.name:list(v for row in o.matrix_world for v in row) for o in scene.objects if o.get('stone_id')}
    assert after==before,'Stone placements changed while combining scene'
    scene['context_source']='resources/georeferencing/site-context.json'
    scene['context_note']='CAD 与航拍的相对场景复原；院外建筑高度示意，传承中心为拟建方案。'
    scene['archive_count']=150
    # Extend only the neutral photography backdrop so an aerial view does not
    # reveal the edge of the former indoor-render ground plane.
    for ob in scene.objects:
        if ob.type=='MESH' and ob.dimensions.x>1000 and ob.dimensions.y>1000 and ob.dimensions.z<1:
            ob.scale*=8
    camera('区域全景',[285,370,270],[-20,0,-154],38)
    camera('院落与传承中心衔接',[-201,185,77],[-28,0,-57],43)
    camera('两侧树木风格',[-115,56,-4],[-36,4,-92],45)
    # Remove the former nine interior camera bindings: frame 1 would otherwise
    # override scene.camera when Cycles evaluates a still render.
    scene.timeline_markers.clear();scene.frame_start=1;scene.frame_end=2
    for im in bpy.data.images:
        if im.source=='FILE' and not im.packed_file:im.pack()
    scene.camera=bpy.data.objects['区域全景']
    scene.render.resolution_x=2200;scene.render.resolution_y=1500;scene.render.resolution_percentage=100
    scene.view_settings.exposure=.1
    scene.cycles.samples=96;scene.cycles.adaptive_threshold=.016
    scene.cycles.max_bounces=8;scene.cycles.diffuse_bounces=4;scene.cycles.glossy_bounces=4
    scene.render.use_persistent_data=True
    bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT),compress=True)
    (OUT/'unified-scene-report.json').write_text(json.dumps(dict(archiveCount=len(ids),stoneTransformsUnchanged=True,
        centreTransform=t,collections=[c.name for c in scene.collection.children],file=str(OUTPUT),bytes=OUTPUT.stat().st_size),ensure_ascii=False,indent=2),encoding='utf-8')
    print('UNIFIED_SCENE_SAVED',OUTPUT,flush=True)
if '--render' in args:
    prefs=bpy.context.preferences.addons['cycles'].preferences;prefs.compute_device_type='OPTIX';prefs.get_devices()
    for dev in prefs.devices:dev.use=dev.type=='OPTIX'
    scene.render.engine='CYCLES';scene.cycles.device='GPU';scene.cycles.use_denoising=True
    scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_depth='8';scene.render.image_settings.color_mode='RGB'
    for name in ['区域全景','院落与传承中心衔接','两侧树木风格']:
        scene.camera=bpy.data.objects[name]
        scene.render.filepath=str(OUT/'renders'/f'{name}.png')
        bpy.ops.render.render(write_still=True)
        print('UNIFIED_RENDER_DONE',name,flush=True)
