"""Upgrade the user's existing placement tool and keep an identical hosted copy."""
from pathlib import Path
import base64, io, json, re, sys
from PIL import Image
sys.stdout.reconfigure(encoding='utf-8')
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT / 'resources/authoring/catalogue-preparation'
TOOL=ROOT / 'resources/reference/viewers/04-旧版三维模型/摆放工具/西长廊石刻摆放.html'
src=(OUT/'inputs/placement-tool-original.html').read_text(encoding='utf-8')
layout=json.loads((ROOT/'data/layouts/xcl-default.json').read_text(encoding='utf-8'))['stones']
rows=json.loads((OUT/'xcl-candidates.json').read_text(encoding='utf-8'))
old_to_new={r['id']:r['no'] for r in rows}
images={}
for s in layout:
    im=Image.open(ROOT / 'tools/viewers/placement' / s['photo']); im.thumbnail((1024,1024))
    content=io.BytesIO(); im.save(content,format='WEBP',quality=84,method=4)
    images[s['id']]='data:image/webp;base64,'+base64.b64encode(content.getvalue()).decode()
start=src.index('const INIT = [',src.index('const GLTF_BASE'))
end=src.index('const LS_KEY',start)
src=src[:start]+'const INIT = '+json.dumps(layout,ensure_ascii=False)+';\nconst LEGACY_IDS = '+json.dumps(old_to_new,ensure_ascii=False)+';\nconst PHOTO_DATA = '+json.dumps(images)+';\n'+src[end:]
src=src.replace('共40件, 初始布局取自CAD布置图','共40件 · 实物照片贴图 · 使用新台账编号')
src=src.replace('<button data-op="export">','<button data-op="applySystem" class="on">应用到系统</button>\n    <button data-op="loadSystem">读取系统布局</button>\n    <button data-op="export">')
src=src.replace('CAD初始布局','初始布局')
src=src.replace('底部编辑条可改名称与尺寸(米)','底部编辑条可改摆放尺寸(米)与位置')
src=src.replace('<b>自动保存</b>到本浏览器, 改完导出JSON给我','<b>自动保存</b>到本浏览器；改完点击“应用到系统”<br>摆放尺寸不会改动台账的实测尺寸')
src=src.replace('width:26px','width:44px')
src=src.replace('<input type="text" id="sbName" title="名称">','<input type="text" id="sbName" title="台账名称" readonly>')
src=src.replace("s.id.replace('XCL-', '')","s.id")
src=src.replace("'初始布局取自CAD布置图, 尺寸为比例估算, 可在下方编辑条修正'","'照片与新编号已同步；调整位置后点击“应用到系统”'")
src=src.replace('renderer.setPixelRatio(', 'renderer.outputEncoding = THREE.sRGBEncoding;\nrenderer.setPixelRatio(',1)

