"""Re-render the saved rear hall with clear specular showcase glass."""
from pathlib import Path
import bpy
from mathutils import Vector
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT / 'resources/authoring/rear-hall'
bpy.ops.wm.open_mainfile(filepath=str(OUT/'后展厅_展陈与石刻.blend'))
scene=bpy.context.scene
mat=bpy.data.materials['展柜_透明玻璃']
nodes,links=mat.node_tree.nodes,mat.node_tree.links
mix=next(n for n in nodes if n.type=='MIX_SHADER')
glossy=nodes.new('ShaderNodeBsdfGlossy')
glossy.inputs['Color'].default_value=(1,1,1,1);glossy.inputs['Roughness'].default_value=.025
links.new(glossy.outputs[0],mix.inputs[2])
next(n for n in nodes if n.type=='MATH').inputs[1].default_value=.12
camera=scene.camera
for obj in scene.objects:
    if obj.type=='LIGHT' and obj.data.type=='AREA':
        obj.data.specular_factor=0
        obj.visible_glossy=False
for name,pos,target in [('01_后展厅_中央展柜',(-3.2,2.02,-3.1),(.9,1.6,5.7)),('02_后展厅_小龛与红色展墙',(1.7,1.72,-1),(4.54,1.6,-5))]:
    camera.location=(pos[0],-pos[2],pos[1]);camera.rotation_euler=(Vector((target[0],-target[2],target[1]))-camera.location).to_track_quat('-Z','Y').to_euler()
    scene.render.filepath=str(OUT/(name+'.png'));bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'后展厅_展陈与石刻.blend'))
