// @ts-nocheck
/* =====================================================================
   武氏祠三维场景构建 —— 自旧版单文件HTML整段迁移(three r147)
   依据《嘉祥武氏墓群石刻保护性设施修缮及扩建工程设计方案》(2019.07)
   与《嘉祥武氏墓群石刻院落环境整治方案》(2023.04) CAD图纸重建。
   本文件为纯场景几何/材质定义, 不含交互与渲染器; 交互见 interactions.ts
===================================================================== */
import * as THREE from 'three-inventory';

export interface SiteHandles {
  ROOFS: THREE.Object3D[];
  /** 墙体(砖墙/毛石围墙/白灰内墙/下碱/压顶)与门窗构件, 供"墙体透明"查看模式切换材质 */
  WALLS: THREE.Mesh[];
  OPENINGS: THREE.Mesh[];
  sun: THREE.DirectionalLight;
  refreshStoneTextures(): void;
}

export function buildSite(scene: THREE.Scene, stoneTextures: Record<string, THREE.Texture> = {}): SiteHandles {

/* 同一来源导出到 HTML / Blender 时保持纹理、绿化完全一致。 */
let seed = 20260905;
function random(){
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
scene.fog = new THREE.Fog(new THREE.Color(0xc8d4d5).convertSRGBToLinear(), 300, 680);
scene.userData.reference = '2019/2023 CAD + 01-原始资料/现场参考照片; 现状单层展厅';

/* 渐变天空穹(不受雾影响) */
(function(){
  const geo = new THREE.SphereGeometry(760, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      cTop: {value: new THREE.Color(0x6f91ad).convertSRGBToLinear()},
      cMid: {value: new THREE.Color(0xc8d4d5).convertSRGBToLinear()},
      cBot: {value: new THREE.Color(0xd2cbbb).convertSRGBToLinear()},
      sunDir: {value: new THREE.Vector3(-42,90,100).normalize()},
      sunHaze: {value: new THREE.Color(0xe7ceab).convertSRGBToLinear()}
    },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: 'varying vec3 vP; uniform vec3 cTop; uniform vec3 cMid; uniform vec3 cBot;\n' +
      'uniform vec3 sunDir; uniform vec3 sunHaze;\n' +
      'void main(){ vec3 direction=normalize(vP); float h=direction.y;\n' +
      '  vec3 c=h>0.0 ? mix(cMid,cTop,pow(h,0.48)) : mix(cMid,cBot,clamp(-h*3.0,0.0,1.0));\n' +
      '  float haze=pow(max(dot(direction,sunDir),0.0),7.0)*0.17;\n' +
      '  c=mix(c,sunHaze,haze);\n' +
      '  gl_FragColor=vec4(c,1.0);\n' +
      '  #include <encodings_fragment>\n' +
      '}'
  });
  mat.toneMapped = false;
  const sky = new THREE.Mesh(geo, mat); sky.name = 'sky'; scene.add(sky);
})();

/* 午后侧向日光塑造瓦垄与柱廊；天空/地面只补足阴影，保留明暗层次。 */
const hemisphere = new THREE.HemisphereLight(
  new THREE.Color(0xb7d2e4).convertSRGBToLinear(),
  new THREE.Color(0x817e65).convertSRGBToLinear(), 0.42);
hemisphere.name = 'sky_hemisphere'; scene.add(hemisphere);
const sun = new THREE.DirectionalLight(new THREE.Color(0xffe7c5).convertSRGBToLinear(), 2.6);
sun.name = 'sun';
sun.position.set(-42, 90, 100);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera;
sc.left=-108; sc.right=108; sc.top=108; sc.bottom=-108; sc.near=1; sc.far=290;
sun.shadow.bias = -0.00010;
sun.shadow.normalBias = 0.018;
sun.shadow.radius = 2.0;
scene.add(sun);
const fill = new THREE.DirectionalLight(new THREE.Color(0xb9cfe1).convertSRGBToLinear(), 0.12);
fill.name = 'sky_fill'; fill.position.set(70, 55, 35); scene.add(fill);
scene.add(new THREE.AmbientLight(0xffffff, 0.02));

/* ---------- 坐标系: 总平面(1:500)PDF点 -> 米, x向东 z向南 ---------- */
const S = 0.17639, CX = 687, CY = 314;
function w2(px, py){ return [(px-CX)*S, (py-CY)*S]; }

/* 建筑群主轴(大门->前展厅->后展厅, 朝东南45°)局部坐标系 */
const G = w2(423.1, 124.6);
const AG = new THREE.Group();
AG.name = 'wushici_courtyard';
AG.position.set(G[0], 0, G[1]);
AG.rotation.y = -Math.PI/4;
scene.add(AG);

/* 屋顶构件集合(用于隐藏屋顶) */
const ROOFS = [];
function asRoof(o){ ROOFS.push(o); return o; }

/* ---------- 程序化纹理 ---------- */
function canvasTex(px, drawFn){
  const c = document.createElement('canvas'); c.width = c.height = px;
  drawFn(c.getContext('2d'), px);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.encoding = THREE.sRGBEncoding;
  t.anisotropy = 8;
  return t;
}
/* 灰度颗粒(白底暗噪, 供与材质color相乘): lo~hi 为亮度范围0-255 */
function grainDraw(ctx, px, lo, hi, blotch){
  const img = ctx.createImageData(px, px), d = img.data;
  for(let i = 0; i < px*px; i++){
    const v = lo + random()*(hi-lo);
    d[i*4] = d[i*4+1] = d[i*4+2] = v; d[i*4+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  /* 低频斑块 */
  for(let i = 0; i < (blotch||0); i++){
    const r = px*(0.04 + random()*0.10);
    const g = ctx.createRadialGradient(0,0,0, 0,0,r);
    const dark = random() < 0.5;
    g.addColorStop(0, dark ? 'rgba(30,30,30,0.10)' : 'rgba(255,255,255,0.10)');
    g.addColorStop(1, 'rgba(128,128,128,0)');
    ctx.save(); ctx.translate(random()*px, random()*px);
    ctx.fillStyle = g; ctx.fillRect(-r,-r,r*2,r*2); ctx.restore();
  }
}
const TEX = {};
/* 通用细颗粒(石材/木材/墙面共用, 乘以各自颜色) */
TEX.grain = canvasTex(256, (c,p)=> grainDraw(c,p, 228, 255, 10));
/* 低饱和草地，保留细颗粒与轻微枯绿差异，1个纹理周期=14米。 */
TEX.grass = canvasTex(512, (ctx,px)=>{
  const img = ctx.createImageData(px,px), d = img.data;
  for(let i = 0; i < px*px; i++){
    const t = random(), s = random();
    d[i*4]   = 91 + t*11 + s*4;
    d[i*4+1] = 105 + t*13;
    d[i*4+2] = 77 + t*10;
    d[i*4+3] = 255;
  }
  ctx.putImageData(img,0,0);
  for(let i = 0; i < 24; i++){
    const r = px*(0.12 + random()*0.20);
    const g = ctx.createRadialGradient(0,0,0, 0,0,r);
    const warm = random() < 0.35;
    g.addColorStop(0, warm ? 'rgba(130,128,80,0.035)' : 'rgba(42,70,36,0.045)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save(); ctx.translate(random()*px, random()*px);
    ctx.fillStyle = g; ctx.fillRect(-r,-r,r*2,r*2); ctx.restore();
  }
});
/* 方砖铺装: 0.5m砖格带缝(灰度乘色), 纹理周期=2米(4x4砖) */
TEX.pave = canvasTex(512, (ctx,px)=>{
  grainDraw(ctx, px, 225, 250, 8);
  const n = 4, w = px/n;
  ctx.strokeStyle = 'rgba(70,64,54,0.28)'; ctx.lineWidth = 2;
  for(let i = 0; i <= n; i++){
    ctx.beginPath(); ctx.moveTo(i*w+0.5, 0); ctx.lineTo(i*w+0.5, px); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i*w+0.5); ctx.lineTo(px, i*w+0.5); ctx.stroke();
  }
  /* 每砖亮度差 */
  for(let i = 0; i < n; i++) for(let j = 0; j < n; j++){
    const v = (random()*2-1)*0.035;
    ctx.fillStyle = v > 0 ? 'rgba(255,255,255,'+v+')' : 'rgba(20,20,20,'+(-v)+')';
    ctx.fillRect(i*w+2, j*w+2, w-4, w-4);
  }
});
/* 青砖甬路: 错缝顺铺(彩色贴图, 材质色置白), 周期=1米(4列x8行, 砖约250x125含缝)
   青砖呈均匀青灰色(黏土闷窑还原烧制, WW/T 0049标准色) */
TEX.qing = canvasTex(512, (ctx,px)=>{
  ctx.fillStyle = '#767b75'; ctx.fillRect(0,0,px,px);   /* 风化灰缝，避免远景重复黑格 */
  const rows = 8, cols = 4, bh = px/rows, bw = px/cols;
  for(let r = 0; r < rows; r++){
    const off = (r%2)*bw/2;
    for(let k = -1; k <= cols; k++){
      const x = k*bw + off;
      const t = random()*2 - 1;               /* 逐砖青灰色差 */
      const g = 139 + t*6.5, w = random()*4;
      ctx.fillStyle = 'rgb(' + Math.round(g+3+w) + ',' + Math.round(g+3) + ',' + Math.round(g-3+w*0.6) + ')';
      ctx.fillRect(x+2, r*bh+2, bw-4, bh-4);
    }
  }
  const img = ctx.getImageData(0,0,px,px), d = img.data;
  for(let i = 0; i < px*px; i++){
    const v = (random()-0.5)*12;
    d[i*4] += v; d[i*4+1] += v; d[i*4+2] += v;
  }
  ctx.putImageData(img,0,0);
});
/* 灰砖墙: 顺砖错缝(灰度乘色), 纹理周期=1.2米宽x0.96米高 */
TEX.brickWall = canvasTex(512, (ctx,px)=>{
  grainDraw(ctx, px, 228, 252, 6);
  const rows = 16, bh = px/rows, bw = px/4;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for(let r = 0; r < rows; r++){
    ctx.fillRect(0, r*bh, px, 2);
    const off = (r%2) * bw/2;
    for(let cx = -1; cx < 5; cx++){
      ctx.fillRect(((cx*bw+off)%px+px)%px, r*bh, 2, bh);
    }
  }
  for(let r = 0; r < rows; r++) for(let cx = 0; cx < 4; cx++){
    const v = (random()*2-1)*0.06;
    ctx.fillStyle = v > 0 ? 'rgba(255,255,255,'+v+')' : 'rgba(0,0,0,'+(-v)+')';
    const off = (r%2)*bw/2;
    ctx.fillRect(cx*bw+off+2, r*bh+3, bw-4, bh-4);
  }
});
/* 毛石/蘑菇石墙: 乱石块(灰度乘色), 周期=1.5米 */
TEX.rubbleWall = canvasTex(512, (ctx,px)=>{
  grainDraw(ctx, px, 215, 245, 8);
  ctx.strokeStyle = 'rgba(40,38,34,0.6)'; ctx.lineWidth = 4; ctx.lineJoin = 'round';
  const n = 6, cw = px/n;
  for(let i = 0; i < n; i++) for(let j = 0; j < n; j++){
    const cxp = i*cw + cw/2 + (random()-0.5)*cw*0.5;
    const cyp = j*cw + cw/2 + (random()-0.5)*cw*0.5;
    const r = cw*(0.38 + random()*0.18), k = 5 + (random()*3|0);
    ctx.beginPath();
    for(let a = 0; a < k; a++){
      const th = a/k*Math.PI*2 + random()*0.5;
      const rr = r*(0.75 + random()*0.3);
      const X = cxp + Math.cos(th)*rr, Y = cyp + Math.sin(th)*rr;
      a ? ctx.lineTo(X,Y) : ctx.moveTo(X,Y);
    }
    ctx.closePath(); ctx.stroke();
    const v = (random()*2-1)*0.08;
    ctx.fillStyle = v > 0 ? 'rgba(255,255,255,'+v+')' : 'rgba(0,0,0,'+(-v)+')';
    ctx.fill();
  }
});
/* 瓦垄: 竖条纹(u向周期, 灰度乘色), 周期=1米(约3.5垄) */
function tileDraw(ctx, px){
  ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0,0,px,px);
  const n = 4, w = px/n;
  for(let i = 0; i < n; i++){
    const x0 = i*w;
    const g = ctx.createLinearGradient(x0, 0, x0+w, 0);
    g.addColorStop(0.00, '#c7c7c7');
    g.addColorStop(0.18, '#e9e9e9');
    g.addColorStop(0.42, '#f6f6f6');
    g.addColorStop(0.66, '#e9e9e9');
    g.addColorStop(1.00, '#c7c7c7');
    ctx.fillStyle = g; ctx.fillRect(x0, 0, w, px);
  }
  /* 横向板瓦叠压细线 */
  ctx.fillStyle = 'rgba(60,60,60,0.13)';
  for(let y = 0; y < px; y += px/6) ctx.fillRect(0, y, px, 2);
  const img = ctx.getImageData(0,0,px,px), d = img.data;
  for(let i = 0; i < px*px; i++){
    const v = (random()-0.5)*14;
    d[i*4] += v; d[i*4+1] += v; d[i*4+2] += v;
  }
  ctx.putImageData(img,0,0);
}
TEX.tileU = canvasTex(256, tileDraw);
TEX.tileV = canvasTex(256, (ctx,px)=>{
  ctx.save(); ctx.translate(px/2,px/2); ctx.rotate(Math.PI/2); ctx.translate(-px/2,-px/2);
  tileDraw(ctx, px); ctx.restore();
});

/* ---------- 材质 ---------- */
function lam(c, ds){
  const col = new THREE.Color(c).convertSRGBToLinear();
  return new THREE.MeshStandardMaterial({color:col, roughness:0.88, metalness:0,
    side:ds ? THREE.DoubleSide : THREE.FrontSide});
}
const M = {
  lawn:      lam(0x6e9a49),
  earth:     lam(0xc5c2b6),
  brickPave: lam(0xb0a48d),
  stonePave: lam(0xb0a48d),
  plaza:     lam(0xb0a48d),
  apron:     lam(0xafa896),
  plinth:    lam(0xa9a294),
  brick:     lam(0xa1a39d),   // 现状灰砖/仿砖缝粉刷墙，保持细砖比例
  brickDark: lam(0x83857f),
  rubble:    lam(0xaaa696),
  wallCap:   lam(0x6b7076),
  tile:      lam(0x67706c, 1), // 日晒风化青灰筒瓦
  tileDark:  lam(0x4d5552),
  stoneWall: lam(0x616467),   // 后展厅深灰蘑菇石墙
  colRed:    lam(0x80352b),   // 实景暗朱红漆檐柱/额枋
  stoneCol:  lam(0xa8a294),
  woodRed:   lam(0x7c4032),
  wood:      lam(0x8a6b4a),
  lattice:   lam(0x5a3c2a),
  latticeDk: lam(0x2f2318),
  door:      lam(0x4a2f22),
  stone:     lam(0xa39e90),
  baseStone: lam(0xa89f8e),   // 毛石下碱
  winRed:    lam(0x8e241c),   // 红漆窗框/窗棂
  winDk:     lam(0x2e2723),
  doorRed:   lam(0x7e1c15),   // 红漆板门
  queDk:     lam(0x55564f),   // 阙身青黑石
  queTan:    lam(0xb2a284),   // 阙楼部风化石
  stoneW:    lam(0xb5b0a3),   // 石狮/石碑浅灰石
  railWood:  lam(0x9a5b28),   // 木栏杆
  slabDk:    lam(0x969890),   // 汉画像石(统一青灰, 与环境区分)
  hpsStone:  lam(0x969890),   // 汉画像石(统一青灰, 同slabDk)
  floorSlab: lam(0xc6c3b8),   // 室内方砖
  screenDk:  lam(0x2a2d30),
  bookPg:    lam(0xd8d5ca),
  wallWhite: lam(0xdfdcd1),   // 石灰抹面避免不真实的纯白高反射
  caseBase:  lam(0x564c42)
};
M.glass = new THREE.MeshPhysicalMaterial({color:new THREE.Color(0xcad6d5).convertSRGBToLinear(),
  transparent:true, opacity:0.055, depthWrite:false, roughness:0.09, metalness:0,
  clearcoat:1, clearcoatRoughness:0.08, side:THREE.DoubleSide});
M.winGlass = new THREE.MeshPhysicalMaterial({color: new THREE.Color(0x819694).convertSRGBToLinear(),
  transparent:true, opacity:0.28, depthWrite:false, roughness:0.18, metalness:0,
  clearcoat:0.8, side:THREE.DoubleSide});

/* ---------- 挂载程序纹理 ---------- */
TEX.grass.repeat.set(1/14, 1/14);        /* 大尺度低反差草地，远景不出现规则斑点 */
M.lawn.map = TEX.grass; M.lawn.color.set(0xffffff);
TEX.soil = canvasTex(256, (c,p)=>{ grainDraw(c, p, 245, 253, 0); });
TEX.soil.repeat.set(1/14, 1/14);
M.earth.map = TEX.soil;
TEX.pave.repeat.set(1/2, 1/2);           /* 铺装uv=米, 0.5m方砖 */
M.stonePave.map = TEX.pave;
/* 甬路/广场: 青砖错缝铺(彩色贴图, 色置白由贴图定色) */
[M.brickPave, M.plaza].forEach(m=>{ m.map = TEX.qing; m.color.set(0xffffff); });
TEX.brickWall.repeat.set(1/1.6, 1/1.28); /* 墙uv=米(metricUV处理) */
M.brick.map = TEX.brickWall;
TEX.rubbleWall.repeat.set(1/1.6, 1/1.6);
M.rubble.map = TEX.rubbleWall;
TEX.mushWall = canvasTex(512, (c,p)=>{ grainDraw(c, p, 215, 245, 8);
  /* 蘑菇石: 规整错缝块石 */
  const rows = 6, bh = p/rows, bw = p/3;
  c.strokeStyle = 'rgba(20,20,22,0.65)'; c.lineWidth = 5;
  for(let r = 0; r < rows; r++){
    c.beginPath(); c.moveTo(0, r*bh+0.5); c.lineTo(p, r*bh+0.5); c.stroke();
    const off = (r%2)*bw/2;
    for(let k = -1; k < 4; k++){
      const x = ((k*bw+off)%p+p)%p;
      c.beginPath(); c.moveTo(x, r*bh); c.lineTo(x, (r+1)*bh); c.stroke();
    }
  }
  for(let r = 0; r < rows; r++) for(let k = 0; k < 3; k++){
    const v = (random()*2-1)*0.09;
    c.fillStyle = v > 0 ? 'rgba(255,255,255,'+v+')' : 'rgba(0,0,0,'+(-v)+')';
    const off = (r%2)*bw/2;
    c.fillRect(k*bw+off+4, r*bh+4, bw-8, bh-8);
  }
});
TEX.mushWall.repeat.set(1/1.5, 1/1.5);
M.stoneWall.map = TEX.mushWall;
/* 细颗粒: 石材/台明/木作 通用 */
[M.plinth, M.apron, M.stone, M.stoneW, M.baseStone, M.queDk, M.queTan,
 M.hpsStone, M.floorSlab, M.wallCap, M.brickDark, M.wallWhite,
 M.wood, M.railWood, M.slabDk].forEach(m=>{ m.map = TEX.grain; });
/* 瓦垄材质(庑殿顶u向 / 硬山挤出v向) */
M.tileHip = new THREE.MeshStandardMaterial({color:new THREE.Color(0x606b67).convertSRGBToLinear(), map:TEX.tileU, roughness:0.84, side:THREE.DoubleSide});
M.tileG   = new THREE.MeshStandardMaterial({color:new THREE.Color(0x606b67).convertSRGBToLinear(), map:TEX.tileV, roughness:0.84, side:THREE.DoubleSide});

/* 凹凸使用线性色彩空间，避免把灰砖接缝误作颜色；没有外链素材依赖。 */
function relief(mat, texture, scale){
  const bump = texture.clone(); bump.encoding = THREE.LinearEncoding; bump.needsUpdate = true;
  mat.bumpMap = bump; mat.bumpScale = scale;
}
relief(M.brick, TEX.brickWall, -0.018); // 白灰勾缝凹入砖面
relief(M.rubble, TEX.rubbleWall, 0.033);
relief(M.stoneWall, TEX.mushWall, 0.026);
[M.plaza,M.brickPave].forEach(m=>relief(m,TEX.qing,0.008));
relief(M.stonePave,TEX.pave,0.010);
[M.tileG,M.tileHip].forEach((m,i)=>relief(m,i?TEX.tileU:TEX.tileV,0.013));
[M.plinth,M.stone,M.stoneW,M.baseStone,M.queDk,M.queTan,M.hpsStone,M.slabDk].forEach(m=>relief(m,TEX.grain,0.007));
TEX.wood = canvasTex(256,(ctx,px)=>{
  grainDraw(ctx,px,232,255,6);
  for(let i=0;i<65;i++){
    const x=random()*px;
    ctx.strokeStyle='rgba(60,42,28,'+(0.025+random()*0.065)+')'; ctx.lineWidth=0.5+random()*1.1;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.bezierCurveTo(x+6,px/3,x-4,px*0.7,x+2,px); ctx.stroke();
  }
});
[M.wood,M.woodRed,M.colRed,M.winRed,M.doorRed,M.railWood,M.door,M.lattice].forEach(m=>{
  m.map=TEX.wood; m.roughness=0.58; relief(m,TEX.wood,0.004);
});
M.baseStone.map=TEX.mushWall; relief(M.baseStone,TEX.mushWall,0.032);
/* PMREM环境反射按真实材质分配，避免天空把粗糙砖石与草地整体照白。 */
Object.values(M).forEach(m=>{m.envMapIntensity=0.38;});
[M.lawn,M.earth].forEach(m=>{m.roughness=1;m.envMapIntensity=0.22;});
[M.brickPave,M.stonePave,M.plaza,M.apron,M.brick,M.rubble,M.wallWhite].forEach(m=>{
  m.roughness=0.96;m.envMapIntensity=0.30;
});
[M.plinth,M.stoneCol,M.stone,M.stoneW,M.baseStone,M.queDk,M.queTan,M.hpsStone,M.slabDk].forEach(m=>{
  m.roughness=0.91;m.envMapIntensity=0.42;
});
[M.tile,M.tileDark,M.tileHip,M.tileG,M.wallCap].forEach(m=>{
  m.roughness=0.84;m.envMapIntensity=0.50;
});
M.tile.map=TEX.grain;
[M.wood,M.railWood,M.lattice].forEach(m=>{m.roughness=0.72;});
[M.woodRed,M.colRed,M.winRed,M.doorRed,M.door].forEach(m=>{m.roughness=0.53;});
[M.glass,M.winGlass].forEach(m=>{m.envMapIntensity=0.90;});
M.glass.envMapIntensity=0.65; /* 陈列柜保留边缘反光，避免叠加玻璃面冲淡石刻。 */
Object.values(M).forEach(m=>{if(m.bumpMap)m.roughnessMap=m.bumpMap;});
Object.entries(M).forEach(([name,mat])=>{mat.name=name;});

/* 场景建成后调用: 将墙体box的uv缩放为米单位 */
function metricUV(){
  const set = new Set([M.brick, M.rubble, M.stoneWall, M.wallWhite, M.baseStone]);
  const flat = new Set([M.stonePave, M.brickPave, M.plaza]);   /* 水平铺面box: 顶面uv=宽x深 */
  scene.traverse(o=>{
    if(!o.isMesh) return;
    const p = o.geometry.parameters;
    if(!p || p.width === undefined || o.geometry.userData.metric) return;
    if(set.has(o.material)){
      o.geometry.userData.metric = true;
      const uv = o.geometry.attributes.uv;
      /* BoxGeometry 每四点一面：侧面按深×高、顶面宽×深、正面宽×高。 */
      for(let i = 0; i < uv.count; i++){
        const face=Math.floor(i/4);
        const u=face<2 ? p.depth : p.width;
        const v=face>=2 && face<4 ? p.depth : p.height;
        uv.setXY(i,uv.getX(i)*u,uv.getY(i)*v);
      }
      uv.needsUpdate = true;
    } else if(flat.has(o.material) && p.depth !== undefined){
      /* 仅处理box顶面; PlaneGeometry由pad()自带米制uv, 勿重复缩放 */
      o.geometry.userData.metric = true;
      const uv = o.geometry.attributes.uv;
      for(let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i)*p.width, uv.getY(i)*p.depth);
      uv.needsUpdate = true;
    }
  });
}