# Only placement fields migrate; old names/IDs cannot overwrite the new catalogue.
helpers=r'''
function mergePlacement(base,row){
  const result={...base};
  for(const key of ['L','H','T','along','off','y','rotY']){
    if(['L','H','T'].includes(key) && base.sizeRevision && base.sizeRevision!==row.sizeRevision) continue;
    if(Number.isFinite(row[key]) && (!['L','H','T'].includes(key)||row[key]>0)) result[key]=row[key];
  }
  return result;
}
function placementMap(rows){
  if(!Array.isArray(rows)) throw new Error('布局内容应为石刻列表');
  const map={};
  for(const row of rows){
    const id=LEGACY_IDS[row.id]||row.id;
    if(!INIT.some(s=>s.id===id)) throw new Error('布局含不属于西长廊的编号');
    if(map[id]) throw new Error('布局含重复编号');
    map[id]=row;
  }
  return map;
}
let systemUpdatedAt = null;
function serializableLayout(){
  commitEditor();
  return {version:'xcl-layout-2',base_updated_at:systemUpdatedAt,stones:stones.map(s=>({id:s.id,name:s.name,wall:s.wall,
    L:s.L,H:s.H,T:s.T,along:s.along,off:s.off,y:s.y,rotY:s.rotY,sizeRevision:s.sizeRevision}))};
}
const SYSTEM_URL=location.protocol==='file:'?'http://127.0.0.1:8002':location.origin;
function commitEditor(){
  if(sel<0) return;
  const s=stones[sel];
  for(const [id,key] of [['sbL','L'],['sbH','H'],['sbT','T'],['sbA','along'],['sbO','off'],['sbY','y']]){
    const value=Number($('#'+id).value);
    if(!Number.isFinite(value)||(['L','H','T'].includes(key)&&value<=0)) throw new Error('请输入有效的摆放数值');
    if(value!==Number(s[key].toFixed(2))) s[key]=value;
  }
  clampStone(s);buildMesh(s);highlight();refreshList();refreshPanel();draw2D();
}
async function applyToSystem(){
  const button=$('[data-op="applySystem"]'); button.disabled=true;
  try{
    const layout=serializableLayout();
    clearTimeout(saveTimer); saveLS();
    if(!systemUpdatedAt) throw new Error('请先导出当前调整作备份，再读取系统布局；旧草稿没有可核对的版本。');
    const response=await fetch(SYSTEM_URL+'/api/layouts/xcl',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(layout)});
    const result=await response.json();
    if(!response.ok) throw new Error(typeof result.detail==='string'?result.detail:'布局数据无效');
    systemUpdatedAt=result.updated_at;
    saveLS(); toast('已将40件石刻的位置与贴图同步到系统；返回全景即可查看');
    if(window.opener) window.opener.postMessage({type:'xcl-layout-applied'},SYSTEM_URL);
  }catch(error){toast('应用失败：'+error.message+'；请确认8002上的系统已启动。');}
  finally{button.disabled=false;}
}
async function loadFromSystem(automatic=false){
  if(!automatic && !confirm('用系统中已应用的布局替换当前摆放？当前摆放可先导出JSON备份。')) return;
  try{
    const response=await fetch(SYSTEM_URL+'/api/layouts/xcl',{cache:'no-store'});
    if(!response.ok) throw new Error('读取失败');
    const result=await response.json(), map=placementMap(result.stones);
    systemUpdatedAt=result.updated_at;
    stones=fromInit().map(s=>map[s.id]?mergePlacement(s,map[s.id]):s);
    rebuildAll(); saveLS(); toast('已读取系统当前布局，40件照片随石刻同步移动');
  }catch(error){if(!automatic) toast('无法读取系统布局，请确认8002已启动。');}
}
const photoTextures={};
function photoFor(s){
  if(!photoTextures[s.id]){
    const tex=new THREE.TextureLoader().load(PHOTO_DATA[s.id],()=>draw2D());
    tex.encoding=THREE.sRGBEncoding; tex.anisotropy=4;
    photoTextures[s.id]=tex;
  }
  return photoTextures[s.id];
}
function profileShape(s){
  const shape=new THREE.Shape();
  s.profile.forEach((p,i)=>{const x=(p[0]-.5)*s.L,y=(.5-p[1])*s.H;if(i)shape.lineTo(x,y);else shape.moveTo(x,y);});
  shape.closePath();return shape;
}
function disposeStoneMesh(mesh){
  if(!mesh)return;
  mesh.traverse(o=>{if(o.isMesh){o.geometry.dispose();(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>m.dispose());}});
}
'''
src=src.replace('function fromInit(){',helpers+'\nfunction fromInit(){',1)
src=src.replace('const data = { v: 1, t: Date.now(), stones:', 'const data = { v: 1, t: Date.now(), base_updated_at:systemUpdatedAt, stones:')
src=src.replace('    return true;\n  }catch(e){ return false; }', "    systemUpdatedAt=typeof d.base_updated_at==='string'?d.base_updated_at:null;\n    return true;\n  }catch(e){ return false; }")
src=src.replace('id: s.id, name: s.name, L: s.L, H: s.H, T: s.T,','id: s.id, name: s.name, sizeRevision: s.sizeRevision, L: s.L, H: s.H, T: s.T,')
src=src.replace('id: s.id, name: s.name, wall: s.wall,','id: s.id, name: s.name, wall: s.wall, sizeRevision: s.sizeRevision,')
src=src.replace("    const map = {};\n    d.stones.forEach(s => map[s.id] = s);",'    const map = placementMap(d.stones);')
src=src.replace("{ ...s, ...map[s.id], wall: s.wall, gltf: s.gltf }",'mergePlacement(s,map[s.id])')
src=src.replace('      const map = {};\n      arr.forEach(s => map[s.id] = s);','      const map = placementMap(arr);')
start=src.index('function buildMesh(s){'); end=src.index('function placeMesh(s){',start)
src=src[:start]+r'''function buildMesh(s){
  if(s.mesh){stoneGroup.remove(s.mesh);disposeStoneMesh(s.mesh);}
  let geometry,frontGeometry;
  if(s.profile){
    const shape=profileShape(s);
    geometry=new THREE.ExtrudeGeometry(shape,{depth:s.T,bevelEnabled:false,steps:1});
    geometry.translate(0,0,-s.T/2);
    frontGeometry=new THREE.ShapeGeometry(shape);
    const p=frontGeometry.attributes.position,uv=frontGeometry.attributes.uv;
    for(let i=0;i<p.count;i++) uv.setXY(i,p.getX(i)/s.L+.5,p.getY(i)/s.H+.5);
  }else{
    geometry=new THREE.BoxGeometry(s.L,s.H,s.T);
    frontGeometry=new THREE.PlaneGeometry(s.L,s.H);
  }
  s.mesh=new THREE.Mesh(geometry,matOf(s).clone());
  const face=new THREE.Mesh(frontGeometry,new THREE.MeshBasicMaterial({map:photoFor(s),toneMapped:false}));
  face.position.z=s.T/2+.0015;face.userData.idx=stones.indexOf(s);s.mesh.add(face);
  s.mesh.userData.idx=stones.indexOf(s);stoneGroup.add(s.mesh);placeMesh(s);
}
''' +src[end:]
src=src.replace("    ctx.fillRect(X, Y, Wd, Hd);\n    ctx.strokeStyle", "    ctx.fillRect(X, Y, Wd, Hd);\n    const photo=photoTextures[s.id]?.image;\n    if(view!=='plan' && photo?.complete) ctx.drawImage(photo,X,Y,Wd,Hd);\n    ctx.strokeStyle")
src=src.replace("ctx.fillStyle = i === sel ? '#4a3a14' : '#1c2025';","ctx.fillStyle = '#ffffff'; ctx.shadowColor='#000'; ctx.shadowBlur=3*dp;")
src=src.replace("ctx.fillText(no, X + Wd/2, Y + Hd/2 + 4*dp);","ctx.fillText(no, X + Wd/2, Y + Hd/2 + 4*dp);\n    ctx.shadowBlur=0;")
src=src.replace("  if(op === 'export'){","  if(op === 'applySystem'){ void applyToSystem(); }\n  else if(op === 'loadSystem'){ void loadFromSystem(); }\n  else if(op === 'export'){")
src=src.replace("  else if(op === 'export'){", "  else if(op === 'export'){\n    commitEditor();")
# Keep numeric editing responsive even before blur (and serialize the editor on apply).
begin=src.index('/* ---------- 编辑条 ---------- */'); end=src.index('/* ---------- 顶部按钮 ---------- */',begin)
edit=src[begin:end]
edit=edit.replace("  $('#' + id).addEventListener('change', e => {", "  const updateValue = e => {")
edit=edit.replace("    if(isNaN(v)) return;", "    if(!Number.isFinite(v) || (['L','H','T'].includes(k)&&v<=0)) return;")
edit=edit.replace("  });\n});", "  };\n  $('#' + id).addEventListener('input',updateValue);\n  $('#' + id).addEventListener('change',updateValue);\n});")
src=src[:begin]+edit+src[end:]
src=src.replace("  stones.forEach(s => { s.gltfObj = null; buildMesh(s); });","  stones.forEach(s => { s.gltfObj = null; buildMesh(s); });")
src=src.replace("toast(restored ? '已恢复上次进度'", "if(!restored) void loadFromSystem(true);\ntoast(restored ? '已恢复上次进度'")
for dest in [TOOL,ROOT / 'tools/viewers/placement/xcl-placement.html']:
    dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(src,encoding='utf-8')
# Save only the application script for linting without the bundled libraries/data.
app=src[src.index('const WALL = '):src.rindex('</script>')]
(OUT/'placement-tool-script.js').write_text(app,encoding='utf-8')
print(json.dumps({'tool':str(TOOL),'stones':len(layout),'embedded_textures':len(images),'bytes':len(src.encode('utf-8'))},ensure_ascii=False))
