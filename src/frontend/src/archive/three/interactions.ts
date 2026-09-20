// @ts-nocheck
/* =====================================================================
   三维交互层 —— 画像石拾取/高亮、相机飞行、预设视角、第一人称漫游
   (自旧版单文件HTML交互模块迁移整理)
===================================================================== */
import * as THREE from 'three-inventory';
import type { OrbitControls } from 'three-inventory/examples/jsm/controls/OrbitControls';
import type { ViewKey } from '../types';
import { VIEWPOINTS } from './sceneWaypoints';

export interface InteractionCallbacks {
  onSelect(id: string | null): void;     // 点击石块(或空白=null)
  onWalkChange(on: boolean): void;
  onDoorClick?(id: string): void;
  onDoorHover?(id: string | null): void;
}

export function setupInteractions(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
  controls: OrbitControls,
  ROOFS: THREE.Object3D[],
  cb: InteractionCallbacks,
) {
  /* ---------- 石块收集(含断裂石别名段) ---------- */
  const meshes: THREE.Mesh[] = [];
  scene.traverse(o => {
    if (o.isMesh && o.userData.hps && o.userData.hps.id !== 'QS-B0') meshes.push(o);
  });
  const byId = new Map<string, THREE.Mesh>();
  meshes.forEach(m => {
    byId.set(m.userData.hps.id, m);
    m.userData._glow = 0;
    m.userData._hpsPick = true;
    (m.userData._parts || [m]).forEach(p => { p.userData._mat0 = p.material; });
  });

  /* ---------- 高亮(材质克隆+自发光, 断裂石两段联动) ---------- */
  let hovered: THREE.Mesh | null = null;
  let hoveredDoor: string | null = null;
  let selected: THREE.Mesh | null = null;
  function applyState() {
    meshes.forEach(m => {
      const want = m === selected ? 2 : m === hovered ? 1 : 0;
      if (m.userData._glow === want) return;
      m.userData._glow = want;
      (m.userData._parts || [m]).forEach(p => {
        if (want === 0) {
          if (p.material !== p.userData._mat0) { p.material.dispose(); p.material = p.userData._mat0; }
        } else {
          if (p.material === p.userData._mat0) p.material = p.userData._mat0.clone();
          p.material.emissive.setHex(want === 2 ? 0x3a3216 : 0x1f1c0d);
        }
      });
    });
    renderer.domElement.style.cursor = hovered || hoveredDoor ? 'pointer' : '';
  }

  /* ---------- 拾取: 玻璃可穿透, 不透明物遮挡, 别名段映射主段 ----------
     注: Raycaster不会自动跳过visible=false的对象(如隐藏的屋顶),
     必须显式检查可见链, 否则隐藏屋顶后俯视无法点选室内石刻 */
  function visibleChain(o: THREE.Object3D): boolean {
    let p: THREE.Object3D | null = o;
    while (p) { if (!p.visible) return false; p = p.parent; }
    return true;
  }
  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  function pick(ev: PointerEvent): THREE.Mesh | null {
    const r = renderer.domElement.getBoundingClientRect();
    ptr.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    ptr.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ptr, camera);
    const hits = ray.intersectObjects(scene.children, true);
    for (const h of hits) {
      if (!h.object.isMesh || !visibleChain(h.object)) continue;
      if (h.object.userData.showcase) continue;   /* 展柜等陈列设施可穿透点选 */
      if (h.object.userData.doorId) return h.object;
      const mt = h.object.material;
      if (mt && mt.transparent && mt.opacity < 0.6) continue;
      const t = h.object.userData.hpsRef || h.object;
      return t.userData._hpsPick ? t : null;
    }
    return null;
  }

  /* 调试钩子: 查看某屏幕点的完整射线命中链 */
  (window as any).__pickAt = (cx: number, cy: number) => {
    const r = renderer.domElement.getBoundingClientRect();
    ptr.x = ((cx - r.left) / r.width) * 2 - 1;
    ptr.y = -((cy - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ptr, camera);
    return ray.intersectObjects(scene.children, true).slice(0, 12).map(h => ({
      name: h.object.name || '(noname)',
      d: +h.distance.toFixed(2),
      vis: visibleChain(h.object),
      op: h.object.material ? h.object.material.opacity : 1,
      tr: h.object.material ? !!h.object.material.transparent : false,
      col: h.object.material?.color ? h.object.material.color.getHexString() : '',
      hps: h.object.userData.hps ? h.object.userData.hps.id : (h.object.userData.hpsRef ? 'ref' : ''),
    }));
  };

  let mvEv: PointerEvent | null = null;
  const onMove = (ev: PointerEvent) => {
    if (!mvEv) requestAnimationFrame(() => {
      if (!mvEv) return;
      const hit = pick(mvEv); mvEv = null;
      const door = hit?.userData.doorId || null;
      const m = door ? null : hit;
      if (door !== hoveredDoor) { hoveredDoor = door; cb.onDoorHover?.(door); applyState(); }
      if (m !== hovered) { hovered = m; applyState(); }
    });
    mvEv = ev;
  };
  let dn: [number, number] | null = null;
  const onDown = (ev: PointerEvent) => {
    if (ev.button === 0) dn = [ev.clientX, ev.clientY];
    if (walkOn && ev.button === 0) lookDrag = [ev.clientX, ev.clientY];
  };
  const onUp = (ev: PointerEvent) => {
    lookDrag = null;
    if (!dn || ev.button !== 0) return;
    const moved = Math.hypot(ev.clientX - dn[0], ev.clientY - dn[1]);
    dn = null;
    if (moved < 6) {
      const m = pick(ev);
      if (m?.userData.doorId) { cb.onDoorClick?.(m.userData.doorId); return; }
      setSelected(m ? m.userData.hps.id : null);
      cb.onSelect(m ? m.userData.hps.id : null);
    }
  };
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);
  const onLeave = () => { mvEv = null; hovered = null; hoveredDoor = null; cb.onDoorHover?.(null); applyState(); };
  renderer.domElement.addEventListener('pointerleave', onLeave);

  function setSelected(id: string | null) {
    selected = id ? byId.get(id) || null : null;
    applyState();
  }

  /* ---------- 相机平滑飞行 ---------- */
  let flyReq = 0;
  function flyTo(pos: THREE.Vector3, tgt: THREE.Vector3, dur = 950) {
    if (walkOn) walkExit();
    const p0 = camera.position.clone(), t0 = controls.target.clone();
    const st = performance.now(), req = ++flyReq;
    (function step() {
      if (req !== flyReq) return;
      const k = Math.min(1, (performance.now() - st) / dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      camera.position.lerpVectors(p0, pos, e);
      controls.target.lerpVectors(t0, tgt, e);
      controls.update();
      if (k < 1) requestAnimationFrame(step);
    })();
  }

  /* 判断从eye能否无遮挡看到石块m(玻璃/展柜/隐藏物/该石自身及别名段不算遮挡) */
  const seeRay = new THREE.Raycaster();
  function canSee(eye: THREE.Vector3, wp: THREE.Vector3, m: THREE.Mesh): boolean {
    const dir = wp.clone().sub(eye);
    const dist = dir.length();
    seeRay.set(eye, dir.normalize());
    seeRay.far = dist + 0.5;
    const hits = seeRay.intersectObjects(scene.children, true);
    for (const h of hits) {
      if (!h.object.isMesh || !visibleChain(h.object)) continue;
      if (h.object.userData.showcase) continue;
      const mt = h.object.material;
      if (mt && mt.transparent && mt.opacity < 0.6) continue;
      const t = h.object.userData.hpsRef || h.object;
      if ((window as any).__seeLog) console.log('[canSee]', t === m ? 'OK' : 'BLOCK by ' + (h.object.name || h.object.material?.color?.getHexString()), 'eye', eye.x.toFixed(1), eye.y.toFixed(1), eye.z.toFixed(1));
      return t === m;                       /* 第一个实体命中必须是目标石(或其别名段) */
    }
    return true;                            /* 无遮挡直达 */
  }

  /* 定位飞行: 在候选方位中选第一个能真正看见石块的机位(优先石面法向), 全败则升高俯视 */
  function focus(id: string): boolean {
    const m = byId.get(id);
    if (!m) return false;
    const wp = new THREE.Vector3(); m.getWorldPosition(wp);
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const s = m.geometry.boundingBox.getSize(new THREE.Vector3());
    s.multiply(m.getWorldScale(new THREE.Vector3()));
    const R = Math.max(s.x, s.y, s.z, 0.8);

    const cur = camera.position.clone().sub(wp); cur.y = 0;
    if (cur.lengthSq() < 0.01) cur.set(0, 0, 1);
    cur.normalize();
    const q = new THREE.Quaternion(); m.getWorldQuaternion(q);
    const faceNormal = m.userData.stoneTextureNormal;
    const nrm = (faceNormal ? new THREE.Vector3(...faceNormal) : new THREE.Vector3(0, 0, 1)).applyQuaternion(q);
    // A horizontal offering-table image needs an elevated view from its lower edge.
    if (faceNormal && nrm.y > 0.85) {
      const up = new THREE.Vector3(...(m.userData.stoneTextureUp || [0,0,-1])).applyQuaternion(q);
      up.y = 0; up.normalize();
      for (const factor of [1.8, 1.25, 2.6]) {
        const eye = wp.clone().addScaledVector(nrm, R * factor).addScaledVector(up, -R * factor * 0.65);
        if (canSee(eye, wp, m)) { flyTo(eye, wp.clone()); return true; }
      }
    }
    nrm.y = 0;
    if (nrm.lengthSq() < 0.01) nrm.copy(cur); else nrm.normalize();
    const rot = (v: THREE.Vector3, a: number) =>
      v.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
    // Photographed faces should remain visible when nearby pillars block the usual distance.
    if (faceNormal) {
      for (const factor of [2.6, 1.8, 1.25]) {
        for (const angle of [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3]) {
          const eye = wp.clone().add(rot(nrm, angle).multiplyScalar(R * factor));
          eye.y = wp.y + R * (m.userData.stoneTextureFocusLift ?? 0.25);
          if (canSee(eye, wp, m)) { flyTo(eye, wp.clone()); return true; }
        }
      }
    }
    /* 石面法向(正面机位)优先, 当前相机方向次之 */
    const cands = [
      nrm, nrm.clone().negate(),
      rot(nrm, Math.PI / 4), rot(nrm, -Math.PI / 4),
      rot(nrm.clone().negate(), Math.PI / 4), rot(nrm.clone().negate(), -Math.PI / 4),
      cur, rot(cur, Math.PI / 2), rot(cur, -Math.PI / 2),
    ];
    /* 第一轮: 平视机位; 第二轮: 升高45°俯视(应对高墙环绕) */
    for (const lift of [0, 1]) {
      for (const c of cands) {
        const d = R * 2.6;
        const eye = wp.clone().add(c.clone().multiplyScalar(d));
        eye.y = wp.y + (lift ? d * 0.9 : R * 0.95);
        if (canSee(eye, wp, m)) { flyTo(eye, wp.clone()); return true; }
      }
    }
    /* 兜底: 沿当前方向 */
    const eye = wp.clone().add(cur.multiplyScalar(R * 2.6));
    eye.y = wp.y + R * 0.95;
    flyTo(eye, wp.clone());
    return true;
  }

  /* ---------- 第一人称漫游 ---------- */
  let walkOn = false, yaw = 0, pitch = 0, groundY = 0;
  const keys: Record<string, boolean> = {};
  const wRay = new THREE.Raycaster();
  const DOWN = new THREE.Vector3(0, -1, 0);
  let lookDrag: [number, number] | null = null;

  function solidHit(hits) {
    return hits.find(h => h.object.isMesh && visibleChain(h.object) &&
      !(h.object.material && h.object.material.transparent && h.object.material.opacity < 0.05));
  }
  function groundAt(x: number, z: number): number {
    wRay.set(new THREE.Vector3(x, 4, z), DOWN);
    wRay.far = 200;
    const g = wRay.intersectObjects(scene.children, true).find(h =>
      h.object.isMesh && h.point.y <= 1.3 && visibleChain(h.object) &&
      !(h.object.material && h.object.material.transparent && h.object.material.opacity < 0.05));
    return g ? g.point.y : 0;
  }
  function walkEnter() {
    flyReq++;
    walkOn = true; controls.enabled = false;
    const d = new THREE.Vector3(); camera.getWorldDirection(d);
    yaw = Math.atan2(d.x, d.z);
    pitch = 0;
    const t = controls.target;
    const back = camera.position.clone().sub(t); back.y = 0;
    if (back.lengthSq() < 0.01) back.set(0, 0, 1);
    back.normalize();
    let px = t.x, pz = t.z, gy = groundAt(px, pz);
    for (let s = 0; s < 20 && gy > 0.65; s++) {
      px += back.x * 0.6; pz += back.z * 0.6;
      gy = groundAt(px, pz);
    }
    { const qx = px + back.x * 1.2, qz = pz + back.z * 1.2, q = groundAt(qx, qz);
      if (q <= 0.65) { px = qx; pz = qz; gy = q; } }
    groundY = gy;
    camera.position.set(px, gy + 1.7, pz);
    cb.onWalkChange(true);
  }
  function walkExit() {
    if (!walkOn) return;
    walkOn = false; controls.enabled = true;
    const d = new THREE.Vector3(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw));
    controls.target.copy(camera.position).add(d.multiplyScalar(4));
    controls.update();
    cb.onWalkChange(false);
  }
  const onKeyDown = (ev: KeyboardEvent) => {
    keys[ev.code] = true;
    if (ev.code === 'Escape' && walkOn && !ev.defaultPrevented) walkExit();
  };
  const onKeyUp = (ev: KeyboardEvent) => { keys[ev.code] = false; };
  const onLook = (ev: PointerEvent) => {
    if (!walkOn || !lookDrag) return;
    yaw -= (ev.clientX - lookDrag[0]) * 0.0042;
    pitch -= (ev.clientY - lookDrag[1]) * 0.0032;
    pitch = THREE.MathUtils.clamp(pitch, -1.25, 1.25);
    lookDrag = [ev.clientX, ev.clientY];
  };
  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', onKeyUp);
  addEventListener('pointermove', onLook);
  addEventListener('pointerup', () => { lookDrag = null; });

  function tryMove(v: THREE.Vector3): boolean {
    if (v.lengthSq() === 0) return false;
    wRay.set(new THREE.Vector3(camera.position.x, groundY + 1.15, camera.position.z), v.clone().normalize());
    wRay.far = 0.95;
    if (solidHit(wRay.intersectObjects(scene.children, true))) return false;
    camera.position.x += v.x; camera.position.z += v.z;
    return true;
  }
  /** 每帧漫游更新; 返回true=漫游接管相机(跳过controls.update) */
  function walkTick(dt: number): boolean {
    if (!walkOn) return false;
    const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
    const mv = new THREE.Vector3();
    if (keys.KeyW || keys.ArrowUp) mv.add(f);
    if (keys.KeyS || keys.ArrowDown) mv.sub(f);
    if (keys.KeyD || keys.ArrowRight) mv.add(r);
    if (keys.KeyA || keys.ArrowLeft) mv.sub(r);
    if (mv.lengthSq() > 0) {
      mv.normalize().multiplyScalar((keys.ShiftLeft || keys.ShiftRight ? 6.5 : 3.1) * dt);
      tryMove(mv) || tryMove(new THREE.Vector3(mv.x, 0, 0)) || tryMove(new THREE.Vector3(0, 0, mv.z));
      wRay.set(new THREE.Vector3(camera.position.x, camera.position.y + 0.4, camera.position.z), DOWN);
      wRay.far = 6;
      const g = solidHit(wRay.intersectObjects(scene.children, true));
      if (g && Math.abs(g.point.y - groundY) < 0.9) groundY = g.point.y;
    }
    camera.position.y += (groundY + 1.7 - camera.position.y) * Math.min(1, dt * 9);
    const dir = new THREE.Vector3(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw));
    camera.lookAt(camera.position.x + dir.x, camera.position.y + dir.y, camera.position.z + dir.z);
    return true;
  }

  function dispose() {
    flyReq++;
    renderer.domElement.removeEventListener('pointermove', onMove);
    renderer.domElement.removeEventListener('pointerdown', onDown);
    renderer.domElement.removeEventListener('pointerup', onUp);
    renderer.domElement.removeEventListener('pointerleave', onLeave);
    removeEventListener('keydown', onKeyDown);
    removeEventListener('keyup', onKeyUp);
    removeEventListener('pointermove', onLook);
  }

  return {
    walkTick,
    dispose,
    setSelected,
    focus,
    flyToView: (v: ViewKey) => {
      const vp = VIEWPOINTS[v];
      if (vp) flyTo(new THREE.Vector3(...vp.p), new THREE.Vector3(...vp.t), 1200);
    },
    setRoof: (on: boolean) => ROOFS.forEach(o => { o.visible = on; }),
    setWalk: (on: boolean) => { on ? walkEnter() : walkExit(); },
    hasMesh: (id: string) => byId.has(id),
  };
}