/* ---------- 通用构件 ---------- */
const boxGeometries = new Map();
function box(g, mat, w, h, d, x, y, z, ry){
  /* 米制UV按材质组分别缓存，避免墙纹理污染相同尺寸的其他构件。 */
  const key = [w,h,d,mat.name].join('/');
  if(!boxGeometries.has(key)) boxGeometries.set(key,new THREE.BoxGeometry(w,h,d));
  const m = new THREE.Mesh(boxGeometries.get(key), mat);
  m.position.set(x, y, z);
  if(ry) m.rotation.y = ry;
  m.castShadow = m.receiveShadow = true;
  g.add(m); return m;
}

/* 筒瓦逐垄有体积，全部拼成一个网格，避免每块瓦一个 draw call。 */
function tileRolls(g, paths, radius, material, name){
  const positions=[], uvs=[], indices=[], sides=6;
  for(const points of paths){
    if(points.length<2) continue;
    const base=positions.length/3;
    let distance=0;
    for(let j=0;j<points.length;j++){
      const p=new THREE.Vector3(...points[j]);
      const tangent=new THREE.Vector3(...points[Math.min(j+1,points.length-1)])
        .sub(new THREE.Vector3(...points[Math.max(0,j-1)])).normalize();
      const side=new THREE.Vector3(-tangent.z,0,tangent.x).normalize();
      const normal=side.clone().cross(tangent).normalize();
      if(j) distance+=p.distanceTo(new THREE.Vector3(...points[j-1]));
      for(let k=0;k<=sides;k++){
        const angle=k/sides*Math.PI;
        const v=p.clone().addScaledVector(side,Math.cos(angle)*radius)
          .addScaledVector(normal,Math.sin(angle)*radius+0.012);
        positions.push(v.x,v.y,v.z); uvs.push(k/sides,distance);
        if(j<points.length-1 && k<sides){
          const a=base+j*(sides+1)+k, b=a+sides+1;
          indices.push(a,b,b+1,a,b+1,a+1);
        }
      }
    }
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
  geo.setIndex(indices); geo.computeVertexNormals();
  const m=new THREE.Mesh(geo,material); m.name=name;
  m.castShadow=m.receiveShadow=true; g.add(m); return m;
}
function cyl(g, mat, r, h, x, y, z, seg){
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r*1.06, h, seg||14), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  g.add(m); return m;
}
function pad(g, mat, w, d, x, z, y){
  const geo = new THREE.PlaneGeometry(w, d);
  const uv = geo.attributes.uv;              /* uv换算为米, 使贴图密度均匀 */
  /* 青砖甬路横铺: 砖长边垂直于道路走向(长边), 长向路交换uv即转90° */
  const swap = (mat === M.brickPave || mat === M.plaza) && w > d;
  for(let i = 0; i < uv.count; i++){
    const U = uv.getX(i)*w, V = uv.getY(i)*d;
    swap ? uv.setXY(i, V, U) : uv.setXY(i, U, V);
  }
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI/2;
  m.position.set(x, y, z);
  m.receiveShadow = true;
  g.add(m); return m;
}

/* 双坡屋面(带举折), 脊沿本体z向；出挑量由各建筑调用决定。 */
function gableRoof(len, hs, eaveH, ridgeH, thick, ridgeOff){
  ridgeOff = ridgeOff || 0;
  const g = new THREE.Group();
  g.name = 'gable_roof';
  const rx = ridgeOff;
  const mL = (eaveH + ridgeH)/2 - (ridgeH-eaveH)*0.155;
  const shape = new THREE.Shape();
  const pts = [
    [-hs, eaveH], [(-hs+rx)/2, mL], [rx, ridgeH],
    [(hs+rx)/2, mL], [hs, eaveH],
    [hs, eaveH-thick], [(hs+rx)/2, mL-thick], [rx, ridgeH-thick],
    [(-hs+rx)/2, mL-thick], [-hs, eaveH-thick]
  ];
  shape.moveTo(pts[0][0], pts[0][1]);
  for(let i=1;i<pts.length;i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {depth: len, bevelEnabled:false});
  geo.translate(0, 0, -len/2);
  const mesh = new THREE.Mesh(geo, M.tileG);
  mesh.castShadow = mesh.receiveShadow = true;
  g.add(mesh);
  box(g, M.tileDark, 0.5, 0.42, len+0.15, rx, ridgeH+0.12, 0);
  box(g, M.tileDark, 0.62, 0.6, 0.5, rx, ridgeH+0.18, -len/2+0.12);
  box(g, M.tileDark, 0.62, 0.6, 0.5, rx, ridgeH+0.18,  len/2-0.12);
  const paths=[];
  const n=Math.max(3,Math.round(len/0.285));
  for(let i=0;i<=n;i++) for(const side of [-1,1]){
    const z=-len/2+i*len/n;
    paths.push([[side*hs,eaveH,z],[(side*hs+rx)/2,mL,z],[rx,ridgeH,z]]);
  }
  tileRolls(g,paths,0.079,M.tile,'gable_tile_rolls');
  /* 博风板沿山面坡折；檐下两道木带形成真实的厚度与阴影。 */
  const verge=[];
  for(const z of [-len/2,len/2]) for(const side of [-1,1]){
    verge.push([[side*hs,eaveH+0.10,z],[(side*hs+rx)/2,mL+0.10,z],[rx,ridgeH+0.10,z]]);
  }
  tileRolls(g,verge,0.115,M.tileDark,'gable_verge_caps');
  for(const side of [-1,1]){
    box(g,M.woodRed,0.11,0.12,len,side*(hs-0.12),eaveH-thick-0.06,0);
    box(g,M.tileDark,0.17,0.09,len+0.05,side*hs,eaveH-0.035,0);
  }
  box(g,M.tile,0.38,0.10,len+0.20,rx,ridgeH+0.37,0);
  return g;
}
/* 山尖封护(硬山端部, 剖面沿本体x向) */
function gableWall(hs, wallTop, ridgeH, thick, mat, ridgeOff){
  ridgeOff = ridgeOff||0;
  const s = new THREE.Shape();
  s.moveTo(-hs, wallTop-0.6);
  s.lineTo(-hs, wallTop);
  s.lineTo(ridgeOff, ridgeH-0.25);
  s.lineTo(hs, wallTop);
  s.lineTo(hs, wallTop-0.6);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, {depth: thick, bevelEnabled:false});
  geo.translate(0, 0, -thick/2);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}
/* 庑殿顶: 四坡 + 正脊(沿z向) */
function hipRoof(lenZ, spanX, ridgeLen, eaveH, ridgeH){
  const g = new THREE.Group();
  g.name = 'hip_roof';
  const hx=spanX/2, hz=lenZ/2, tx=0.08, tz=ridgeLen/2;
  const v = [
    [-hx,eaveH,-hz],[hx,eaveH,-hz],[hx,eaveH,hz],[-hx,eaveH,hz],
    [-tx,ridgeH,-tz],[tx,ridgeH,-tz],[tx,ridgeH,tz],[-tx,ridgeH,tz]
  ];
  const idx = [1,0,4, 1,4,5,  2,1,5, 2,5,6,  3,2,6, 3,6,7,  0,3,7, 0,7,4,  4,7,6, 4,6,5];
  const pos = [], uvs = [];
  const dh = ridgeH - eaveH;
  const sZ = Math.hypot(dh, hz - tz), sX = Math.hypot(dh, hx - tx);
  idx.forEach((vi, k)=>{
    const p = v[vi]; pos.push(p[0], p[1], p[2]);
    const fi = Math.floor(k/6);          /* 0:-z坡 1:+x坡 2:+z坡 3:-x坡 4:脊顶 */
    if(fi === 4){ uvs.push(p[2], p[0]); }
    else{
      const u = (fi === 1 || fi === 3) ? p[2] : p[0];
      const s = (fi === 0 || fi === 2) ? sZ : sX;
      uvs.push(u, (p[1]-eaveH)/dh * s);  /* v=沿坡面实际长度(米) */
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs,2));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, M.tileHip);
  mesh.castShadow = mesh.receiveShadow = true;
  g.add(mesh);
  box(g, M.tile, spanX, 0.32, lenZ, 0, eaveH-0.15, 0);                 // 檐口
  box(g, M.tileDark, 0.55, 0.45, ridgeLen+0.2, 0, ridgeH+0.14, 0);     // 正脊
  box(g, M.tileDark, 0.68, 0.66, 0.55, 0, ridgeH+0.2, -ridgeLen/2-0.05); // 吻兽
  box(g, M.tileDark, 0.68, 0.66, 0.55, 0, ridgeH+0.2,  ridgeLen/2+0.05);
  const paths=[], spacing=0.285;
  for(const side of [-1,1]){
    const nz=Math.round(lenZ/spacing);
    for(let i=1;i<nz;i++){
      const z=-hz+i*lenZ/nz;
      const t=Math.min(1,(hz-Math.abs(z))/(hz-tz));
      paths.push([[side*hx,eaveH,z],[side*(hx+(tx-hx)*t),eaveH+dh*t,z]]);
    }
    const nx=Math.round(spanX/spacing);
    for(let i=1;i<nx;i++){
      const x=-hx+i*spanX/nx;
      const t=Math.min(1,(hx-Math.abs(x))/(hx-tx));
      paths.push([[x,eaveH,side*hz],[x,eaveH+dh*t,side*(hz+(tz-hz)*t)]]);
    }
  }
  tileRolls(g,paths,0.079,M.tile,'hip_tile_rolls');
  const hips=[];
  for(const sx of [-1,1]) for(const sz of [-1,1]){
    hips.push([[sx*hx,eaveH+0.11,sz*hz],[sx*tx,ridgeH+0.11,sz*tz]]);
  }
  tileRolls(g,hips,0.14,M.tileDark,'hip_diagonal_ridges');
  box(g,M.tile,0.39,0.12,ridgeLen+0.25,0,ridgeH+0.40,0);
  for(const side of [-1,1]){
    box(g,M.woodRed,0.14,0.17,lenZ-0.12,side*(hx-0.10),eaveH-0.39,0);
    box(g,M.woodRed,spanX-0.12,0.17,0.14,0,eaveH-0.39,side*(hz-0.10));
  }
  return g;
}
/* 隔扇窗 */
function latticeWin(g, w, h, x, y, z, ry, mF, mI){
  const A = mF||M.lattice, B = mI||M.latticeDk;
  const win = new THREE.Group();
  box(win, A, w, h, 0.14, 0, 0, 0);
  box(win, B, w-0.16, h-0.16, 0.06, 0, 0, 0.045);
  const nV = Math.max(2, Math.round(w/0.55));
  for(let i=1;i<nV;i++)
    box(win, A, 0.05, h-0.2, 0.05, -w/2+i*w/nV, 0, 0.08);
  const nH = Math.max(2, Math.round(h/0.6));
  for(let i=1;i<nH;i++)
    box(win, A, w-0.2, 0.05, 0.05, 0, -h/2+i*h/nH, 0.08);
  win.position.set(x, y, z);
  if(ry) win.rotation.y = ry;
  g.add(win); return win;
}
/* 透光隔扇窗: 边框 + 半透明玻璃芯 + 棂条(无实心底板) */
function glassWin(g, w, h, x, y, z, ry, mF, mG){
  const A = mF || M.lattice;
  const win = new THREE.Group();
  box(win, A, w, 0.1, 0.14, 0, h/2-0.05, 0);
  box(win, A, w, 0.1, 0.14, 0, -h/2+0.05, 0);
  box(win, A, 0.1, h-0.2, 0.14, -w/2+0.05, 0, 0);
  box(win, A, 0.1, h-0.2, 0.14, w/2-0.05, 0, 0);
  const gl = new THREE.Mesh(new THREE.BoxGeometry(w-0.12, h-0.12, 0.03), mG || M.winGlass);
  win.add(gl);
  const nV = Math.max(2, Math.round(w/0.55));
  for(let i=1;i<nV;i++)
    box(win, A, 0.05, h-0.2, 0.05, -w/2+i*w/nV, 0, 0.06);
  const nH = Math.max(2, Math.round(h/0.6));
  for(let i=1;i<nH;i++)
    box(win, A, w-0.2, 0.05, 0.05, 0, -h/2+i*h/nH, 0.06);
  win.position.set(x, y, z);
  if(ry) win.rotation.y = ry;
  g.add(win); return win;
}
/* 板门(双扇), 默认面向+z */
function doubleDoor(g, w, h, x, y, z, ry, mF, mD){
  const A = mF||M.lattice, B = mD||M.door;
  const d = new THREE.Group();
  box(d, A, w+0.35, h+0.25, 0.16, 0, 0.06, 0);
  box(d, B, w/2-0.06, h-0.1, 0.1, -w/4, 0, 0.06);
  box(d, B, w/2-0.06, h-0.1, 0.1,  w/4, 0, 0.06);
  box(d, A, 0.06, h-0.1, 0.12, 0, 0, 0.08);
  d.position.set(x, y, z);
  if(ry) d.rotation.y = ry;
  g.add(d); return d;
}
/* 玻璃展柜: 深色柜座 + 玻璃罩 + 顶框, h为总高
   全部构件标记showcase: 陈列设施不遮挡石刻拾取(俯视/斜视可穿透点选柜内石头) */
