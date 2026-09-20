"""Detailed Blender vegetation, sharing the centre's actual crown geometry.

Only tree transforms from the reviewed vegetation manifest are used. Linked
crowns export as EXT_mesh_gpu_instancing, rather than duplicating leaf buffers.
"""
import math
import random
import struct
import bpy
import numpy as np
from mathutils import Vector


def build_vegetation(data, collection, materials, rod, document, glb_bytes):
    json_length=struct.unpack_from('<I',glb_bytes,12)[0]
    binary=memoryview(glb_bytes)[28+json_length:]
    def accessor(index):
        a=document['accessors'][index];view=document['bufferViews'][a['bufferView']]
        dtype=np.dtype({5126:'<f4',5125:'<u4',5123:'<u2',5121:'u1'}[a['componentType']])
        width={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
        start=view.get('byteOffset',0)+a.get('byteOffset',0)
        return np.ndarray((a['count'],width),dtype=dtype,buffer=binary,offset=start,
            strides=(view.get('byteStride',width*dtype.itemsize),dtype.itemsize)).copy()

    def material(source):
        m=bpy.data.materials.new('环境_精细树木_'+source['name']);m.use_nodes=True
        pbr=source['pbrMetallicRoughness'];p=m.node_tree.nodes.get('Principled BSDF')
        m.diffuse_color=pbr.get('baseColorFactor',[1,1,1,1]);p.inputs['Base Color'].default_value=m.diffuse_color
        p.inputs['Roughness'].default_value=pbr.get('roughnessFactor',.9)
        m.use_backface_culling=False
        return m

    # Reuse one existing fine crown per palette colour, including its normals.
    source_crowns={}
    for mesh in document['meshes']:
        if not mesh.get('name','').startswith('实例树冠'):continue
        for prim in mesh['primitives']:
            source_crowns.setdefault(prim['material'],(mesh,prim))
    assert len(source_crowns)==5,'Expected the five existing centre foliage variants'
    prototypes=[];parents=[];sources=[]
    def instance_parent(name):
        parent=bpy.data.objects.new(name,None);collection.objects.link(parent)
        parent['siteContext']=True;parent['context_role']='vegetation'
        parent['tree_style']='centre-fine-leaf';return parent

    for index,(material_id,(source,prim)) in enumerate(sorted(source_crowns.items())):
        positions=accessor(prim['attributes']['POSITION']);normals=accessor(prim['attributes']['NORMAL'])
        low=positions.min(axis=0);high=positions.max(axis=0);height=float(high[1])
        assert height>1 and high[1]-low[1]>1
        positions[:,0]-=(low[0]+high[0])/2;positions[:,2]-=(low[2]+high[2])/2
        positions/=height
        vertices=np.column_stack((positions[:,0],-positions[:,2],positions[:,1]))
        normals=np.column_stack((normals[:,0],-normals[:,2],normals[:,1]))
        faces=accessor(prim['indices']).reshape(-1,3)
        me=bpy.data.meshes.new(f'精细阔叶树冠_{index}')
        me.from_pydata(vertices.tolist(),[],faces.tolist());me.update()
        me.materials.append(material(document['materials'][material_id]))
        for poly in me.polygons:poly.use_smooth=True
        me.normals_split_custom_set_from_vertices(normals.tolist())
        me['source_crown']=source['name'];me['source_model']='hanwenhua-center.glb'
        prototypes.append(me);parents.append(instance_parent(f'精细阔叶树实例_{index}'))
        sources.append(dict(mesh=source['name'],material=document['materials'][material_id]['name'],triangles=len(faces)))

    # Fine sprays retain the six existing cypresses' narrow habit. Their palette
    # and small crossed leaves follow the courtyard's photographed cypresses.
    rng=random.Random(270911);verts=[];faces=[];colors=[]
    palette=[(48,69,39),(59,79,46),(69,89,50),(77,94,56)]
    def linear(v):
        v/=255;return v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4
    for level in range(24):
        t=level/24;z=.16+.79*t;radius=.14*(1-t)**.58+.007
        for branch in range(7):
            angle=branch*math.tau/7+level*2.39996+rng.uniform(-.15,.15)
            for segment in range(6):
                d=radius*(.12+.88*segment/5)*rng.uniform(.87,1.08)
                center=Vector((math.cos(angle)*d,math.sin(angle)*d,z+.04*segment/5+rng.uniform(-.014,.014)))
                for spray in range(3):
                    az=angle+(spray-1)*.72+rng.uniform(-.2,.2)
                    length=rng.uniform(.023,.041)*(1-.4*t);width=length*.36
                    direction=Vector((math.cos(az)*.75,math.sin(az)*.75,.67));side=Vector((-math.sin(az),math.cos(az),.2))
                    n=len(verts);verts.extend([center-direction*length*.35,center-side*width,center+direction*length,center+side*width])
                    faces.extend([(n,n+1,n+2),(n,n+2,n+3)])
                    tone=(*[linear(v) for v in rng.choice(palette)],1);colors.extend([tone]*4)
    cypress=bpy.data.meshes.new('精细柏树叶簇');cypress.from_pydata(verts,[],faces);cypress.update()
    cp_mat=material({'name':'柏树叶簇','pbrMetallicRoughness':{'roughnessFactor':.98}})
    color=cypress.color_attributes.new(name='LeafTone',type='FLOAT_COLOR',domain='POINT')
    for item,tone in zip(color.data,colors):item.color=tone
    cypress.color_attributes.active_color=color
    node=cp_mat.node_tree.nodes.new('ShaderNodeVertexColor');node.layer_name='LeafTone'
    cp_mat.node_tree.links.new(node.outputs['Color'],cp_mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
    cypress.materials.append(cp_mat);cp_parent=instance_parent('精细柏树实例')

    source_bark=next(m for m in document['materials'] if m.get('name','').startswith('树木枝干'))
    materials['trunk']=material(source_bark)
    for index,tree in enumerate(data['trees']):
        rng=random.Random(tree['seed']);x,y,h=tree['x'],-tree['z'],tree['height']
        is_cypress=tree['kind']=='cypress';variant=tree['seed']%len(prototypes)
        ob=bpy.data.objects.new(f'环境精细树冠_{index:03d}',cypress if is_cypress else prototypes[variant])
        collection.objects.link(ob);ob.parent=cp_parent if is_cypress else parents[variant]
        ob.location=(x,y,0);ob.scale=(h,h,h);ob.rotation_euler.z=rng.random()*math.tau
        ob['tree_instance']=True;ob['siteContext']=True;ob['context_role']='vegetation'
        ob['tree_index']=index;ob['height']=h;ob['species']=tree['kind']
        rod('精细树干',(x,y,0),(x,y,h*(.91 if is_cypress else .82)),h*.019,'trunk',9,top=h*.008)
        if not is_cypress:
            for branch in range(7):
                a=ob.rotation_euler.z+branch*2.39996
                tip=(x+math.cos(a)*h*.25,y+math.sin(a)*h*.25,h*(.57+branch*.043))
                rod('精细树枝',(x,y,h*(.4+branch*.036)),tip,h*.008,'trunk',7,top=h*.0028)
    return dict(style='centre-fine-leaf',instances=len(data['trees']),broadleaf=sum(t['kind']=='broadleaf' for t in data['trees']),
        cypress=sum(t['kind']=='cypress' for t in data['trees']),crownPrototypes=6,sourceCrowns=sources)
