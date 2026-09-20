"""Build the registered, lightweight surrounding environment in Blender.

blender --background --factory-startup --python tools/authoring/build_site_context_blender.py
Input: resources/georeferencing/site-context.json. Writes only the context asset and
its editable source; existing courtyard/centre GLBs and stone layouts are untouched.
"""
from pathlib import Path
import bpy
import json
import math
import struct
import importlib.util
import numpy as np
from mathutils import Vector

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT / 'resources/authoring/site-context'
for folder in ['blender','textures','renders']:(OUT/folder).mkdir(exist_ok=True,parents=True)
data=json.loads((ROOT / 'resources/georeferencing/site-context.json').read_text('utf-8'))
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
col=bpy.data.collections.new('周边环境_黄线范围');bpy.context.scene.collection.children.link(col)
def move(obj):
    for c in list(obj.users_collection):c.objects.unlink(obj)
    col.objects.link(obj);obj['siteContext']=True
    return obj
def linear(v):
    v=v/255;return v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4
COLORS={'grass':(133,143,91),'lawn':(98,111,82),'meadow':(116,131,88),'field':(141,146,108),'furrow':(126,137,95),
 'asphalt':(86,94,96),'lane':(114,121,119),'concrete':(183,181,169),'paving':(203,194,169),
 'shoulder':(166,162,140),'dirt':(174,157,119),'yard':(173,168,152),'kerb':(189,185,168),
 'marking':(227,222,193),'brick':(160,151,133),'plinth':(117,116,108),'wall':(149,143,127),
 'roof_red':(129,82,63),'roof_grey':(92,100,101),'roof_blue':(87,119,141),
 'roof_seam':(77,81,80),'window':(67,89,92),'frame':(122,115,99),'trunk':(87,78,61),
 'leaf0':(75,100,65),'leaf1':(86,108,66),'leaf2':(99,121,75),'leaf3':(62,90,61)}
M={}
for name,rgb in COLORS.items():
    m=bpy.data.materials.new('环境_'+name);m.diffuse_color=(*[linear(v) for v in rgb],1);m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=m.diffuse_color
    p.inputs['Roughness'].default_value=.93 if name!='window' else .24
    if name=='window':p.inputs['Metallic'].default_value=.3
    M[name]=m

# Use the neighbouring lawns' own palette, smoothly interpolated at the
# interface. Vertex colours export directly to glTF without a repeating noise map.
center_bytes=(ROOT / 'resources/scenes/models/hanwenhua-center.glb').read_bytes()
center_doc=json.loads(center_bytes[20:20+struct.unpack_from('<I',center_bytes,12)[0]])
center_grass=next(m for m in center_doc['materials'] if m.get('name','').startswith('地被草坪'))
center_tone=np.array(center_grass['pbrMetallicRoughness']['baseColorFactor'][:3])
# Mean of the retained courtyard grass texture palette in buildSite.ts.
courtyard_tone=np.array([linear(v) for v in COLORS['lawn']])
lawn_nodes=M['lawn'].node_tree.nodes
lawn_color=lawn_nodes.new('ShaderNodeVertexColor');lawn_color.layer_name='GrassTone'
M['lawn'].node_tree.links.new(lawn_color.outputs['Color'],lawn_nodes.get('Principled BSDF').inputs['Base Color'])
M['lawn']['color_reference']='原传承中心草坪与现有武氏祠草坪色系；无条纹、无斑驳贴图'

def boundary_distance(point,boundary):
    starts=np.asarray(boundary[:-1]);segments=np.asarray(boundary[1:])-starts
    factors=np.clip(np.sum((point-starts)*segments,axis=1)/np.maximum(np.sum(segments*segments,axis=1),1e-10),0,1)
    return np.min(np.linalg.norm(point-starts-segments*factors[:,None],axis=1))

def lawn_tone(x,z):
    point=np.array([x,z])
    dc=boundary_distance(point,data['centerBoundaryWorldXZ'])
    dw=boundary_distance(point,data['courtyardBoundaryWorldXZ'])
    amount=dc/max(dc+dw,1e-6)
    return (*((1-amount)*center_tone+amount*courtyard_tone),1)