function showcase(g, w, d, x, z, y0, h){
  h = h || 1.56;
  const gh = h - 0.56;
  const p1 = box(g, M.caseBase, w, 0.5, d, x, y0+0.25, z);
  const gl = new THREE.Mesh(new THREE.BoxGeometry(w-0.08, gh, d-0.08), M.glass);
  gl.position.set(x, y0+0.5+gh/2, z);
  g.add(gl);
  const p2 = box(g, M.caseBase, w, 0.06, d, x, y0+h-0.03, z);
  [p1, gl, p2].forEach(p => { p.userData.showcase = true; });
}
/* 台阶(向+z伸出) */
function steps(g, w, n, rise, tread, x, y, z, ry){
  const st = new THREE.Group();
  for(let i=0;i<n;i++)
    box(st, M.plinth, w, rise, tread*(n-i), 0, rise/2+i*rise, tread*(n-i)/2);
  st.position.set(x, y, z);
  if(ry) st.rotation.y = ry;
  g.add(st); return st;
}

/* =====================================================================
   1. 地面与围墙 (codex位置精确版: 方案图P75矢量边界, 23顶点)
===================================================================== */
/* local系(主轴x, 前展厅中心=(39.34,0)) -> 世界 */
function L2W(lx, lz){ return [G[0]+0.70711*(lx-lz), G[1]+0.70711*(lx+lz)]; }

/* codex outer_boundary(model X,Z) 转 local(X+39.34, Z) */
const BLOC = [
  [103.60,-4.73],[78.12,24.06],[71.97,29.89],[37.93,29.83],[34.10,29.98],
  [12.78,29.78],[10.75,29.80],[1.21,19.46],[1.08,3.83],
  [1.56,-4.19],[1.55,-9.43],[1.42,-10.09],[1.42,-13.65],
  [1.42,-18.53],[1.49,-20.54],[77.78,-79.63],[82.69,-79.85],[86.01,-79.43],
  [90.50,-75.72],[94.30,-71.98],[111.59,-55.02],[114.64,-52.08],[123.25,-26.61]
];
const BW = BLOC.map(p=>L2W(p[0],p[1]));

/* 背景地坪延伸至雾区，远景中不出现矩形地板的硬边。 */
pad(scene, M.earth, 1600, 1600, 0, 0, -0.06).name = 'courtyard_backdrop';

/* 院内草地；中轴照片可确认的柏树另行在甬路两侧表达。 */
(function(){
  const sh = new THREE.Shape();
  sh.moveTo(BW[0][0], -BW[0][1]);
  for(let i=1;i<BW.length;i++) sh.lineTo(BW[i][0], -BW[i][1]);
  sh.closePath();
  const geo = new THREE.ShapeGeometry(sh);
  const m = new THREE.Mesh(geo, M.lawn);
  m.rotation.x = -Math.PI/2;
  m.position.y = 0.01;
  m.receiveShadow = true;
  scene.add(m);
})();

/* 毛石围墙 h3.0 t0.5; 大门开口对齐主甬路(段8内z±2.6), 段9为售票房占位 */
(function(){
  function wallSeg(ax, az, bx, bz){
    const L = Math.hypot(bx-ax, bz-az);
    if(L<=0.1) return;
    const mx=(ax+bx)/2, mz=(az+bz)/2;
    const ang = Math.atan2(bz-az, bx-ax);
    box(scene, M.rubble, L, 3.0, 0.5, mx, 1.5, mz, -ang);
    box(scene, M.wallCap, L, 0.16, 0.72, mx, 3.08, mz, -ang);
  }
  for(let i=0;i<BW.length;i++){
    if(i===9) continue;                       /* 售票房贴墙段 */
    const a = BW[i], b = BW[(i+1)%BW.length];
    if(i===8){                                /* 大门开口(z±2.6) */
      const t1=0.153, t2=0.802;
      wallSeg(a[0], a[1], a[0]+(b[0]-a[0])*t1, a[1]+(b[1]-a[1])*t1);
      wallSeg(a[0]+(b[0]-a[0])*t2, a[1]+(b[1]-a[1])*t2, b[0], b[1]);
      continue;
    }
    wallSeg(a[0], a[1], b[0], b[1]);
  }
})();

/* 大门: 仿汉阙式(实景照片): 两侧子母阙柱+红漆板门, 正对主甬路(z=0) */
(function(){
  const G0 = new THREE.Group();
  G0.position.set(1.49, 0, 0);
  AG.add(G0);
  /* 两层瓦檐薄坡 */
  function queEave(g, w, d, y, cz){
    box(g, M.tileDark, w, 0.14, d, 0, y, cz);
    box(g, M.tile, w*0.72, 0.16, d*0.72, 0, y+0.14, cz);
    box(g, M.stone, w*0.5, 0.16, d*0.5, 0, y-0.14, cz);
  }
  [-1,1].forEach(s=>{
    const cz = s*2.3;
    box(G0, M.queDk, 1.35, 0.45, 1.35, 0, 0.225, cz);    // 基座
    box(G0, M.stone, 1.05, 4.1, 1.05, 0, 2.5, cz);       // 阙柱身
    queEave(G0, 2.0, 1.85, 3.0, cz);                     // 下层阙檐
    queEave(G0, 2.1, 1.95, 3.95, cz);                    // 上层阙檐
    box(G0, M.stone, 0.85, 0.75, 0.85, 0, 4.85, cz);     // 顶阙楼身
    queEave(G0, 2.2, 2.0, 5.45, cz);                     // 阙楼大檐
    box(G0, M.tileDark, 0.3, 0.2, 2.1, 0, 5.72, cz);     // 楼顶正脊
  });
  /* 红门框 + 上枋 + 匾 + 双扇板门 */
  box(G0, M.doorRed, 0.3, 3.7, 0.28, 0, 1.85,  1.64);
  box(G0, M.doorRed, 0.3, 3.7, 0.28, 0, 1.85, -1.64);
  box(G0, M.doorRed, 0.32, 0.4, 3.56, 0, 3.85, 0);
  box(G0, M.bookPg,  0.1, 0.55, 1.35, 0.14, 4.4, 0);
  box(G0, M.doorRed, 0.1, 3.35, 1.5, 0, 1.68,  0.77);
  box(G0, M.doorRed, 0.1, 3.35, 1.5, 0, 1.68, -0.77);
})();

/* 售票房(大门西南侧贴墙, 原CAD门房轮廓 3.0x5.24): 灰砖硬山瓦顶 */
(function(){
  const cx = 3.06, cz = -6.81;
  box(AG, M.plinth, 3.5, 0.25, 5.7, cx, 0.125, cz);
  box(AG, M.brick, 3.06, 3.1, 5.24, cx, 1.8, cz);
  box(AG, M.winDk, 0.1, 0.9, 1.2, cx-3.06/2-0.02, 1.75, cz, 0);   // 售票窗(朝院外)
  box(AG, M.door, 0.1, 2.0, 1.0, cx+3.06/2+0.02, 1.25, cz+1.6, 0); // 门(朝院内)
  const gr = gableRoof(5.94, 1.9, 3.15, 4.15, 0.2);
  gr.position.set(cx, 0, cz);
  AG.add(asRoof(gr));
})();

/* =====================================================================
   2. 甬路/铺装
===================================================================== */
function apad(mat, w, d, x, z, y){ return pad(AG, mat, w, d, x, z, y===undefined?0.03:y); }

/* ---- 以下均按p74矢量边线精确重绘(local坐标) ---- */
apad(M.brickPave, 32.7, 3.2, 17.95, 0);            // 主甬路: 西墙内(1.6)->前展厅台明(34.3)
apad(M.brickPave, 2.95, 12.03, 3.08, -3.42, 0.031);// 大门内侧集散场地(售票房前->甬路)
apad(M.brickPave, 26.7, 3.32, 57.7, 0, 0.028);     // 中轴甬路(前展厅->后展厅台明)
apad(M.brickPave, 3.5, 23.92, 58.65, 0.51, 0.03);  // 支路: 西廊北墙->东北纵条带南缘(贯穿甬路)
/* 展厅四周"田"字路网: 贴台明窄带+山墙条带+中轴+支路, 其余为草地岛(按CAD) */
apad(M.brickPave, 4.75, 3.32, 31.96, 0, 0.028);    // 中轴甬路(垂直路->前展厅台明)
apad(M.brickPave, 1.57, 22.9, 33.52, 0, 0.028);    // 前展厅西北台明窄带
apad(M.brickPave, 1.57, 22.9, 45.17, 0, 0.028);    // 前展厅东南台明窄带
apad(M.brickPave, 14.79, 1.34, 36.99, 10.78, 0.028);  // 西南山墙条带(垂直路->前展厅东南带)
apad(M.brickPave, 14.79, 1.34, 36.99, -10.78, 0.028); // 东北山墙条带(垂直路->前展厅东南带)
apad(M.brickPave, 10.95, 1.34, 51.43, 10.78, 0.028);  // 西南条带延伸(->支路)
apad(M.brickPave, 25.96, 1.34, 57.36, -10.78, 0.028); // 东北纵条带(前展厅台明带->广场西南角, 一体对齐)
apad(M.brickPave, 1.6, 22.48, 70.2, 0, 0.028);     // 后展厅西北台明窄带
apad(M.brickPave, 12.78, 0.48, 77.40, 11.0, 0.028);   // 后展厅西南山墙窄条
apad(M.brickPave, 12.83, 0.93, 77.42, -11.24, 0.028); // 后展厅东北山墙窄条
apad(M.brickPave, 1.45, 29.8, 28.83, 3.4, 0.032);  // 垂直连接路(x28.1-29.55): 东北庭院缘->卫生间小径
apad(M.brickPave, 12.05, 1.5, 23.52, 17.55, 0.032);// 卫生间小径(z16.8-18.3, 平行主轴)
apad(M.brickPave, 2.5, 19.75, 20.85, 11.54, 0.033);// 卫生间->主甬路 垂直路(x19.6-22.1)
apad(M.brickPave, 2.33, 40.85, 48.1, -31.88, 0.031); // 北廊东端->东北纵条带南缘 垂直路(x48轴, 穿毛石路)
apad(M.brickPave, 15.66, 1.95, 37.33, 12.42, 0.031);// 西廊西北角连接路(z11.45-13.4)
apad(M.brickPave, 0.5, 3.75, 38.35, 15.7, 0.031);  // 办公室(北)东角->连接路 窄径
apad(M.brickPave, 27.5, 12.45, 58.2, 23.52, 0.027);// 办公内院大铺装(x44.45-71.95, z17.3-29.75)
apad(M.brickPave, 6.86, 4.26, 41.73, 15.53, 0.027);// 办公室(北)东北侧铺装片

/* 实景中轴路有顺铺边砖与中线收边；与原铺地齐平，不缩窄通路。 */
for(const [start,end] of [[1.6,34.3],[45.95,71.05]]){
  for(const z of [-1.50,1.50]) apad(M.stonePave,end-start,0.14,(start+end)/2,z,0.038);
  apad(M.stonePave,end-start,0.12,(start+end)/2,0,0.038);
}

