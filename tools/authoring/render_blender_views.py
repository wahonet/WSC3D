"""Queue the three presentation renders in the connected Blender GUI.

Execute through Blender MCP. Uses Blender timers, never worker threads for bpy.
Progress is written next to the output images; the saved scene keeps all cameras.
"""
import bpy
import json
import time
import traceback
from pathlib import Path

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
PROJECT = Path(__file__).resolve().parents[2]
OUTPUT = PROJECT / 'resources/authoring/scene-base'
RENDERS = OUTPUT / 'renders'


def start_render_queue():
    scene = bpy.context.scene
    if not scene.name.startswith('武氏祠_整体渲染_20260905'):
        raise RuntimeError('Select the generated Wushici scene before rendering.')
    if bpy.app.is_job_running('RENDER'):
        raise RuntimeError('A render is already running.')
    jobs = [
        {'camera':'WSC_01_院落鸟瞰', 'file':'01_武氏祠_整体鸟瞰.png', 'size':(3840,2400), 'samples':96},
        {'camera':'WSC_02_中轴近景', 'file':'02_武氏祠_中轴近景.png', 'size':(3000,1875), 'samples':96},
        {'camera':'WSC_03_总平面', 'file':'03_武氏祠_总平面.png', 'size':(3200,2000), 'samples':64},
    ]
    status_file = RENDERS/'render_status.json'
    state = {'status':'queued','current':None,'completed':[],'started_at':time.strftime('%Y-%m-%d %H:%M:%S'),'error':None}
    def record():
        status_file.write_text(json.dumps(state,ensure_ascii=False,indent=2),encoding='utf-8')
    def tick():
        try:
            if bpy.app.is_job_running('RENDER'):
                return 2.0
            if state['current']:
                path = RENDERS/state['current']
                if not path.is_file() or path.stat().st_size == 0:
                    raise RuntimeError('Render stopped without producing '+str(path))
                state['completed'].append(state['current'])
                state['current'] = None
            if not jobs:
                scene.camera = bpy.data.objects['WSC_01_院落鸟瞰']
                scene.render.resolution_x, scene.render.resolution_y = 3840,2400
                scene.cycles.samples = 96
                scene.render.filepath = str(RENDERS/'01_武氏祠_整体鸟瞰.png')
                bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT/'blender'/'武氏祠_整体场景.blend'))
                state['status'] = 'complete'
                state['completed_at'] = time.strftime('%Y-%m-%d %H:%M:%S')
                record()
                return None
            job = jobs.pop(0)
            scene.camera = bpy.data.objects[job['camera']]
            scene.render.resolution_x, scene.render.resolution_y = job['size']
            scene.cycles.samples = job['samples']
            scene.render.filepath = str(RENDERS/job['file'])
            state['current'] = job['file']
            state['status'] = 'rendering'
            record()
            bpy.ops.render.render('INVOKE_DEFAULT',write_still=True)
            return 3.0
        except Exception:
            state['status'] = 'failed'
            state['error'] = traceback.format_exc()
            record()
            return None
    record()
    bpy.app.timers.register(tick,first_interval=0.25)
    print('Queued 3 Cycles renders; progress: '+str(status_file))


if __name__ == '__main__':
    start_render_queue()
