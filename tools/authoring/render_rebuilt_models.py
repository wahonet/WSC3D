from pathlib import Path
import bpy, math, json
from mathutils import Vector
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT / 'resources/authoring/stone-reconstruction'
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
s=bpy.context.scene;s.render.engine='CYCLES';s.cycles.samples=24;s.render.resolution_x=1000;s.render.resolution_y=1100;s.render.resolution_percentage=100;s.world.color=(.14,.14,.14);s.view_settings.view_transform='Standard'
camera=bpy.data.objects.new('RebuildQA_Camera',bpy.data.cameras.new('RebuildQA_Camera'));s.collection.objects.link(camera);s.camera=camera;camera.data.type='ORTHO'
for name,pos,power in [('Key',(-3,-4,8),700),('Fill',(4,2,6),500)]:
 l=bpy.data.objects.new(name,bpy.data.lights.new(name,'AREA'));s.collection.objects.link(l);l.location=pos;l.rotation_euler=(-l.location).to_track_quat('-Z','Y').to_euler();l.data.energy=power;l.data.size=6
report=[]
for id in ['QUE-W','QUE-E','SHI-W','SHI-E']:
 before=set(bpy.data.objects)
 bpy.ops.import_scene.gltf(filepath=str(stone_file(id, 'models/gallery/photo-reconstruction-20260910.glb')))
 added=set(bpy.data.objects)-before;meshes=[o for o in added if o.type=='MESH']
 points=[o.matrix_world@Vector(c) for o in meshes for c in o.bound_box]
 lo=Vector([min(p[i] for p in points) for i in range(3)]);hi=Vector([max(p[i] for p in points) for i in range(3)]);center=(hi+lo)/2;size=hi-lo;R=max(size)
 view=Vector((-1.76,-1.28,.456) if id=='SHI-W' else (2.71,-1.84,.385) if id=='SHI-E' else (.95,-1.8,.65));camera.location=center+view*R;camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.ortho_scale=R*1.28
 s.render.filepath=str(OUT/f'{id}-rebuilt.png');bpy.ops.render.render(write_still=True)
 report.append({'id':id,'dimensions_blender_m':list(size),'meshes':len(meshes),'vertices':sum(len(o.data.vertices) for o in meshes),'has_phototextures':all(any(n.type=='TEX_IMAGE' and n.image for m in o.data.materials if m for n in m.node_tree.nodes) for o in meshes)})
 for o in added:bpy.data.objects.remove(o,do_unlink=True)
(OUT/'models-validation.json').write_text(json.dumps(report,indent=2))