/* 两厅外景照片支持中轴两侧柏树。位置是景观示意，避开横向道路、石刻和墓葬区。 */
(function(){
  const trees=new THREE.Group(); trees.name='cypress_reference_landscape'; AG.add(trees);
  trees.userData.reference='前展厅/武氏墓群石刻阙室展厅外景.JPG；后展厅/博物馆陈列室展厅外景.JPG';
  trees.userData.accuracy='树位与高度依据照片表达氛围，非单木测绘';
  const positions=[],colors=[],uvs=[],normals=[];
  const crownGeo=new THREE.IcosahedronGeometry(1,1);
  const crown=crownGeo.index ? crownGeo.toNonIndexed() : crownGeo;
  const p=crown.attributes.position;
  const palette=[0x3b5040,0x495e47,0x5a6b50,0x40563f].map(c=>new THREE.Color(c).convertSRGBToLinear());
  const slots=[12.5,17,25.6,30.8,49.8,54.0,63.4,67.2];
  for(const x of slots) for(const side of [-1,1]){
    const z=side*(4.3+random()*0.45), h=4.4+random()*1.5;
    cyl(trees,M.wood,0.13,h*0.40,x,h*0.20,z,8);
    for(let j=0;j<7;j++){
      const t=j/6, radius=(0.73*(1-t)+0.16)*(0.92+random()*0.14);
      const level=h*(0.22+0.69*t), stretch=h*0.22*(1-0.32*t);
      const yaw=random()*Math.PI, cs=Math.cos(yaw), sn=Math.sin(yaw);
      const offset=(random()-0.5)*0.16;
      for(let k=0;k<p.count;k++){
        const px=p.getX(k),py=p.getY(k),pz=p.getZ(k);
        positions.push(x+offset+(px*cs-pz*sn)*radius,level+py*stretch,z+(px*sn+pz*cs)*radius);
        /* 保留冠层的连续法线，减少合并后每个三角形各自发亮的塑料碎面。 */
        const normal=new THREE.Vector3((px*cs-pz*sn)/radius,py/stretch,(px*sn+pz*cs)/radius).normalize();
        normals.push(normal.x,normal.y,normal.z);
        const color=palette[j%palette.length].clone().multiplyScalar(0.84+0.16*(py+1)/2);
        colors.push(color.r,color.g,color.b);
        uvs.push(px,pz);
      }
    }
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geo.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
  geo.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  const leaf=new THREE.MeshStandardMaterial({color:0xffffff,vertexColors:true,roughness:1,envMapIntensity:0.20}); leaf.name='cypress_foliage';
  const mesh=new THREE.Mesh(geo,leaf); mesh.name='cypress_crowns'; mesh.castShadow=mesh.receiveShadow=true; trees.add(mesh);
  crownGeo.dispose(); if(crown!==crownGeo) crown.dispose();
})();

/* =====================================================================
   2b. 院落道路系统 (按 院落环境CAD 方案-02设计平面图 p74 矢量提取)
   qP: 方案图PDF坐标 -> 世界坐标(codex精确标定: 原点=前展厅中心, 主轴45.45°)
===================================================================== */
function qP(px, py){
  const dx = px - 459.117, dy = py - 333.734;
  const X = (dx*0.7015239 + dy*0.7126459)*S;
  const Z = (-dx*0.7126459 + dy*0.7015239)*S;
  return L2W(X + 39.34, Z);
}
const q74w = qP, q74e = qP;

/* 世界系多边形铺装 */
function polyPad(mat, pts, y){
  const sh = new THREE.Shape();
  sh.moveTo(pts[0][0], -pts[0][1]);
  for(let i=1;i<pts.length;i++) sh.lineTo(pts[i][0], -pts[i][1]);
  sh.closePath();
  const m = new THREE.Mesh(new THREE.ShapeGeometry(sh), mat);
  m.rotation.x = -Math.PI/2;
  m.position.y = y;
  m.receiveShadow = true;
  scene.add(m);
  return m;
}
/* 世界系多边形棱柱(平台) */
function polyPrism(mat, pts, h, y0){
  const sh = new THREE.Shape();
  sh.moveTo(pts[0][0], -pts[0][1]);
  for(let i=1;i<pts.length;i++) sh.lineTo(pts[i][0], -pts[i][1]);
  sh.closePath();
  const geo = new THREE.ExtrudeGeometry(sh, {depth:h, bevelEnabled:false});
  geo.rotateX(-Math.PI/2);
  const m = new THREE.Mesh(geo, mat);
  m.position.y = y0||0;
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  return m;
}
/* 直路带: 中线a->b, 宽w */
function band(mat, a, b, w, y){
  const dx=b[0]-a[0], dz=b[1]-a[1], L=Math.hypot(dx,dz);
  const nx=-dz/L*w/2, nz=dx/L*w/2;
  return polyPad(mat, [
    [a[0]+nx, a[1]+nz],[b[0]+nx, b[1]+nz],
    [b[0]-nx, b[1]-nz],[a[0]-nx, a[1]-nz]], y);
}

/* (北院墙内侧毛石地坪带已按需求取消; 后展厅西北面为草地岛+台明窄带, 已在上方apad中绘制) */

/* --- 东区(墓葬保护展示区)道路 --- */
polyPad(M.plaza, [L2W(70.34,-11.65), q74e(731.2,312.7),
                  q74e(779.9,361.2), L2W(82.6,-11.65)], 0.036);    // 政德教育广场(西南边直抵后展厅台明)
band(M.brickPave, q74e(779.9,361.2), q74e(771.3,374.3), 2.8, 0.034); // 广场东角->祭坛环路入口(端点收进环路口)

/* 八号墓/七号墓 地下墓葬标识花田(方案: 种植金盏菊, 以低草台表示) */
box(AG, M.lawn, 5.2, 0.16, 5.2, 60.4, 0.08, -58.7);
box(AG, M.lawn, 7.0, 0.16, 3.0, 74.7, 0.08, -62.8);

/* --- 墓葬区环形甬路系统(祭坛/一二三号墓: 环形砖路围草地岛, 矢量原样) ---
   外边界为一条连续边界线, 5个内边界闭合环作为孔 */
(function(){
  const outer = [[762.1,379.0],[764.8,381.6],[754.7,393.4],[756.8,396.3],[745.6,409.9],
    [758.8,421.0],[757.1,423.1],[777.0,441.4],[779.2,439.0],[794.0,452.4],[800.0,444.7],
    [813.2,456.0],[783.5,487.7],[793.1,497.1],[788.3,502.6],[825.2,535.5],[830.0,530.2],
    [849.2,547.2],[855.0,540.5],[896.0,495.9],[884.0,484.3],[877.6,478.6],[882.4,473.3],
    [854.3,448.8],[875.9,423.4],[880.2,427.5],[881.9,426.0],[894.4,437.3],[916.0,412.3],
    [903.0,401.3],[904.4,399.6],[882.1,380.7],[879.7,384.0],[869.2,375.1],[859.6,385.2],
    [841.3,369.9],[883.6,317.1],[896.3,327.1],[901.1,321.1],[920.8,336.7],[950.0,300.0],
    [931.1,284.4],[935.6,278.7],[910.2,258.3],[871.1,306.5],[876.8,311.3],[816.1,386.4],
    [787.8,361.9],[773.4,377.8],[768.4,372.7]];
  const holes = [
    [[788.8,373.0],[776.5,386.2],[773.6,383.1],[765.5,392.2],[768.6,395.1],[756.6,409.5],
     [768.8,420.7],[766.9,422.9],[776.3,430.8],[778.4,428.4],[793.3,441.4],[825.7,404.4]],
    [[822.4,392.7],[835.6,376.3],[853.3,392.9],[850.2,396.5],[860.8,405.4],[858.8,408.5],
     [869.4,417.9],[847.1,441.9],[844.7,439.9],[839.9,445.5],[830.8,437.1],[819.7,449.1],
     [807.2,437.8],[835.8,403.9]],
    [[879.7,417.1],[881.2,415.7],[893.6,426.3],[905.2,413.1],[892.7,402.0],[894.1,400.3],
     [883.1,391.2],[880.4,394.1],[870.6,385.0],[861.2,395.5],[871.6,404.4],[868.7,407.3]],
    [[883.6,306.7],[895.1,316.3],[899.6,310.3],[919.6,325.9],[939.5,301.5],[920.3,285.6],
     [924.8,279.6],[913.1,270.0],[908.0,276.0],[906.4,274.6],[886.2,299.5],[888.4,301.2]],
    [[831.2,447.6],[794.3,487.9],[803.9,496.6],[798.8,502.1],[824.5,525.1],[829.6,519.6],
     [848.5,536.7],[885.0,496.3],[866.3,479.5],[871.1,473.5],[845.6,450.7],[840.6,456.3]]
  ];
  const sh = new THREE.Shape();
  const O = outer.map(p=>q74e(p[0],p[1]));
  sh.moveTo(O[0][0], -O[0][1]);
  for(let i=1;i<O.length;i++) sh.lineTo(O[i][0], -O[i][1]);
  sh.closePath();
  holes.forEach(H=>{
    const path = new THREE.Path();
    const P = H.map(p=>q74e(p[0],p[1]));
    path.moveTo(P[0][0], -P[0][1]);
    for(let i=1;i<P.length;i++) path.lineTo(P[i][0], -P[i][1]);
    path.closePath();
    sh.holes.push(path);
  });
  const m = new THREE.Mesh(new THREE.ShapeGeometry(sh), M.brickPave);
  m.rotation.x = -Math.PI/2;
  m.position.y = 0.045;
  m.receiveShadow = true;
  scene.add(m);
})();

/* =====================================================================
   3. 前展厅  22.2 x 11.22, 檐口4.92, 正脊9.05, 单檐悬山灰瓦
===================================================================== */
(function(){
  const g = new THREE.Group();
  g.position.set(39.34, 0, 0);
  g.name = 'front_que_hall';
  g.scale.setScalar(0.9047);   /* 等比缩至方案图轮廓 10.09x20.21 */
  AG.add(g);
  const D=11.22, W=22.2, wallH=4.92, ridge=9.05;
  box(g, M.plinth, D+1.0, 0.45, W+1.0, 0, 0.225, 0);
  const F = 0.45;
  /* 檐墙: 窗位(z=±4,±8)开洞 2.3x1.9, 窗台F+1.55 */
  [-1,1].forEach(s=>{
    const bx = s*(D/2-0.22), bh = wallH-1.3, by = F+1.3+bh/2;
    [[-W/2,-9.15],[-6.85,-5.15],[-2.85,2.85],[5.15,6.85],[9.15,W/2]].forEach(a=>{
      box(g, M.brick, 0.44, bh, a[1]-a[0], bx, by, (a[0]+a[1])/2);
    });
    [-8,-4,4,8].forEach(z=>{
      box(g, M.brick, 0.44, 0.25, 2.3, bx, F+1.3+0.125, z);
      box(g, M.brick, 0.44, wallH-3.45, 2.3, bx, F+3.45+(wallH-3.45)/2, z);
    });
    box(g, M.baseStone, 0.5, 1.3, W, bx, F+0.65, 0);
  });
  [-1,1].forEach(s=>{
    box(g, M.brick, D, wallH-1.3, 0.44, 0, F+1.3+(wallH-1.3)/2, s*(W/2-0.22));
    box(g, M.baseStone, D, 1.3, 0.5, 0, F+0.65, s*(W/2-0.22));
    const gw = gableWall(D/2+0.1, F+wallH, F+ridge-0.3, 0.44, M.brick);
    gw.position.set(0, 0, s*(W/2-0.22));
    g.add(asRoof(gw));
  });
  [-10,-6,-2,2,6,10].forEach(z=>{
    [-1,1].forEach(s=>{
      box(g, M.stoneCol, 0.6, wallH, 0.6, s*(D/2-0.3), F+wallH/2, z);
    });
  });
  [-1,1].forEach(s=> box(g, M.stoneCol, 0.7, 0.3, W+0.3, s*(D/2-0.25), F+wallH+0.15, 0));
  [-1,1].forEach(s=> box(g, M.woodRed, 0.5, 0.32, W+0.5, s*(D/2-0.1), F+wallH+0.45, 0));
  [-1,1].forEach(s=>{
    doubleDoor(g, 2.4, 3.1, s*(D/2+0.02), F+1.55, 0, s>0?Math.PI/2:-Math.PI/2, M.winRed, M.doorRed);
    [-8,-4,4,8].forEach(z=>{
      glassWin(g, 2.3, 1.9, s*(D/2+0.02), F+2.5, z, s>0?Math.PI/2:-Math.PI/2, M.winRed, M.winGlass);
    });
    steps(g, 3.4, 3, 0.15, 0.32, s*(D/2+0.5), 0, 0, s>0?Math.PI/2:-Math.PI/2);
  });

  /* ---- 阙室内部陈列(依据实景照片, 示意) ---- */
  (function(){
    const R = new THREE.Group();
    R.position.set(0, F, 0);
    R.rotation.y = Math.PI;   // 陈列正面朝向大门(入口)一侧
    g.add(R);
    /* 整组构件登记为可交互文物: 首件为主体, 其余部件以 hpsRef 别名指回 */
    function regGroup(grp, id){
      const parts = [];
      grp.traverse(o => { if(o.isMesh) parts.push(o); });
      const main = parts[0];
      main.name = 'HPS-' + id;
      main.userData.hps = { id: id, face: 'QS' };
      main.userData._parts = parts;
      for(let i = 1; i < parts.length; i++) parts[i].userData.hpsRef = main;
    }
    pad(R, M.floorSlab, D-0.9, W-0.9, 0, 0, 0.015);   // 室内方砖地面
    /* 白灰内墙面(门洞两侧分段) */
    [-1,1].forEach(s=>{
      const wx = s*(D/2-0.47), wh = wallH-0.25;
      [[1.45,2.85],[5.15,6.85],[9.15,W/2-0.47]].forEach(a=>{ [-1,1].forEach(t=>
        box(R, M.wallWhite, 0.06, wh, a[1]-a[0], wx, wh/2, t*(a[0]+a[1])/2)); });
      [-8,-4,4,8].forEach(z=>{
        box(R, M.wallWhite, 0.06, 1.1, 2.3, wx, 0.55, z);
        box(R, M.wallWhite, 0.06, wh-3.0, 2.3, wx, 3.0+(wh-3.0)/2, z);
      });
      box(R, M.wallWhite, 0.06, wh-3.4, 2.9, wx, 3.4+(wh-3.4)/2, 0);
      box(R, M.wallWhite, D-0.94, wh, 0.06, 0, wh/2, s*(W/2-0.47));
    });

    /* 两阙、两狮使用档案中相同的照片重建GLB。
       透明包围体只负责固定身份、坐标和定位；可见几何由photoModels加载。 */
    function photoAnchor(id,width,height,depth,x,z,rotation){
      const K=1/g.scale.x;
      const anchor=new THREE.Mesh(new THREE.BoxGeometry(width,height,depth),
        new THREE.MeshStandardMaterial({transparent:true,opacity:0,depthWrite:false}));
      anchor.name='HPS-'+id;
      anchor.position.set(x,height*K/2,z);anchor.rotation.y=rotation;anchor.scale.setScalar(K);
      anchor.userData.hps={id,face:'QS'};
      anchor.userData._parts=[];
      anchor.userData.photoModel={archiveId:id,height,status:'loading'};
      anchor.userData.stoneTextureNormal=id==='SHI-W'?[-1,0,.65]:id==='SHI-E'?[1,0,.65]:[0,0,1];
      R.add(anchor);
    }
    [-1,1].forEach(s=>{
      photoAnchor(s>0?'QUE-E':'QUE-W',2.60,s>0?4.28:4.30,1.50,-.9,s*(4.6+.355/g.scale.x),Math.PI/2);
    });

    /* 立狮及覆斗状基座，总长2.13米；沿用面向中央通道的方向。 */
    [-1,1].forEach(s=>{
      photoAnchor(s>0?'SHI-E':'SHI-W',.93,s>0?1.59:1.61,2.13,1.5,s*6.8,s>0?Math.PI:0);
    });

    /* 东西碑: 圭形碑身轮廓(尖首、双肩、底边、圆穿)取自 2026-08 盘点抠图照片, 与该照片矫正的贴图逐点对应
       (数值由 output/wushici-outdoor-textures-20260907/stele_profile.py 生成);
       高按名录顶高 2.10 m(含 0.26 m 碑座), 西碑肩高由此得 1.67 m(名录 1.70), 厚按名录 0.25 m。
       坐标为实测米(x 自碑身中线, y 自碑身底), 乘 K 补偿本组 0.9047 的整体缩放; 沿用原编号/基座/摆放。 */
    const STELES = {
      /* 西碑=武斑碑: 宽 0.73 */
      'BEI-WUBAN': { profile: [[-0.0053,1.84],[0.0802,1.7679],[0.3634,1.4143],[0.3536,0.0027],[-0.3313,0],
                               [-0.3634,0.0205],[-0.358,1.4152],[-0.252,1.5612]],
                     hole: [0.0007, 1.2664, 0.0524] },
      /* 东碑=无字碑: 宽 0.86 */
      'BEI-WUZI':  { profile: [[0.0032,1.84],[0.4279,1.3125],[0.4152,0.2328],[0.4234,0.0109],[-0.3979,0],
                               [-0.4161,0.0136],[-0.4279,1.3106],[-0.0159,1.8309]],
                     hole: [-0.0012, 1.1296, 0.0574] },
    };
    const K = 1 / g.scale.x;
    [-1,1].forEach(s=>{
      /* 西碑=武斑碑, 东碑=无字碑(布置图) */
      const id = s > 0 ? 'BEI-WUZI' : 'BEI-WUBAN', def = STELES[id];
      const b = new THREE.Group();
      b.position.set(1.1, 0, s*3.1);
      R.add(b);
      const pedH = 0.26*K;
      box(b, M.stoneW, 0.62*K, pedH, 1.15*K, 0, pedH/2, 0);
      const profile=new THREE.Shape();
      def.profile.forEach((p, i)=>{ if(i===0) profile.moveTo(p[0]*K, pedH + p[1]*K); else profile.lineTo(p[0]*K, pedH + p[1]*K); });
      profile.closePath();
      const hole=new THREE.Path(); hole.absarc(def.hole[0]*K, pedH + def.hole[1]*K, def.hole[2]*K, 0, Math.PI*2, true); profile.holes.push(hole);
      const depth = 0.25*K;
      const geo=new THREE.ExtrudeGeometry(profile,{depth,bevelEnabled:false,curveSegments:18});
      geo.translate(0,0,-depth/2); geo.rotateY(Math.PI/2);
      const body=new THREE.Mesh(geo,M.hpsStone); body.name='pointed_stele_with_aperture';
      body.castShadow=body.receiveShadow=true; b.add(body);
      regGroup(b, id);
    });

    /* 门槛(阈+闑): 横铺于东西双阙之间的长石 5.70x0.55x0.20,
       中部嵌竖圆首碣形"闑"石 0.44宽x0.51高x0.20厚(两面铺首衔环) */
    (function(){
      const yu = box(R, M.stoneW, 0.55, 0.20, 5.70, -0.9, 0.10, 0);          // 阈(横铺长石)
      const nie = box(R, M.stoneW, 0.20, 0.29, 0.44, -0.9, 0.345, 0);        // 闑身
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.20, 16), M.stoneW);
      cap.rotation.z = Math.PI/2;                                            // 圆首(轴沿厚度)
      cap.position.set(-0.9, 0.49, 0);
      cap.castShadow = cap.receiveShadow = true;
      R.add(cap);
      yu.name = 'HPS-MENKAN';
      yu.userData.hps = { id: 'MENKAN', face: 'QS' };
      yu.userData._parts = [yu, nie, cap];
      nie.userData.hpsRef = yu;
      cap.userData.hpsRef = yu;
    })();

    /* 中央石书展台(石书旋转90度, 书脊沿通道向) */
    (function(){
      const bg = new THREE.Group();
      bg.position.set(0.9, 0, 0);
      bg.rotation.y = Math.PI/2;
      R.add(bg);
      box(bg, M.stone, 0.9, 0.18, 1.1, 0, 0.09, 0);
      box(bg, M.stone, 0.42, 0.55, 0.5, 0, 0.45, 0);
      const p1 = box(bg, M.bookPg, 0.62, 0.06, 0.86, -0.28, 0.82, 0);
      p1.rotation.z = 0.3;
      const p2 = box(bg, M.bookPg, 0.62, 0.06, 0.86, 0.28, 0.82, 0);
      p2.rotation.z = -0.3;
    })();
    /* 红棕木栏杆: 整体围合全部陈列 */
    function railSeg(x0, z0, x1, z1){
      const L = Math.hypot(x1-x0, z1-z0);
      const ang = -Math.atan2(z1-z0, x1-x0);
      const mx=(x0+x1)/2, mz=(z0+z1)/2;
      box(R, M.railWood, L, 0.06, 0.06, mx, 0.82, mz, ang);
      box(R, M.railWood, L, 0.05, 0.05, mx, 0.48, mz, ang);
      const n = Math.max(1, Math.round(L/1.35));
      for(let i=0;i<=n;i++){
        const t = i/n;
        box(R, M.railWood, 0.1, 0.92, 0.1, x0+(x1-x0)*t, 0.46, z0+(z1-z0)*t);
      }
    }
    (function(){
      const x0=-2.85, x1=2.85, z0=-7.9, z1=7.9;
      railSeg(x0, z0, x1, z0);
      railSeg(x0, z1, x1, z1);
      railSeg(x0, z0, x0, z1);
      railSeg(x1, z0, x1, z1);
    })();

  })();














  /* ---- 阙室东北角石刻(13块+石座, 编号对应实拍) ----
     石体尺寸(2026-09-08)为实测米: 雕刻面按贴图宽高比取实测面积, 厚度取实测, 使照片贴图铺满该面;
     本组随建筑整体缩放 0.9047, 乘 K 补偿使世界尺寸等于实测。 */
  (function(){
    const S = new THREE.Group(); S.name = 'HPS_QUE_IN'; g.add(S);
    const K = 1 / g.scale.x;
    function reg(m, i){ m.name = 'HPS-QS-' + i; m.userData.hps = {id: 'QS-' + i, face: 'QS'}; return m; }
    /* 斜靠石(绕Z转a, 顶部朝墙)的中心: 底面中心落在 y0, 顶部背角贴到墙面 xWall */
    function lean(id, t, h, w, a, xWall, y0, z){
      const s = Math.sign(a) || 1;   /* a>0 顶部朝-X, a<0 顶部朝+X */
      const x = xWall + s*(h/2*Math.abs(Math.sin(a)) + t/2*Math.cos(a));
      const m = box(S, M.slabDk, t, h, w, x, y0 + h/2*Math.cos(a), z);
      m.rotation.z = a; return reg(m, id);
    }
    /* A面(西北墙, 内表面x=-5.11): ①大画像板立于窗下 + ②长条石长边触地斜倚 */
    lean(1, 0.16*K, 1.392*K, 0.704*K, 0.08, -5.11, F, -7.70);
    (function(){   /* QS-2: 倚角0.85, 最低点为底前角 */
      const t = 0.14*K, h = 0.52*K, w = 1.12*K, a = 0.85;
      const x = -5.11 + h/2*Math.sin(a) + t/2*Math.cos(a);
      const m = box(S, M.slabDk, t, h, w, x, F + h/2*Math.cos(a) + t/2*Math.sin(a), -8.90);
      m.rotation.z = a; reg(m, 2);
    })();
    /* B面(东北山墙): 通长石座(顶住两侧墙) + 3~10八块画像板均匀斜靠(倾角0.42, 顶部背角贴石座后沿z=-10.60) */
    reg(box(S, M.slabDk, 10.22, 0.28, 0.55, 0, F + 0.14, -10.325), 'B0');
    [[-4.47,0.968,0.334,0.10],[-3.19,0.971,0.380,0.14],[-1.92,0.952,0.373,0.13],[-0.64,0.966,0.374,0.14],
     [0.64,0.944,0.368,0.13],[1.92,0.937,0.375,0.16],[3.19,0.948,0.367,0.14],[4.47,0.969,0.373,0.15]
    ].forEach((a, i) => {
      const w = a[1]*K, h = a[2]*K, t = a[3]*K;
      const m = box(S, M.slabDk, w, h, t,
        a[0], F + 0.28 + Math.cos(0.42)*h/2, -10.60 + Math.sin(0.42)*h/2 + Math.cos(0.42)*t/2);
      m.rotation.x = -0.42; reg(m, i + 3);
    });
    /* C面(东南墙, 内表面x=5.11): 11小立石(刻面朝室内) + 12窗左下 + 13窗右侧(均避z=-10/-6柱) */
    reg(box(S, M.slabDk, 0.226*K, 0.876*K, 0.18*K, 4.62, F + 0.876*K/2, -9.30), 11);
    lean(12, 0.11*K, 1.013*K, 0.478*K, -0.24, 5.11, F, -8.45);
    lean(13, 0.19*K, 1.192*K, 0.967*K, -0.25, 5.11, F, -6.90);
  })();

  g.add(asRoof(gableRoof(W+0.7, D/2+0.85, F+wallH+0.55, F+ridge, 0.34)));
})();