def noise_image(key,scale=1):
    # Small seamless texture made as a Blender asset; all surfaces use metric UVs.
    rng=np.random.default_rng(37+len(key));n=256
    fine=rng.random((n,n),dtype=np.float32)-.5
    yy,xx=np.mgrid[:n,:n]
    broad=(np.sin(xx*np.pi/32)*np.cos(yy*np.pi/64)+np.sin((xx+yy)*np.pi/64))*.018
    rgb=np.array(COLORS[key],dtype=np.float32)/255
    arr=np.ones((n,n,4),dtype=np.float32)
    arr[:,:,:3]=np.clip(rgb[None,None,:]+(fine*.07+broad)[...,None]*scale,0,1)
    if key=='brick':
        mortar=(yy%32<2)|((xx+(yy//32%2)*32)%64<2)
        arr[mortar,:3]=np.array([.68,.66,.60])
    if key=='paving':
        mortar=(yy%64<2)|((xx+(yy//64%2)*32)%64<2)
        arr[mortar,:3]*=.83
    # Blender's image pixel API stores scene-linear values. Convert the intended
    # sRGB palette before saving, so PNG/glTF do not brighten it a second time.
    rgb_pixels=arr[:,:,:3]
    arr[:,:,:3]=np.where(rgb_pixels<=.04045,rgb_pixels/12.92,((rgb_pixels+.055)/1.055)**2.4)
    im=bpy.data.images.new('环境纹理_'+key,n,n,alpha=True);im.pixels.foreach_set(arr.ravel());im.update()
    im.filepath_raw=str(OUT/'textures'/f'{key}.png');im.file_format='PNG';im.save();im.pack()
    nodes=M[key].node_tree.nodes;p=nodes.get('Principled BSDF');tex=nodes.new('ShaderNodeTexImage');tex.image=im
    M[key].node_tree.links.new(tex.outputs['Color'],p.inputs['Base Color'])
for key in ['grass','field','meadow','asphalt','concrete','brick','paving','yard']:noise_image(key,.6 if key=='brick' else 1)
def mesh(name,verts,faces,material):
    me=bpy.data.meshes.new(name);me.from_pydata(verts,[],faces);me.update()
    ob=bpy.data.objects.new(name,me);col.objects.link(ob);ob['siteContext']=True;me.materials.append(M[material])
    uv=me.uv_layers.new(name='UVMap')
    # World metric UVs on horizontal surfaces; local face projections on walls.
    repeat=18 if material in ['grass','field','meadow'] else 6 if material=='asphalt' else 4
    for poly in me.polygons:
        ax=max(range(3),key=lambda a:abs(poly.normal[a]));axes=[a for a in range(3) if a!=ax]
        for li in poly.loop_indices:
            v=me.vertices[me.loops[li].vertex_index].co;uv.data[li].uv=(v[axes[0]]/repeat,v[axes[1]]/repeat)
    return ob
def slab(name,tris,y,material):
    verts=[];faces=[]
    for tri in tris:
        i=len(verts);vs=[(x,-z,y) for x,z in tri]
        a,b,c=map(Vector,vs)
        if (b-a).cross(c-a).z<0:vs.reverse()
        verts.extend(vs);faces.append((i,i+1,i+2))
    ob=mesh(name,verts,faces,material)
    if material=='lawn':
        colors=ob.data.color_attributes.new(name='GrassTone',type='FLOAT_COLOR',domain='POINT')
        for item,vertex in zip(colors.data,ob.data.vertices):item.color=lawn_tone(vertex.co.x,-vertex.co.y)
        ob.data.color_attributes.active_color=colors
    return ob
for surface in data['surfaces']:
    ob=slab(surface['name'],surface['triangles'],surface['y'],surface['material'])
    ob['source']=surface['source'];ob['context_role']='ground'
def extrude(name,footprint,tris,height,mat):
    p=footprint[:-1] if footprint[0]==footprint[-1] else footprint
    verts=[(x,-z,h) for h in [0,height] for x,z in p];n=len(p)
    faces=[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    ob=mesh(name,verts,faces,mat)
    slab(name+'_顶面',tris,height,mat)
    return ob
def cube(name,position,size,material,angle=0):
    cx,cy,cz=position;w,d,h=size;c,s=math.cos(angle),math.sin(angle)
    verts=[(cx+c*x-s*y,cy+s*x+c*y,cz+z) for z in [-h/2,h/2] for x,y in [(-w/2,-d/2),(w/2,-d/2),(w/2,d/2),(-w/2,d/2)]]
    return mesh(name,verts,[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)],material)
def rod(name,a,b,radius,material,vertices=7,top=None):
    a,b=Vector(a),Vector(b);delta=b-a
    direction=delta.normalized();u=direction.cross(Vector((1,0,0)) if abs(direction.z)>.9 else Vector((0,0,1))).normalized();v=direction.cross(u)
    verts=[p+r*(u*math.cos(i*2*math.pi/vertices)+v*math.sin(i*2*math.pi/vertices)) for p,r in [(a,radius),(b,radius*.7 if top is None else top)] for i in range(vertices)]
    faces=[tuple(reversed(range(vertices))),tuple(range(vertices,vertices*2))]+[(i,(i+1)%vertices,(i+1)%vertices+vertices,i+vertices) for i in range(vertices)]
    return mesh(name,verts,faces,material)
print('CONTEXT_GROUND',len(data['surfaces']),flush=True)
for b in data['buildings']:
    name=b['name'];p=b['footprint'][:-1];h=b['height']
    ob=extrude(name,p,b['triangles'],h,'brick');ob['source']=b['source'];ob['storeys']=b['storeys'];ob['heightSource']=b['heightSource']
    coords=np.array([[x,-z] for x,z in p]);center=coords.mean(axis=0)
    edges=np.roll(coords,-1,axis=0)-coords;main=edges[np.argmax(np.linalg.norm(edges,axis=1))];u=main/np.linalg.norm(main);v=np.array([-u[1],u[0]])
    uv=np.column_stack([(coords-center)@u,(coords-center)@v]);lo=uv.min(axis=0);hi=uv.max(axis=0)
    width,length=hi-lo;ridge=(lo[1]+hi[1])/2;rise=min(1.65,(hi[1]-lo[1])*.16)
    def roofpoint(a,c,zz):
        q=center+u*a+v*c;return (q[0],q[1],zz)
    # Sheds are shallow pitched; complex footprints keep their CAD outline.
    roofverts=[];rooffaces=[]
    for t in b['triangles']:
        i=len(roofverts)
        for x,z in t:
            q=np.array([x,-z]);r=(q-center)@v
            roofverts.append((x,-z,h+.13+rise*max(0,1-abs(r-ridge)/max((hi[1]-lo[1])/2,.1))))
        rooffaces.append((i,i+2,i+1))
    if len(p)==4:
        rv=[roofpoint(a,c,zz) for a,c,zz in [(lo[0]-.22,lo[1]-.25,h+.13),(hi[0]+.22,lo[1]-.25,h+.13),
            (hi[0]+.22,hi[1]+.25,h+.13),(lo[0]-.22,hi[1]+.25,h+.13),
            (lo[0]-.22,ridge,h+.13+rise),(hi[0]+.22,ridge,h+.13+rise)]]
        mesh(name+'_坡屋顶',rv,[(0,1,5,4),(4,5,2,3),(0,4,3),(1,2,5)],'roof_'+b['roof'])
        for a in np.arange(lo[0],hi[0],.55):
            for side in [lo[1],hi[1]]:
                rod('屋面瓦垄',roofpoint(a,side,h+.16),roofpoint(a,ridge,h+.16+rise),.026,'roof_seam',5)
        rod('屋脊',roofpoint(lo[0]-.25,ridge,h+.16+rise),roofpoint(hi[0]+.25,ridge,h+.16+rise),.085,'roof_'+b['roof'],7)
    else:mesh(name+'_轮廓屋顶',roofverts,rooffaces,'roof_'+b['roof'])
    # Windows and masonry base follow the actual footprint edges. They are closed
    # facade details, with no invented interior rooms in the surrounding backdrop.
    for i,a in enumerate(coords):
        c=coords[(i+1)%len(coords)];delta=c-a;L=np.linalg.norm(delta)
        if L<1:continue
        axis=delta/L;normal=np.array([-axis[1],axis[0]]);mid=(a+c)/2
        if np.dot(normal,mid-center)<0:normal=-normal
        ang=math.atan2(axis[1],axis[0])
        cube('勒脚',(*mid,.28),(L,.08,.55),'plinth',ang)
        for level in range(b['storeys']):
            for dist in np.arange(1.6,L-.8,3.4):
                q=a+axis*dist+normal*.055;z=1.75+level*2.8
                cube('窗框',(*q,z),(1.15,.08,1.15),'frame',ang)
                q+=normal*.047
                cube('窗玻璃',(*q,z),(1.01,.025,1.01),'window',ang)
                cube('窗竖梃',(*q,z),(.045,.04,1.02),'frame',ang)
print('CONTEXT_BUILDINGS',len(data['buildings']),flush=True)
for detail in data['details']:extrude(detail['name'],detail['footprint'],detail['triangles'],detail['height'],'wall')
tree_spec=importlib.util.spec_from_file_location('blender_context_vegetation',ROOT / 'tools/authoring/blender_context_vegetation.py')
tree_module=importlib.util.module_from_spec(tree_spec);tree_spec.loader.exec_module(tree_module)
vegetation=tree_module.build_vegetation(data,col,M,rod,center_doc,center_bytes)
# Merge by material and broad spatial region, keeping draw calls bounded while
# allowing distant context chunks to be culled. No live asset is imported here.
print('CONTEXT_TREES',len(data['trees']),flush=True)
groups={}
for ob in list(col.objects):
    if ob.type!='MESH' or ob.get('tree_instance'):continue
    mat=ob.data.materials[0].name if ob.data.materials else ''
    zone='south' if ob.location.y<150 else 'north'
    if ob.get('context_role')=='ground':zone='ground'
    groups.setdefault((mat,zone),[]).append(ob)
for (mat,zone),objects in groups.items():
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objects:ob.select_set(True)
    bpy.context.view_layer.objects.active=objects[0]
    # A crown mesh is shared by many trees, including other spatial chunks. Make
    # the join target unique so joining one chunk cannot enlarge the next one.
    if objects[0].data.users>1:objects[0].data=objects[0].data.copy()
    if len(objects)>1:bpy.ops.object.join()
    ob=bpy.context.object;ob.name=f'周边_{zone}_{mat}';ob['siteContext']=True;ob['context_role']='ground' if zone=='ground' else 'landscape'
    # Imported surfaces can have either source winding; orient solid exterior faces.
    bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.mesh.normals_make_consistent(inside=False);bpy.ops.object.mode_set(mode='OBJECT')
scene=bpy.context.scene;scene['site_context_version']=data['version'];scene['sources']=json.dumps(data['sources'],ensure_ascii=False)
scene['reconstruction_limits']='周边建筑轮廓来自 CAD；立面高度与树木按航拍作示意。'
scene.world.color=(.65,.72,.82)
triangles=sum(len(o.data.loop_triangles) if o.data.loop_triangles else sum(len(p.vertices)-2 for p in o.data.polygons) for o in col.objects if o.type=='MESH')
bpy.ops.object.select_all(action='DESELECT')
for ob in col.objects:ob.select_set(True)
asset=ROOT / 'resources/scenes/models/site-context-20260911.glb'
bpy.ops.export_scene.gltf(filepath=str(asset),export_format='GLB',use_selection=True,export_extras=True,export_cameras=False,export_lights=False,export_gpu_instances=True)
bpy.context.preferences.filepaths.save_version=0
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'blender/周边环境_黄线范围.blend'))
asset_bytes=asset.read_bytes();asset_doc=json.loads(asset_bytes[20:20+struct.unpack_from('<I',asset_bytes,12)[0]])
instance_nodes=[n for n in asset_doc['nodes'] if 'EXT_mesh_gpu_instancing' in n.get('extensions',{})]
assert len(instance_nodes)==vegetation['crownPrototypes'],'Tree crowns must remain GPU instances'
report=dict(meshes=len(asset_doc['meshes']),triangles=triangles,bytes=asset.stat().st_size,buildings=data['stats']['buildings'],trees=data['stats']['trees'],
    vegetation=vegetation,instancedDraws=len(instance_nodes),
    uniqueTriangles=sum(asset_doc['accessors'][p['indices']]['count']//3 for m in asset_doc['meshes'] for p in m['primitives']))
(OUT/'asset-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print('CONTEXT_ASSET',json.dumps(report),flush=True)
