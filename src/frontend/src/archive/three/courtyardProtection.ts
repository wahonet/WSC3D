import * as THREE from 'three-inventory';

/** The archive and the later north corridor are independent of the architecture layer. */
export function inspectCourtyard(scene: THREE.Scene) {
  scene.updateMatrixWorld(true);
  const north = scene.getObjectByName('HPS_BL')?.parent;
  if (!north) throw new Error('北长廊保护范围缺失，停止更新建筑');
  const courtyard = scene.getObjectByName('wushici_courtyard')!;
  const objectIds = new Map<string, THREE.Object3D>();
  let objectIndex = 0;
  scene.traverse(o => objectIds.set(`o${String(++objectIndex).padStart(5, '0')}`, o));
  const protectedMeshes = new Set<THREE.Mesh>();
  const replacement = new Map<THREE.Mesh, string>();
  const hasAncestor = (object: THREE.Object3D, target: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = object; p; p = p.parent) if (p === target) return true;
    return false;
  };
  const stones: THREE.Object3D[] = [];
  scene.traverse(o => {
    if (o.userData.hps && o.userData.hps.id !== 'QS-B0') stones.push(o);
    if (o instanceof THREE.Mesh && (hasAncestor(o, north) || o.userData.hps || o.userData.hpsRef || o.userData.showcase)) protectedMeshes.add(o);
  });
  if (stones.length !== 150) throw new Error(`文物保护校验失败：${stones.length}/150`);
  for (const stone of stones) {
    stone.traverse(o => { if (o instanceof THREE.Mesh) protectedMeshes.add(o); });
    for (const part of stone.userData._parts || []) if (part instanceof THREE.Mesh) protectedMeshes.add(part);
  }
  const zone = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) {
      if (p.name === 'front_que_hall') return 'front';
      if (p.name === 'rear_exhibition_hall') return 'rear';
      if (p.parent === courtyard && p.type === 'Group') {
        if (Math.abs(p.position.x - 58.62) < .01 && Math.abs(p.position.z - 14.88) < .01) return 'west';
        if (Math.abs(p.position.x - 1.49) < .01 && Math.abs(p.position.z) < .01) return 'gate';
        if (Math.abs(p.position.x - 3.06) < .01 && Math.abs(p.position.z + 6.81) < .01) return 'ticket';
      }
      if (p.parent === scene && p.type === 'Group' && Math.abs(p.rotation.y + Math.PI / 4) < .001 && p !== courtyard) return 'management';
    }
    // The ticket room was built as separate meshes, all within this small footprint.
    const local = courtyard.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
    if (local.x > 1 && local.x < 5 && local.z > -10 && local.z < -4) return 'ticket';
    return 'site';
  };
  const northBoundary = new THREE.Vector3(49.635, 0, -50.085);
  scene.traverse(o => {
    if (!(o instanceof THREE.Mesh) || protectedMeshes.has(o)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some(m => m.type === 'ShaderMaterial' || ['railWood', 'caseBase', 'glass'].includes(m.name))) return;
    if (hasAncestor(o, scene.getObjectByName('cypress_reference_landscape') || north)) {
      replacement.set(o, 'landscape'); return;
    }
    // Preserve the boundary supporting the later north corridor as well.
    const local = courtyard.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
    if (mats.some(m => ['rubble', 'wallCap'].includes(m.name)) && Math.hypot(local.x-northBoundary.x, local.z-northBoundary.z)<.1) {
      protectedMeshes.add(o); return;
    }
    // Hidden, retired archive placeholders are not architecture and stay hidden.
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return;
    replacement.set(o, zone(o));
  });
  return { north, stones, protectedMeshes, replacement, objectIds };
}