/* =====================================================================
   4. 后展厅  22.28 x 13.2, 柱顶4.28, 檐口5.97, 庑殿顶正脊8.97
      圆柱为墙体内柱(半露), 东南面明间大门
===================================================================== */
(function(){
  const g = new THREE.Group();
  g.position.set(77.40, 0, 0);   /* codex精确位置: X=38.06 -> local 77.40 */
  g.name = 'rear_exhibition_hall';
  g.scale.setScalar(0.9672);   /* 等比缩至方案图轮廓 12.78x21.52 */
  AG.add(g);
  const D=13.2, W=22.28, wallH=4.28;
  box(g, M.plinth, D+2.0, 0.3, W+2.2, 0, 0.15, 0);       // 台明(室外-0.300)
  const F=0.3;
  /* 2019 CAD 第20页：砖填充、涂料仿砖缝；现场A/C面同为细灰砖外观。 */
  [-1,1].forEach(s=>{
    box(g, M.brick, 0.5, wallH, W, s*(D/2-0.25), F+wallH/2, 0);
    box(g, M.baseStone, 0.52, 0.38, W, s*(D/2-0.25), F+0.19, 0);
  });
  [-1,1].forEach(s=>{
    box(g, M.brick, D-1.0, wallH, 0.5, 0, F+wallH/2, s*(W/2-0.25));
    box(g, M.baseStone, D-1.0, 0.38, 0.52, 0, F+0.19, s*(W/2-0.25));
  });
  /* 前后檐外露红漆圆柱 φ500 (轴①~⑥: z=±2.1, ±6.32, ±9.96) + 红额枋 */
  const zs=[-9.96,-6.32,-2.10,2.10,6.32,9.96];
  [-1,1].forEach(s=>{
    zs.forEach(z=> cyl(g, M.colRed, 0.25, wallH, s*(D/2+0.02), F+wallH/2, z, 12));
    box(g, M.colRed, 0.32, 0.45, W-0.8, s*(D/2+0.05), F+wallH-0.225, 0);
  });
  /* 山墙红柱: 每面4根(轴A/B/C/D), 分段 1.2/3.6/3.6/3.6/1.2 (图纸P19) */
  [-5.4, -1.8, 1.8, 5.4].forEach(x=>{ [-1,1].forEach(s=> cyl(g, M.colRed, 0.25, wallH, x, F+wallH/2, s*(W/2+0.02), 12)); });
  /* 檐口斗拱/檐椽带 4.28 -> 5.6 (随屋顶隐藏) */
  asRoof(box(g, M.tileDark, D+0.4, 1.32, W+0.4, 0, F+wallH+0.66, 0));
  /* 正面(朝中院): 明间红漆大门 + 4樘直棂窗(2400/2000, 窗高2.6) */
  doubleDoor(g, 3.0, 3.4, -(D/2+0.06), F+1.7, 0, -Math.PI/2, M.winRed, M.doorRed);
  [-8.14,-4.21,4.21,8.14].forEach((z,i)=>{
    const ww = (Math.abs(z)<6) ? 2.4 : 2.0;
    latticeWin(g, ww, 2.6, -(D/2+0.04), F+2.3, z, -Math.PI/2, M.winRed, M.winDk);
  });
  /* 背面: 中央出口 + 4樘直棂窗 */
  doubleDoor(g, 2.6, 3.0, D/2+0.06, F+1.5, 0, Math.PI/2, M.winRed, M.doorRed);
  [-8.14,-4.21,4.21,8.14].forEach(z=>{
    const ww = (Math.abs(z)<6) ? 2.4 : 2.0;
    latticeWin(g, ww, 2.6, D/2+0.04, F+2.3, z, Math.PI/2, M.winRed, M.winDk);
  });
  steps(g, 4.2, 4, 0.15, 0.32, -D/2-1.0, 0, 0, -Math.PI/2);
  steps(g, 4.2, 2, 0.15, 0.34, D/2+1.0, 0, 0, Math.PI/2);
  /* ---- 室内白色衬墙(墙内表面: x=±6.10, z=±10.64), 门洞处断开 ---- */
  [-1,1].forEach(s=> box(g, M.wallWhite, 12.16, wallH, 0.04, 0, F+wallH/2, s*10.62));  // 两山墙
  /* 正面(-X)大门墙: 门洞3.0宽x3.4高 */
  [-1,1].forEach(s=> box(g, M.wallWhite, 0.04, wallH, 9.14, -6.08, F+wallH/2, s*6.07));
  box(g, M.wallWhite, 0.04, wallH-3.4, 3.0, -6.08, F+3.4+(wallH-3.4)/2, 0);
  /* 背面(+X)出口墙: 门洞2.6宽x3.0高 */
  [-1,1].forEach(s=> box(g, M.wallWhite, 0.04, wallH, 9.34, 6.08, F+wallH/2, s*5.97));
  box(g, M.wallWhite, 0.04, wallH-3.0, 2.6, 6.08, F+3.0+(wallH-3.0)/2, 0);
  /* 室内侧门扇(与外门对应, 朝内开视) */
  doubleDoor(g, 3.0, 3.4, -6.0, F+1.7, 0, Math.PI/2, M.winRed, M.doorRed);
  doubleDoor(g, 2.6, 3.0, 6.0, F+1.5, 0, -Math.PI/2, M.winRed, M.doorRed);
  /* 玻璃展柜: 周圈沿墙通高(门及正对门处留空) + 中央三组 */
  [-1,1].forEach(sx=>{ [-1,1].forEach(sz=>{
    showcase(g, 0.6, 8.0, sx*5.8, sz*5.9, F, wallH);
  });});
  [-1,1].forEach(sz=> showcase(g, 10.8, 0.6, 0, sz*10.34, F, wallH));
  showcase(g, 1.2, 4.2, 0, 5.0, F, 2.2);
  showcase(g, 2.6, 2.8, 0, 0, F, 2.2);
  showcase(g, 1.2, 4.2, 0, -5.0, F, 2.2);
  /* ---- 散置汉画像石简易示意 ----
     A面=西南山墙(+Z), B面=背面檐墙(+X, 朝墓区), C面=东北山墙(-Z)
     台明顶0.3, 墙外表面: |z|=11.14, x=6.6 */
  (function(){
    const S = new THREE.Group(); S.name = 'HPS_REAR'; g.add(S);
    const mat = M.hpsStone, T = F;
    /* 靠墙立石: w沿墙宽, h高, t厚, u沿墙位置, lean倾角(顶部朝墙倾,不接触墙)
       底部与墙面净距0.3m */
    function slab(id, face, w, h, t, u, lean){
      const a = lean || 0, off = 0.30 + t/2;
      let m;
      if(face === 'A'){        /* 墙外+Z侧(外表面z=11.14) */
        m = box(S, mat, w, h, t, u, T + h/2*Math.cos(a), 11.14 + off);
        m.rotation.x = -a;
      }else if(face === 'C'){  /* 墙外-Z侧 */
        m = box(S, mat, w, h, t, u, T + h/2*Math.cos(a), -11.14 - off);
        m.rotation.x = a;
      }else{                   /* B: 墙外+X侧(外表面x=6.6) */
        m = box(S, mat, t, h, w, 6.6 + off, T + h/2*Math.cos(a), u);
        m.rotation.z = a;
      }
      m.name = 'HPS-' + id;
      m.userData.hps = { id: id, face: face };
      return m;
    }
    /* 自由摆放石块(平躺/斜搭等): 尺寸(w,h,d)+位置+旋转 */
    function loose(id, w, h, t, x, y, z, rx, ry, rz){
      const m = box(S, mat, w, h, t, x, y, z);
      m.rotation.set(rx || 0, ry || 0, rz || 0);
      m.name = 'HPS-' + id;
      m.userData.hps = { id: id, face: id.charAt(0) };
      return m;
    }

    /* ---- A面(西南山墙) 4块: 照片近端=-X(内院端), 远端=+X(东南围墙) ----
       ②柱间长条刻石(贴第二柱) ③④⑤第二柱后三块斜靠竖石板
       (原A-1大横条石经2026-08实地盘点确认为清代碑刻, 非汉画像石, 已移除) */
    slab('A-2', 'A', 1.90, 0.55, 0.30,  0.58);
    slab('A-3', 'A', 0.55, 1.40, 0.18,  2.35, 0.10);
    /* A-4 残破石板: 右上角豁口(从外侧看) */
    (function(){
      const sp = new THREE.Shape();
      sp.moveTo(0, 0); sp.lineTo(0.80, 0); sp.lineTo(0.80, 0.62);
      sp.lineTo(0.55, 0.95); sp.lineTo(0.30, 1.20); sp.lineTo(0, 1.20);
      sp.closePath();
      const ge = new THREE.ExtrudeGeometry(sp, { depth: 0.22, bevelEnabled: false });
      ge.translate(-0.40, 0, -0.11);
      const m = new THREE.Mesh(ge, mat);
      m.position.set(3.07, T, 11.14 + 0.30 + 0.11);
      m.rotation.x = -0.12;
      m.castShadow = m.receiveShadow = true;
      m.name = 'HPS-A-4'; m.userData.hps = { id: 'A-4', face: 'A' };
      S.add(m);
    })();
    slab('A-5', 'A', 0.75, 0.95, 0.18,  3.90, 0.12);

    /* ---- B面(背面檐墙) 3处4块 ----
       ①第一窗下长条石(竖放靠墙) ②台明外地上竖放立石 ③④台明上两块平躺 */
    slab('B-1', 'B', 3.00, 0.72, 0.30,  8.10);
    loose('B-2', 0.18, 0.45, 1.70, 8.15, 0.275, -5.60);                   /* ②地上立石(长边触地) */
    loose('B-3', 0.72, 0.15, 1.05, 7.05, T + 0.075, -8.70);               /* ③台明上平躺 */
    loose('B-4', 0.60, 0.13, 0.90, 7.05, T + 0.065, -10.70);              /* ④台明上平躺(避开柱脚) */

    /* ---- C面(东北山墙) 8块: 照片左端=-X(正面端), 以两根柱为参照 ----
       ①柱1左楔形躺石 ②③柱1右断裂残碑 ④两柱间方板 ⑤柱2左脚小残石
       ⑥柱2右大横碑 ⑦⑧斜靠方板 */
    /* C面不规则残石: shape以沿墙u坐标绘制, 挤出后置于台明 */
    function shard(id, pts, t, lean, zOff){
      const sp = new THREE.Shape();
      sp.moveTo(pts[0][0], pts[0][1]);
      for(let i = 1; i < pts.length; i++) sp.lineTo(pts[i][0], pts[i][1]);
      sp.closePath();
      const ge = new THREE.ExtrudeGeometry(sp, { depth: t, bevelEnabled: false });
      ge.translate(0, 0, -t/2);
      const m = new THREE.Mesh(ge, mat);
      m.position.set(0, T, zOff !== undefined ? zOff : -11.14 - 0.30 - t/2);
      m.rotation.x = lean || 0;
      m.castShadow = m.receiveShadow = true;
      m.name = 'HPS-' + id; m.userData.hps = { id: id, face: 'C' };
      S.add(m); return m;
    }
    /* ①小残石(与⑤同款), 贴柱1(轴D)靠墙角一侧 */
    loose('C-1', 0.32, 0.35, 0.25,  5.83, T + 0.175, -11.70);
    /* ②断裂残碑: 紧贴柱1, 拼合山形, 中间裂缝一分为二;
       2026-08实地盘点确认两段为同一块石头, 档案合并为C-2(原C-3编号弃用) */
    (function(){
      const p1 = shard('C-2', [[4.65,0],[5.15,0],[5.15,0.72],[5.11,0.76],[4.65,1.06]], 0.20, 0.10);
      const p2 = shard('C-2', [[4.09,0],[4.61,0],[4.61,1.06],[4.55,1.12],[4.09,0.78]], 0.22, 0.10);
      p2.name = 'HPS-C-2-part2';
      delete p2.userData.hps;
      p2.userData.hpsRef = p1;                      /* 别名段: 点击等同选中C-2 */
      p1.userData._parts = [p1, p2];                /* 高亮时两段联动; 实测尺寸由SURVEY_2026提供 */
    })();
    slab('C-4', 'C', 1.00, 0.88, 0.16,  3.51, 0.15);
    loose('C-5', 0.32, 0.35, 0.25,  2.78, T + 0.175, -11.70);             /* ⑤紧随④ */
    slab('C-6', 'C', 1.05, 0.80, 0.25,  1.00, 0.06);
    slab('C-7', 'C', 0.75, 0.80, 0.16,  0.04, 0.20);
    slab('C-8', 'C', 0.72, 0.88, 0.18, -0.85, 0.28);
  })();


  /* ---- 后展厅室内石刻(简化体块, 按摆放布局固定, 尺寸取一览表) ---- */
  (function(){
    const S = new THREE.Group(); S.name = 'HPS_HALL_IN'; g.add(S);
    /* [x,y,z, rx,ry,rz, 宽,高,厚, 名称, 左肩高?, 右肩高?] 有肩高的为锐顶石 */
    const L = [
    [-5.78,1.3204,-6.3, 0,1.5708,0, 2.4,1.64,0.16, '2 武梁祠后壁'],
    [-5.78,1.42,-4, 0,1.5708,0, 1.395,1.84,0.17, '3 武梁祠东壁', 1.63, 1.63],
    [-5.78,1.42,-8.7, 0,1.5708,0, 1.4,1.84,0.17, '4 武梁祠西壁', 1.63, 1.63],
    [-5.78,1.65,3, 0,1.5708,0, 1.1,1.1,0.18, '36 有鸟如鹤'],
    [-5.78,0.6543,3.6, 0,1.5708,0, 2.09,0.31,0.21, '44 脊石画像石'],
    [-5.78,1.666,4.6, 0,1.5708,0, 1.65,0.72,0.2, '35 左石室后壁小龛后壁'],
    [-5.78,1.0875,8.8, 0,1.5708,0, 0.78,0.975,0.26, '31 左石室后壁小龛东侧'],
    [-5.78,2.4875,8.8, 0,1.5708,0, 0.69,0.975,0.3, '30 左石室后壁小龛西侧'],
    [-5.78,2.1858,7, 0,1.5708,0, 1.72,0.36,0.26, '32 左石室后壁东承檐石'],
    [-5.78,1.1553,7.5, 0,1.5708,0, 0.735,0.72,0.3, '33 左石室后壁小龛东壁'],
    [-5.78,1.163,6.6, 0,1.5708,0, 0.74,0.71,0.3, '34 左石室后壁小龛西壁'],
    [-5.6522,0.9285,5.1, 0,1.5708,0, 0.69,0.25,0.21, '46 菱纹残石'],
    [-3.2,2.247,10.28, 0,3.1416,0, 2.1,0.9,0.26, '28 左石室东壁上石', 0.58, 0.58],
    [-3.2,0.9893,10.28, 0,3.1416,0, 2.1,0.98,0.26, '29 左石室东壁下石'],
    [-0.7,2.2534,10.28, 0,3.1416,0, 2.11,0.91,0.23, '27 左石室西壁上石', 0.58, 0.58],
    [-0.7,0.9943,10.28, 0,3.1416,0, 2.12,0.99,0.23, '25 左石室西壁下石'],
    [1.9,2.2028,10.28, 0,3.1416,0, 2.22,1.21,0.22, '23 前石室屋顶前坡东石'],
    [2,0.7528,10.28, 0,3.1416,0, 2.5,0.51,0.27, '24 左石室后壁横额'],
    [4.3,1.649,10.28, 0,3.1416,0, 1.69,1.29,0.22, '21 左石室屋顶前坡西石'],
    [-3.8,2.4985,-10.28, 0,0,0, 2.79,1.14,0.2, '5 武梁祠屋顶前坡'],
    [-3.8,1.07,-10.28, 0,0,0, 2.78,1.14,0.2, '6 武梁祠屋顶后坡'],
    [-0.6,1.8981,-10.28, 0,0,0, 1.67,0.39,0.2, '7 前石室后壁西承檐石'],
    [-0.6,1.2457,-10.28, 0,0,0, 1.69,0.7,0.2, '9 前石室后壁小龛后壁'],
    [-0.6,0.6304,-10.28, 0,0,0, 1.68,0.26,0.4, '45 前石室后壁小龛下供案石'],
    [3,0.7571,-10.28, 0,0,0, 3.52,0.51,0.29, '10 前石室后壁横额'],
    [2,1.6851,-10.28, 0,0,0, 2.02,1.17,0.2, '8 前石室东壁上石', 0.88, 0.88],
    [4.2,1.6858,-10.28, 0,0,0, 2.03,1.17,0.2, '11 前石室西壁上石', 0.84, 0.84],
    [5.78,2.1752,-8.4, 0,-1.5708,0, 2.03,0.96,0.16, '12 前石室西壁下石'],
    [5.78,0.9779,-8.4, 0,-1.5708,0, 2.03,0.96,0.19, '13 前石室东壁下石'],
    [5.78,1.8457,-5.7, 0,-1.5708,0, 1.775,0.29,0.22, '15 前石室前壁承檐枋东石正面'],
    [5.78,0.8401,-5.7, 0,-2.0944,0, 0.94,0.7,0.71, '17 前石室后壁小龛东壁'],
    [5.78,0.8477,-3.4, 0,-0.7854,0, 0.94,0.7,0.71, '16 前石室后壁小龛西壁'],
    [5.78,1.8492,-3.4, 0,-1.5708,0, 1.98,0.3,0.22, '18 前石室前壁承檐枋西石'],
    [5.78,1.6033,8.2, 0,-1.5708,0, 2.15,1.21,0.22, '22 前石室屋顶前坡西石'],
    [5.78,1.7456,3.4, 0,-1.5708,0, 1.675,1.48,0.23, '19 左石室屋顶后坡东石'],
    [0,0.8014,-1.2, 18.8496,15.708,18.8496, 1.42,0.9,0.18, '39 蔡题一石'],
    [0.0412,0.9045,1.1417, 6.2832,12.5664,12.5664, 1.71,0.84,0.18, '40 蔡题二石'],
    [1.1,0.7888,-0.1, -1.5708,4.7124,-1.5708, 2.13,0.57,0.2, '41 蔡题三石', 0.19, 0.25],
    [0.2,0.6384,0, 10.9956,4.7124,4.7124, 1.0,0.25,0.4, '43 舞蹈画像石'],
    /* 供案平放：132×49厘米是顶面，23厘米是厚度；底面沿用原展台高度。 */
    [-0.8,0.6158,0, -1.5708,4.7124,-1.5708, 1.32,0.23,0.49, '42 耳杯盛鱼'],
    [0,0.8024,3.6, -1.5708,4.7124,-1.5708, 0.61,0.64,0.46, '38 东北墓间'],
    [0,0.8677,-3.8, 10.9956,17.2788,17.2788, 1.55,0.67,0.18, '37 南道旁'],
    [0,0.8301,-5.9, -1.5708,4.7124,-1.5708, 2.27,0.62,0.24, '14 前石室隔梁石', 0.12, 0.12],
    [0,0.8297,5.5, 6.2832,14.1372,18.8496, 2.39,0.64,0.24, '26 左石室隔梁东面', 0.28, 0.28],
    [5.78,1.8,5.7, 0,4.7124,1.5708, 1.4,1.67,0.22, '占位石A 167×140×22'],
    [-5.78,0.85,-2.9, 0,3.1416,0, 0.135,0.7,0.19, '占位石B 70×13.5×19']
    ];
    function stoneGeo(a){
      if(a[9]==='36 有鸟如鹤'){
        /* 残石的右上、右下缺损沿2025实照描边，贴图与残存轮廓共用坐标。 */
        const outline=[[0,0],[.55,0],[.59,.035],[.63,.105],[.71,.19],[.82,.235],[.91,.24],[.95,.31],[.96,.40],[1,.58],[.99,.70],[.90,.73],[.83,.77],[.80,.84],[.79,.92],[.72,1],[.04,1],[0,.94]];
        const shape=new THREE.Shape();
        outline.forEach(([u,v],i)=>shape[i?'lineTo':'moveTo']((u-.5)*a[6],(.5-v)*a[7]));
        shape.closePath();
        const geo=new THREE.ExtrudeGeometry(shape,{depth:a[8],bevelEnabled:false});
        geo.translate(0,0,-a[8]/2); return geo;
      }
      if(a.length > 10){   /* 锐顶: 五边形轮廓挤出 */
        const w = a[6], hc = a[7], t = a[8], hl = a[10], hr = a[11];
        const s = new THREE.Shape();
        s.moveTo(-w/2, -hc/2);
        s.lineTo(w/2, -hc/2);
        s.lineTo(w/2, -hc/2 + hr);
        s.lineTo(0, hc/2);
        s.lineTo(-w/2, -hc/2 + hl);
        s.closePath();
        const geo = new THREE.ExtrudeGeometry(s, {depth: t, bevelEnabled: false});
        geo.translate(0, 0, -t/2);
        return geo;
      }
      return new THREE.BoxGeometry(a[6], a[7], a[8]);
    }
    L.forEach(a => {
      const m = new THREE.Mesh(stoneGeo(a), M.slabDk);
      m.position.set(a[0], a[1] + F, a[2]);
      m.rotation.set(a[3], a[4], a[5]);
      m.castShadow = m.receiveShadow = true;
      m.name = 'HPS-IN-' + a[9];
      m.userData.hps = { id: a[9], face: 'IN' };
      S.add(m);
    });
  })();

  /* 庑殿顶: 檐口5.97, 正脊8.97, 脊长约9m */
  g.add(asRoof(hipRoof(W+3.0, D+3.0, 9.0, F+5.67, F+8.62)));
})();

