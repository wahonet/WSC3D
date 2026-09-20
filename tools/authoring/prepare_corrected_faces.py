"""Reproducible photographic rectification; source originals are read-only."""
from pathlib import Path
import hashlib, json, sys
from PIL import Image
sys.stdout.reconfigure(encoding='utf-8')
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT / 'resources/authoring/stone-reconstruction'
# Coordinates are on the photographed stone perimeter, TL, TR, BR, BL.
# Face labels follow the original publication, not the sometimes misleading filenames.
specs=[
 ('5 武梁祠屋顶前坡','front','979cac78a31fa0717150',(4096,1674),[(.026,.065),(.966,.068),(.972,.907),(.025,.907)],[0,0,1],'屋顶前坡完整雕刻面'),
 ('6 武梁祠屋顶后坡','front','31d0a3bdf9d1d0a05d1f',(4096,1680),[(.024,.071),(.973,.088),(.977,.930),(.019,.920)],[0,0,1],'屋顶后坡完整雕刻面'),
 ('16 前石室后壁小龛西壁','wall','58cecd1749448983009b',(3600,2681),[(.048,.039),(.966,.041),(.967,.959),(.044,.958)],[0,0,1],'小龛西壁'),
 ('16 前石室后壁小龛西壁','outer','bd5d3127721e5e68ea4e',(3000,2958),[(.147,.042),(.846,.044),(.861,.965),(.143,.960)],[-1,0,0],'小龛西侧（外侧）'),
 ('17 前石室后壁小龛东壁','wall','c4d851199f7ac72bd884',(3600,2681),[(.041,.039),(.964,.034),(.964,.952),(.037,.959)],[0,0,1],'小龛东壁'),
 ('17 前石室后壁小龛东壁','outer','9b2a7667b3fd0a1b88b3',(3000,2958),[(.141,.036),(.862,.038),(.866,.960),(.143,.958)],[1,0,0],'小龛东侧（外侧）'),
 ('36 有鸟如鹤','front','85969b0d596819fe5a5a',(3400,3400),[(.16,.028),(.84,.028),(.84,.97),(.16,.97)],[0,0,1],'祥瑞图残石完整残存面'),
 ('占位石B 70×13.5×19','front','dc417f7ac582dd96ec41',(1042,3840),[(.322,.028),(.655,.027),(.659,.959),(.322,.959)],[-1,0,0],'正面（19厘米）：连弧纹、线刻波浪纹'),
 ('占位石B 70×13.5×19','left','25d46ff5ea807c834029',(741,3840),[(150/630,40/2048),(484/630,40/2048),(494/630,1971/2048),(130/630,1920/2048)],[0,0,-1],'左外侧（13.5厘米）：后刻“武家林”三字'),
 ('占位石B 70×13.5×19','right','a292c3d2694bbb1369c7',(741,3840),[(.385,.021),(.623,.021),(.622,.980),(.373,.980)],[0,0,1],'右内侧（13.5厘米）：相叠二人、翼龙、鸟首云纹'),
]
manifest=ROOT / 'src/frontend/src/archive/three/stoneTextureManifest.json'
data=json.loads(manifest.read_text(encoding='utf-8'))
affected={s[0] for s in specs}
data['entries']=[e for e in data['entries'] if e['id'] not in affected]
added=[]
for id,face,key,size,quad,normal,label in specs:
 source=stone_file(id, Path('media') / 'previews' / f'{key}.jpg')
 im=Image.open(source).convert('RGB');w,h=im.size
 coords=tuple(v for i in (0,3,2,1) for v in (quad[i][0]*w,quad[i][1]*h))
 rect=im.transform(size,Image.Transform.QUAD,coords,Image.Resampling.BICUBIC)
 no=json.loads((stone_file(id, 'meta.json')).read_text(encoding='utf-8'))['catalogue_no']
 file=f'corrected-{no[1:]}-{face}.webp'
 rect.save(ROOT / 'resources/scenes/textures/stones' / file,quality=95,method=6)
 entry=dict(id=id,faceKey=face,faceLabel=label,file=file,crop=[0,0,*size],imageSize=list(size),normal=normal,up=[0,1,0],fit='face',
  primaryFace=face in ['front','wall'],sourceKind='20260907-supplied-photograph',sourcePath=source.relative_to(ROOT).as_posix(),
  sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),sourceQuadNormalized=quad,
  mappingEvidence='断石柱：蒋英炬、吴文祺2014修订本书页91、配置书页65；小龛：整体照片核对转角关系及分面照片；其余按整理目录名称对应',
  imageTreatment='Four-corner geometric rectification only; no generative changes to archaeological imagery')
 if face=='wall':entry['focusNormal']=[-1,0,1] if id.startswith('16 ') else [1,0,1]
 added.append(entry)
data['entries']+=added
data['version']=2
data['description']='逐文物、逐石面登记的照片与扫描贴图；断石柱三面按原文核对；小龛分转角两面'
manifest.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
(OUT/'corrected-faces.json').write_text(json.dumps(added,ensure_ascii=False,indent=2),encoding='utf-8')
print(f'Prepared {len(added)} faces for {len(affected)} objects')
