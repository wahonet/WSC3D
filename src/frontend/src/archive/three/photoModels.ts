import * as THREE from 'three-inventory';
import { GLTFLoader } from 'three-inventory/examples/jsm/loaders/GLTFLoader';
import type { PrepareModel } from './assetScheduling';

/** Load the same self-contained GLB used by the ledger into each registered scene anchor. */
export function createPhotoModels(scene: THREE.Scene, changed: () => void,
  options: { after?: Promise<unknown>; prepare?: PrepareModel } = {}) {
  let disposed = false;
  const report = { pending: [] as string[], loaded: [] as string[], failed: [] as string[] };
  scene.userData.photoModelReport = report;
  const loader = new GLTFLoader();
  function release(root: THREE.Object3D) {
    root.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry.dispose();
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      materials.forEach(material => {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
        material.dispose();
      });
    });
  }
  const anchors: THREE.Mesh[] = [];
  scene.traverse(o => { if (o instanceof THREE.Mesh && o.userData.photoModel) anchors.push(o); });
  for (const anchor of anchors) {
    const { height } = anchor.userData.photoModel;
    // The unified file API resolves catalogue identities (武001, etc.).
    // applyCatalogue already maps the anchor; the historical directory key is
    // retained only for standalone viewers without the unified catalogue.
    const archiveId = anchor.userData.hps?.id || anchor.userData.photoModel.archiveId;
    report.pending.push(archiveId);
    void Promise.resolve(options.after).then(async () => {
      if (disposed) return;
      const gltf = await loader.loadAsync(`/files/${encodeURIComponent(archiveId)}/models/gallery/photo-reconstruction-20260910.glb`);
      try { await options.prepare?.(gltf.scene); }
      catch (error) { release(gltf.scene); throw error; }
      if (disposed) { release(gltf.scene); return; }
      gltf.scene.position.y -= height / 2;
      const parts: THREE.Mesh[] = [];
      gltf.scene.traverse(o => {
        if (!(o instanceof THREE.Mesh)) return;
        o.userData.hpsRef = anchor;
        o.userData._mat0 = o.material;
        o.castShadow = o.receiveShadow = true;
        parts.push(o);
      });
      anchor.add(gltf.scene);
      anchor.userData._parts = parts;
      anchor.userData._glow = -1;
      anchor.userData.photoModel.status = 'ready';
      report.pending = report.pending.filter(id => id !== archiveId);
      report.loaded.push(archiveId);
      changed();
    }).catch(() => {
      if (disposed) return;
      anchor.userData.photoModel.status = 'error';
      report.pending = report.pending.filter(id => id !== archiveId);
      report.failed.push(archiveId);
      changed();
    });
  }
  return { report, dispose: () => { disposed = true; } };
}