/* =====================================================================
   5. 西廊(西展厅) 27.94 x 5.1, 檐口2.88, 正脊5.37, 前廊木柱
===================================================================== */
(function(){
  const g = new THREE.Group();
  g.position.set(58.62, 0, 14.88);   /* codex精确位置: (19.28,14.88) -> local */
  g.scale.setScalar(0.9542);   /* 等比缩至方案图轮廓 26.91x4.82 */
  AG.add(g);
  const L=27.94, D=5.1;
  box(g, M.plinth, L+0.7, 0.22, D+0.7, 0, 0.11, 0);
  const F=0.22, colH=2.62;
  box(g, M.brick, L, 3.0, 0.4, 0, F+1.5, D/2-0.2);          // 后檐墙
  [-1,1].forEach(s=>{                                        // 山墙(两端)
    box(g, M.brick, 0.4, 3.0, D, s*(L/2-0.2), F+1.5, 0);
    const gw = gableWall(D/2+0.15, F+3.0, F+5.15, 0.4, M.brick, 0.55);
    gw.rotation.y = -Math.PI/2;
    gw.position.set(s*(L/2-0.2), 0, 0);
    g.add(asRoof(gw));
  });
  const xs=[-13.45,-9.75,-5.85,-1.95,1.95,5.85,9.75,13.45];
  xs.forEach(x=> cyl(g, M.woodRed, 0.1, colH, x, F+colH/2, -D/2+0.35, 10));
  box(g, M.woodRed, L+0.2, 0.28, 0.24, 0, F+colH+0.14, -D/2+0.35);
  /* 前檐墙: 槛墙至窗台(1.0) + 窗间/门侧砌砖至额枋 + 窗上压条 */
  box(g, M.brickDark, L-1.2, 1.0, 0.22, 0, F+0.5, -D/2+0.75);   // 槛墙
  [[-13.77,-12.9],[-10.3,-9.1],[-6.5,-5.2],[-2.6,-1.28],
   [1.28,2.6],[5.2,6.5],[9.1,10.3],[12.9,13.77]].forEach(a=>{
    box(g, M.brick, a[1]-a[0], colH-1.0, 0.22, (a[0]+a[1])/2, F+1.0+(colH-1.0)/2, -D/2+0.75);
  });
  [-1,1].forEach(s=> box(g, M.brick, 12.49, 0.14, 0.22, s*7.525, F+2.55, -D/2+0.75)); // 窗上压条(门位断开)
  box(g, M.brick, 2.56, colH-2.3, 0.10, 0, F+2.3+(colH-2.3)/2, -D/2+0.87);  // 门上档(后移避门框)
  doubleDoor(g, 2.2, 2.3, 0, F+1.15, -D/2+0.72, Math.PI, M.winRed, M.doorRed);
  [-11.6,-7.8,-3.9, 3.9,7.8,11.6].forEach(x=>
    glassWin(g, 2.6, 1.5, x, F+1.75, -D/2+0.75, Math.PI, M.winRed, M.winGlass));
  /* U形玻璃通柜: 南墙通长段 + 东西山墙段折回, 三段连通 */
  (function(){
    const W2 = L/2 - 0.4;                 /* 山墙内面 13.57 */
    const z0 = 1.275, z1 = D/2 - 0.4;     /* 南段玻璃立面 / 南墙内面 */
    const cd = z1 - z0;                   /* 柜深 0.875 */
    const zN = -1.6;                      /* 山墙段北端(留出前廊) */
    const gh = 3.0 - 0.56, gy = F + 0.5 + gh/2;
    const xg = W2 - cd;                   /* 山墙段玻璃立面 */
    const sc = m => { m.userData.showcase = true; return m; };   /* 陈列设施标记: 不遮挡石刻拾取 */
    function glass(w, d, x, z){
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, gh, d), M.glass);
      m.position.set(x, gy, z); g.add(m); sc(m);
    }
    /* 南墙段(通长) */
    sc(box(g, M.caseBase, W2*2, 0.5, cd, 0, F+0.25, (z0+z1)/2));
    sc(box(g, M.caseBase, W2*2, 0.06, cd, 0, F+3.0-0.03, (z0+z1)/2));
    glass(xg*2, 0.02, 0, z0);
    /* 东西山墙段(与南段拐角连通) */
    [-1,1].forEach(s=>{
      const zc = (zN + z1)/2, zl = z1 - zN;
      sc(box(g, M.caseBase, cd, 0.5, zl, s*(W2 - cd/2), F+0.25, zc));
      sc(box(g, M.caseBase, cd, 0.06, zl, s*(W2 - cd/2), F+3.0-0.03, zc));
      glass(0.02, z0 - zN, s*xg, (zN + z0)/2);      /* 内侧玻璃 */
      glass(cd, 0.02, s*(W2 - cd/2), zN);           /* 北端封头 */
    });
  })();
  const roof = gableRoof(L+0.6, D/2+0.75, F+2.78, F+5.15, 0.28, 0.55);
  roof.rotation.y = -Math.PI/2;
  g.add(asRoof(roof));
  steps(g, 2.8, 2, 0.11, 0.3, 0, 0, -D/2-0.35, Math.PI);
})();

/* ---- 西长廊室内石刻陈列(40件: 西墙38 + 北墙隋碑 + 南墙获麟处碑)
   布局 = 西长廊摆放工具实摆导出(正式版 2026-08-28), 尺寸按2023定级清单
   全部贴西墙分三层陈列(地面/搁板1.05/搁板1.95); 同层按真实尺寸保序消重叠
   坐标: along=沿墙自北山墙内面(AG x=45.67), off=距西墙内面(AG z=16.93), y=底距台基顶(0.21) ---- */
