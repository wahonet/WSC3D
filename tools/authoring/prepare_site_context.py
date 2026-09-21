"""Prepare the yellow-envelope context without changing either existing model.

0804 DWG supplies relative plan dimensions and existing building footprints. The
user's aerial supplies the requested envelope and visible roads/field divisions.
Heights of off-site buildings and vegetation are illustrative, not surveyed.
Run with Python containing numpy, shapely >=2.1 and matplotlib.
"""
from pathlib import Path
import hashlib
import json
import math
import numpy as np
import shapely
from shapely.geometry import Polygon, Point, LineString
from shapely.ops import unary_union
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, source_files, node_binary
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT / 'resources/authoring/site-context'
DATA=ROOT / 'resources/georeferencing/site-context.json'
cad=json.loads((OUT/'reference/registered-cad.json').read_text('utf-8'))
source=json.loads((ROOT / 'resources/georeferencing/hanwenhua-center-source.json').read_text('utf-8'))
placement=json.loads((ROOT / 'resources/georeferencing/hanwenhua-center-placement.json').read_text('utf-8'))
court=Polygon(json.loads((ROOT / 'resources/georeferencing/courtyard-registration.json').read_text('utf-8'))['boundaryWorldXZ'])
angle=math.radians(placement['transform']['rotationYDeg'])
rotation=np.array([[math.cos(angle),-math.sin(angle)],[math.sin(angle),math.cos(angle)]])
translation=np.array(placement['transform']['translation'])[[0,2]]
def local_world(points):
    points=np.array(points)
    return np.column_stack((points[:,0],-points[:,1]))@rotation+translation
center=Polygon(local_world(source['plotBoundaryLocal']))
# Image #2 coordinates normalized to a 2048-pixel-wide reference. Eight distinct
# blue-boundary corners, rather than the image edges or the unmeasured red line.
pixels=np.array([[575,74],[641,76],[639,136],[999,142],[1004,764],[729,759],[672,846],[524,830]])
local=np.array(source['plotBoundaryLocal'])[[0,1,2,3,12,13,15,16]]
pixel_matrix=np.linalg.lstsq(np.column_stack([pixels,np.ones(len(pixels))]),local,rcond=None)[0]
residual=np.linalg.norm(np.column_stack([pixels,np.ones(len(pixels))])@pixel_matrix-local,axis=1)
def aerial(points):return local_world(np.column_stack([points,np.ones(len(points))])@pixel_matrix)
envelope=Polygon(aerial([[549,32],[1037,46],[1029,1141],[479,1175]]))
outside=envelope.difference(unary_union([center,court]))
def polygons(g):
    if g.is_empty:return []
    if g.geom_type=='Polygon':return [g]
    if g.geom_type not in ['MultiPolygon','GeometryCollection']:return []
    return [p for part in g.geoms for p in polygons(part)]
def rings(g):
    return [dict(outer=np.round(p.exterior.coords,4).tolist(),
                 holes=[np.round(h.coords,4).tolist() for h in p.interiors]) for p in polygons(g)]
def triangles(g):
    items=[]
    for p in polygons(g):
        items.extend(np.round(list(t.exterior.coords)[:3],5).tolist()
                     for t in shapely.constrained_delaunay_triangles(p).geoms)
    return items
surfaces=[]
def surface(name,geometry,material,y,origin,clip=True):
    g=geometry.intersection(outside) if clip else geometry
    if g.area<.02:return g
    tris=triangles(g)
    assert abs(sum(Polygon(t).area for t in tris)-g.area)<.05, name+' incomplete triangulation'
    surfaces.append(dict(name=name,material=material,y=y,source=origin,areaM2=round(g.area,3),triangles=tris))
    return g
surface('黄线范围连续地坪',outside,'grass',-.035,'用户黄线范围；与院落及传承中心边界严密拼接')
def road_pixels(name,pts,width,material='asphalt'):
    g=LineString(aerial(pts)).buffer(width/2,cap_style='flat',join_style='round')
    surface(name+'路肩',g.buffer(.55),'shoulder',-.017,'航拍道路走向')
    return surface(name,g,material,.008,'航拍道路走向')
