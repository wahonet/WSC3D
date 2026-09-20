"""Blender: measured architectural reconstruction, independently mapped four-face photographs.

Dimensions: 蒋英炬、吴文祺，2014修订本，书页8–9，图2.2。
No vanished ridges or subsidiary roofs are invented. The stone's fine surface relief is photographic.
Local axes after glTF export: +X west, +Y up, +Z north.
"""
from pathlib import Path
import bpy, json, math, numpy as np
from mathutils import Vector
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT / 'resources/authoring/stone-reconstruction'
OUT.mkdir(parents=True,exist_ok=True)
# Full-photo UV coordinates. heights are [top, upper-roof-bottom, pillar-bottom,
# lower-roof-bottom, capital-bottom, shaft-bottom, plinth-bottom, base2-bottom, base1-bottom].
SOURCES={
 'QUE-W':{
  'N':dict(key='73ea0b22ed20271d904a',ys=[.109,.166,.236,.288,.377,.778,.876,.933,.991],body=[.193,.561],child=[.569,.768],childY=[.467,.778],childTop=.393),
  'S':dict(key='df6e94d7f14a1851ffa9',ys=[.113,.174,.240,.283,.369,.744,.839,.899,.963],body=[.452,.752],child=[.291,.451],childY=[.456,.734],childTop=.385),
  'E':dict(key='2bce8a9f8337270971a9',ys=[.117,.170,.242,.285,.376,.760,.858,.910,.964],body=[.389,.617]),
  'W':dict(key='0e2bfae776c25a63e1d4',ys=[.056,.103,.168,.204,.293,.744,.838,.904,.977],body=[.419,.600],child=[.449,.578],childY=[.394,.733],childTop=.306),
 },
 'QUE-E':{
  'N':dict(key='340a3a74a8f0f43ef8e0',ys=[.145,.192,.254,.301,.384,.744,.839,.900,.963],body=[.458,.752],child=[.291,.456],childY=[.450,.734],childTop=.390),
  'S':dict(key='76bb813a47c06770bc79',ys=[.158,.203,.258,.296,.376,.716,.807,.864,.925],body=[.261,.555],child=[.559,.744],childY=[.467,.711],childTop=.392),
  'E':dict(key='afd54c304aff5c99368d',ys=[.240,.280,.329,.364,.440,.800,.886,.935,.995],body=[.418,.583],child=[.437,.551],childY=[.503,.798],childTop=.449),
  'W':dict(key='8d831309c273fb063b8f',ys=[.118,.173,.239,.285,.376,.763,.854,.911,.963],body=[.399,.604]),
 },
}
HEIGHTS=[4.30,4.07,3.69,3.47,2.99,.91,.43,.20,0]
def material(image,name):
 m=bpy.data.materials.new(name);m.use_nodes=True
 nodes=m.node_tree.nodes;bs=nodes.get('Principled BSDF');bs.inputs['Roughness'].default_value=.92
 tex=nodes.new('ShaderNodeTexImage');tex.image=image;tex.interpolation='Linear';tex.extension='EXTEND'
 m.node_tree.links.new(tex.outputs['Color'],bs.inputs['Base Color'])
 return m
def ycoord(cfg,h):
 return float(np.interp(h,list(reversed(HEIGHTS)),list(reversed(cfg['ys']))))
