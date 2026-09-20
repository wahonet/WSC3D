"""Blender: reproject the supplied high-resolution photographs onto the visible mesh.

The single-view inferred geometry and unseen textures are approximate. Projection cameras
are calibrated against the original silhouette; no archaeological photograph is generated.
Run with resources/authoring/stone-reconstruction/lions-generated.blend.
"""
from pathlib import Path
import bpy, json, math, numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT / 'resources/authoring/stone-reconstruction'
def emit_material(mat,color_output):
 n=mat.node_tree.nodes;links=mat.node_tree.links
 em=n.new('ShaderNodeEmission');links.new(color_output,em.inputs['Color']);links.new(em.outputs[0],n.get('Material Output').inputs['Surface'])
for side,totalHeight in [('W',1.61),('E',1.59)]:
 ob=bpy.data.objects[f'SHI_{side}_Photo_Reconstruction'];cal=json.loads((OUT/f'lion-{side}-calibration.json').read_text())
 bpy.ops.object.select_all(action='DESELECT');ob.hide_set(False);ob.hide_render=False;ob.select_set(True);bpy.context.view_layer.objects.active=ob
 for other in bpy.context.scene.objects:
  if other!=ob:other.hide_render=True
 mesh=ob.data;atlas=mesh.uv_layers.active;atlas.name='AtlasUV'
 photo=bpy.data.images.load(str(stone_file(f'SHI-{side}', f'images/previews/{cal["sourceId"]}.jpg')),check_existing=True)
 pp=np.asarray(photo.pixels[:],dtype=np.float32).reshape((photo.size[1],photo.size[0],4))
 proj=mesh.uv_layers.new(name='PhotoProjection')
 eye=np.array(cal['eye']);n=np.array(cal['normal']);right=np.array(cal['right']);up=np.array(cal['up'])
 verts=np.array([v.co[:] for v in mesh.vertices]);dep=(eye-verts)@n
 xy=np.c_[verts@right/dep,verts@up/dep];uv=(xy-np.array(cal['lo']))/np.array(cal['span'])
 x0,y0,x1,y1=cal['imageBounds'];iw,ih=cal['imageSize']
 uv[:,0]=(x0+uv[:,0]*(x1-x0))/iw;uv[:,1]=1-(y1-uv[:,1]*(y1-y0))/ih
 for loop in mesh.loops:proj.data[loop.index].uv=uv[loop.vertex_index]
 fallback=mesh.materials[0];nodes=fallback.node_tree.nodes
 bs=nodes.get('Principled BSDF');oldcolor=bs.inputs['Base Color'].links[0].from_socket
 emit_material(fallback,oldcolor)
 pm=bpy.data.materials.new(f'SHI-{side}_source_photo');pm.use_nodes=True
 pn=pm.node_tree.nodes;pt=pn.new('ShaderNodeTexImage');pt.image=photo;pt.extension='EXTEND'
 uc=pn.new('ShaderNodeUVMap');uc.uv_map='PhotoProjection';pm.node_tree.links.new(uc.outputs['UV'],pt.inputs['Vector']);emit_material(pm,pt.outputs['Color'])
 # Fade projection at grazing angles, occlusions and the photograph perimeter.
 # The fallback samples the original inferred atlas explicitly, independent of active UV layers.
 oldtex=pn.new('ShaderNodeTexImage');oldtex.image=oldcolor.node.image
 olduv=pn.new('ShaderNodeUVMap');olduv.uv_map='AtlasUV';pm.node_tree.links.new(olduv.outputs['UV'],oldtex.inputs['Vector'])
 bvh=BVHTree.FromObject(ob,bpy.context.evaluated_depsgraph_get());camera=Vector(eye)
 weights=np.zeros(len(mesh.vertices),dtype=np.float32)
 for v in mesh.vertices:
  direction=camera-v.co;facing=v.normal.dot(direction.normalized());mx,my=uv[v.index];ix=int(mx*iw);iy=int(my*ih)
  if not(4<=ix<iw-4 and 4<=iy<ih-4) or np.max(pp[iy-3:iy+4,ix-3:ix+4,:3],axis=2).min()<.035:continue
  hit,_,_,_=bvh.ray_cast(camera,-direction.normalized())
  if hit is not None and (hit-v.co).length<.028:weights[v.index]=np.clip((facing-.10)/.60,0,1)
 neighbors=[[] for _ in weights]
 for e in mesh.edges:
  a,b=e.vertices;neighbors[a].append(b);neighbors[b].append(a)
 for _ in range(6):weights=np.array([.55*w+.45*np.mean(weights[n]) if n else w for w,n in zip(weights,neighbors)],dtype=np.float32)
 attr=mesh.color_attributes.new(name='PhotoWeight',type='FLOAT_COLOR',domain='POINT')
 for i,w in enumerate(weights):attr.data[i].color=(float(w),float(w),float(w),1)
 vn=pn.new('ShaderNodeVertexColor');vn.layer_name='PhotoWeight';mix=pn.new('ShaderNodeMixRGB')
 pm.node_tree.links.new(vn.outputs['Color'],mix.inputs[0]);pm.node_tree.links.new(oldtex.outputs['Color'],mix.inputs[1]);pm.node_tree.links.new(pt.outputs['Color'],mix.inputs[2]);emit_material(pm,mix.outputs['Color'])
 mesh.materials.clear();mesh.materials.append(pm)
 for p in mesh.polygons:p.material_index=0
 count=int(sum(np.mean(weights[list(p.vertices)])>.5 for p in mesh.polygons))
 # Bake both projected faces and the inferred unseen surfaces into a portable 4K atlas.
 target=bpy.data.images.new(f'SHI-{side}_photo_atlas_4k',width=4096,height=4096,alpha=False)
 for m in [pm]:
  node=m.node_tree.nodes.new('ShaderNodeTexImage');node.image=target;m.node_tree.nodes.active=node;node.select=True
 mesh.uv_layers.active=atlas;atlas.active_render=True
 s=bpy.context.scene;s.render.engine='CYCLES';s.cycles.samples=1;s.render.bake.margin=12;s.render.bake.use_clear=True
 bpy.ops.object.bake(type='EMIT')
 target.filepath_raw=str(OUT/f'SHI-{side}-photographic-atlas.jpg');target.file_format='JPEG';target.save()
 # Replace temporary projection shaders with one standard rough stone material.
 final=bpy.data.materials.new(f'SHI-{side}_photographic_stone');final.use_nodes=True
 fn=final.node_tree.nodes;tex=fn.new('ShaderNodeTexImage');tex.image=target;final.node_tree.links.new(tex.outputs['Color'],fn.get('Principled BSDF').inputs['Base Color'])
 fn.get('Principled BSDF').inputs['Roughness'].default_value=.94
 mesh.materials.clear();mesh.materials.append(final)
 for p in mesh.polygons:p.material_index=0;p.use_smooth=True
 mesh.uv_layers.remove(proj)
 mesh.color_attributes.remove(attr)
 # Actual overall dimensions include the base: 2.13 × .93 × 1.61/1.59 m.
 lo=verts.min(0);span=np.ptp(verts,axis=0);scale=np.array([2.13,.93,totalHeight])/span
 rotation=Matrix.Rotation(-math.pi/2 if side=='W' else math.pi/2,4,'Z')
 for v in mesh.vertices:
  pos=(np.array(v.co)-lo)*scale-np.array([1.065,.465,0]);v.co=rotation@Vector(pos)
 ob['reconstruction']='单张照片辅助重建；可见面使用原照投影贴图；未拍摄面为近似推断，非扫描测绘'
 ob['photograph']=cal['sourceId'];ob['source_silhouette_iou']=float(cal['silhouetteIoU'])
 dest=stone_file(f'SHI-{side}', 'models/gallery');dest.mkdir(parents=True,exist_ok=True)
 path=dest/'photo-reconstruction-20260910.glb'
 bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_image_format='JPEG',export_jpeg_quality=95,export_extras=True)
 print(side,'original photo polygons',count,'of',len(mesh.polygons),'GLB',path.stat().st_size,flush=True)
 (OUT/f'SHI-{side}-mapping.json').write_text(json.dumps({'calibration':cal,'photoPolygons':count,'polygons':len(mesh.polygons),'dimensions_m':[.93,totalHeight,2.13],'texture_size':[4096,4096],'method':'Hyper3D Rodin inferred single-image mesh; original photo reprojected onto visible surfaces; unseen faces approximate'},ensure_ascii=False,indent=2),encoding='utf-8')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'lions-final.blend'))
