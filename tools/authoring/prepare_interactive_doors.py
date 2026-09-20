"""Split the delivered courtyard's existing door leaves and close them at their hinges.

Only door leaf buffers change. Walls, gatehouse correction, archive and UVs stay intact.
The appended GLB nodes carry interaction metadata; rerunning an updated asset is a no-op.
"""
from pathlib import Path
import hashlib
import json
import math
import struct
import numpy as np

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT = Path(__file__).resolve().parents[2]
ASSET = ROOT / 'resources/scenes/models/courtyard-architecture-20260910.glb'
OUT = ROOT / 'resources/authoring/interactive-doors'
SQ = math.sqrt(.5)
GX, GZ = (423.1-687)*.17639, (124.6-314)*.17639


def prepare():
    raw = ASSET.read_bytes()
    size = struct.unpack_from('<I', raw, 12)[0]
    doc = json.loads(raw[20:20+size])
    if any(n.get('extras', {}).get('door') for n in doc['nodes']):
        print('Interactive doors already prepared'); return
    OUT.mkdir(parents=True, exist_ok=True)
    backup = OUT / 'before/courtyard-architecture.glb'
    if not backup.exists(): backup.write_bytes(raw)
    blob = bytearray(raw[28+size:])
    specs = []
    def add(building, label, cx, cz, orient, floor, u, v, width, height, title):
        specs.append(dict(id=f'door-{len(specs)+1:02}', building=building, label=label,
                          cx=cx, cz=cz, orient=orient, floor=floor, u=u, v=v, w=width, h=height, title=title))
    for side in [-1, 1]:
        add('01_阙室','中门',39.34,0,'front',.407115,0,side*4.835,1.96,3.1,'阙室'+('前门' if side<0 else '后门'))
        add('02_后展厅','展厅中门',77.4,0,'front',.29016,0,side*5.70,3,3,'后展厅'+('前门' if side<0 else '后门'))
    add('03_西长廊','中部格扇门',58.62,14.88,'west',.209924,0,-1.19,3.4,2.4,'西长廊格扇门')
    add('04_北管理房','木门',41.2,22.86,'back',.30,0,-3.27,1.3,2.15,'北管理房')
    for i,u in enumerate([-10.84/3,0,10.84/3]):
        add('05_南管理房','木门',58.84,23.85,'back',.30,u,-3.79,1.25,2.15,f'南管理房第{i+1}间')
    add('06_卫生间','木门',18.82,24.39,'west',.30,0,-3.,1.3,2.15,'卫生间')
    add('07_售票房','临甬路侧门',3.06,-6.81,'west',.30,0,2.64,1.3,2.15,'门房临甬路侧门')
    add('08_子母阙式大门','红框铁栅门',1.49,0,'front',0,0,-.20,3.75,4.2,'院落大门')

    def point(s,u,v,h):
        if s['orient']=='front': a,b=s['cx']+v,s['cz']+u
        elif s['orient']=='back': a,b=s['cx']-v,s['cz']-u
        else: a,b=s['cx']-u,s['cz']+v
        return np.array([GX+SQ*(a-b),h+s['floor'],GZ+SQ*(a+b)])
    def local(s, p):
        a=((p[...,0]-GX)+(p[...,2]-GZ))/(2*SQ)
        b=((p[...,2]-GZ)-(p[...,0]-GX))/(2*SQ)
        if s['orient']=='front': return np.stack([b-s['cz'],a-s['cx']],axis=-1)
        if s['orient']=='back': return np.stack([s['cz']-b,s['cx']-a],axis=-1)
        return np.stack([s['cx']-a,b-s['cz']],axis=-1)
    dtypes={5126:'<f4',5125:'<u4',5123:'<u2',5121:'u1'}
    dims={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}
    def read(index):
        a=doc['accessors'][index];v=doc['bufferViews'][a['bufferView']]
        dtype=np.dtype(dtypes[a['componentType']]);width=dims[a['type']]
        return np.ndarray((a['count'],width),dtype=dtype,buffer=blob,
            offset=v.get('byteOffset',0)+a.get('byteOffset',0),
            strides=(v.get('byteStride',dtype.itemsize*width),dtype.itemsize)).copy()
    def append(values,kind,component=5126):
        values=np.asarray(values,dtype=dtypes[component]);padding=(-len(blob))%4;blob.extend(b'\0'*padding)
        offset=len(blob);blob.extend(values.tobytes())
        view=len(doc['bufferViews']);doc['bufferViews'].append(dict(buffer=0,byteOffset=offset,byteLength=values.nbytes))
        a=dict(bufferView=view,componentType=component,count=len(values),type=kind)
        if kind=='VEC3': a.update(min=values.min(axis=0).tolist(),max=values.max(axis=0).tolist())
        index=len(doc['accessors']);doc['accessors'].append(a);return index
    def rotate(values,angle):
        c,s=math.cos(angle),math.sin(angle);out=values.copy()
        out[:,0]=c*values[:,0]+s*values[:,2];out[:,2]=-s*values[:,0]+c*values[:,2]
        return out

    removed=[];parts={};source_vertices=0
    for ni,node in enumerate(doc['nodes']):
        name=node.get('name','')
        if not any(f'_{word}_' in name for word in ['敞开门扇','门扇横档','竖栅']): continue
        matches=[s for s in specs if name.startswith(s['building']+'_'+s['label']+'_')]
        if not matches: continue
        assert not any(k in node for k in ['matrix','translation','rotation','scale']), name
        removed.append(ni)
        candidates=[(s,side,s['u']+side*s['w']/2-side*math.cos(math.radians(72))*(s['w']/2-.06)/2,
                     s['v']-math.sin(math.radians(72))*(s['w']/2-.06)/2) for s in matches for side in [-1,1]]
        for primitive in doc['meshes'][node['mesh']]['primitives']:
            attrs={k:read(v) for k,v in primitive['attributes'].items()}
            indices=read(primitive['indices']).reshape(-1,3)
            uv=local(matches[0],attrs['POSITION'][indices].mean(axis=1))
            distance=np.stack([((uv-np.array([u,v]))**2).sum(axis=1) for _,_,u,v in candidates])
            assignment=distance.argmin(axis=0)
            for ci,(spec,side,_,_) in enumerate(candidates):
                triangles=indices[assignment==ci]
                if not len(triangles): continue
                ids,inverse=np.unique(triangles,return_inverse=True)
                subset={k:v[ids].copy() for k,v in attrs.items()}
                origin=point(spec,spec['u']+side*spec['w']/2,spec['v'],0)
                angle=side*math.radians(72)
                subset['POSITION']=rotate(subset['POSITION']-origin,-angle)
                for k in ['NORMAL','TANGENT']:
                    if k in subset: subset[k]=rotate(subset[k],-angle)
                parts.setdefault((spec['id'],side),[]).append((subset,inverse,primitive['material']))
                source_vertices+=len(ids)
    assert len(removed)==16, f'Unexpected door mesh count: {len(removed)}'
    assert len(parts)==24
    new_nodes=[];report=[]
    for spec in specs:
        for side in [-1,1]:
            pieces=parts[(spec['id'],side)]
            assert len({p[2] for p in pieces})==1
            keys=set(pieces[0][0]);assert all(set(p[0])==keys for p in pieces)
            attrs={k:np.concatenate([p[0][k] for p in pieces]) for k in keys}
            indices=[];offset=0
            for subset,idx,_ in pieces:indices.extend((idx+offset).tolist());offset+=len(subset['POSITION'])
            primitive={'attributes':{k:append(v,'VEC'+str(v.shape[1])) for k,v in attrs.items()},
                       'indices':append(np.array(indices).reshape(-1,1),'SCALAR',5125),'material':pieces[0][2]}
            mesh=len(doc['meshes']);doc['meshes'].append({'name':spec['title']+str(side),'primitives':[primitive]})
            origin=point(spec,spec['u']+side*spec['w']/2,spec['v'],0)
            direction=point(spec,1,0,0)-point(spec,0,0,0)
            width=spec['w']/2-.06;center=direction*(-side*width/2);center[1]=(spec['h']-.12)/2
            door=dict(id=spec['id'],label=spec['title'],side=side,open_angle=side*math.radians(82),
                      center=center.tolist(),width=width,height=spec['h']-.12,yaw=math.atan2(-direction[2],direction[0]))
            node=dict(name=spec['title']+('_左门扇' if side<0 else '_右门扇'),mesh=mesh,
                      translation=origin.tolist(),extras={'building':spec['building'],'arch_role':'opening','door':door})
            new_nodes.append(len(doc['nodes']));doc['nodes'].append(node)
            report.append({**door,'hinge':origin.tolist()})
    for node in doc['nodes']:
        if 'children' in node: node['children']=[i for i in node['children'] if i not in removed]
    for scene in doc['scenes']:scene['nodes']=[i for i in scene['nodes'] if i not in removed]+new_nodes
    doc['buffers'][0]['byteLength']=len(blob)
    encoded=json.dumps(doc,ensure_ascii=False,separators=(',',':')).encode('utf-8');encoded+=b' '*((-len(encoded))%4)
    blob.extend(b'\0'*((-len(blob))%4))
    out=struct.pack('<III',0x46546c67,2,28+len(encoded)+len(blob))+struct.pack('<I4s',len(encoded),b'JSON')+encoded+struct.pack('<I4s',len(blob),b'BIN\0')+blob
    ASSET.write_bytes(out)
    result={'portals':12,'leaves':24,'default':'closed','original_sha256':hashlib.sha256(raw).hexdigest(),
            'sha256':hashlib.sha256(out).hexdigest(),'removed_nodes':removed,'doors':report}
    (OUT/'doors.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    manifest=ROOT / 'src/frontend/src/archive/three/courtyardArchitectureManifest.json'
    data=json.loads(manifest.read_text(encoding='utf-8'));data['asset_revision']='doors-20260911-v1'
    data['interactive_doors']={'portals':12,'leaves':24,'default':'closed'}
    manifest.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(f'Closed 12 portals / 24 leaves; unchanged source buffers, appended {source_vertices} door vertices.')


if __name__=='__main__':prepare()