road_geoms=[]
north=Polygon(aerial([[549,32],[1037,46],[1037,92],[547,78]]))
road_geoms.append(surface('北侧公路（黄线内部分）',north,'asphalt',.008,'航拍北侧现状公路'))
road_geoms.append(road_pixels('西侧村道',[[561,66],[555,160],[540,405],[524,644],[512,839],[497,1127],[494,1168]],6.1))
road_geoms.append(road_pixels('东侧村道',[[1024,92],[1029,371],[1028,608],[1026,771],[1025,925],[1024,1075],[1007,1138]],5.4,'lane'))
road_geoms.append(road_pixels('南侧村道',[[486,1163],[673,1152],[817,1143],[1017,1134],[1030,1133]],5.6,'lane'))
# These survey polylines enclose the existing parking apron outside the north-west gate.
parking=Polygon([[-112.9,-71],[-68,-68.2],[-39.7,-65.8],[-40.4,-52.2],[-38.7,-44.5],[-53,-30.8],[-112,-35]])
road_geoms.append(surface('现状停车场',parking,'concrete',.015,'0804 CAD waibu 现状停车场及航拍'))
parking_entry=LineString([[-121,-42],[-104,-43],[-60,-41],[-46.2,-34.3]]).buffer(3,cap_style='flat',join_style='round')
road_geoms.append(surface('停车场至武氏祠大门通道',parking_entry,'concrete',.018,'CAD 停车场及现有模型大门位置衔接'))
# User confirmed the curved walk outside the centre boundary does not exist.
# Keep this interface as lawn; do not extend a CAD proposal into the existing site.
road_geoms.append(road_pixels('过渡地块田间路',[[529,831],[665,845],[742,866],[1008,861]],2.1,'dirt'))
roads=unary_union(road_geoms)

# The smallest closed CAD footprint containing a storey mark is a building;
# larger enclosing plots are not extruded as solid buildings.
candidates=[]
for i,e in enumerate(cad['entities']):
    if 'waibu' not in e['block'] or not e['closed'] or len(e['points'])<4:continue
    p=Polygon(e['points']).buffer(0)
    if 8<p.area<1200 and p.geom_type=='Polygon':candidates.append((i,e,p))
chosen={}
for label in cad['texts']:
    if 'waibu' not in label['block'] or label['text'] not in ['1','2','简']:continue
    point=Point(label['point'])
    matches=[v for v in candidates if v[2].buffer(.65).covers(point)]
    if not matches:continue
    i,e,p=min(matches,key=lambda v:v[2].area)
    if not envelope.covers(p.centroid) or p.intersection(center.buffer(.6)).area>.1 or p.intersection(court.buffer(.55)).area>.1:continue
    # A small existing building stands within the parking apron; paved ground
    # beneath a footprint must not make that building disappear.
    if p.intersection(unary_union(road_geoms[:4])).area>p.area*.15:continue
    chosen[i]=(e,p,label)
buildings=[]
for i,(e,p,label) in sorted(chosen.items()):
    p=p.intersection(envelope)
    if p.geom_type!='Polygon':continue
    floors=2 if label['text']=='2' else 1
    height=6.15 if floors==2 else 2.65 if label['text']=='简' else 3.25
    buildings.append(dict(name=f'现状院外建筑_{i}',cadEntityIndex=i,sourceHandle=e['handle'],
        source='0804 CAD / waibu / DMTZ-1',footprint=np.round(p.exterior.coords,4).tolist(),
        triangles=triangles(p),height=height,storeys=floors,storeyMark=label['text'],
        roof='red' if i in [9030,8974,9180] else 'blue' if label['text']=='简' else 'grey',
        heightSource='按 CAD 层数作示意，未实测立面高度'))
