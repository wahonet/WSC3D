"""Create repeatable PBR material maps and local, read-only reference derivatives."""
from pathlib import Path
import sys,json
import numpy as np
from PIL import Image,ImageDraw,ImageFilter,ImageOps
sys.stdout.reconfigure(encoding='utf-8')
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, source_files, node_binary
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT / 'resources/authoring/courtyard'
SRC=ROOT / 'resources/sources/site-survey/现场参考照片'
TARGET=OUT/'blender/materials';TARGET.mkdir(parents=True,exist_ok=True)
rng=np.random.default_rng(20260910)
for logical,f in source_files(SRC/'大门'):
 if logical.suffix.lower() not in ('.tif','.tiff'):continue
 im=ImageOps.exif_transpose(Image.open(f)).convert('RGB');im.thumbnail((1800,1800));im.save(OUT/'reference'/(f.stem+'.jpg'),quality=93)

# Samples document the observed palette; masonry maps use metric courses instead
# of baking trees, shadows, stone exhibits or perspective into the building.
samples=[('front','前展厅/武氏墓群石刻阙室展厅外景.JPG',(1870,1000,2240,1120)),
         ('rear','后展厅/博物馆陈列室展厅外景.JPG',(2270,1150,2370,1200))]
palettes={}
for name,rel,bounds in samples:
 im=Image.open(source_path(SRC/rel)).convert('RGB').crop(bounds)
 im.save(OUT/'reference'/f'{name}-brick-sample.png')
 palettes[name]={'source':rel,'crop':bounds,'median_srgb':np.median(np.array(im).reshape(-1,3),axis=0).tolist()}

def save_maps(name,color,height,physical):
 color=np.clip(color,0,255).astype('uint8');height=height.astype('float32')
 Image.fromarray(color).save(TARGET/(name+'-color.png'))
 dy,dx=np.gradient(height)
 n=np.stack((-dx*2.2,dy*2.2,np.ones_like(dx)),axis=-1)
 n/=np.linalg.norm(n,axis=-1,keepdims=True)
 Image.fromarray(np.uint8(np.clip((n*.5+.5)*255,0,255))).save(TARGET/(name+'-normal.png'))
 return {'name':name,'repeat_metres':physical,'base_color':name+'-color.png','normal':name+'-normal.png'}

maps=[];N=1024
def brick(name,base,mortar,cols,rows,physical,joint=3):
 im=Image.new('RGB',(N,N),mortar);d=ImageDraw.Draw(im)
 hi=Image.new('L',(N,N),40);hd=ImageDraw.Draw(hi)
 bw=N/cols;bh=N/rows
 for row in range(rows):
  for col in range(-1,cols+1):
   x=int((col+(row%2)*.5)*bw);y=int(row*bh)
   shade=rng.normal(0,4);c=tuple(int(v+shade) for v in base)
   box=(x+joint,y+joint,int(x+bw)-joint,int(y+bh)-joint)
   d.rounded_rectangle(box,radius=2,fill=c);hd.rounded_rectangle(box,radius=2,fill=int(170+rng.random()*12))
 arr=np.array(im).astype(float)+rng.normal(0,2.4,(N,N,1))
 h=np.array(hi.filter(ImageFilter.GaussianBlur(1.1))).astype(float)/255+rng.normal(0,.007,(N,N))
 maps.append(save_maps(name,arr,h,physical))
brick('grey-brick',(123,126,123),(167,166,155),8,24,(1.92,1.56),2)
brick('dark-brick',(99,104,102),(174,170,155),8,24,(1.92,1.56),2)
brick('ashlar',(155,157,150),(121,124,116),4,6,(2.4,1.8),3)
brick('paving',(141,141,134),(101,105,96),8,12,(2.4,2.4),3)
yy,xx=np.mgrid[0:N,0:N]
near=np.full((N,N),1.e10);second=near.copy();index=np.zeros((N,N),dtype=int)
centres=[]
for row in range(-1,7):
 for col in range(-1,9):centres.append(((col+rng.uniform(-.24,.24))*N/7,(row+rng.uniform(-.27,.27))*N/5))
for i,(x,y) in enumerate(centres):
 dist=(xx-x)**2+(yy-y)**2;better=dist<near
 second=np.where(better,near,np.minimum(second,dist));near=np.minimum(near,dist);index=np.where(better,i,index)
palette=np.array([(141,143,136) for _ in centres],float)+rng.normal(0,10,(len(centres),1))
mortar=(np.sqrt(second)-np.sqrt(near))<4.0
color=palette[index];color[mortar]=(173,173,161)
height=np.where(mortar,.1,.65)+rng.normal(0,.018,(N,N))
maps.append(save_maps('rubble',color+rng.normal(0,2,(N,N,1)),height,(2.4,1.8)))
gatephoto=Image.open(OUT/'reference/J_014.jpg')
for name,bounds in [('plaque-left',(315,915,404,980)),('plaque-right',(782,912,867,978))]:
 patch=gatephoto.crop(bounds).resize((512,340),Image.Resampling.LANCZOS)
 patch.save(TARGET/(name+'-color.png'))
 Image.new('RGB',patch.size,(128,128,255)).save(TARGET/(name+'-normal.png'))
for name,base,physical in [('redwood',(116,46,40),(1,2)),('limestone',(184,185,173),(1,1)),('tile',(110,115,113),(1,1))]:
 grain=rng.normal(0,2,(N,N));grain+=np.array(Image.fromarray(np.uint8(rng.random((64,64))*255)).resize((N,N),Image.Resampling.BICUBIC))* .04-5
 if name=='redwood':grain+=rng.normal(0,1.4,(1,N))
 arr=np.array(base)[None,None,:]+grain[:,:,None]
 maps.append(save_maps(name,arr,grain*.004,physical))
(TARGET/'manifest.json').write_text(json.dumps({'source_palettes':palettes,'materials':maps},ensure_ascii=False,indent=2),encoding='utf-8')

# Only Blender's rendering copies are reduced; database media and web textures
# are never overwritten. Pack these into the editable project for portability.
scene=OUT/'scene/baseline';rendertex=OUT/'blender/reference-textures';rendertex.mkdir(exist_ok=True)
data=json.loads((scene/'scene.json').read_text(encoding='utf-8'))
for t in data['textures']:
 src=scene/t['file'];dest=rendertex/src.name
 if not dest.exists():
  im=Image.open(src);im.thumbnail((2048,2048));im.save(dest)
print(json.dumps({'materials':len(maps),'render_texture_copies':len(data['textures'])}))
