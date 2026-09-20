"""Blender 5.2: CAD-based architecture, protected archive and reference-photo facades.

Run: blender --background --factory-startup --python tools/authoring/rebuild_courtyard_blender.py
The GLB contains architecture only. The editable blend also contains a frozen
copy of all current exhibits and the unchanged later north corridor.
"""
import bpy,math,json,sys,importlib.util,random
from pathlib import Path
from collections import defaultdict
from mathutils import Matrix,Vector
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT / 'resources/authoring/courtyard'
MATDIR=OUT/'blender/materials'
BASE=OUT/'scene/baseline/scene.json'
random.seed(20260910)
spec=importlib.util.spec_from_file_location('reference_import',ROOT / 'tools/authoring/build_blender_scene.py')
ref=importlib.util.module_from_spec(spec);spec.loader.exec_module(ref)
ref.SCENE_FILE=BASE;ref.PREFIX='保留_'
C=ref.C
SQ=math.sqrt(.5)
GX,GZ=(423.1-687)*.17639,(124.6-314)*.17639
def world(a,b,h=0):return (GX+SQ*(a-b),-GZ-SQ*(a+b),h)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene;scene.name='武氏祠_院落更新_20260910'
scene.unit_settings.system='METRIC';scene.unit_settings.length_unit='METERS'
scene['依据']='2019修缮CAD/PDF、2023环境CAD/PDF、现场参考照片；保留后建北长廊'
scene['文物总数']=150
scene['尺寸说明']='建筑构造尺寸按图纸；总图沿用现有院落配准中心及方向；室内标高衔接既有展陈。'
arch=bpy.data.collections.new('01_重建院落与建筑');scene.collection.children.link(arch)
north=bpy.data.collections.new('02_北长廊_原样保留');scene.collection.children.link(north)
archive=bpy.data.collections.new('03_150件文物与既有展陈');scene.collection.children.link(archive)
context=bpy.data.collections.new('04_保留景观与场地设施');scene.collection.children.link(context)
lights=bpy.data.collections.new('05_摄影机与灯光');scene.collection.children.link(lights)

def linear(c):return ((c/255+.055)/1.055)**2.4 if c>10.31475 else c/3294.6
def material(name,rgb,rough=.85,mapname=None,metal=0,alpha=1):
 m=bpy.data.materials.new(name);m.use_nodes=True
 n=m.node_tree.nodes;l=m.node_tree.links;p=n.get('Principled BSDF')
 p.inputs['Base Color'].default_value=(*(linear(v) for v in rgb),1)
 p.inputs['Roughness'].default_value=rough;p.inputs['Metallic'].default_value=metal
 p.inputs['Alpha'].default_value=alpha
 m.diffuse_color=(*(linear(v) for v in rgb),alpha)
 if alpha<1:
  m.surface_render_method='DITHERED';p.inputs['Transmission Weight'].default_value=.15
 if mapname:
  tex=n.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(str(MATDIR/(mapname+'-color.png')),check_existing=True);tex.image.pack()
  l.new(tex.outputs['Color'],p.inputs['Base Color'])
  norm=n.new('ShaderNodeTexImage');norm.image=bpy.data.images.load(str(MATDIR/(mapname+'-normal.png')),check_existing=True);norm.image.colorspace_settings.name='Non-Color';norm.image.pack()
  nm=n.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.65
  l.new(norm.outputs['Color'],nm.inputs['Color']);l.new(nm.outputs['Normal'],p.inputs['Normal'])
 return m
M={
 'brick':material('现状_细灰砖_白灰勾缝',(123,126,123),.93,'grey-brick'),
 'darkbrick':material('西廊_青砖白缝',(99,104,102),.95,'dark-brick'),
 'stone':material('台基_灰色块石',(155,157,150),.9,'ashlar'),
 'column':material('阙室_浅灰石柱',(184,185,173),.9,'limestone'),
 'paving':material('院落_青灰砖铺地',(145,147,140),.95,'paving'),
 'red':material('现状_暗朱红木作',(116,46,40),.62,'redwood'),
 'white':material('室内_灰白抹面',(214,211,197),.95),
 'glass':material('窗_透明灰玻璃',(124,142,140),.2,alpha=.20),
 'iron':material('门窗_深褐金属',(49,42,34),.65,metal=.32),
 'earth':material('场外_中性地表',(173,171,157),1),
 'rubble':material('围墙_灰色毛石',(146,146,135),.97,'rubble'),
 'dark':material('椽下_深棕木',(64,45,32),.87),
 'mortar':material('瓦口_浅灰',(140,142,134),.95),
}
M['plaque-left']=material('门牌_北京大学_原照片',(255,255,255),.82,'plaque-left')
M['plaque-right']=material('门牌_武氏墓群石刻博物馆_原照片',(255,255,255),.82,'plaque-right')
for i in range(5):
 c=106+i*5;M['tile'+str(i)]=material('灰陶瓦_'+str(i),(c,c+5,c+3),.84)
METRIC={'brick':(1.92,1.56),'darkbrick':(1.92,1.56),'stone':(2.4,1.8),'column':(1,1),'paving':(2.4,2.4),'red':(1,2),'rubble':(2.4,1.8)}