(function(){
  const S = new THREE.Group(); S.name = 'HPS_XCL_IN'; AG.add(S);
  const X0 = 45.67, XS = 71.57, Z0 = 16.93, Y0 = 0.21;
  const BASE = 0.48;    /* U形玻璃通柜台座高: 石刻均立于台面上 */
  /* [id, 长, 高, 厚, along, off, y] 西墙石(长边沿廊向, 面朝东; y为底距台面) */
  const DATA = [
    ['XCL-01', 1.15, 0.41, 0.17, 0.75, 0.14, 1.05],
    ['XCL-02', 2.85, 0.56, 0.16, 1.475, 0.05, 0],
    ['XCL-03', 1.44, 0.68, 0.17, 2.105, 0.14, 1.05],
    ['XCL-04', 0.8, 1.15, 0.25, 3.43, 0.14, 0],
    ['XCL-05', 0.45, 1.11, 0.16, 4.185, 0.14, 0],
    ['XCL-06', 0.5, 1.11, 0.16, 4.72, 0.14, 0],
    ['XCL-07', 0.52, 1.39, 0.16, 5.7, 0.14, 0],
    ['XCL-08', 0.52, 1.38, 0.16, 6.7, 0.14, 0],
    ['XCL-09', 1.8, 0.28, 0.17, 7.7, 0.14, 1.7],
    ['XCL-10', 0.6, 0.74, 0.16, 8.2, 0.14, 1.05],
    ['XCL-11', 1.7, 0.37, 0.17, 8.2, 0.14, 0],
    ['XCL-12', 0.7, 0.82, 0.16, 9.01, 0.14, 1.7],
    ['XCL-13', 0.68, 0.81, 0.17, 9.7, 0.14, 0.05],
    ['XCL-14', 0.61, 0.87, 0.17, 10.6, 0.14, 1.05],
    ['XCL-15', 1.05, 0.4, 0.17, 11.095, 0.14, 0],
    ['XCL-16', 0.57, 0.73, 0.17, 11.6, 0.14, 1.05],
    ['XCL-17', 1.03, 0.35, 0.17, 12.195, 0.14, 0],
    ['XCL-18', 0.65, 0.87, 0.17, 12.6, 0.14, 1.05],
    ['XCL-19', 0.58, 0.63, 0.17, 13.65, 0.14, 1.05],
    ['XCL-20', 1.2, 0.49, 0.17, 13.37, 0.14, 0],
    ['XCL-21', 0.68, 0.69, 0.17, 14.65, 0.14, 1.05],
    ['XCL-22', 0.6, 0.64, 0.17, 15.7, 0.14, 1.05],
    ['XCL-23', 1.27, 0.42, 0.17, 14.665, 0.14, 0],
    ['XCL-24', 0.68, 0.69, 0.17, 16.7, 0.14, 1.05],
    ['XCL-25', 1.53, 0.54, 0.16, 17.9, 0.14, 1.05],
    ['XCL-26', 2.44, 0.4, 0.17, 16.58, 0.14, 0],
    ['XCL-27', 1.36, 0.44, 0.17, 19.405, 0.14, 1.05],
    ['XCL-28', 1.3, 0.41, 0.17, 18.51, 0.14, 0],
    ['XCL-29', 1.55, 0.54, 0.17, 20.92, 0.14, 1.05],
    ['XCL-30', 1.13, 0.42, 0.17, 19.785, 0.14, 0],
    ['XCL-31', 1.11, 0.39, 0.17, 22.31, 0.14, 1.05],
    ['XCL-32', 1.3, 0.67, 0.16, 21.06, 0.14, 0],
    ['XCL-33', 0.94, 0.94, 0.16, 22.24, 0.14, 0],
    ['XCL-34', 1.13, 0.68, 0.17, 23.335, 0.14, 0],
    ['XCL-35', 0.97, 0.49, 0.08, 24.42, 0.14, 0],
    ['XCL-36', 0.97, 0.49, 0.08, 25.4, 0.14, 0],
    ['XCL-37', 0.97, 0.49, 0.08, 24.42, 0.14, 0.54],
    ['XCL-38', 0.97, 0.49, 0.08, 25.4, 0.14, 0.54],
  ];
  DATA.forEach(d=>{
    const mt = (d[0] === 'XCL-35' || d[0] === 'XCL-36' || d[0] === 'XCL-37' || d[0] === 'XCL-38')
      ? M.stoneW : M.slabDk;
    const m = box(S, mt, d[1], d[2], d[3], X0 + d[4], Y0 + BASE + d[6] + d[2]/2, Z0 - d[5]);
    m.name = 'HPS-' + d[0];
    m.userData.hps = { id: d[0], face: 'XCL' };
    m.userData.xclBaseSize = [d[1], d[2], d[3]];
  });
  /* 碑体按照片外轮廓挤出，正面贯通碑首与碑身，避免分段漏贴。 */
  function stele(id, bw, bh, bt, along, off, southWall){
    const shape = new THREE.Shape();
    const profile = stoneTextures[id+':front']?.userData.profile || [[0,1],[1,1],[1,.1],[.85,0],[.15,0],[0,.1]];
    profile.forEach((p,i)=>{ const x=(p[0]-.5)*bw, y=(.5-p[1])*bh; if(i) shape.lineTo(x,y); else shape.moveTo(x,y); });
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape,{depth:bt,bevelEnabled:false,steps:1});
    geometry.translate(0,0,-bt/2);
    const body = new THREE.Mesh(geometry, M.stoneW);
    body.castShadow = body.receiveShadow = true; S.add(body);
    body.name = 'HPS-' + id;
    body.userData.hps = { id: id, face: 'XCL' };
    body.userData.xclBaseSize = [bw,bh,bt];
    body.position.set(southWall ? XS - off : X0 + off, Y0 + BASE + bh/2, Z0 - along);
    body.rotation.y = southWall ? -Math.PI/2 : Math.PI/2;
  }
  stele('XCL-N', 0.68, 1.77, 0.19, 2.2, 0.4, false);   // 大隋开皇三年佛造像碑(北山墙)
  stele('XCL-S', 0.68, 1.43, 0.17, 2.1, 0.35, true);   // 明"获麟处"碑(南山墙)
})();

/* ---- 西长廊东南山墙外汉画像石 3块(自南侧小门起向北排) ---- */
(function(){
  const S = new THREE.Group(); S.name = 'HPS_XCL'; AG.add(S);
  const mat = M.hpsStone, WX = 71.95;   /* 山墙外表面x */
  function leanX(id, w, h, t, z, a){
    const m = box(S, mat, t, h, w, WX + 0.30 + t/2, h/2*Math.cos(a), z);
    m.rotation.z = a;
    m.name = 'HPS-' + id; m.userData.hps = { id: id, face: 'X' };
    return m;
  }
  leanX('X-1', 1.00, 0.95, 0.18, 16.60, 0.20);   /* 方形云龙纹雕板(垫砖斜靠) */
  leanX('X-2', 0.85, 1.10, 0.22, 15.55, 0.12);   /* 竖长画像石板 */
  /* 长条弦纹石断裂两段; 2026-08实地盘点确认为同一块, 档案合并为X-3(实测整体187×71×20) */
  (function(){
    const p1 = leanX('X-3', 1.15, 0.72, 0.22, 14.42, 0.14);   /* 南段 */
    const p2 = leanX('X-3', 0.82, 0.72, 0.22, 13.42, 0.14);   /* 北段 */
    p2.name = 'HPS-X-3-part2';
    delete p2.userData.hps;
    p2.userData.hpsRef = p1;
    p1.userData._parts = [p1, p2];   /* 实测尺寸由SURVEY_2026提供 */
  })();
})();

/* =====================================================================
   6. 北长廊(展示棚) —— 沿北院墙西段, 单坡仿古瓦, 松木柱, 深3.55
===================================================================== */
function shed(g, len, bays){
  const depth=3.55, backH=2.85, frontH=2.02;
  box(g, M.stonePave, len, 0.12, depth+0.5, len/2, 0.06, depth/2+0.15);
  for(let i=0;i<=bays;i++){
    const x = 0.3 + i*(len-0.6)/bays;
    cyl(g, M.wood, 0.075, frontH-0.1, x, 0.12+(frontH-0.1)/2, depth+0.05, 8);
  }
  box(g, M.wood, len, 0.18, 0.15, len/2, frontH+0.02, depth+0.05);
  box(g, M.wood, len, 0.15, 0.12, len/2, backH-0.08, 0.3);
  const slope = Math.atan((backH-frontH)/(depth+0.3));
  const r = new THREE.Mesh(new THREE.BoxGeometry(len+0.4, 0.12, depth+1.0), M.tile);
  r.position.set(len/2, (backH+frontH)/2+0.12, depth/2+0.2);
  r.rotation.x = slope;
  r.castShadow = r.receiveShadow = true;
  g.add(asRoof(r));
  /* 两条通长条形石座(沿廊向, 后条贴墙/前条居中) */
  [[0.75, 'N'], [2.45, 'S']].forEach(r2=>{
    const p = box(g, M.stone, len-0.7, 0.45, 0.8, len/2, 0.12+0.225, r2[0]);
    p.name = 'BL-PED-' + r2[1];
  });
  /* ---- 两排陈列画像石(20块, 位置为摆放工具实摆导出, 固定不动) ----
     [编号, 长,高,厚(m), x,底面y,z, rx,rz]  rx=1.5708平躺(长沿廊向, 高为进深, 厚为竖向) rz=1.5708竖放(长为竖向)
     尺寸(2026-09-08): 雕刻面按贴图宽高比(照片透视推算/实测)取实测面积, 厚度取实测, 使照片贴图铺满该面;
     R1-07 长条石照片所见正面仅约 11 cm 高, 长按实测 2.48 */
  const S = new THREE.Group(); S.name = 'HPS_BL'; g.add(S);
  [
    ['R1-01', 2.539,0.724,0.13, 28.9,  0.60, 0.75,   0,0],
    ['R1-02', 0.929,0.731,0.23, 26,    0.60, 0.75,   0,0],
    ['R1-03', 1.113,0.426,0.21, 24,    0.60, 0.75,   0,1.5708],
    ['R1-04', 1.079,0.447,0.18, 22.8,  0.60, 0.75,   0,1.5708],
    ['R1-05', 1.401,0.453,0.24, 20.3,  0.60, 0.75,   0,0],
    ['R1-06', 1.522,0.485,0.27, 17.9,  0.60, 0.75,   0,0],
    ['R1-07', 2.48, 0.11, 0.20, 19.1,  0.60, 1.0,    0,0],
    ['R1-08', 1.100,0.640,0.24, 7.6,   0.60, 0.75,   0,1.5708],
    ['R1-09', 1.010,0.687,0.24, 14.9,  0.60, 0.75,   0,1.5708],
    ['R1-10', 1.379,0.812,0.13, 9.9,   0.60, 0.75,   0,0],
    ['R1-11', 0.849,0.940,0.19, 5.2,   0.60, 0.75,   0,0],
    ['R1-12', 1.257,0.279,0.26, 2.5,   0.60, 0.75,   0,0],
    ['R1-13', 0.991,0.871,0.24, 12.2,  0.60, 0.75,   0,0],
    ['R2-01', 4.75, 0.59, 0.19, 4.3,   0.57, 2.45,   1.5708,0],
    ['R2-02', 1.50, 0.56, 0.28, 8.6,   0.60, 2.45,   0,0],
    ['R2-03', 1.712,0.569,0.26, 16.3,  0.60, 2.45,   0,0],
    ['R2-04', 2.02, 0.55, 0.32, 25.3,  0.60, 2.45,   1.5708,0],
    ['R2-05', 3.35, 0.56, 0.23, 20.7,  0.60, 2.45,   1.5708,0],
    ['R2-06', 2.226,0.468,0.34, 12.1692,0.60,2.4834, 0,0],
    ['R2-07', 1.16, 1.00, 0.19, 28.9,  0.57, 2.45,   1.5708,0]
  ].forEach(a=>{
    /* 竖向尺寸: 平躺=厚, 旋转竖放=长, 其余=高 */
    const vert = a[7] ? a[3] : (a[8] ? a[1] : a[2]);
    const m = box(S, M.slabDk, a[1], a[2], a[3], a[4], a[5] + vert/2, a[6]);
    m.rotation.set(a[7], 0, a[8]);
    m.name = 'HPS-BL-' + a[0];
    m.userData.hps = {id: 'BL-' + a[0], face: 'BL'};
  });
}
(function(){
  /* 直段长33.28贴北墙, 北墙段中间偏西(距西端24) */
  const A = L2W(20.86, -34.72);
  const dW = L2W(47.17, -55.10);
  const g1 = new THREE.Group();
  g1.position.set(A[0], 0, A[1]);
  g1.rotation.y = -Math.atan2(dW[1]-A[1], dW[0]-A[0]);
  scene.add(g1);
  shed(g1, 33.28, 9);
})();

/* =====================================================================
   7. 墓葬展示区: 祭坛(位于环路中央草地岛上, 与环路同向45°)
===================================================================== */
(function(){
  const c = q74e(791.15, 407.2);   /* 岛心=草岛对角线交点 */
  const g = new THREE.Group();
  g.position.set(c[0], 0.02, c[1]);
  g.rotation.y = -0.697;   /* 按草岛边线实际方位(页面40.4°, 与主轴差5°) */
  scene.add(g);
  box(g, M.stone, 7.6, 0.5, 7.6, 0, 0.25, 0);
  box(g, M.stone, 5.4, 0.45, 5.4, 0, 0.72, 0);
  box(g, M.stone, 1.6, 0.9, 1.0, 0, 1.4, 0);
})();

/* =====================================================================
   8. 管理用房(卫生间/办公室x2, 位置尺寸按方案-02设计平面图)
===================================================================== */
function mgmtHouse(cx, cz, wx, wz, ridgeAlongX, door, threeBay){
  const g = new THREE.Group();
  g.position.set(cx, 0, cz);
  g.rotation.y = -Math.PI/4;
  scene.add(g);
  const F=0.3, wallH=2.9, ridgeH=4.3;
  box(g, M.plinth, wx+0.7, F, wz+0.7, 0, F/2, 0);
  box(g, M.brick, wx, wallH, wz, 0, F+wallH/2, 0);
  box(g, M.baseStone, wx+0.06, 0.9, wz+0.06, 0, F+0.45, 0);
  const len = (ridgeAlongX?wx:wz)+0.5, hs=(ridgeAlongX?wz:wx)/2+0.5;
  const roof = gableRoof(len, hs, F+wallH-0.05, F+ridgeH, 0.22);
  if(ridgeAlongX) roof.rotation.y = Math.PI/2;
  g.add(asRoof(roof));
  [-1,1].forEach(s=>{
    const gw = gableWall(hs-0.1, F+wallH, F+ridgeH-0.22, 0.28, M.brick);
    if(ridgeAlongX){ gw.rotation.y = Math.PI/2; gw.position.set(s*(wx/2-0.14), 0, 0); }
    else gw.position.set(0, 0, s*(wz/2-0.14));
    g.add(asRoof(gw));
  });
  if(threeBay){
    /* 三间屋: 正面三门, 背面三窗 */
    const sgn = (door==='px') ? 1 : -1;
    [-1,0,1].forEach(i=>{
      box(g, M.door, 1.25, 2.1, 0.1, sgn*(wx/2+0.03), F+1.05, i*wz/3, Math.PI/2);
      box(g, M.lattice, 1.35, 1.35, 0.08, -sgn*(wx/2+0.03), F+1.7, i*wz/3, Math.PI/2);
      box(g, M.winDk,   1.12, 1.12, 0.12, -sgn*(wx/2+0.03), F+1.7, i*wz/3, Math.PI/2);
    });
    return;
  }
  /* 门 + 门面两侧窗 */
  const dp = {px:[wx/2+0.03,0,Math.PI/2], mx:[-wx/2-0.03,0,Math.PI/2],
              pz:[0,wz/2+0.03,0],         mz:[0,-wz/2-0.03,0]}[door];
  box(g, M.door, 1.3, 2.15, 0.1, dp[0], F+1.075, dp[1], dp[2]);
  const onX = (door==='px'||door==='mx');
  const wof = (onX?wz:wx)/4 + 0.3;
  [-1,1].forEach(s=>{
    const x = onX ? dp[0] : s*wof;
    const z = onX ? s*wof : dp[1];
    box(g, M.lattice, 1.35, 1.35, 0.08, x, F+1.7, z, dp[2]);
    box(g, M.winDk,   1.12, 1.12, 0.12, x, F+1.7, z, dp[2]);
  });
}
(function(){
  /* 位置/外廓按codex位置精确版(P75矢量), local: (X+39.34, Z) */
  const wc = L2W(18.82, 24.39);      // 卫生间 8.36x5.96, 长轴沿主轴
  mgmtHouse(wc[0], wc[1], 8.36, 5.96, true, 'mz');
  const b1 = L2W(41.20, 22.86);      // 办公室(北) 6.5x10.4, 长轴垂直主轴
  mgmtHouse(b1[0], b1[1], 6.5, 10.4, false, 'px');
  const b2 = L2W(58.84, 23.85);      // 办公室(南) 7.54x10.84, 三间屋: 正面(东南)三门, 背面三窗
  mgmtHouse(b2[0], b2[1], 7.54, 10.84, false, 'px', true);
})();

/* 分隔墙: 西廊东南端 -> 西南围墙, 沿z向(x=71.95), 门口2.5m紧贴西廊山墙 */
(function(){
  box(AG, M.rubble, 0.5, 3.0, 10.07, 71.95, 1.5, 24.85);
  box(AG, M.wallCap, 0.72, 0.16, 10.29, 71.95, 3.08, 24.85);
  /* 影壁: 门口内侧偏西, 青砖+石座+筒瓦压顶 */
  box(AG, M.baseStone, 0.55, 0.4, 6.8, 66.5, 0.2, 20.7);
  box(AG, M.brick, 0.4, 2.2, 6.6, 66.5, 1.5, 20.7);
  box(AG, M.tileDark, 0.66, 0.22, 6.92, 66.5, 2.7, 20.7);
})();

/* ---- 生活区内画像石 5块: 2块贴影壁东面北段, 3块贴西廊南山墙脚 ---- */
(function(){
  const S = new THREE.Group(); S.name = 'HPS_SHQ'; AG.add(S);
  const mat = M.hpsStone;
  function reg(m, id){ m.name = 'HPS-' + id; m.userData.hps = { id: id, face: 'S' }; return m; }
  /* 贴影壁东面(x=66.70): S-2大方板斜靠墙角, S-1方墩在其南 */
  reg(box(S, mat, 0.40, 0.65, 0.75, 67.20, 0.325, 19.50), 'S-1');
  const m2 = box(S, mat, 0.20, 1.05, 1.05, 67.10, 0.515, 18.30);
  m2.rotation.z = 0.20; reg(m2, 'S-2');
  /* 贴西廊南山墙脚(z=17.31): 自影壁向门口排(避开墙角斜板) */
  reg(box(S, mat, 0.95, 0.90, 0.50, 68.05, 0.45, 17.86), 'S-3');
  reg(box(S, mat, 1.35, 0.35, 0.40, 69.35, 0.175, 17.81), 'S-4');
  reg(box(S, mat, 1.05, 0.38, 0.38, 70.60, 0.19, 17.80), 'S-5');
  /* 院东南角: S-6方形石板贴分隔墙内侧, S-7高条碑斜靠南围墙 */
  const m6 = box(S, mat, 0.18, 0.72, 0.75, 71.31, 0.36, 27.60);
  m6.rotation.z = -0.10; reg(m6, 'S-6');
  const m7 = box(S, mat, 0.45, 1.55, 0.22, 70.30, 0.765, 29.14);
  m7.rotation.x = 0.18; reg(m7, 'S-7');
})();

