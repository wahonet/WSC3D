import * as THREE from 'three-inventory';
import defaults from './rearLayoutDefault.json';

export type RearPlacement = typeof defaults.stones[number];
export const rearDefaults = defaults;

export function applyRearLayout(scene: THREE.Scene, rows: RearPlacement[]) {
  const hall = scene.getObjectByName('HPS_HALL_IN');
  if (!hall) return 0;
  const byNo = new Map(rows.map(row => [row.id, row]));
  let count = 0;
  for (const object of hall.children) {
    const row = byNo.get(object.userData.hps?.catalogue_no);
    if (!row) continue;
    object.position.set(row.x, row.y, row.z);
    object.rotation.set(row.rx, row.ry, row.rz);
    object.userData.rearPlacementApplied = true;
    count++;
  }
  scene.updateMatrixWorld(true);
  return count;
}

export function watchRearLayout(scene: THREE.Scene, changed: () => void) {
  applyRearLayout(scene, defaults.stones);
  let disposed = false, pending = false, last = '';
  const refresh = async () => {
    if (disposed || pending) return;
    pending = true;
    try {
      const response = await fetch('/api/layouts/rear', { cache: 'no-store' });
      if (!response.ok) throw new Error('后展厅布局读取失败');
      const layout = await response.json();
      const signature = JSON.stringify(layout.stones);
      if (!disposed && signature !== last) {
        applyRearLayout(scene, layout.stones); last = signature; changed();
      }
    } catch (error) { if (!disposed) console.warn(error); }
    finally { pending = false; }
  };
  const visible = () => { if (!document.hidden) void refresh(); };
  const message = (event: MessageEvent) => {
    if (event.origin === location.origin && event.data?.type === 'rear-layout-applied') void refresh();
  };
  window.addEventListener('focus', refresh);
  window.addEventListener('message', message);
  document.addEventListener('visibilitychange', visible);
  void refresh();
  return () => {
    disposed = true;
    window.removeEventListener('focus', refresh);
    window.removeEventListener('message', message);
    document.removeEventListener('visibilitychange', visible);
  };
}