def make_que(id):
 sign=1 if id=='QUE-W' else -1
 group=bpy.data.collections.new(id+'_Rebuilt');bpy.context.scene.collection.children.link(group)
 cfgs=SOURCES[id];mats={};arrays={}
 for direction,cfg in cfgs.items():
  path=stone_file(id, f'images/previews/{cfg["key"]}.jpg')
  padded=OUT/'que-texture-padding'/f'{id}-{direction}.jpg'
  im=bpy.data.images.load(str(padded if padded.exists() else path),check_existing=True)
  mats[direction]=material(im,id+'_'+direction+'_original_photo')
  cfg['sourcePath']=path.relative_to(ROOT).as_posix()
 # Horizontal sides of each course use their own photograph, keeping north/south/east/west separate.
 def course(name,z0,z1,w0,d0,w1=None,d1=None,cx=0,child=False):
  w1=w0 if w1 is None else w1;d1=d0 if d1 is None else d1
  verts=[(cx-w0/2,-d0/2,z0),(cx+w0/2,-d0/2,z0),(cx+w0/2,d0/2,z0),(cx-w0/2,d0/2,z0),
         (cx-w1/2,-d1/2,z1),(cx+w1/2,-d1/2,z1),(cx+w1/2,d1/2,z1),(cx-w1/2,d1/2,z1)]
  faces=[(0,1,5,4),(2,3,7,6),(3,0,4,7),(1,2,6,5),(4,5,6,7),(3,2,1,0)]
  mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update()
  ob=bpy.data.objects.new(name,mesh);group.objects.link(ob)
  for direction in ['N','S','E','W']:mesh.materials.append(mats[direction])
  uv=mesh.uv_layers.new(name='PhotoUV')
  for pi,poly in enumerate(mesh.polygons):
   direction=['N','S','E','W','N','N'][pi];cfg=cfgs[direction];poly.material_index=min(pi,3) if pi<4 else 0
   body=cfg['child'] if child and 'child' in cfg else cfg['body']
   center=sum(body)/2;unit=(body[1]-body[0])/(.71 if child else 1.18) if direction in ['N','S'] else (body[1]-body[0])/(.40 if child else .70)
   roof_scale={'QUE-W':{'N':(.872,1.080),'S':(.947,1.265),'E':(1.034,1.086),'W':(1.021,1.110)},'QUE-E':{'N':(.931,1.136),'S':(.947,1.198),'E':(.966,1.034),'W':(1.017,1.050)}}
   if name.startswith('upper_') and name!='upper_pillar':unit*=roof_scale[id][direction][0]
   if name.startswith('lower_'):unit*=roof_scale[id][direction][1]
   y0=ycoord(cfg,z0);y1=ycoord(cfg,z1)
   if child and 'childY' in cfg:
    if z0>=.91-1e-5 and z1<=2.56+1e-5:
     y0=float(np.interp(z0,[.91,2.56],list(reversed(cfg['childY']))));y1=float(np.interp(z1,[.91,2.56],list(reversed(cfg['childY']))))
    elif z0>=2.55:
     y0=cfg['childY'][0];y1=cfg['childTop']
   # Basal courses span both towers; follow the actual width of their photographed perimeter.
   if name.startswith('base'):
    spans={'QUE-W':{'N':(.05,.95),'S':(.12,.89),'E':(.25,.735),'W':(.26,.76)},'QUE-E':{'N':(.12,.89),'S':(.127,.909),'E':(.30,.72),'W':(.286,.71)}}
    ends=spans[id][direction];center=sum(ends)/2;unit=(ends[1]-ends[0])/(2.60 if direction in ['N','S'] else 1.41)
   # Horizontal caps sample uncarved stone from the same supplied photograph.
   if pi>=4:
    coords=[(.48,.805),(.52,.805),(.52,.82),(.48,.82)]
   else:
    width0=w0 if direction in ['N','S'] else d0;width1=w1 if direction in ['N','S'] else d1
    coords=[(center-width0*unit/2,y0),(center+width0*unit/2,y0),(center+width1*unit/2,y1),(center-width1*unit/2,y1)]
   for li,(u,v) in zip(poly.loop_indices,coords):uv.data[li].uv=(u,1-v)
  bevel=ob.modifiers.new('Worn stone arrises','BEVEL');bevel.width=.004;bevel.segments=2
  ob['source']='2014修订本书页8–9尺寸；20260907整理实物四面照片'
  return ob
 cx=-sign*.355;childX=sign*.59
 course('base_1',0,.20,2.60,1.41)
 course('base_2',.20,.43,2.36,1.13)
 course('mother_inverted_plinth',.43,.91,1.37,.94,1.20,.74,cx=cx)
 course('child_inverted_plinth',.43,.91,.78,.65,.72,.42,cx=childX,child=True)
 # Three separate blocks; UV coordinates remain continuous over the full shaft.
 for a,b in [(.91,1.60),(1.60,2.30),(2.30,2.99)]:course(f'mother_shaft_{a}',a,b,1.18,.70,cx=cx)
 course('child_shaft',.91,2.56,.71,.40,cx=childX,child=True)
 course('mother_capital',2.99,3.47,1.20,.74,1.36,1.20,cx=cx)
 course('child_capital',2.56,2.94,.69,.43,.78,.55,cx=childX,child=True)
 course('lower_eaves',3.47,3.63,1.87,1.50,cx=cx)
 course('lower_hip_roof',3.63,3.69,1.87,1.50,1.35,.94,cx=cx)
 course('upper_pillar',3.69,4.07,.65,.38,.70,.45,cx=cx)
 course('upper_eaves',4.07,4.23,1.33,.94,cx=cx)
 course('upper_hip_roof',4.23,4.30,1.33,.94,.88,.54,cx=cx)
 # Do not add the lost main ridge or the lost subsidiary roof.
 bpy.ops.object.select_all(action='DESELECT')
 for ob in group.objects:
  ob.select_set(True)
  if id=='QUE-E':
   for v in ob.data.vertices:v.co.z*=4.28/4.30
 dest=stone_file(id, 'models/gallery');dest.mkdir(parents=True,exist_ok=True)
 path=dest/'photo-reconstruction-20260910.glb'
 bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_apply=True,export_image_format='JPEG',export_jpeg_quality=95,export_extras=True)
 print(id,'exported',path.stat().st_size,flush=True)
 (OUT/f'{id}-mapping.json').write_text(json.dumps({'sources':cfgs,'height_m':4.30 if id=='QUE-W' else 4.28,'base_m':[2.60,1.41],'method':'measured course reconstruction; separate original photographic UVs on four sides','reference':'2014修订本书页8–9，PDF22–23'},ensure_ascii=False,indent=2),encoding='utf-8')
 return group
if __name__=='__main__':
 for id in ['QUE-W','QUE-E']:make_que(id)
 bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'que-photo-models.blend'))