/* 青砖筒瓦顶围墙(办公院西北界, 按CAD粗线): L形 办公室(北)东北角->北3.8m->东5.3m,
   门口1.6m留在贴西廊西端一侧 */
(function(){
  box(AG, M.brick, 0.3, 2.5, 3.76, 38.4, 1.25, 15.78);
  box(AG, M.tileDark, 0.5, 0.2, 3.96, 38.4, 2.6, 15.78);
  box(AG, M.brick, 5.25, 2.5, 0.3, 40.88, 1.25, 14.05);
  box(AG, M.tileDark, 5.45, 0.2, 0.5, 40.88, 2.6, 14.05);
})();


metricUV();   /* 墙体uv转米单位, 使砖石纹理密度均匀 */

/* 已核对编号的图像只覆盖指定雕刻面；沿用石体，不把照片包到背面与侧面。 */
/* 照片贴图材质: 场景光照只在 [STONE_PHOTO_MIN_LIGHT, 1] 内调节亮度——阴影里略暗, 直射阳光下不超过照片本身亮度,
   不叠加高光与环境反射, 因此不会过曝发白、也不触发泛光, 照片清晰度不受光照影响。
   以子类实现: 交互层高亮时 clone() 材质仍保留该着色, 高亮自发光照常叠加。 */
const STONE_PHOTO_MIN_LIGHT = 0.6;
class StonePhotoMaterial extends THREE.MeshStandardMaterial {
  onBeforeCompile(shader){
    shader.fragmentShader = shader.fragmentShader.replace('#include <output_fragment>',
      `{
        vec3 lighting = totalDiffuse / max(diffuseColor.rgb, vec3(1e-4));
        float lit = clamp(dot(lighting, vec3(0.2126, 0.7152, 0.0722)), ${STONE_PHOTO_MIN_LIGHT.toFixed(3)}, 1.0);
        outgoingLight = diffuseColor.rgb * lit + totalEmissiveRadiance;
      }
      #include <output_fragment>`);
  }
  customProgramCacheKey(){ return 'stone_photo_clamped_light'; }
}
const stoneSurfaces = [];
const textureReport = { applied: [], missing: [], unsupported: [] };
scene.userData.stoneTextureReport = textureReport;
scene.updateMatrixWorld(true);
const stoneById = new Map();
scene.traverse(o => { if(o.isMesh && o.userData.hps) stoneById.set(o.userData.hps.id,o); });
for(const [textureKey,texture] of Object.entries(stoneTextures)){
  const entry = texture.userData || {}, id = entry.id || textureKey;
  const master = stoneById.get(id);
  if(!master){ textureReport.missing.push(id); continue; }
  const direction = entry.normal;
  if(!Array.isArray(direction) || direction.length!==3 || !direction.every(Number.isFinite)){
    textureReport.unsupported.push({id,reason:'missing confirmed face normal'}); continue;
  }
  const normal = new THREE.Vector3(...direction).normalize();
  if(normal.lengthSq()<0.9){ textureReport.unsupported.push({id,reason:'invalid normal'}); continue; }
  const existingParts = master.userData._parts || [master];
  const originalParts = existingParts.filter(p=>!p.userData.isStoneTexture);
  let parts = [master];
  if(entry.partName) parts = originalParts.filter(p=>p.name===entry.partName);
  else if(id==='C-2' || id==='X-3') parts = [...originalParts];
  else if(originalParts.length>1){
    textureReport.unsupported.push({id,reason:'composite object requires explicit partName'}); continue;
  }
  /* U×V=指定正面法线，背向的展面也不会镜像；竖放照片可通过 up 指定图像上方。 */
  const vAxis = Array.isArray(entry.up) ? new THREE.Vector3(...entry.up)
    : Math.abs(normal.y)>0.9 ? new THREE.Vector3(0,0,-Math.sign(normal.y)) : new THREE.Vector3(0,1,0);
  vAxis.addScaledVector(normal,-vAxis.dot(normal)).normalize();
  if(vAxis.lengthSq()<0.9){ textureReport.unsupported.push({id,reason:'up parallel to normal'}); continue; }
  const uAxis = vAxis.clone().cross(normal).normalize();
  const toMaster = master.matrixWorld.clone().invert();
  const faces=[];
  let uMin=Infinity,uMax=-Infinity,vMin=Infinity,vMax=-Infinity;
  for(const part of parts){
    const input=part.geometry;
    const geo=input.index ? input.toNonIndexed() : input;
    const pos=geo.attributes.position, norms=geo.attributes.normal;
    const position=[],normals=[],projected=[];
    const toCommon=toMaster.clone().multiply(part.matrixWorld);
    if(norms) for(let i=0;i<pos.count;i+=3){
      let front=true;
      for(let j=0;j<3;j++){
        if(new THREE.Vector3().fromBufferAttribute(norms,i+j).dot(normal)<0.995){ front=false; break; }
      }
      if(!front) continue;
      for(let j=0;j<3;j++){
        const vertex=new THREE.Vector3().fromBufferAttribute(pos,i+j);
        const common=vertex.clone().applyMatrix4(toCommon);
        const u=common.dot(uAxis),v=common.dot(vAxis);
        uMin=Math.min(uMin,u);uMax=Math.max(uMax,u);vMin=Math.min(vMin,v);vMax=Math.max(vMax,v);
        projected.push(u,v);
        vertex.addScaledVector(normal,0.0015);
        position.push(vertex.x,vertex.y,vertex.z); normals.push(normal.x,normal.y,normal.z);
      }
    }
    if(geo!==input) geo.dispose();
    if(position.length) faces.push({part,position,normals,projected,toCommon});
  }
  if(!faces.length || uMax-uMin<1e-6 || vMax-vMin<1e-6){
    textureReport.unsupported.push({id,reason:'no matching planar triangles'}); continue;
  }
  const material = new StonePhotoMaterial({
    color:0xffffff,map:texture,roughness:1,metalness:0,
    polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1,
    side:THREE.FrontSide,
  });
  material.name='stone_image_'+id;
  let fitU=1,fitV=1;
  if(entry.fit==='contain' && entry.crop && entry.crop[2]>0 && entry.crop[3]>0){
    const imageAspect=entry.crop[2]/entry.crop[3],faceAspect=(uMax-uMin)/(vMax-vMin);
    if(imageAspect>faceAspect) fitV=faceAspect/imageAspect;
    else fitU=imageAspect/faceAspect;
  }
  const overlays=[];
  for(const face of faces){
    const uv=[];
    for(let i=0;i<face.projected.length;i+=2) uv.push(
      (face.projected[i]-uMin)/(uMax-uMin),(face.projected[i+1]-vMin)/(vMax-vMin));
    const position=[...face.position];
    if(fitU!==1 || fitV!==1){
      const toLocal=face.toCommon.clone().invert();
      for(let i=0;i<position.length;i+=3){
        const k=i/3*2;
        const vertex=new THREE.Vector3(position[i],position[i+1],position[i+2]).applyMatrix4(face.toCommon);
        vertex.addScaledVector(uAxis,(face.projected[k]-(uMin+uMax)/2)*(fitU-1));
        vertex.addScaledVector(vAxis,(face.projected[k+1]-(vMin+vMax)/2)*(fitV-1));
        vertex.applyMatrix4(toLocal); position[i]=vertex.x;position[i+1]=vertex.y;position[i+2]=vertex.z;
      }
    }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.Float32BufferAttribute(position,3));
    geo.setAttribute('normal',new THREE.Float32BufferAttribute(face.normals,3));
    geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
    const surface=new THREE.Mesh(geo,material);
    surface.name='HPS-TEXTURE-'+textureKey+(overlays.length ? '-part'+(overlays.length+1) : '');
    surface.userData.hpsRef=master;
    surface.userData.isStoneTexture=true;
    surface.userData.stoneTexture={id,faceKey:entry.faceKey,faceLabel:entry.faceLabel,sourcePath:entry.sourcePath,sourceKind:entry.sourceKind,
      normal:[...direction],crop:entry.crop,imageSize:entry.imageSize,fit:entry.fit||'face'};
    surface.castShadow=false; surface.receiveShadow=true;
    face.part.add(surface); overlays.push(surface); stoneSurfaces.push({surface,texture});
  }
  /* 同步建立_parts后再由setupInteractions记录_mat0，避免异步载图破坏高亮。 */
  master.userData._parts=[...existingParts,...overlays];
  if(entry.primaryFace || !master.userData.stoneTextureNormal) {
    master.userData.stoneTextureNormal=[...(entry.focusNormal||direction)];
    master.userData.stoneTextureUp=vAxis.toArray();
    master.userData.stoneTextureFocusLift=entry.focusLift;
  }
  textureReport.applied.push(textureKey);
}
function refreshStoneTextures(){
  for(const {surface,texture} of stoneSurfaces){
    surface.visible=!surface.userData.superseded && texture.userData.loadState!=='error' && texture.userData.loadState!=='loading'
      && Boolean(texture.image && (texture.image.width || texture.image.naturalWidth));
  }
}
refreshStoneTextures();

/* COURTYARD_GEOREFERENCE_BEGIN */
scene.userData.georeference = {"version":1,"status":"provisional","sourceType":"RTK","datum":{"horizontal":"待确认","vertical":"待确认","calculationEllipsoid":"WGS84"},"origin":{"latitudeDeg":35.28316176587301,"longitudeDeg":116.34273306746033,"heightM":29.388},"transform":{"type":"rigid-horizontal","matrix2x3":[[0.9993822675790076,-0.035143751203327134,-24.12366326274792],[-0.03514375120332709,-0.9993822675790076,-3.9278116172221487]],"rotationDeg":-2.01400334234293,"scale":1,"geometryFrame":"original-local-metres","coordinateFrame":"ENU relative to origin","appliesTo":"complete-scene-world-coordinates","geometryModified":false},"vertical":{"controlHeightM":29.388,"mode":"recorded-control-height-only","modelZeroHeightConfirmed":false},"quality":{"rmsM":4.615538633200767,"maxM":6.788177336818166,"isSurveyAccuracy":false},"surveyAreaM2":9492.29549220151,"modelAreaM2":8875.270151498884,"boundaryWorldXZ":[[30.051905300000016,36.5036997],[-8.322954399999986,38.84423380000001],[-16.79413219999999,38.61795860000001],[-40.82172999999999,14.505507600000001],[-43.636027799999994,11.903342800000004],[-58.570190999999994,-3.313664399999997],[-60.01976649999999,-4.7349554999999945],[-59.454078499999994,-18.792302299999996],[-48.49387349999999,-29.9363559],[-42.48343849999999,-35.2679653],[-38.78525319999999,-38.9802928],[-38.41048489999999,-39.5389097],[-35.893173299999994,-42.0562213],[-32.44247649999999,-45.5069181],[-30.97168769999999,-46.878711499999994],[64.7568641,-34.71641949999999],[68.3843384,-31.4000736],[70.43495740000002,-28.755482199999996],[70.98650320000002,-22.957180199999993],[71.02892980000001,-17.625570799999995],[71.26227610000001,6.592946699999999],[71.34005820000002,10.82853560000001],[59.418183600000006,34.92684440000001]],"controls":[{"id":10,"name":"院落-北院墙最西端","latitudeDms":"35°17′0.9497″","longitudeDms":"116°20′31.6739″","heightM":29.388,"latitudeDeg":35.28359713888889,"longitudeDeg":116.34213163888889,"modelVertexIndex":14,"correspondenceStatus":"inferred","modelWorldXZ":[-30.97168769999999,-46.878711499999994],"enu":[-54.71346371357118,48.30318493978924],"fittedEnu":[-53.42872497343422,44.0104026697059],"residualM":4.480907636712746},{"id":11,"name":"院落-北院墙最北端","latitudeDms":"35°16′59.8540″","longitudeDms":"116°20′30.3559″","heightM":29.388,"latitudeDeg":35.283292777777774,"longitudeDeg":116.34176552777777,"modelVertexIndex":7,"correspondenceStatus":"inferred","modelWorldXZ":[-59.454078499999994,-18.792302299999996],"enu":[-88.01983796524101,14.535713145697537],"fittedEnu":[-82.88058305432934,16.94232141120913],"residualM":5.674830780116573},{"id":12,"name":"院落-北院墙最东端","latitudeDms":"35°16′57.9150″","longitudeDms":"116°20′32.4898″","heightM":29.388,"latitudeDeg":35.28275416666666,"longitudeDeg":116.34235827777778,"modelVertexIndex":1,"correspondenceStatus":"inferred","modelWorldXZ":[-8.322954399999986,38.84423380000001],"enu":[-34.0959096347553,-45.22155049017371],"fittedEnu":[-33.80660839232766,-42.45555023592505],"residualM":2.7810883868323613},{"id":13,"name":"院落-南院墙东南端","latitudeDms":"35°16′58.0411″","longitudeDms":"116°20′35.1211″","heightM":29.388,"latitudeDeg":35.28278919444444,"longitudeDeg":116.34308919444445,"modelVertexIndex":22,"correspondenceStatus":"inferred","modelWorldXZ":[59.418183600000006,34.92684440000001],"enu":[32.39808566040877,-41.33535528945119],"fittedEnu":[34.03035546893497,-40.92125843446533],"residualM":1.6839777115910268},{"id":14,"name":"院落-南院墙最东端","latitudeDms":"35°16′58.7673″","longitudeDms":"116°20′35.6772″","heightM":29.388,"latitudeDeg":35.28299091666666,"longitudeDeg":116.34324366666667,"modelVertexIndex":21,"correspondenceStatus":"inferred","modelWorldXZ":[71.34005820000002,10.82853560000001],"enu":[46.45083505558204,-18.95496438061083],"fittedEnu":[46.7917705093637,-17.256815335921843],"residualM":1.7320355543762438},{"id":15,"name":"院落-南院墙最南端","latitudeDms":"35°16′59.6609″","longitudeDms":"116°20′35.9660″","heightM":29.388,"latitudeDeg":35.28323913888889,"longitudeDeg":116.34332388888889,"modelVertexIndex":19,"correspondenceStatus":"inferred","modelWorldXZ":[71.02892980000001,-17.625570799999995],"enu":[53.748741931233965,8.584408553294955],"fittedEnu":[47.48081833949807,11.190648259126403],"residualM":6.788177336818166},{"id":16,"name":"院落-西院墙最南端","latitudeDms":"35°17′0.4885″","longitudeDms":"116°20′35.5894″","heightM":29.388,"latitudeDeg":35.28346902777778,"longitudeDeg":116.34321927777778,"modelVertexIndex":15,"correspondenceStatus":"inferred","modelWorldXZ":[64.7568641,-34.71641949999999],"enu":[44.23184019644229,34.08967515945706],"fittedEnu":[41.81326363239404,28.49136330427386],"residualM":6.09841030302555}],"alternativeScaleFit":{"scale":1.0506415227465153,"rmsM":3.476789454072614,"applied":false},"notes":["点号与原始名称按用户表保留；名称中的方位不用于判定地理北向。","院墙对应点按轮廓顺序推定，尚未逐角现场确认。","29.388米为输入高程记录；模型零平面和高程基准未确认，未据此改变地形或文物高度。","RMS表示现模型与控制点的匹配偏差，不代表RTK测量精度。"],"provenance":{"controlFile":"data\\georeferencing\\courtyard-control-points.json","correspondenceFile":"data\\georeferencing\\courtyard-correspondence.json","controlSha256":"32ebbd70258149aad4fdd9ed4a8e520765877b84e948b5b4533cb59593134e45","sceneWithoutRegistrationSha256":"6f7decad935bbe708a89d0f7c5d1b73b3545235824687776bdbf2588a9a58923","methodReference":"https://proj.org/en/stable/operations/conversions/topocentric.html"}};
/* COURTYARD_GEOREFERENCE_END */

/* 墙体与门窗按材质归类, 供"墙体透明"模式切换(石体、柱、台基、屋顶、陈列设施不在其中) */
const WALL_MATERIALS = new Set([M.brick, M.brickDark, M.rubble, M.stoneWall, M.wallWhite, M.baseStone, M.wallCap]);
const OPENING_MATERIALS = new Set([M.winRed, M.winDk, M.doorRed, M.winGlass, M.lattice, M.latticeDk, M.door]);
const WALLS = [], OPENINGS = [];
scene.traverse(o=>{
  if(!o.isMesh) return;
  if(WALL_MATERIALS.has(o.material)) WALLS.push(o);
  else if(OPENING_MATERIALS.has(o.material)) OPENINGS.push(o);
});
return { ROOFS, WALLS, OPENINGS, sun, refreshStoneTextures };
}
