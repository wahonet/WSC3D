"""Read source drawings and freeze the current archive before rebuilding architecture."""
from pathlib import Path
from collections import Counter
import hashlib, json, shutil, sys
import ezdxf
import pypdfium2 as pdfium

sys.stdout.reconfigure(encoding='utf-8')
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT / 'resources/authoring/courtyard'
SOURCE=ROOT / 'resources/sources/site-survey'
OUT.mkdir(parents=True,exist_ok=True)
for name in ['before','reference','scene','renders','blender']:(OUT/name).mkdir(exist_ok=True)
def write(p,value):p.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()

# Large photo/model originals are guarded by file inventory; all archive text,
# preferred-model pointers, layouts and image mappings are also hashed.
inventory=[]
for folder in ['resources/stones','data/layouts']:
 for p in (source_path(folder)).rglob('*'):
  if p.is_file():
   st=p.stat();item=dict(path=p.relative_to(ROOT).as_posix(),bytes=st.st_size,mtime_ns=st.st_mtime_ns)
   if p.suffix.lower() in ['.json','.md','.txt']:item['sha256']=digest(p)
   inventory.append(item)
protected=OUT/'before/archive-inventory.json'
if not protected.exists():write(protected,inventory)
code=['src/frontend/src/archive/three/buildSite.ts','src/frontend/src/archive/three/SiteStage.tsx','src/frontend/src/archive/three/interactions.ts',
      'src/frontend/src/archive/three/renderLook.ts','src/frontend/src/archive/three/wallXray.ts','src/frontend/src/archive/three/xclLayout.ts',
      'src/frontend/src/archive/three/catalogueMap.json']
code += [str(p.relative_to(ROOT)) for p in (ROOT / 'src/frontend/src/archive/three').glob('stoneTextureManifest*.json')]
for rel in code:
 src=source_path(rel);dest=OUT/'before'/rel
 if not dest.exists():dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dest)
catalogue=json.loads((ROOT / 'src/frontend/src/archive/three/catalogueMap.json').read_text(encoding='utf-8'))
entries=[]
for name in ['stoneTextureManifest','stoneTextureManifestBL','stoneTextureManifestOutdoor','stoneTextureManifestXCL']:
 entries += [e for e in json.loads((source_path(f'src/frontend/src/archive/three/{name}.json')).read_text(encoding='utf-8'))['entries'] if e['id'] not in catalogue['removed']]
write(OUT/'scene/stone-texture-manifest.json',{'entries':entries})

sources=[]
for folder in ['CAD图纸','现场参考照片']:
 for p in (SOURCE/folder).rglob('*'):
  if not p.is_file():continue
  item=dict(path=p.relative_to(SOURCE).as_posix(),bytes=p.stat().st_size,sha256=digest(p))
  if p.suffix.lower()=='.pdf':
   doc=pdfium.PdfDocument(str(p));item['pages']=len(doc)
   texts=[]
   for i,page in enumerate(doc):
    texts.append(f'\n--- PDF PAGE {i+1} ---\n'+page.get_textpage().get_text_range())
   (OUT/'reference'/f'{p.stem}.txt').write_text('\n'.join(texts),encoding='utf-8')
   doc.close()
  if p.suffix.lower()=='.dwg':item['format_signature']=p.open('rb').read(6).decode('ascii')
  sources.append(item)
write(OUT/'reference/source-manifest.json',sources)
doc=ezdxf.readfile(SOURCE/'CAD图纸/武氏祠石刻布置图.dxf')
model=doc.modelspace();texts=[]
for entity in model:
 if entity.dxftype() in ['TEXT','MTEXT']:
  texts.append(dict(text=entity.dxf.text if entity.dxftype()=='TEXT' else entity.plain_text(),insert=list(entity.dxf.insert),layer=entity.dxf.layer))
write(OUT/'reference/dxf-inspection.json',dict(version=doc.dxfversion,units=doc.units,entities=dict(Counter(e.dxftype() for e in model)),texts=texts))
print(json.dumps({'source_files':len(sources),'archive_files_protected':len(inventory),'stone_count':len(catalogue['items']),'texture_faces':len(entries),'dxf_texts':len(texts)},ensure_ascii=False))
