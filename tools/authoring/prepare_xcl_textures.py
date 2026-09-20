"""Copy/rectify the supplied west-gallery photographs, with per-object provenance.

No retouching, synthesis or modification of source photographs. Layout dimensions
are display geometry, kept separate from measured catalogue dimensions.
"""
from pathlib import Path
import hashlib, json, re, shutil, sys
from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding='utf-8')
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'resources/authoring/catalogue-preparation'
PUBLIC = ROOT / 'src/frontend/public'
TOOL = ROOT / 'resources/reference/viewers/04-旧版三维模型/摆放工具'
rows = json.loads((OUT/'xcl-candidates.json').read_text(encoding='utf-8'))
source = (ROOT / 'src/frontend/src/archive/three/buildSite.ts').read_text(encoding='utf-8')
data = {}
for m in re.finditer(r"\['(XCL-\d+)',\s*([\d.,\s]+)\]", source):
    vals = [float(v) for v in m[2].split(',')]
    if len(vals) == 6:
        data[m[1]] = dict(zip(['L','H','T','along','off','y'], vals), wall='W', rotY=0)
data['XCL-N'] = dict(L=.68,H=1.77,T=.19,along=2.2,off=.4,y=0,wall='N',rotY=0)
data['XCL-S'] = dict(L=.68,H=1.43,T=.17,along=2.1,off=.35,y=0,wall='S',rotY=0)

# Four photographed perimeter corners, TL/TR/BR/BL, in normalized source pixels.
quads = {
 'XCL-N':[(.012,.027),(.988,.027),(.959,.966),(.063,.966)],
 'XCL-S':[(.118,.027),(.942,.027),(.953,.971),(.112,.967)],
 'XCL-04':[(.032,.085),(.968,.085),(.963,.985),(.050,.985)],
 'XCL-35':[(.027,.153),(.985,.162),(.984,.981),(.023,.981)],
 'XCL-36':[(.011,.140),(.986,.140),(.985,.986),(.011,.986)],
 'XCL-37':[(.018,.149),(.985,.149),(.984,.984),(.011,.984)],
 'XCL-38':[(.016,.117),(.985,.117),(.984,.984),(.011,.984)],
}
profiles = {
 'XCL-N':[[.02,1],[.97,1],[.99,.30],[1,.23],[.96,.13],[.91,.075],[.83,.04],[.69,.015],[.5,0],[.30,.013],[.18,.045],[.10,.09],[.055,.16],[.015,.27]],
 'XCL-S':[[.02,1],[.98,1],[1,.94],[.99,.055],[.94,.006],[.80,.011],[.71,0],[.54,.012],[.40,.002],[.25,.013],[.09,.009],[.015,.06],[0,.93]],
}
entries, layout = [], []
for row in rows:
    sid, no = row['id'], row['no']
    item = row['images'][2 if sid == 'XCL-S' else 0]
    path = stone_file(sid, item['file'])
    im = Image.open(path).convert('RGB')
    quad = quads.get(sid,[(.006,.014),(.994,.014),(.994,.986),(.006,.986)])
    d = data[sid]
    ratio = d['L']/d['H']
    size = (min(2048,im.width), round(min(2048,im.width)/ratio)) if ratio >= 1 else (round(min(2048,im.height)*ratio),min(2048,im.height))
    size = tuple(max(64,int(v)) for v in size)
    coords = tuple(v for i in (0,3,2,1) for v in (quad[i][0]*im.width,quad[i][1]*im.height))
    rect = im.transform(size,Image.Transform.QUAD,coords,Image.Resampling.BICUBIC)
    file = f'xcl-{no[1:]}.webp'
    dest = PUBLIC/'textures/stones'/file
    rect.save(dest, quality=87, method=4)
    for base in [TOOL, PUBLIC/'tools']:
        folder = base/'西长廊贴图'
        folder.mkdir(parents=True,exist_ok=True)
        shutil.copy2(dest,folder/f'{no}.webp')
    entries.append(dict(id=sid,faceKey='front',faceLabel='完整雕刻正面',file=file,
        crop=[0,0,*size],imageSize=list(size),normal=[0,0,-1 if d['wall']=='W' else 1],
        up=[0,1,0],fit='face',primaryFace=True,sourceKind='supplied-photograph',
        sourcePath=path.relative_to(ROOT).as_posix(),sourceSha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        originalPath=item['original'],originalSha256=item['sha256'],sourceQuadNormalized=quad,
        profile=profiles.get(sid),mappingEvidence=f"{no} {row['name']}；按目录名称及照片内容逐件核对",
        imageTreatment='Geometric perimeter rectification only; no generated or retouched imagery'))
    placement=dict(id=no,name=row['name'],**d,photo=f'西长廊贴图/{no}.webp',profile=profiles.get(sid))
    meta=json.loads((stone_file(sid, 'meta.json')).read_text(encoding='utf-8'))
    if meta.get('size_revision'):placement['sizeRevision']=meta['size_revision']
    layout.append(placement)

manifest = dict(version=1,description='西长廊40件石刻：用户提供实物照片，覆盖完整正面；圆首碑按照片轮廓贴面',entries=entries)
(ROOT / 'src/frontend/src/archive/three/stoneTextureManifestXCL.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
layouts=ROOT/'data/layouts'; layouts.mkdir(exist_ok=True)
default=dict(version='xcl-layout-2',stones=layout)
(layouts/'xcl-default.json').write_text(json.dumps(default,ensure_ascii=False,indent=2),encoding='utf-8')
(OUT/'xcl-texture-provenance.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
# A contact sheet for visual verification of the actual copied texture assets.
sheet=Image.new('RGB',(1500,1800),'#22272c'); draw=ImageDraw.Draw(sheet)
font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',17)
for i,(row,entry) in enumerate(zip(rows,entries)):
    x=(i%5)*300; y=(i//5)*225
    im=Image.open(PUBLIC/'textures/stones'/entry['file']); im.thumbnail((280,190))
    sheet.paste(im,(x+(300-im.width)//2,y+(192-im.height)//2))
    draw.text((x+8,y+198),row['no']+' '+row['name'][:12],font=font,fill='white')
sheet.save(OUT/'xcl-textures-contact.jpg',quality=94)
print(json.dumps({'textures':len(entries),'copied_to_tool':str(TOOL),'default_layout':len(layout)},ensure_ascii=False))
