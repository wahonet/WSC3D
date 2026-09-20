from pathlib import Path
import json,math,sys,numpy as np
sys.stdout.reconfigure(encoding='utf-8')
root=Path(__file__).resolve().parents[2];out=root/'resources/authoring/courtyard'
s=json.loads((out/'scene/baseline/scene.json').read_text(encoding='utf-8'))
m=json.loads((out/'scene/architecture-manifest.json').read_text(encoding='utf-8'))
by={o['id']:o for o in s['objects']};geo={g['id']:g for g in s['geometries']}
SQ=math.sqrt(.5);GX,GZ=(423.1-687)*.17639,(124.6-314)*.17639
issues=[];checked=[]
for o in s['objects']:
 h=o.get('userData',{}).get('hps')
 if not h or h['id']=='QS-B0':continue
 chain=[];p=o
 while p:chain.append(p['name']);p=by.get(p.get('parentId'))
 exterior=None;offset_b=0;lower=None
 if 'HPS_HALL_IN' in chain:center=77.4;limits=np.array([5.125,9.685])
 elif 'HPS_QUE_IN' in chain:center=39.34;limits=np.array([4.21,9.70])
 elif 'HPS_XCL_IN' in chain:
  center=58.62;offset_b=14.88;limits=np.array([13.65,2.15]);lower=np.array([-13.65,-.93])
 elif 'HPS_REAR' in chain:
  center=77.4;exterior=h['face']
 elif 'HPS_XCL' in chain:center=0;exterior='X'
 else:continue
 pts=np.array(geo[o['geometryId']]['positions']).reshape(-1,3)
 matrix=np.array(o['matrixWorld']).reshape(4,4).T
 pts=(np.c_[pts,np.ones(len(pts))]@matrix.T)[:,:3]
 move=m['stone_movements'].get(h['id'],{});angle=move.get('rotation_y',0)
 if angle:
  pivot=matrix[:3,3];c,ss=math.cos(angle),math.sin(angle)
  pts=(pts-pivot)@np.array([[c,0,ss],[0,1,0],[-ss,0,c]]).T+pivot
 delta=move.get('world_delta',[0,0,0]);pts+=delta
 local=np.c_[((pts[:,0]-GX)+(pts[:,2]-GZ))*SQ-center,((pts[:,2]-GZ)-(pts[:,0]-GX))*SQ-offset_b]
 if exterior=='X':clearance=np.array([local[:,0].min()-72.59])
 elif exterior=='B':clearance=np.array([local[:,0].min()-5.675])
 elif exterior in ['A','C']:clearance=np.array([(local[:,1]*(1 if exterior=='A' else -1)).min()-10.235])
 elif lower is not None:clearance=np.minimum(local.min(axis=0)-lower,limits-local.max(axis=0))
 else:clearance=limits-np.max(np.abs(local),axis=0)
 record={'id':h['id'],'legacy_id':h.get('legacy_id'),'exterior':exterior,'clearance':clearance.tolist(),'bounds':[local.min(axis=0).tolist(),local.max(axis=0).tolist()]}
 checked.append(record)
 if min(clearance)<(-.01 if exterior else .02):issues.append(record)
print(json.dumps(issues,ensure_ascii=False,indent=2))
(out/'scene/clearance-issues.json').write_text(json.dumps(issues,ensure_ascii=False,indent=2),encoding='utf-8')
(out/'scene/clearance-checks.json').write_text(json.dumps({'checked':len(checked),'items':checked},ensure_ascii=False,indent=2),encoding='utf-8')
