"""Fit the source photographic silhouette to each generated mesh, without changing the mesh."""
from pathlib import Path
import json, sys, time
import numpy as np
from PIL import Image,ImageDraw
from scipy.optimize import differential_evolution, minimize
from scipy.ndimage import binary_opening, label
sys.stdout.reconfigure(encoding='utf-8')
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT / 'resources/authoring/stone-reconstruction'
for side,key in [('W','700c50985a31ee3a31e0'),('E','c4c3c62481196ec429d9')]:
 data=json.loads((OUT/f'lion-{side}-mesh.json').read_text())
 v=np.array(data['vertices']);tri=np.array(data['triangles'])
 im=Image.open(stone_file(f'SHI-{side}', f'images/previews/{key}.jpg')).convert('RGB')
 a=np.asarray(im);mask=binary_opening(np.max(a,axis=2)>25,iterations=3)
 labels,count=label(mask);sizes=np.bincount(labels.ravel());sizes[0]=0;mask=labels==sizes.argmax()
 yy,xx=np.where(mask);bounds=[int(xx.min()),int(yy.min()),int(xx.max()+1),int(yy.max()+1)]
 target=Image.fromarray(mask.astype('uint8')*255).crop(bounds).resize((180,180),Image.Resampling.NEAREST)
 target=np.asarray(target)>0
 def project(p):
  az,el,dist=np.array(p)*[np.pi/180,np.pi/180,1]
  eye=dist*np.array([np.cos(az)*np.cos(el),np.sin(az)*np.cos(el),np.sin(el)])
  n=eye/np.linalg.norm(eye);right=np.cross([0,0,1],n);right/=np.linalg.norm(right);up=np.cross(n,right)
  depth=(eye-v)@n
  xy=np.c_[v@right/depth,v@up/depth]
  lo=xy.min(0);span=np.ptp(xy,axis=0);uv=(xy-lo)/span
  return uv,{'eye':eye.tolist(),'right':right.tolist(),'up':up.tolist(),'normal':n.tolist(),'lo':lo.tolist(),'span':span.tolist(),'imageBounds':bounds,'imageSize':list(im.size),'sourceId':key}
 def loss(p,save=False):
  uv,_=project(p);pts=np.c_[uv[:,0]*179,(1-uv[:,1])*179].astype(int)
  canvas=Image.new('1',(180,180));dr=ImageDraw.Draw(canvas)
  for t in pts[tri]:dr.polygon(tuple(map(tuple,t)),fill=1)
  rendered=np.asarray(canvas)>0
  result=1-np.count_nonzero(rendered&target)/np.count_nonzero(rendered|target)
  if save: canvas.convert('RGB').resize((720,720)).save(OUT/f'lion-{side}-silhouette.png')
  return result
 # Both assets have their photographed side toward negative Y; E is the mirrored pose.
 limits=[(-100,-20) if side=='W' else (-160,-80),(3,50),(2,8)]
 result=differential_evolution(loss,limits,popsize=7,maxiter=22,tol=.002,seed=19,polish=False)
 result=minimize(loss,result.x,method='Nelder-Mead',bounds=limits,options={'maxiter':100,'xatol':.03})
 uv,cal=project(result.x);cal['silhouetteIoU']=1-loss(result.x,True);cal['cameraParameters']=result.x.tolist()
 (OUT/f'lion-{side}-calibration.json').write_text(json.dumps(cal,indent=2))
 print(side,'calibrated',cal,flush=True)
