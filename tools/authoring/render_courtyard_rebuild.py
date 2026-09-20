import bpy,sys,json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT / 'resources/authoring/courtyard'
args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
bpy.ops.wm.open_mainfile(filepath=str(OUT/'blender/武氏祠_院落重建_20260910.blend'))
scene=bpy.context.scene
preview='--preview' in args
if preview:
 scene.render.resolution_x=1200;scene.render.resolution_y=800;scene.cycles.samples=24
try:
 prefs=bpy.context.preferences.addons['cycles'].preferences;prefs.compute_device_type='OPTIX';prefs.get_devices()
 for d in prefs.devices:d.use=d.type!='CPU'
 scene.cycles.device='GPU'
except Exception:pass
codes=[x for x in args if x.isdigit()] or ['01','02','03','04','05','06']
for cam in [o for o in scene.objects if o.type=='CAMERA']:
 if not any(cam.name.startswith('保留_'+c+'_') for c in codes):continue
 scene.camera=cam;name=cam.name.removeprefix('保留_')+('_预览' if preview else '')
 scene.render.filepath=str(OUT/'renders'/(name+'.png'))
 bpy.ops.render.render(write_still=True)
 print('RENDERED '+name,flush=True)
