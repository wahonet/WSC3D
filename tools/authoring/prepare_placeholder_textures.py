"""Rectify supplied frontal photographs to the complete, measured stone faces."""
from pathlib import Path
from PIL import Image
import hashlib, json, sys
sys.stdout.reconfigure(encoding='utf-8')
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
BASE=Path(__file__).resolve().parents[2]
manifest=BASE / 'src/frontend/src/archive/three/stoneTextureManifest.json'
data=json.loads(manifest.read_text(encoding='utf-8'))
backup=BASE / 'resources/authoring/source-import/backups/src/frontend/src/archive/three/stoneTextureManifest.json'
backup.parent.mkdir(parents=True,exist_ok=True)
if not backup.exists():backup.write_bytes(manifest.read_bytes())
specs=[
 {'id':'占位石A 167×140×22','name':'屋顶前坡东段画像','key':'78c19e3dec3eaaf595b1','file':'catalogue-wu027.webp',
  'quad':[(.090,.034),(.925,.027),(.922,.965),(.075,.965)],'size':(2386,2000),'up':[1,0,0]},
 # The column's three faces are maintained by prepare_corrected_faces.py.
]
for s in specs:
 source=stone_file(s['id'], Path('media') / 'previews' / f"{s['key']}.jpg")
 im=Image.open(source).convert('RGB');w,h=im.size
 # Pillow QUAD order: top left, bottom left, bottom right, top right.
 q=[s['quad'][i] for i in (0,3,2,1)]
 output=im.transform(s['size'],Image.Transform.QUAD,tuple(v for x,y in q for v in (x*w,y*h)),Image.Resampling.BICUBIC)
 destination=BASE / 'resources/scenes/textures/stones' / s['file']
 output.save(destination,quality=95,method=6)
 entry={'id':s['id'],'file':s['file'],'crop':[0,0,*s['size']],'imageSize':list(s['size']),
  'normal':[0,0,1],'up':s['up'],'fit':'face','sourceKind':'20260907-supplied-frontal-photograph',
  'sourcePath':str(source.relative_to(BASE)).replace('\\','/'),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
  'sourceQuadNormalized':s['quad'],'mappingEvidence':f'整理目录明确替换占位石，文物主名：{s["name"]}',
  'imageTreatment':'Geometric four-corner rectification and WebP encoding only; complete front face, no invented image content'}
 data['entries']=[e for e in data['entries'] if e['id']!=s['id']]+[entry]
 print(destination)
data['description']='具名石刻的扫描正面影像及20260907整理目录两块补位石的实物正面照片'
data['imageTreatment']='Existing scans use UV crops; the two supplied placeholder photographs use recorded four-corner geometric rectification to cover each complete stone face.'
manifest.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
