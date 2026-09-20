import * as THREE from 'three-inventory';
import { OrbitControls } from 'three-inventory/examples/jsm/controls/OrbitControls';
import { buildSite } from '../three/buildSite';
import { applyCatalogue } from '../three/catalogue';
import catalogue from '../three/catalogueMap.json';
import manifest from '../three/stoneTextureManifest.json';
import { applyRearLayout, rearDefaults, type RearPlacement } from '../three/rearHallLayout';
import { createRearExhibition, rearStoneBounds } from '../three/rearExhibition';
import './rearPlacement.css';

document.getElementById('app')!.innerHTML=`
<header><div><h1>后展厅石刻摆放</h1><small>武氏祠 · 46 件石刻</small></div><div id="save-state" role="status">正在载入平台布局…</div></header>
<div class="layout"><aside><input id="search" type="search" aria-label="搜索编号或名称" placeholder="搜索编号或名称"/><div id="count">全部 46 件</div><div id="list"></div><button id="reload">重新载入平台布局</button></aside>
<main id="viewport"><div class="views"><button id="top">俯视</button><button id="oblique">斜视</button><button id="inside">室内</button><button id="focus">定位选中石刻</button><button id="drag" aria-pressed="false">开启拖动</button></div><div class="hint" id="hint">点击石刻或左侧列表选择；开启拖动后，可在展厅平面内移动。</div></main>
<aside><h2 id="selection">选择一件石刻</h2><p id="size">尺寸按档案保留</p><div class="fields">
${[['x','横向 X（米）'],['z','纵向 Z（米）'],['y','中心高度（米）'],['ry','水平转角（°）'],['rx','X 倾转（°）'],['rz','Z 倾转（°）']].map(([id,label])=>`<label>${label}<input id="${id}" type="number" step="${id.startsWith('r')?'1':'.01'}" disabled/></label>`).join('')}</div>
<label class="toggle"><input id="snap" type="checkbox" checked/>拖动按 1 厘米吸附</label><div class="actions"><button id="undo" disabled>撤销</button><button id="redo" disabled>重做</button></div>
<div id="clearance" class="status">选择石刻后检查与展柜的关系。</div><label class="toggle"><input id="glass" type="checkbox" checked/>显示玻璃</label><label class="toggle"><input id="roof" type="checkbox"/>显示吊顶和柜顶</label>
<hr/><button id="save" class="primary" disabled>保存到主平台</button><div class="actions"><button id="export">导出布局 JSON</button><button id="import">导入布局 JSON</button></div><input class="file" id="file" type="file" accept=".json,application/json"/><p class="subtle">保存会保留上一版布局。回到主平台后自动更新；导入的布局先在这里预览。</p><p class="subtle" id="load-status">展陈模型加载中…</p></aside></div>`;
const $ = <T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const clone = <T>(value:T):T=>JSON.parse(JSON.stringify(value));
let rows=clone(rearDefaults.stones), baseVersion='', selected='', dirty=false, dragMode=false, loading=false;
let undo:RearPlacement[][]=[], redo:RearPlacement[][]=[];
const viewport=$('viewport');
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));
renderer.outputEncoding=THREE.sRGBEncoding;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
viewport.prepend(renderer.domElement);
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(48,1,.02,150);
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.minDistance=.3;controls.maxDistance=50;
const textures:Record<string,THREE.Texture>={};const loader=new THREE.TextureLoader();
let site:ReturnType<typeof buildSite>|undefined;
for(const entry of manifest.entries) {
  const texture=loader.load('/textures/stones/'+encodeURIComponent(entry.file),t=>{t.userData.loadState='loaded';site?.refreshStoneTextures();},undefined,()=>{texture.userData.loadState='error';site?.refreshStoneTextures();});
  texture.userData={...entry,loadState:'loading'};texture.encoding=THREE.sRGBEncoding;texture.anisotropy=8;
  const [x,y,w,h]=entry.crop,[iw,ih]=entry.imageSize;
  texture.repeat.set(w/iw,h/ih);texture.offset.set(x/iw,1-(y+h)/ih);
  textures[entry.id+('faceKey' in entry?':'+entry.faceKey:'')]=texture;
}
site=buildSite(scene,textures);applyCatalogue(scene,catalogue);
const hall=scene.getObjectByName('rear_exhibition_hall')!, stoneGroup=scene.getObjectByName('HPS_HALL_IN')!;
hall.removeFromParent();scene.clear();
hall.children.filter(o=>o!==stoneGroup).forEach(o=>hall.remove(o));
hall.position.set(0,0,0);hall.rotation.set(0,0,0);hall.scale.setScalar(1);scene.add(hall);
scene.background=new THREE.Color(0x11191f);scene.fog=null;
scene.add(new THREE.HemisphereLight(0xdce8f3,0x595048,1));
const light=new THREE.DirectionalLight(0xfff2d9,1.15);light.position.set(-3,10,7);scene.add(light);
const roofs:THREE.Object3D[]=[], walls:THREE.Mesh[]=[];
const anchors=new Map<string,THREE.Object3D>();stoneGroup.children.forEach(o=>{if(o.userData.hps)anchors.set(o.userData.hps.catalogue_no,o);});
const highlight=new THREE.Box3Helper(new THREE.Box3(),new THREE.Color(0xf2c479));highlight.visible=false;(highlight.material as THREE.Material).depthTest=false;highlight.renderOrder=10;scene.add(highlight);
const exhibition=createRearExhibition(scene,roofs,walls,()=>{setVisibility();sync();});
const resize=()=>{renderer.setSize(viewport.clientWidth,viewport.clientHeight);camera.aspect=viewport.clientWidth/viewport.clientHeight;camera.updateProjectionMatrix();};
new ResizeObserver(resize).observe(viewport);resize();
function view(position:number[],target:number[]=[0,1,0]){camera.position.set(...position as [number,number,number]);controls.target.set(...target as [number,number,number]);controls.update();}
view([0,28,.01],[0,0,0]);
$('top').onclick=()=>{view([0,28,.01],[0,0,0]);};
$('oblique').onclick=()=>view([13,17,17]);
$('inside').onclick=()=>{view([-3.1,1.8,-3],[1.2,1.5,5.7]);};
function setVisibility(){roofs.forEach(o=>o.visible=$<HTMLInputElement>('roof').checked);hall.traverse(o=>{if(o.userData.rear_role==='glass')o.visible=$<HTMLInputElement>('glass').checked;});}
$('roof').onchange=$('glass').onchange=setVisibility;
function renderList(){
  const query=$<HTMLInputElement>('search').value.trim().toLowerCase();
  const filtered=rows.filter(r=>(r.id+r.name).toLowerCase().includes(query));
  $('count').textContent=`${filtered.length} / 46 件`;
  $('list').replaceChildren(...filtered.map(row=>{
    const button=document.createElement('button');button.type='button';button.title=row.id+' '+row.name;button.setAttribute('aria-pressed',String(selected===row.id));
    const number=document.createElement('span');number.className='no';number.textContent=row.id;
    const name=document.createElement('span');name.className='name';name.textContent=row.name;
    button.append(number,name);button.onclick=()=>choose(row.id);return button;
  }));
}
$('search').oninput=renderList;
const keys=['x','y','z','rx','ry','rz'] as const;
function choose(id:string){selected=id;renderList();updateSelection();}
function updateSelection(){
  const row=rows.find(r=>r.id===selected), stone=anchors.get(selected);
  if(!row||!stone)return;
  $('selection').textContent=row.id+' '+row.name;
  $('size').textContent=`档案尺寸：${row.size.map(n=>+(n*100).toFixed(1)).join(' × ')} 厘米`;
  for(const key of keys){const input=$<HTMLInputElement>(key);input.disabled=false;input.value=(row[key]*(key.startsWith('r')?180/Math.PI:1)).toFixed(key.startsWith('r')?1:3);}
  highlight.box.copy(rearStoneBounds(stone));highlight.visible=!highlight.box.isEmpty();
  const b=highlight.box;
  const cases:{x:number,z:number,w:number,d:number,h:number}[]=[];
  for(const x of [-4.52,4.52])for(const z of [-5.7,5.7])cases.push({x,z,w:1.36,d:7.84,h:4});
  for(const z of [-9.5,9.5])cases.push({x:0,z,w:9.94,d:.96,h:4});
  cases.push({x:0,z:0,w:2.85,d:2.95,h:2.95},...[-5,5].map(z=>({x:0,z,w:1.55,d:4.35,h:2.95})));
  const c=cases.find(c=>b.min.x>c.x-c.w/2+.02&&b.max.x<c.x+c.w/2-.02&&b.min.z>c.z-c.d/2+.02&&b.max.z<c.z+c.d/2-.02&&b.min.y>=.79&&b.max.y<c.h);
  $('clearance').classList.toggle('warning',!c);
  $('clearance').textContent=c?'石刻包围盒位于展柜内。':'石刻包围盒超出展柜或过于接近玻璃，请结合室内视角检查。';
}
function sync(){applyRearLayout(scene,rows);exhibition?.syncPedestals();if(selected)updateSelection();}
function checkpoint(){undo.push(clone(rows));if(undo.length>60)undo.shift();redo=[];updateButtons();}
function updateButtons(){$<HTMLButtonElement>('undo').disabled=!undo.length;$<HTMLButtonElement>('redo').disabled=!redo.length;}
function markDirty(){dirty=true;$('save-state').textContent='有未保存的调整';updateButtons();}
for(const key of keys)$<HTMLInputElement>(key).onchange=()=>{
  const row=rows.find(r=>r.id===selected);if(!row)return;
  const input=$<HTMLInputElement>(key);let value=Number(input.value);
  if(!input.value.trim()||!Number.isFinite(value)){updateSelection();return;}
  if(key.startsWith('r'))value*=Math.PI/180;
  const limit=key==='x'?[-5.22,5.22]:key==='z'?[-9.95,9.95]:key==='y'?[.3,4.3]:[-100,100];
  if(value<limit[0]||value>limit[1]){$('save-state').textContent='数值超出展厅范围';updateSelection();return;}
  checkpoint();row[key]=value;markDirty();sync();
};
$('undo').onclick=()=>{if(!undo.length)return;redo.push(clone(rows));rows=undo.pop()!;markDirty();sync();};
$('redo').onclick=()=>{if(!redo.length)return;undo.push(clone(rows));rows=redo.pop()!;markDirty();sync();};
$('focus').onclick=()=>{const object=anchors.get(selected);if(!object)return;const b=rearStoneBounds(object),c=b.getCenter(new THREE.Vector3());const radius=Math.max(.9,b.getSize(new THREE.Vector3()).length()*.9);view([c.x-radius,c.y+radius*.65,c.z+radius],c.toArray());};
$('drag').onclick=()=>{dragMode=!dragMode;$('drag').setAttribute('aria-pressed',String(dragMode));$('drag').textContent=dragMode?'关闭拖动':'开启拖动';$('hint').textContent=dragMode?'拖动石刻调整平面位置；高度、转角可在右侧输入。':'点击石刻选择；按住空白处旋转视角，滚轮缩放。';};
const ray=new THREE.Raycaster(),pointer=new THREE.Vector2(),plane=new THREE.Plane(new THREE.Vector3(0,1,0),0);
let dragging:{id:string,offset:THREE.Vector3,start:RearPlacement[],moved:boolean}|undefined;
function rayAt(e:PointerEvent){const r=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);ray.setFromCamera(pointer,camera);}
renderer.domElement.addEventListener('pointerdown',e=>{
  if(e.button!==0)return;rayAt(e);
  const hit=ray.intersectObjects([...anchors.values()],true).find(h=>h.object.visible&&!h.object.userData.superseded&&!h.object.userData.rearProxy);
  if(!hit)return;
  let object:THREE.Object3D|null=hit.object;
  while(object&&!object.userData.hps&&!object.userData.hpsRef)object=object.parent;
  const anchor=object?.userData.hpsRef||object;
  const id=anchor?.userData.hps?.catalogue_no;if(!id)return;choose(id);
  if(!dragMode)return;
  const row=rows.find(r=>r.id===id)!;plane.constant=-row.y;
  const point=ray.ray.intersectPlane(plane,new THREE.Vector3());if(!point)return;
  dragging={id,offset:new THREE.Vector3(row.x,row.y,row.z).sub(point),start:clone(rows),moved:false};
  controls.enabled=false;renderer.domElement.setPointerCapture(e.pointerId);
},true);
renderer.domElement.addEventListener('pointermove',e=>{
  if(!dragging)return;rayAt(e);const point=ray.ray.intersectPlane(plane,new THREE.Vector3());if(!point)return;
  point.add(dragging.offset);const row=rows.find(r=>r.id===dragging!.id)!;
  const snap=$<HTMLInputElement>('snap').checked;
  row.x=THREE.MathUtils.clamp(snap?Math.round(point.x*100)/100:point.x,-5.22,5.22);
  row.z=THREE.MathUtils.clamp(snap?Math.round(point.z*100)/100:point.z,-9.95,9.95);
  dragging.moved=true;markDirty();sync();
});
function endDrag(){if(!dragging)return;if(dragging.moved){undo.push(dragging.start);redo=[];updateButtons();}dragging=undefined;controls.enabled=true;}
renderer.domElement.addEventListener('pointerup',endDrag);renderer.domElement.addEventListener('pointercancel',endDrag);
function validate(payload:any):RearPlacement[]{
  if(payload?.version!=='rear-layout-1'||!Array.isArray(payload.stones)||payload.stones.length!==46)throw new Error('请使用本工具导出的后展厅布局（46件）。');
  const seen=new Set<string>();
  return payload.stones.map((r:any)=>{
    const source=rearDefaults.stones.find(s=>s.id===r.id);
    if(!source||seen.has(r.id))throw new Error('布局编号重复或不匹配。');seen.add(r.id);
    for(const key of keys)if(typeof r[key]!=='number'||!Number.isFinite(r[key]))throw new Error('布局含无效数值。');
    if(Math.abs(r.x)>5.22||Math.abs(r.z)>9.95||r.y<.3||r.y>4.3||['rx','ry','rz'].some(k=>Math.abs(r[k])>100))throw new Error('布局数值超出展厅范围。');
    return {...source,...Object.fromEntries(keys.map(k=>[k,r[k]]))};
  });
}
async function reload(){
  if(loading)return;loading=true;
  try{const response=await fetch('/api/layouts/rear',{cache:'no-store'});if(!response.ok)throw new Error('无法读取主平台布局');const payload=await response.json();const next=validate(payload);if(dirty)checkpoint();rows=next;baseVersion=payload.updated_at;dirty=false;sync();renderList();$('save-state').textContent='已载入主平台布局';$<HTMLButtonElement>('save').disabled=false;}
  catch(e){$('save-state').textContent=String(e);}
  finally{loading=false;}
}
$('reload').onclick=reload;
$('save').onclick=async()=>{
  const button=$<HTMLButtonElement>('save');button.disabled=true;
  try{const response=await fetch('/api/layouts/rear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:'rear-layout-1',base_updated_at:baseVersion,stones:rows})});const payload=await response.json();if(!response.ok)throw new Error(payload.detail||'保存失败');baseVersion=payload.updated_at;dirty=false;$('save-state').textContent=`已保存 ${payload.count} 件 · 主平台已同步`;window.opener?.postMessage({type:'rear-layout-applied'},location.origin);}
  catch(e){$('save-state').textContent=String(e);}
  finally{button.disabled=false;}
};
$('export').onclick=()=>{const payload={version:'rear-layout-1',coordinateSystem:'rear-hall-local-metres',updated_at:new Date().toISOString(),stones:rows};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='后展厅石刻布局.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('import').onclick=()=>$<HTMLInputElement>('file').click();
$<HTMLInputElement>('file').onchange=async()=>{const input=$<HTMLInputElement>('file'),file=input.files?.[0];if(!file)return;try{const next=validate(JSON.parse(await file.text()));checkpoint();rows=next;markDirty();renderList();sync();$('save-state').textContent='已导入预览，保存后同步到主平台';}catch(e){$('save-state').textContent=String(e);}finally{input.value='';}};
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
renderList();applyRearLayout(scene,rows);void reload();
exhibition.ready.then(()=>{$('load-status').textContent=exhibition.report.errors.length?'部分模型加载失败：'+exhibition.report.errors.join('、'):'展陈已载入 · 两块小龛使用真实扫描';setVisibility();sync();});
function loop(){requestAnimationFrame(loop);if(document.hidden)return;controls.update();renderer.render(scene,camera);}loop();
