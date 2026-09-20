"""Self-contained GLBs for unscanned west-gallery objects; photo slabs, not scans."""
from pathlib import Path
import io,json,math,struct,sys
from PIL import Image
sys.stdout.reconfigure(encoding='utf-8')
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2]
layout=json.loads((ROOT/'data/layouts/xcl-default.json').read_text(encoding='utf-8'))['stones']
catalogue=json.loads((ROOT / 'src/frontend/src/archive/three/catalogueMap.json').read_text(encoding='utf-8'))['items']
keys={r['catalogue_no']:r['legacy_id'] for r in catalogue}

def triangles(poly):
    cross=lambda a,b,c:(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
    indices=list(range(len(poly)))
    if sum(poly[i][0]*poly[(i+1)%len(poly)][1]-poly[(i+1)%len(poly)][0]*poly[i][1] for i in indices)<0:indices.reverse()
    out=[]
    while len(indices)>3:
        for i,b in enumerate(indices):
            a,c=indices[i-1],indices[(i+1)%len(indices)]
            if cross(poly[a],poly[b],poly[c])<=0:continue
            if any(all(v>=-1e-10 for v in [cross(poly[a],poly[b],poly[p]),cross(poly[b],poly[c],poly[p]),cross(poly[c],poly[a],poly[p])]) for p in indices if p not in (a,b,c)):continue
            out.append((a,b,c));indices.pop(i);break
        else:raise ValueError('Cannot triangulate photographed perimeter')
    return out+[tuple(indices)]

def export(s):
    L,H,T=s['L'],s['H'],s['T']
    poly=[((p[0]-.5)*L,(.5-p[1])*H) for p in (s.get('profile') or [[0,1],[1,1],[1,0],[0,0]])]
    tri=triangles(poly)
    arrays=[[],[]]
    def face(material,points,normal):
        for x,y,z in points:arrays[material].append((x,y,z,*normal,x/L+.5,.5-y/H))
    for t in tri:
        face(1,[(poly[i][0],poly[i][1],T/2) for i in t],(0,0,1))
        face(0,[(poly[i][0],poly[i][1],-T/2) for i in reversed(t)],(0,0,-1))
    # Orient perimeter CCW for outward side normals.
    boundary=list(poly)
    if sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(boundary,boundary[1:]+boundary[:1]))<0:boundary.reverse()
    for a,b in zip(boundary,boundary[1:]+boundary[:1]):
        dx,dy=b[0]-a[0],b[1]-a[1];norm=math.hypot(dx,dy);n=(dy/norm,-dx/norm,0)
        A=(*a,-T/2);B=(*b,-T/2);C=(*b,T/2);D=(*a,T/2)
        face(0,[A,B,C,A,C,D],n)
    blob=bytearray();views=[];accessors=[];primitives=[]
    def buffer(content):
        while len(blob)%4:blob.append(0)
        idx=len(views);views.append({'buffer':0,'byteOffset':len(blob),'byteLength':len(content)});blob.extend(content);return idx
    for mat,verts in enumerate(arrays):
        attrs={}
        for name,offset,n in [('POSITION',0,3),('NORMAL',3,3),('TEXCOORD_0',6,2)]:
            values=[v[offset:offset+n] for v in verts]
            view=buffer(b''.join(struct.pack('<'+'f'*n,*v) for v in values))
            accessor={'bufferView':view,'componentType':5126,'count':len(values),'type':'VEC'+str(n)}
            if name=='POSITION':accessor.update(min=[min(v[k] for v in values) for k in range(n)],max=[max(v[k] for v in values) for k in range(n)])
            attrs[name]=len(accessors);accessors.append(accessor)
        primitives.append({'attributes':attrs,'material':mat,'mode':4})
    im=Image.open(ROOT / 'tools/viewers/placement' / s['photo']).convert('RGB');buf=io.BytesIO();im.save(buf,format='JPEG',quality=90)
    imgview=buffer(buf.getvalue())
    gltf={'asset':{'version':'2.0','generator':'WSC photograph slab; approximate display geometry'},'scene':0,'scenes':[{'nodes':[0]}],
          'nodes':[{'mesh':0,'name':s['id']+' '+s['name']}],'meshes':[{'primitives':primitives}],
          'materials':[{'pbrMetallicRoughness':{'baseColorFactor':[.34,.31,.27,1],'metallicFactor':0,'roughnessFactor':1}},
                       {'pbrMetallicRoughness':{'baseColorTexture':{'index':0},'metallicFactor':0,'roughnessFactor':1},'extensions':{'KHR_materials_unlit':{}}}],
          'textures':[{'source':0}],'images':[{'bufferView':imgview,'mimeType':'image/jpeg'}],
          'extensionsUsed':['KHR_materials_unlit'],'buffers':[{'byteLength':len(blob)}],'bufferViews':views,'accessors':accessors}
    js=json.dumps(gltf,ensure_ascii=False,separators=(',',':')).encode();js+=b' '*((-len(js))%4);blob+=b'\0'*((-len(blob))%4)
    content=struct.pack('<III',0x46546c67,2,12+8+len(js)+8+len(blob))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(blob),0x004e4942)+blob
    folder=stone_dir(keys[s['id']]);model=folder/'models/gallery';model.mkdir(exist_ok=True)
    name='photographic-slab.glb';(model/name).write_bytes(content)
    meta=json.loads((folder/'metadata/catalogue.json').read_text(encoding='utf-8'))
    meta['preferred_model']=name
    meta['model_reconstruction']={'label':'照片贴图模型','description':'完整实物照片覆盖石刻正面；体块厚度与轮廓用于陈列展示，浮雕深度未作三维测量。',
        'measurement_model':False,'view':[.16,.12,1.5],'source_count':1}
    if meta.get('size_source')=='measured':
        meta['model_reconstruction']['description']='按实测外形尺寸制作体块，完整实物照片覆盖正面；浮雕深度未作三维测量。'
    elif s['id']=='武071':
        meta['model_reconstruction']['description']='实物照片覆盖正面；实测尺寸待补，展示体块按照片比例设置，浮雕深度未作三维测量。'
    (folder/'metadata/catalogue.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8')
    return {'id':s['id'],'model':str(model/name),'bytes':len(content)}

if __name__=='__main__':
    selected=set(sys.argv[1:])
    results=[export(s) for s in layout if s['id']!='武067' and (not selected or s['id'] in selected)]
    report=ROOT / 'resources/authoring/catalogue-preparation/xcl-models.json'
    previous=json.loads(report.read_text(encoding='utf-8')) if selected and report.exists() else []
    merged={r['id']:r for r in previous+results}
    report.write_text(json.dumps(list(merged.values()),ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'photo_models':len(results),'bytes':sum(r['bytes'] for r in results)}))