building_area=unary_union([Polygon(b['footprint']) for b in buildings])
yards=[]
for name,pts in [
    ('西北侧现状院落',[[-112,-33],[-65,-32],[-58,-22],[-59,7],[-113,7]]),
    ('西南侧现状院落',[[-113,6],[-79,6],[-70,37],[-71,48],[-115,52]]),
    ('沿墙居住院落',[[-77,-32],[-63,-32],[-40,-10],[-17,41],[-49,48],[-69,38],[-71,7]])]:
    yards.append(surface(name,Polygon(pts).difference(roads),'yard',-.006,'CAD 院墙与航拍硬化院地'))
yard_area=unary_union(yards)
plantable=outside.difference(unary_union([roads.buffer(1.1),building_area.buffer(1),yard_area]))
fields=[]
for name,pts,material in [
    ('北侧狭长地块',[[642,80],[1020,91],[1017,136],[644,131]],'field')]:
    fields.append(surface(name,Polygon(aerial(pts)).intersection(plantable),material,-.013,'用户航拍可见地块分界'))
# A continuous low-contrast lawn replaces the contrasting field overlays and
# their row markings at the courtyard/centre interface, including the removed walk.
interface=Polygon([[-65,-112],[74,-112],[74,-24],[-65,-24]])
interface=interface.difference(unary_union([roads,building_area,yard_area]))
surface('两区交界连续绿地',interface,'lawn',-.013,'用户确认交界处草坪统一颜色；弯曲连接路不存在')
details=[]
def line_detail(name,pts,width,height,material):
    # Flat strips, already clipped so no line or kerb crosses protected ground.
    return surface(name,LineString(pts).buffer(width/2,cap_style='flat'),material,height,'环境细部')
# Faint traffic markings visible on the northern public road.
north_line=LineString(aerial([[552,52],[1035,66]]))
for d in np.arange(1,north_line.length-5,11):
    line_detail('北侧公路虚线',[north_line.interpolate(d).coords[0],north_line.interpolate(d+5).coords[0]],.15,.022,'marking')
# Parking remains a shared concrete apron; only the southern row is marked.
for i in range(11):
    x=-104+i*2.8
    g=LineString([[x,-40.3],[x,-45.3]]).buffer(.055,cap_style='flat').intersection(parking).difference(parking_entry)
    surface('停车场车位线',g,'marking',.03,'停车场位置据航拍；车位线示意')
for i,field in enumerate(fields):
    if field.is_empty:continue
    x0,z0,x1,z1=field.bounds
    for z in np.arange(z0+2,z1,3.5):
        g=LineString([[x0,z],[x1,z+.9]]).buffer(.12).intersection(field)
        surface('地块植被行纹',g,'furrow',-.004,'航拍地块纹理示意')
# Boundary walls of the west-side ancillary compounds, with access breaks.
for i,points in enumerate([
    [[-112,-33],[-112,-24]], [[-113,-16],[-113,1]],
    [[-114,9],[-114,12]], [[-76,7],[-76,15]],
    [[-71,23],[-71,33]], [[-69,-28],[-61,-26]],
    [[-57,11],[-54,18]], [[-48,32],[-38,43]],
]):
    geom=LineString(points).buffer(.15,cap_style='flat').intersection(outside).difference(building_area)
    for p in polygons(geom):details.append(dict(name=f'附属院墙_{i}',kind='wall',height=1.65,footprint=list(p.exterior.coords),triangles=triangles(p)))