# Native editable meshes are batched by building/component/material. This keeps
# the browser model to a few hundred draw calls while preserving roof/xray roles.
buffers={}
class Builder:
 def __init__(self,name,cx,cz,orient='front',floor=0):
  self.name,self.cx,self.cz,self.orient,self.floor=name,cx,cz,orient,floor
 def point(self,u,v,h):
  if self.orient=='front':a,b=self.cx+v,self.cz+u
  elif self.orient=='west':a,b=self.cx-u,self.cz+v
  elif self.orient=='back':a,b=self.cx-v,self.cz-u
  return world(a,b,h+self.floor)
 def mesh(self,label,verts,faces,mat='brick',role='wall',uv=None):
  key=(self.name,label,mat,role)
  if key not in buffers:buffers[key]=[[],[],[]]
  vs,fs,uvs=buffers[key];offset=len(vs)
  vs.extend(self.point(*p) for p in verts);fs.extend(tuple(i+offset for i in face) for face in faces)
  if uv is None:uv=[[(verts[i][0],verts[i][2]) for i in f] for f in faces]
  sx,sy=METRIC.get(mat,(1,1));uvs.extend([[(u/sx,v/sy) for u,v in face] for face in uv])
 def box(self,label,size,at,mat='brick',role='wall',angle=0):
  w,d,h=size;u,v,z=at
  if min(w,d,h)<=0:return
  points=[(x*w/2,y*d/2,t*h/2) for x,y,t in [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
  ca,sa=math.cos(angle),math.sin(angle)
  verts=[(u+x*ca-y*sa,v+x*sa+y*ca,z+t) for x,y,t in points]
  faces=[(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)]
  uv=[]
  for f in faces:
   p=[Vector(points[i]) for i in f];n=(p[1]-p[0]).cross(p[2]-p[0]);ax=max(range(3),key=lambda j:abs(n[j]));axes=[j for j in range(3) if j!=ax]
   uv.append([(q[axes[0]]+at[axes[0]],q[axes[1]]+at[axes[1]]) for q in p])
  self.mesh(label,verts,faces,mat,role,uv)
 def cylinder(self,label,r,h,at,mat='red',role='wall',segments=24):
  u,v,z=at;verts=[(u+r*math.cos(i*2*math.pi/segments),v+r*math.sin(i*2*math.pi/segments),z+s*h/2) for s in [-1,1] for i in range(segments)]
  faces=[tuple(reversed(range(segments))),tuple(range(segments,segments*2))]
  faces.extend((i,(i+1)%segments,(i+1)%segments+segments,i+segments) for i in range(segments))
  self.mesh(label,verts,faces,mat,role)
 def tube(self,label,path,r,mat='tile2',role='roof',half=True,sides=6):
  verts=[]
  for i,p in enumerate(path):
   tangent=Vector(path[min(i+1,len(path)-1)])-Vector(path[max(i-1,0)])
   lateral=Vector((-tangent.y,tangent.x,0)).normalized()
   for j in range(sides+1):
    a=j/sides*(math.pi if half else math.tau)
    q=Vector(p)+lateral*(r*math.cos(a))+Vector((0,0,r*math.sin(a)))
    verts.append(tuple(q))
  faces=[(i*(sides+1)+j,i*(sides+1)+j+1,(i+1)*(sides+1)+j+1,(i+1)*(sides+1)+j) for i in range(len(path)-1) for j in range(sides)]
  faces += [tuple(reversed(range(sides+1))),tuple(range((len(path)-1)*(sides+1),len(path)*(sides+1)))]
  self.mesh(label,verts,faces,mat,role)
 def wall(self,label,width,center_v,height,thick,holes=(),base=.0,mat='brick',inner=True):
  # holes = (center u, width, sill, head). All holes pass through the wall.
  limits=sorted(set([-width/2,width/2]+[max(-width/2,min(width/2,x+s*w/2)) for x,w,lo,hi in holes for s in [-1,1]]))
  for left,right in zip(limits,limits[1:]):
   middle=(left+right)/2;hole=next((p for p in holes if p[0]-p[1]/2<middle<p[0]+p[1]/2),None)
   spans=[(0,height)] if not hole else [(0,hole[2]),(hole[3],height)]
   for bottom,top in spans:
    cuts=sorted(set([bottom,top]+([base] if bottom<base<top else [])))
    for z0,z1 in zip(cuts,cuts[1:]):
     if z1-z0<.001:continue
     self.box(label,(right-left,thick,z1-z0),(middle,center_v,(z0+z1)/2),'stone' if z1<=base else mat)
     if inner:
      iv=center_v-math.copysign(thick/2+.009,center_v)
      self.box(label+'_内抹面',(right-left,.016,z1-z0),(middle,iv,(z0+z1)/2),'white')
 def window(self,label,u,v,w,sill,h,grid=False):
  z=sill+h/2
  self.box(label+'_玻璃',(w-.12,.025,h-.12),(u,v,z),'glass','opening')
  for a in [-1,1]:
   self.box(label+'_边框',(.085,.13,h+.10),(u+a*w/2,v,z),'red','opening')
   self.box(label+'_边框',(w+.16,.13,.085),(u,v,z+a*h/2),'red','opening')
  step=.14 if grid else .095
  n=max(1,round(w/step))
  for i in range(1,n):self.box(label+'_窗棂',(.025,.052,h-.08),(u-w/2+w*i/n,v-.035,z),'red','opening')
  nh=max(2,round(h/.14)) if grid else 3
  for i in range(1,nh):self.box(label+'_窗棂',(w-.08,.054,.025),(u,v-.036,sill+h*i/nh),'red','opening')
  self.box(label+'_窗台',(w+.30,.34,.10),(u,v,sill-.065),'column','wall')
 def door(self,label,u,v,w,h,bars=False):
  for s in [-1,1]:self.box(label+'_门框',(.14,.20,h+.12),(u+s*(w/2+.04),v,h/2),'red','opening')
  self.box(label+'_门楣',(w+.40,.23,.22),(u,v,h+.12),'red','opening')
  # Open leaves are visible from the courtyard and leave a real walkable doorway.
  for s in [-1,1]:
   a=s*math.radians(72);leaf=w/2-.06;hinge=u+s*w/2
   cu=hinge-s*math.cos(a)*leaf/2;cv=v-math.sin(abs(a))*leaf/2
   if not bars:self.box(label+'_敞开门扇',(leaf,.075,h-.12),(cu,cv,(h-.12)/2),'red','opening',a)
   for z in [.1,h-.22]:self.box(label+'_门扇横档',(leaf,.095,.075),(cu,cv,z),'red','opening',a)
   if bars:
    for i in range(13):
     t=(i/12-.5)*leaf
     self.box(label+'_竖栅',(.028,.028,h-.32),(cu+t*math.cos(a),cv+t*math.sin(a),(h-.12)/2),'red','opening')
 def stairs(self,width,v,floor):
  n=max(1,round(floor/.15))
  for i in range(n):self.box('入口石阶',(width,.34*(n-i),floor*(i+1)/n),(0,v-.34*(n-i)/2,-floor+floor*(i+1)/n/2),'stone','floor')

def roof(b,W,D,eave,ridge,hip=False,ridge_len=None,rear_eave=None,ridge_offset=0,ridge_cap=.43):
 """Curved tile slopes with separately modelled barrel tiles, hips and ridge caps."""
 H=W/2;A=D/2;R=(ridge_len or W)/2
 steps=22
 def h(t,ev):
  ev-=.083  # the curved barrel tile, not the backing sheet, reaches the CAD eave
  return ev+(ridge-ev)*t**1.48+.075*(math.exp(-t*16)-(1-t))
 # Front/back slopes: every cover tile runs perpendicular to the eave.
 for s in [-1,1]:
  ev=rear_eave if s>0 and rear_eave is not None else eave
  layers=[]
  for i in range(steps+1):
   t=i/steps;span=H-(H-R)*t if hip else H
   v=s*A*(1-t)+ridge_offset*t
   layers.extend([(-span,v,h(t,ev)),(span,v,h(t,ev))])
  faces=[(2*i,2*i+1,2*i+3,2*i+2) for i in range(steps)]
  b.mesh('屋面_青灰底瓦',layers,faces,'tile1','roof')
  count=round(W/.205)
  for i in range(count+1):
   u=-H+W*i/count;end=min(1,(H-abs(u))/(H-R)) if hip else 1
   if end<.001:continue
   path=[(u,s*A*(1-t)+ridge_offset*t,h(t,ev)+.013) for t in [end*j/steps for j in range(steps+1)]]
   b.tube('屋面_筒瓦垄',path,.069,'tile'+str(i%5))
   # Circular tile heads and timber rafters under the continuous eave.
   b.tube('瓦当与檐口',[(u,s*(A-.055),ev+.025),(u,s*(A+.03),ev+.02)],.076,'tile2',sides=8)
  b.box('檐口连檐木',(W,.15,.13),(0,s*(A-.05),ev-.10),'red','roof')
  for i in range(round(W/.23)+1):
   u=-H+W*i/round(W/.23)
   b.box('檐椽',( .085,.72,.09),(u,s*(A-.31),ev-.18),'dark','roof')
 if hip:
  for s in [-1,1]:
   layers=[]
   for i in range(steps+1):
    t=i/steps;u=s*(H-(H-R)*t)
    layers.extend([(u,-A*(1-t),h(t,eave)),(u,A*(1-t),h(t,eave))])
   b.mesh('屋面_两端坡',layers,[(i*2,i*2+1,i*2+3,i*2+2) for i in range(steps)],'tile1','roof')
   count=round(D/.205)
   for i in range(1,count):
    v=-A+D*i/count;end=1-abs(v)/A
    path=[(s*(H-(H-R)*t),v,h(t,eave)+.014) for t in [end*j/steps for j in range(steps+1)]]
    b.tube('屋面_两端筒瓦',path,.069,'tile'+str(i%5))
   b.box('山面檐木',(.14,D,.14),(s*(H-.05),0,eave-.12),'red','roof')
  for su in [-1,1]:
   for sv in [-1,1]:
    path=[(su*(H-(H-R)*t),sv*A*(1-t),h(t,eave)+.08) for t in [i/32 for i in range(33)]]
    b.tube('四角垂脊',path,.13,'tile0',sides=10)
    b.box('檐角收头',(.20,.20,.30),(su*H,sv*A,eave+.16),'tile0','roof')
 else:
  for su in [-1,1]:
   for sv in [-1,1]:
    ev=rear_eave if sv>0 and rear_eave is not None else eave
    path=[(su*H,sv*A*(1-t)+ridge_offset*t,h(t,ev)+.04) for t in [i/32 for i in range(33)]]
    b.tube('山面博缝瓦脊',path,.115,'tile0',sides=8)
 b.box('正脊_砖砌脊座',(R*2+.04,.31,.27),(0,ridge_offset,ridge+.14),'tile0','roof')
 b.tube('正脊_盖瓦',[(-R-.05,ridge_offset,ridge+ridge_cap-.15),(R+.05,ridge_offset,ridge+ridge_cap-.15)],.15,'tile2',sides=10)

def gable(b,W,D,wall_height,eave,ridge,thick=.3,offset=0,profile=None):
 for s in [-1,1]:
  outline=[(-D/2,wall_height),(-D/2,eave)]
  outline.extend((-D/2*(1-t)+offset*t,eave+(ridge-eave)*t**1.48) for t in [i/14 for i in range(1,15)])
  outline.extend((D/2*(1-t)+offset*t,eave+(ridge-eave)*t**1.48) for t in [i/14 for i in range(13,-1,-1)])
  outline.append((D/2,wall_height))
  if profile:
   rf,ef,eb=profile
   def z_at(v):
    t=(v+rf)/(rf+offset) if v<offset else (rf-v)/(rf-offset)
    ev=(ef if v<offset else eb)-.083
    return max(wall_height,ev+(ridge-ev)*t**1.48+.075*(math.exp(-16*t)-(1-t))-.025)
   outline=[(-D/2,wall_height)]+[(v,z_at(v)) for v in [-D/2+(D*i/30) for i in range(31)]]+[(D/2,wall_height)]
  n=len(outline);verts=[(s*(W/2-d),v,z) for d in [0,thick] for v,z in outline]
  faces=[tuple(range(n)),tuple(reversed(range(n,n*2)))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
  b.mesh('山墙上部',verts,faces,'brick','roof')

front=Builder('01_阙室',39.34,0,floor=.407115)
front.box('散水与台基',(22.2,11.22,.30),(0,0,-.15),'stone','floor')
front.box('室内地坪',(20.00,9.02,.07),(0,0,-.025),'paving','floor')
front_holes=[(0,1.96,0,3.10)]+[(u,1.4,1.25,3.12) for u in [-8,-4,4,8]]
for s in [-1,1]:
 front.wall('前后檐墙',20.6,s*4.51,4.92,.60,front_holes,base=.9)
 for u in [-10,-6,-2,2,6,10]:front.box('方石柱',(.60,.66,4.92),(u,s*4.51,2.46),'column')
 for u in [-8,-4,4,8]:
  front.window('直棂窗',u,s*4.835,1.4,1.25,1.87)
  front.box('红色窗楣',(2.45,.25,.26),(u,s*4.86,3.43),'red')
 front.door('中门',0,s*4.835,1.96,3.1)
 front.box('石檐枋',(20.8,.77,.30),(0,s*4.51,5.07),'column','roof')
 front.box('檐下红枋',(21.8,.30,.22),(0,s*4.79,5.33),'red','roof')
 # Gable wall openings, two windows in each gable, as on the plan.
 side=Builder('01_阙室',39.34,0,'west',.407115)
 side.wall('两山墙',9.02,s*10.0,4.92,.60,[(-.95,1.4,1.25,3.12),(.95,1.4,1.25,3.12)],base=.9)
 for u in [-.95,.95]:side.window('山墙窗',u,s*10.32,1.4,1.25,1.87)
gable(front,20.6,9.62,4.92,5.40,8.59,.60)
roof(front,22.4,11.55,5.53,8.62)
front.stairs(3.2,-5.61,.407115)

rear=Builder('02_后展厅',77.40,0,floor=.29016)
rear.box('散水与台基',(22.28,13.20,.29),(0,0,-.145),'stone','floor')
rear.box('室内地坪',(19.37,10.25,.06),(0,0,-.025),'paving','floor')
rear_holes=[(0,3,0,3.0)]+[(u,2.4 if abs(u)<6 else 2.,.32,2.92) for u in [-8.14,-4.21,4.21,8.14]]
for s in [-1,1]:
 rear.wall('前后檐墙',20.47,s*5.40,4.28,.55,rear_holes,base=.30)
 rear.box('檐下砖额',(20.45,.55,.77),(0,s*5.4,4.77),'brick','roof')
 for u in [-8.14,-4.21,4.21,8.14]:rear.window('大直棂窗',u,s*5.70,2.4 if abs(u)<6 else 2.,.32,2.60)
 rear.door('展厅中门',0,s*5.70,3,3)
 for h in [3.10,4.28,5.21]:rear.box('通长红额枋',(20.68,.30,.26),(0,s*5.68,h),'red','roof' if h>4.28 else 'wall')
 for u in [-9.96,-6.32,-2.10,2.10,6.32,9.96]:
  rear.cylinder('红色圆柱',.33,4.20,(u,s*5.40,2.18))
  rear.cylinder('圆柱石础',.39,.18,(u,s*5.40,.09),'column')
  rear.box('柱头承托',(.79,.80,.18),(u,s*5.4,4.35),'red','roof')
  for k in range(3):
   rear.box('斗拱横栱',(1.08+k*.22,.18,.14),(u,s*(5.4+.12*k),4.56+k*.30),'red','roof')
   rear.box('斗拱承斗',(.24,.32,.18),(u,s*(5.4+.12*k),4.73+k*.30),'red','roof')
  rear.box('昂与挑檐梁',(.17,1.25,.14),(u,s*5.76,5.51),'red','roof')
 rear.box('檐口通枋',(22.35,.27,.22),(0,s*6.18,5.68),'red','roof')
 side=Builder('02_后展厅',77.4,0,'west',.29016)
 side.wall('实心山墙',10.80,s*9.96,4.28,.55,(),base=.30)
 side.box('山面檐下砖额',(10.80,.55,.77),(0,s*9.96,4.77),'brick','roof')
 for v in [-5.4,-1.8,1.8,5.4]:
  rear.cylinder('山面圆柱',.33,4.2,(s*9.96,v,2.18))
  rear.cylinder('山面柱础',.39,.18,(s*9.96,v,.09),'column')
  rear.box('山面斗拱',(.95,.48,.20),(s*10.05,v,4.58),'red','roof')
  rear.box('山面斗拱',(.80,.82,.16),(s*10.22,v,4.94),'red','roof')
 for h in [2.95,4.28,5.21]:rear.box('山面红额枋',(.27,11.30,.26),(s*10.21,0,h),'red','roof' if h>4.28 else 'wall')
roof(rear,23.10,13.60,5.97,8.54,True,9.4)
rear.stairs(4.0,-6.6,.29016)

west=Builder('03_西长廊',58.62,14.88,'west',.209924)
west.box('台基',(27.94,5.1,.21),(0,0,-.105),'stone','floor')
west.box('青砖地面',(27.3,4.6,.06),(0,0,-.024),'paving','floor')
west.wall('后檐墙',27.94,2.30,3.59,.30,(),0,'darkbrick')
west_holes=[(0,3.40,0,2.40)]+[(u,3.38,1.0,2.4) for u in [-11.7,-7.8,-3.9,3.9,7.8,11.7]]
west.wall('内廊槛墙',27.3,-1.05,2.70,.24,west_holes,0,'darkbrick')
for u in [-11.7,-7.8,-3.9,3.9,7.8,11.7]:west.window('格扇窗',u,-1.19,3.38,1.,1.40,True)
west.door('中部格扇门',0,-1.19,3.40,2.4,True)
for u in [-13.65,-9.75,-5.85,-1.95,1.95,5.85,9.75,13.65]:
 west.cylinder('檐柱',.09,2.70,(u,-2.30,1.35))
 west.cylinder('金柱',.09,2.95,(u,-1.05,1.475))
west.box('前檐枋',(27.8,.24,.20),(0,-2.3,2.76),'red','roof')
for s in [-1,1]:
 west.box('山墙',(.32,4.90,2.875),(s*13.81,0,2.875/2),'darkbrick')
gable(west,27.94,4.90,2.875,3.12,4.985,.32,.55,(5.45/2,2.915,3.59))
roof(west,28.18,5.45,2.915,4.985,False,rear_eave=3.59,ridge_offset=.55,ridge_cap=.385)
west.stairs(3.8,-2.55,.209924)

def small_house(name,cx,cz,W,D,orient='back',three=False,wall=2.9,ridge=4.30,road_entry=False):
 if road_entry and orient!='front':raise ValueError('Road-side entrance is defined in the front-facing ticket-house frame.')
 b=Builder(name,cx,cz,orient,.30)
 b.box('台基',(W+.7,D+.7,.30),(0,0,-.15),'stone','floor')
 b.box('地面',(W-.45,D-.45,.05),(0,0,-.02),'paving','floor')
 holes=[(u,1.25,0,2.15) for u in [-W/3,0,W/3]] if three else [(0,1.3,0,2.15),(-W*.3,1.3,1.1,2.35),(W*.3,1.3,1.1,2.35)]
 if road_entry:holes=[hole for hole in holes if hole[2]>0]
 for s in [-1,1]:
  hs=holes if s<0 else [(u,1.3,1.1,2.35) for u in [-W*.3,0,W*.3]]
  b.wall('前后墙',W,s*(D/2-.14),wall,.28,hs,base=.65,mat='darkbrick')
  for u,w,lo,hi in hs:
   if lo==0:b.door('木门',u,s*(D/2+.02),w,hi)
   else:b.window('木窗',u,s*(D/2+.02),w,lo,hi-lo,True)
  if road_entry and s>0:
   side=Builder(name,cx,cz,'west',.30)
   side.wall('临甬路山墙',D,W/2-.14,wall,.28,[(0,1.3,0,2.15)],mat='darkbrick',inner=False)
   side.door('临甬路侧门',0,W/2+.02,1.3,2.15)
   for i in range(2):
    depth=.34*(2-i);height=.15*(i+1)
    side.box('侧门石阶',(1.8,depth,height),(0,W/2+.35+depth/2,-.30+height/2),'stone','floor')
  else:b.box('两山墙',(.28,D,wall),(s*(W/2-.14),0,wall/2),'darkbrick')
 gable(b,W,D,wall,wall+.06,ridge-.35,.28)
 roof(b,W+.60,D+.75,wall+.08,ridge-.35)
 if not road_entry:b.stairs(1.8,-D/2-.35,.30)
 return b
small_house('04_北管理房',41.20,22.86,10.4,6.5)
small_house('05_南管理房',58.84,23.85,10.84,7.54,three=True)
small_house('06_卫生间',18.82,24.39,8.36,5.96,'west')
ticket=small_house('07_售票房',3.06,-6.81,5.24,3.06,'front',wall=2.75,ridge=3.75,road_entry=True)

# Three wall/cap pairs in the frozen baseline still follow the old, narrower
# gate opening. Replace the return and both stubs so neither plaque is covered.
ENTRANCE_BOUNDARY_SOURCE_IDS=('o00973','o00974','o00975','o00976','o00977','o00978')

def entrance_boundary():
 b=Builder('09_院落与围墙',0,0,'front')
 a0,u0=1.21,19.46
 a1,u1=1.49,4.24  # Embed the end in the outer child que, allowing for its taper.
 length=math.hypot(a1-a0,u1-u0);angle=math.atan2(a1-a0,u1-u0)
 b.box('大门外侧围墙收口',(length,.50,2.50),((u0+u1)/2,(a0+a1)/2,1.25),'rubble','wall',angle)
 b.box('大门外侧围墙压顶',(length,.72,.16),((u0+u1)/2,(a0+a1)/2,2.58),'tile1','wall',angle)

entrance_boundary()

gate=Builder('08_子母阙式大门',1.49,0,'front')
def taper(b,label,u,width_bottom,width_top,depth,h,z0):
 verts=[(u+x*w/2,y*depth/2,z0+z) for w,z in [(width_bottom,0),(width_top,h)] for x,y in [(-1,-1),(1,-1),(1,1),(-1,1)]]
 b.mesh(label,verts,[(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)],'column')
def gate_eave(b,u,width,depth,z):
 b.box('阙檐枋',(width,.0+depth,.16),(u,0,z),'column','roof')
 for i in range(round(width/.18)+1):
  q=u-width/2+i*width/round(width/.18)
  b.tube('阙檐瓦垄',[(q,-depth/2,z+.1),(q,0,z+.26),(q,depth/2,z+.1)],.075,'tile2')
 b.box('阙檐垂边',(width+.04,.11,.16),(u,-depth/2,z+.08),'column','roof')
 for q in [-1,1]:b.box('阙檐角',(.10,depth,.15),(u+q*width/2,0,z+.17),'column','roof')
for s in [-1,1]:
 u=s*2.72
 taper(gate,'母阙身',u,1.60,1.10,1.03,4.95,0)
 gate_eave(gate,u,2.65,1.85,5.02)
 taper(gate,'母阙上层',u,.95,.84,.83,.84,5.14)
 gate_eave(gate,u,2.2,1.55,6.07)
 taper(gate,'子阙身',s*3.88,.98,.70,.82,3.76,0)
 gate_eave(gate,s*3.88,1.5,1.18,3.90)
 # White identification plaques are geometry; archive stone count is unaffected.
 gate.box('阙门标牌',(.85,.026,.55),(u,-.54,2.65),'white','detail')
 gate.mesh('实照门牌',[(u-.425,-.555,2.375),(u+.425,-.555,2.375),(u+.425,-.555,2.925),(u-.425,-.555,2.925)],[(0,1,2,3)],'plaque-left' if s<0 else 'plaque-right','detail',[[(0,0),(1,0),(1,1),(0,1)]])
gate.box('门额石梁',(3.98,1.0,.28),(0,0,4.47),'column')
gate_eave(gate,0,4.10,1.12,4.66)
gate.door('红框铁栅门',0,-.20,3.75,4.20,True)

# Import frozen north, exhibits and reference landscape. Architecture marked
# "site" retains the vector-traced CAD footprint but receives native new meshes
# and the same physical palette as the newly constructed houses.
payload=json.loads(BASE.read_text(encoding='utf-8'))
byid={r['id']:r for r in payload['objects']};geos={g['id']:g for g in payload['geometries']}
texs={r['id']:{**r,'file':str((OUT/'blender/reference-textures'/Path(r['file']).name).resolve())} for r in payload['textures']}
matrecords={r['id']:r for r in payload['materials']}
cache={};oldmats={};meshcache={}
def old_material(mid):
 if mid not in oldmats:oldmats[mid]=ref.make_material(matrecords[mid],texs,cache)
 return oldmats[mid]
def ancestry(r):
 while r:
  yield r
  r=byid.get(r.get('parentId'))
def datum_matrix(r):return C@Matrix([r['matrixWorld'][i:i+4] for i in range(0,16,4)]).transposed()
movements={};object_moves={};object_rotations={}
# Preserve the user's corrected straight row when regenerating the frozen exhibit copy.
approved_moves=json.loads((ROOT / 'src/frontend/src/archive/three/courtyardArchitectureManifest.json').read_text(encoding='utf-8'))['stone_movements']
que_row_ids={f'QS-{i}' for i in range(3,11)}
for r in payload['objects']:
 hps=r.get('userData',{}).get('hps')
 if not hps or hps['id']=='QS-B0':continue
 chain=list(ancestry(r));names={a['name'] for a in chain};p=datum_matrix(r).translation
 # Inverse courtyard plan registration. Translate close-to-wall exhibits only.
 a=((p.x-GX)+(-p.y-GZ))*SQ;b=((-p.y-GZ)-(p.x-GX))*SQ
 dx=dz=angle=0
 if 'rear_exhibition_hall' in names:
  if 'HPS_HALL_IN' in names:
   if abs(a-77.4)>5.2:dx=-math.copysign(.770, a-77.4)
   if abs(b)>9.4:dz=-math.copysign(.607,b)
   if hps.get('legacy_id')=='17 前石室后壁小龛东壁':dx-=.29
   if hps.get('legacy_id')=='16 前石室后壁小龛西壁':dx-=.33
  else:
   if hps.get('face')=='B':dx=-.70852
   if hps.get('face') in ['A','C']:dz=-math.copysign(.539608,b)
 elif 'front_que_hall' in names:
  if abs(a-39.34)>4.1:dx=-math.copysign(.47,a-39.34)
  if hps.get('legacy_id') in que_row_ids:
   # All eight remain parallel to the gable wall, with measured widths and 2 cm gaps.
   move=approved_moves[hps['id']]
   if move.get('rotation_y',0):raise ValueError('阙室八块题记必须沿同一面墙排直')
   dx,dz=move['plan_delta']
 elif 'HPS_XCL' in names:
  # The measured 27.94 m west hall extends .64 m past its earlier scaled gable.
  dx=.64
 if dx or dz:
  delta=(SQ*(dx-dz),-SQ*(dx+dz),0)
  movements[hps['id']]={'name':hps.get('name'),'world_delta':[delta[0],0,-delta[1]],'plan_delta':[dx,dz],'rotation_y':angle}
  ids={r['id']}|{part.get('objectId') for part in r['userData'].get('_parts',[]) if isinstance(part,dict)}
  for q in payload['objects']:
   if q['id'] in ids or any(x['id']==r['id'] for x in ancestry(q)):
    object_moves[q['id']]=delta
    if angle:object_rotations[q['id']]=(p.copy(),angle)

site_map={'brickPave':'paving','stonePave':'paving','plaza':'paving','plinth':'stone','baseStone':'stone','stone':'stone','rubble':'rubble','wallCap':'tile1','brick':'darkbrick','earth':'earth'}
imported=0
for r in payload['objects']:
 if r.get('type')!='Mesh' or r.get('skipRender') or not r.get('visible'):continue
 if r['id'] in ENTRANCE_BOUNDARY_SOURCE_IDS:continue
 if any(q['name']=='cypress_reference_landscape' for q in ancestry(r)):continue
 zone=r.get('userData',{}).get('courtyardReplacement')
 if zone and zone!='site':continue
 if any(q['parentId'] and q['type']=='Group' and abs(q['matrixWorld'][12]-world(3.06,-6.81)[0])<.01 and abs(q['matrixWorld'][14]+world(3.06,-6.81)[1])<.01 for q in ancestry(r)):continue
 mids=r.get('materialIds',[])
 if not mids:continue
 mats={mid:old_material(mid) for mid in mids}
 key=(r['geometryId'],tuple(mids))
 if key not in meshcache:meshcache[key]=ref.make_mesh(geos[r['geometryId']],mids,mats)
 mesh=meshcache[key]
 if zone=='site':
  mesh=mesh.copy()
  for i,mid in enumerate(mids):
   mn=matrecords[mid].get('name');mapped=site_map.get(mn)
   if mapped:mesh.materials[i]=M[mapped]
  if mesh.uv_layers:
   mapped=site_map.get(matrecords[mids[0]].get('name'))
   if mapped in METRIC:
    sx,sy=METRIC[mapped]
    for loop in mesh.uv_layers.active.data:loop.uv=(loop.uv.x/sx,loop.uv.y/sy)
 obj=bpy.data.objects.new(('新场地_' if zone else '保留_')+r['name'],mesh)
 col=arch if zone else north if r.get('userData',{}).get('courtyardNorthProtected') else archive if r.get('hps') or r.get('userData',{}).get('showcase') else context
 col.objects.link(obj);obj.matrix_world=datum_matrix(r)
 if r['id'] in object_rotations:
  pivot,angle=object_rotations[r['id']]
  obj.matrix_world=Matrix.Translation(pivot)@Matrix.Rotation(angle,4,'Z')@Matrix.Translation(-pivot)@obj.matrix_world
 if r['id'] in object_moves:obj.location+=Vector(object_moves[r['id']])
 # Cases at the rear follow their adjacent wall. Their glass/base geometry is
 # furnishing, not registered stone geometry, and can be refitted separately.
 if r.get('userData',{}).get('showcase') and any(q['name']=='rear_exhibition_hall' for q in ancestry(r)):
  p=obj.location;a=((p.x-GX)+(-p.y-GZ))*SQ;b=((-p.y-GZ)-(p.x-GX))*SQ
  dx=-math.copysign(.770,a-77.4) if abs(a-77.4)>5.2 else 0
  dz=-math.copysign(.607,b) if abs(b)>9.4 else 0
  obj.location+=Vector((SQ*(dx-dz),-SQ*(dx+dz),0))
  if dx or dz:object_moves[r['id']]=(SQ*(dx-dz),-SQ*(dx+dz),0)
 obj['source_object_id']=r['id'];obj['preserved_north']=bool(r.get('userData',{}).get('courtyardNorthProtected'))
 if r.get('hps'):obj['stone_id']=r['hps']['id']
 if zone:
  mn=matrecords[mids[0]].get('name');obj['arch_role']='wall' if mn in ['rubble','wallCap','brick'] else 'floor'
  obj['building']='09_院落与围墙'
  # Photo-based rough stone boundary is 2.50m; north supporting wall was excluded.
  if mn=='rubble':obj.location.z*=2.5/3;obj.scale.y*=2.5/3
  if mn=='wallCap':obj.location.z-=.50
 imported+=1

# Rebuild the photographed narrow cypresses with small branched foliage sprays.
# Only the existing landscape tree locations are used; no exhibit is introduced.
for i,c in enumerate([(48,69,39),(59,79,46),(69,89,50),(77,94,56)]):M['leaf'+str(i)]=material('柏树叶簇_'+str(i),c,.98)
tree_count=0
for r in payload['objects']:
 if not r.get('geometryId') or not any(q['name']=='cypress_reference_landscape' for q in ancestry(r)):continue
 if matrecords[r['materialIds'][0]].get('name')!='wood':continue
 p=datum_matrix(r).translation;a=((p.x-GX)+(-p.y-GZ))*SQ;b=((-p.y-GZ)-(p.x-GX))*SQ
 coords=geos[r['geometryId']]['positions'];height=(max(coords[1::3])-min(coords[1::3]))/.4
 tree=Builder('10_现场柏树',a,b)
 tree.cylinder('树干',.075,height*.9,(0,0,height*.45),'dark','detail',10)
 for level in range(29):
  t=level/29;z=height*(.16+.79*t);radius=.69*(1-t)**.58+.035
  for branch in range(7):
   angle=branch*math.tau/7+level*2.39996+random.uniform(-.15,.15)
   ux,uy=math.cos(angle),math.sin(angle)
   for k in range(7):
    d=radius*(.12+.88*k/6)*random.uniform(.87,1.08)
    center=Vector((ux*d,uy*d,z+.20*k/6+random.uniform(-.07,.07)))
    for spray in range(3):
     az=angle+(spray-1)*.72+random.uniform(-.2,.2)
     length=random.uniform(.10,.20)*(1-.4*t);wid=length*.36
     direction=Vector((math.cos(az)*.75,math.sin(az)*.75,.67));side=Vector((-math.sin(az),math.cos(az),.2))
     verts=[tuple(center-direction*length*.35),tuple(center-side*wid),tuple(center+direction*length),tuple(center+side*wid)]
     tree.mesh('枝叶喷簇',verts,[(0,1,2),(0,2,3)],'leaf'+str(random.randrange(4)),'detail')
 tree_count+=1

# Four new photo-based que/lion models are imported unmodified from the archive.
for r in payload['objects']:
 pm=r.get('userData',{}).get('photoModel')
 if not pm:continue
 file=stone_file(pm['archiveId'], Path('model') / 'photo-reconstruction-20260910.glb')
 before=set(bpy.data.objects)
 bpy.ops.import_scene.gltf(filepath=str(file))
 new=set(bpy.data.objects)-before
 # Blender converts GLB Y-up to Z-up on import. The anchor matrix rotates the
 # Blender-converted mesh back through the original Three model frame once.
 matrix=datum_matrix(r)@Matrix.Translation((0,-pm['height']/2,0))@C.inverted()
 for o in new:
  if o.parent not in new:o.matrix_world=matrix@o.matrix_world
  for co in list(o.users_collection):co.objects.unlink(o)
  archive.objects.link(o);o['stone_id']=r['hps']['id']

for (building,label,mat,role),(verts,faces,uvs) in buffers.items():
 mesh=bpy.data.meshes.new(building+'_'+label);mesh.from_pydata(verts,[],faces);mesh.update();mesh.materials.append(M[mat])
 uv=mesh.uv_layers.new(name='UVMap')
 for poly,coords in zip(mesh.polygons,uvs):
  for li,xy in zip(poly.loop_indices,coords):uv.data[li].uv=xy
 obj=bpy.data.objects.new(building+'_'+label+'_'+mat,mesh);arch.objects.link(obj)
 obj['building']=building;obj['arch_role']=role;obj['source']='CAD/PDF + 现场照片 20260910'

# Stable metadata is shared with the Three loader so the complete protected
# archive can stay independent of future architecture rebuilds.
report={
 'version':'20260910-cad-1','asset_revision':'entrance-20260910-v1','archive_count':150,
 'cad_dimensions':{'front':{'width_axes':20,'depth_axes':9.02,'apron':[22.2,11.22],'eave':5.53,'ridge':9.05},
                   'rear':{'width_axes':19.92,'depth_axes':10.8,'apron':[22.28,13.2],'eave':5.97,'ridge':8.97},
                   'west':{'length':27.94,'depth':5.1,'front_eave':2.915,'rear_eave':3.59,'ridge':5.37}},
 'stone_movements':movements,
 'furnishing_movements':{k:[v[0],v[2],-v[1]] for k,v in object_moves.items() if byid[k].get('userData',{}).get('showcase')},
 'north_preserved_meshes':len(north.objects),'architecture_meshes':len(arch.objects),
 'references':['武氏祠整体CAD.pdf P3–12/P13–19/P20–28','院落环境CAD.pdf P75/P83–88','ABCDEFG.dwg','04后展厅方案图_t3.dwg','现场参考照片'],
 'scope_note':'现状可视化重建；构造尺寸取修缮图，总图保留当前配准框架；照片不可见的小构造为示意。'}
(OUT/'scene/architecture-manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')

# PBR GLB comes directly from the Blender scene, with wall/roof roles as extras.
bpy.ops.object.select_all(action='DESELECT')
for o in arch.objects:o.select_set(True)
glb=OUT/'blender/武氏祠_院落建筑_20260910.glb'
bpy.ops.export_scene.gltf(filepath=str(glb),export_format='GLB',use_selection=True,export_extras=True,export_animations=False,export_cameras=False,export_lights=False)

scene.world=bpy.data.worlds.new('自然日光天空');scene.world.use_nodes=True
wn=scene.world.node_tree.nodes;wl=scene.world.node_tree.links
bg=wn.get('Background');bg.inputs['Color'].default_value=(.55,.68,.85,1);bg.inputs['Strength'].default_value=.52
ld=bpy.data.lights.new('柔和日光','SUN');lo=bpy.data.objects.new('柔和日光',ld);lights.objects.link(lo)
ld.energy=3.0;ld.angle=math.radians(8);lo.rotation_euler=(math.radians(24),math.radians(-32),math.radians(-28))
for name,a,b,h,target,lens in [
 ('01_院落鸟瞰',-60,88,142,(59,-18,0),42),
 ('02_阙室外立面',6,0,4.2,(39.34,0,3.6),36),
 ('03_后展厅外立面',46,-1,3.4,(77.4,0,3.65),36),
 ('04_西长廊',59,-17,6,(58.62,14.88,2.8),32),
 ('05_大门',-14,0,3.3,(1.49,0,2.9),38),
 ('06_后展厅山面',92,23,7,(77.4,0,3.8),38)]:
 camera=ref.make_camera(scene,name,world(a,b,h),world(*target),lens)
 if name.startswith('01_'):camera.data.type='ORTHO';camera.data.ortho_scale=176
 for col in list(camera.users_collection):col.objects.unlink(camera)
 lights.objects.link(camera)
scene.camera=bpy.data.objects['保留_01_院落鸟瞰']
scene.render.engine='CYCLES';scene.cycles.samples=64;scene.cycles.use_denoising=True
scene.render.resolution_x=1800;scene.render.resolution_y=1200;scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX';scene.view_settings.look='AgX - Medium High Contrast';scene.view_settings.exposure=.35
scene.render.image_settings.file_format='PNG'
try:
 prefs=bpy.context.preferences.addons['cycles'].preferences;prefs.compute_device_type='OPTIX';prefs.get_devices()
 for dev in prefs.devices:dev.use=dev.type!='CPU'
 scene.cycles.device='GPU'
except Exception as e:print('Cycles device:',e,flush=True)
scene.render.film_transparent=False
bpy.ops.object.select_all(action='DESELECT')
for screen in bpy.data.screens:
 for area in screen.areas:
  if area.type=='VIEW_3D':
   space=area.spaces.active
   space.clip_end=2500
   space.region_3d.view_perspective='CAMERA'
   space.shading.type='MATERIAL'
   space.shading.use_scene_world=True;space.shading.use_scene_lights=True
   space.overlay.show_overlays=False
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'blender/武氏祠_院落重建_20260910.blend'))
print(json.dumps({'architecture_meshes':len(arch.objects),'native_batches':len(buffers),'protected_north':len(north.objects),'stone_movements':len(movements),'glb_bytes':glb.stat().st_size},ensure_ascii=False),flush=True)
