"""Read editable Blender sources and render previews without saving changes."""
import json
import os
from pathlib import Path
import sys
import time
import bpy

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools/authoring'))
from project import source_path
OUT=Path(os.environ.get('WSC_TEST_OUTPUT',str(Path(os.environ.get('TEMP','.'))/'wsc-tests')))/'blender'
OUT.mkdir(parents=True,exist_ok=True)
report=[]
files=[p for p in (ROOT/'resources/authoring').rglob('*.blend') if not {'backup','before'}.intersection(p.relative_to(ROOT).parts)]
for file in files:
    start=time.monotonic()
    bpy.ops.wm.open_mainfile(filepath=str(file),load_ui=False)
    images=[]
    for image in bpy.data.images:
        if image.source!='FILE':continue
        path=Path(bpy.path.abspath(image.filepath))
        if not image.packed_file and not path.is_file():
            try:
                candidate=source_path(path)
                if candidate.is_file():image.filepath=str(candidate);path=candidate
            except ValueError:pass
        images.append({'name':image.name,'packed':bool(image.packed_file),'exists':path.is_file(),'path':str(path)})
    missing=[i for i in images if not i['packed'] and not i['exists']]
    libraries=[{'path':lib.filepath,'exists':Path(bpy.path.abspath(lib.filepath)).is_file()} for lib in bpy.data.libraries]
    row={'file':file.relative_to(ROOT).as_posix(),'objects':len(bpy.data.objects),'images':len(images),'missing':missing,'libraries':libraries}
    if not missing and bpy.context.scene.camera:
        scene=bpy.context.scene;scene.render.engine='BLENDER_WORKBENCH'
        scene.render.resolution_x,scene.render.resolution_y,scene.render.resolution_percentage=640,480,100
        scene.render.image_settings.file_format='PNG';scene.render.filepath=str(OUT/(file.stem+'.png'))
        bpy.ops.render.render(write_still=True)
    row['seconds']=round(time.monotonic()-start,2)
    row['ok']=not missing and all(lib['exists'] for lib in libraries) and row['objects']>0
    report.append(row)
    (OUT/'sources.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(row,ensure_ascii=False),flush=True)
assert all(row['ok'] for row in report),'Some authoring inputs are unavailable'