# Preserve established vegetation while editing roads and ground materials.
vegetation_file=ROOT / 'resources/georeferencing/site-context-vegetation.json'
trees=json.loads(vegetation_file.read_text('utf-8'))['trees']
manifest=dict(version='20260911-context-v4',label='周边环境及传承中心',defaultVisible=False,
    asset='models/site-context-20260911.glb',coordinateFrame='existing courtyard world X/Z metres',
    envelopeWorldXZ=np.round(envelope.exterior.coords,4).tolist(),
    centerBoundaryWorldXZ=np.round(center.exterior.coords,4).tolist(),courtyardBoundaryWorldXZ=list(court.exterior.coords),
    bounds={'min':[round(envelope.bounds[0],3),-.05,round(envelope.bounds[1],3)],'max':[round(envelope.bounds[2],3),12,round(envelope.bounds[3],3)]},
    viewpoint={'p':[270,300,250],'t':[-25,0,-154]},
    aerialRegistration={'normalizedImageWidth':2048,'blueCornerPixels':pixels.tolist(),'pixelToCenterLocal':pixel_matrix.tolist(),
        'rmsM':float(np.sqrt(np.mean(residual**2))),'maxM':float(residual.max())},
    cadRegistration=cad['fit'],
    accuracy='相对场景配准，沿用院落 RTK 匹配约 4.6 m RMS；CAD 轮廓同形不代表新增测绘精度。',
    sources=[dict(file=logical.relative_to(ROOT).as_posix(),sha256=hashlib.sha256(p.read_bytes()).hexdigest())
             for logical,p in [*source_files('resources/sources/site-context-20260911'),(vegetation_file,vegetation_file)]],
    limitations=['原有院落及传承中心设计模型位置与尺寸保持不变。','周边建筑平面依据 CAD；立面、树高和环境细部按航拍作示意复原。','交界处按用户确认保留连续绿地，未建的弯曲连接路及路缘已取消。'],
    stats={'envelopeAreaM2':round(envelope.area,1),'addedGroundAreaM2':round(outside.area,1),'buildings':len(buildings),'trees':len(trees),'surfaceMeshes':len(surfaces)},
    surfaces=surfaces,buildings=buildings,details=details,trees=trees)
DATA.write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
small={k:manifest[k] for k in ['version','label','defaultVisible','asset','envelopeWorldXZ','bounds','viewpoint','stats','accuracy','limitations']}
(ROOT / 'src/frontend/src/archive/three/siteContextManifest.json').write_text(json.dumps(small,ensure_ascii=False,indent=2),encoding='utf-8')
fig,ax=plt.subplots(figsize=(11,17))
colors={'grass':'#b4ba8d','lawn':'#76835c','asphalt':'#525d62','lane':'#788080','concrete':'#bcbbb1','paving':'#e3d9c3','field':'#929677','meadow':'#819073','yard':'#c4beb1','dirt':'#c1ad85','shoulder':'#aba791','kerb':'#cecbbd','marking':'#ebe8cf','furrow':'#7a8563'}
for s in surfaces:
    for t in s['triangles']:ax.fill([v[0] for v in t],[-v[1] for v in t],color=colors[s['material']],linewidth=0)
for poly,color in [(center,'#748967'),(court,'#dad4c2')]:
    ax.fill(*((np.array(poly.exterior.coords)*[1,-1]).T),color=color,alpha=.45)
for b in buildings:
    p=np.array(b['footprint']);ax.fill(p[:,0],-p[:,1],color='#836557' if b['roof']=='red' else '#65747d',edgecolor='#4a4e4e',lw=.4)
    c=Polygon(p).centroid;ax.text(c.x,-c.y,str(b['cadEntityIndex']),size=5)
for t in trees:ax.add_patch(plt.Circle((t['x'],-t['z']),1.7,color='#456148',alpha=.7))
for poly,color in [(envelope,'#c4a34a'),(center,'#477abb'),(court,'#b95247')]:ax.plot(*(np.array(poly.exterior.coords)*[1,-1]).T,color=color,lw=1.5)
ax.set_aspect('equal');ax.set_title('Unified site / surrounding roads, existing compounds and connecting ground');ax.grid(alpha=.12)
fig.savefig(OUT/'reference/context-plan.png',dpi=145,bbox_inches='tight');plt.close(fig)
print(json.dumps(manifest['stats'],ensure_ascii=False))
