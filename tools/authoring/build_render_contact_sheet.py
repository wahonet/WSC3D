"""Compose a labeled overview of the nine renders inside Blender."""
import bpy,json,sys
from pathlib import Path

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT / 'resources/authoring/photography'
preview='--preview' in sys.argv
views=json.loads((OUT/'views.json').read_text(encoding='utf-8'))
bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene
engines={i.identifier for i in scene.render.bl_rna.properties['engine'].enum_items}
scene.render.engine='BLENDER_EEVEE' if 'BLENDER_EEVEE' in engines else 'BLENDER_EEVEE_NEXT'
scene.render.resolution_x=3192;scene.render.resolution_y=2520;scene.render.resolution_percentage=100
scene.view_settings.view_transform='Standard';scene.view_settings.look='None'
scene.view_settings.exposure=0;scene.view_settings.gamma=1

def rgb(hexcode):
    values=[int(hexcode[i:i+2],16)/255 for i in (0,2,4)]
    return tuple(v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in values)

def emission(name,color=None,image=None):
    mat=bpy.data.materials.new(name);mat.use_nodes=True
    n,l=mat.node_tree.nodes,mat.node_tree.links;n.clear()
    out=n.new('ShaderNodeOutputMaterial');emit=n.new('ShaderNodeEmission')
    if image:
        tex=n.new('ShaderNodeTexImage');tex.image=image;l.new(tex.outputs['Color'],emit.inputs['Color'])
    else:emit.inputs['Color'].default_value=(*rgb(color),1)
    l.new(emit.outputs[0],out.inputs['Surface']);return mat

def panel(name,x,y,w,h,mat,z=0):
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata([(x,y,z),(x+w,y,z),(x+w,y+h,z),(x,y+h,z)],[],[(0,1,2,3)])
    layer=mesh.uv_layers.new(name='UVMap')
    for loop,uv in zip(layer.data,[(0,0),(1,0),(1,1),(0,1)]):loop.uv=uv
    obj=bpy.data.objects.new(name,mesh);scene.collection.objects.link(obj);mesh.materials.append(mat)

font=bpy.data.fonts.load('C:/Windows/Fonts/msyh.ttc')
serif=bpy.data.fonts.load('C:/Windows/Fonts/simsun.ttc')
ink=emission('墨色','30382F');muted=emission('灰绿','72796D')
def label(text,x,y,size,mat=ink,heading=False):
    data=bpy.data.curves.new(text,'FONT');data.body=text;data.size=size
    data.font=serif if heading else font;data.align_x='LEFT'
    obj=bpy.data.objects.new(text,data);scene.collection.objects.link(obj);obj.location=(x,y,.02)
    data.materials.append(mat)

panel('底色',0,0,26.6,21,emission('纸色','F2F0EB'),-.02)
label('武氏祠 · 三馆影像',.7,20.02,.66,heading=True)
label('九个视角 / 当前模型与照片纹理的数字渲染',.72,19.43,.26,muted)
for column,(zone,title) in enumerate([('que','阙室'),('xcl','西长廊'),('rear','后展厅')]):
    x=.7+column*8.6;label(title,x,18.88,.38,heading=True)
    for row,view in enumerate(v for v in views if v['zone']==zone):
        stem=view['id']+'_'+view['name'];folder='previews' if preview else 'renders';extension='.png'
        photo=bpy.data.images.load(str(OUT/folder/(stem+extension)))
        assert tuple(photo.size)==((1200,750) if preview else (3840,2400)),stem
        y=13.5-row*5.7
        panel(stem,x,y,8,5,emission(stem,image=photo))
        label(view['id']+'  '+view['name'].split('_',1)[1],x,y-.4,.26,muted)
label('BLENDER CYCLES  /  3840 × 2400 原图另附  /  2026.09.11',.7,.55,.25,muted)
camera=bpy.data.objects.new('图集相机',bpy.data.cameras.new('图集相机'))
scene.collection.objects.link(camera);camera.location=(13.3,10.5,30)
camera.data.type='ORTHO';camera.data.ortho_scale=26.6;scene.camera=camera
scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGB';scene.render.image_settings.color_depth='8'
scene.render.filepath=str(OUT/('previews' if preview else '')/'三馆影像_总览.png')
bpy.ops.render.render(write_still=True)
print('CONTACT_SHEET_RENDERED',scene.render.filepath)
