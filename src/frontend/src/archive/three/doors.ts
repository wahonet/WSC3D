import * as THREE from 'three-inventory';

export interface DoorInfo {
  id: string; label: string; open: boolean;
}
interface DoorMetadata {
  id: string; label: string; open_angle: number; center: number[]; width: number; height: number; yaw: number;
}

/** Asset nodes are already closed, with origins at their real hinges. */
export function createDoors(changed: (doors: DoorInfo[]) => void) {
  const portals = new Map<string, { info: DoorInfo; leaves: THREE.Object3D[]; progress: number }>();
  const hitAreas: THREE.Mesh[] = [];
  const report = () => [...portals.values()].map(p => ({ ...p.info }));
  function register(root: THREE.Object3D) {
    const leaves: THREE.Object3D[] = [];
    root.traverse(node => { if (node.userData.door) leaves.push(node); });
    for (const leaf of leaves) {
      if (leaf.userData.doorRegistered) continue;
      leaf.userData.doorRegistered = true;
      const meta = leaf.userData.door as DoorMetadata;
      const portal = portals.get(meta.id) || { info: { id: meta.id, label: meta.label, open: false }, leaves: [], progress: 0 };
      portals.set(meta.id, portal); portal.leaves.push(leaf);
      leaf.rotation.y = 0;
      leaf.userData.doorId = meta.id;
      // Invisible hit surface covers spaces between iron bars; it also blocks walking.
      const hit = new THREE.Mesh(new THREE.PlaneGeometry(meta.width + .14, meta.height),
        new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, visible: false, depthWrite: false, colorWrite: false }));
      hit.position.fromArray(meta.center); hit.rotation.y = meta.yaw;
      hit.name = `${meta.label}_点击面`; hit.userData.doorId = meta.id;
      hit.userData.doorHitArea = true;
      leaf.add(hit); hitAreas.push(hit);
    }
    changed(report());
  }
  function toggle(id: string) {
    const door = portals.get(id);
    if (!door) return false;
    door.info.open = !door.info.open;
    changed(report());
    return true;
  }
  function tick(dt: number) {
    let moved = false;
    for (const p of portals.values()) {
      const target = p.info.open ? 1 : 0;
      if (target === p.progress) continue;
      p.progress = target > p.progress ? Math.min(target, p.progress + dt / .55) : Math.max(target, p.progress - dt / .55);
      const smooth = p.progress * p.progress * (3 - 2 * p.progress);
      for (const leaf of p.leaves) {
        leaf.rotation.y = smooth * (leaf.userData.door as DoorMetadata).open_angle;
        leaf.updateWorldMatrix(true, true);
      }
      moved = true;
    }
    return moved;
  }
  return { register, toggle, tick, report,
    screenPositions(camera: THREE.Camera, rect: DOMRect) {
      return [...portals.values()].map(p => ({ ...p.info, leaves: p.leaves.map(leaf => {
        const point = leaf.localToWorld(new THREE.Vector3().fromArray(leaf.userData.door.center)).project(camera);
        return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
      }) }));
    },
    get(id: string) { return portals.get(id)?.info; },
    closeAll() { portals.forEach(p => { p.info.open = false; }); changed(report()); },
    dispose() { hitAreas.forEach(m => { m.removeFromParent(); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }); portals.clear(); },
  };
}
