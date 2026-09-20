import * as THREE from 'three-inventory';
import { GLTFLoader } from 'three-inventory/examples/jsm/loaders/GLTFLoader';
import { inspectCourtyard } from './courtyardProtection';
import type { buildSite } from './buildSite';
import manifest from './courtyardArchitectureManifest.json';
import type { PrepareModel } from './assetScheduling';

export type ArchitectureStatus = 'loading' | 'ready' | 'error';

/** Apply a world translation to every piece once; geometry/UV/scale are untouched. */
export function translateStone(stone: THREE.Object3D, values: number[], rotationY = 0) {
  const delta = new THREE.Vector3(...values as [number, number, number]);
  const parts = new Set<THREE.Object3D>([stone, ...(stone.userData._parts || [])]);
  const roots = [...parts].filter(part => {
    for (let p = part.parent; p; p = p.parent) if (parts.has(p)) return false;
    return true;
  });
  const pivot = stone.getWorldPosition(new THREE.Vector3());
  const transform = new THREE.Matrix4().makeTranslation(pivot.x+delta.x,pivot.y+delta.y,pivot.z+delta.z)
    .multiply(new THREE.Matrix4().makeRotationY(rotationY))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x,-pivot.y,-pivot.z));
  for (const part of roots) {
    if (rotationY) {
      const matrix = transform.clone().multiply(part.matrixWorld);
      if (part.parent) matrix.premultiply(part.parent.matrixWorld.clone().invert());
      matrix.decompose(part.position, part.quaternion, part.scale);
      continue;
    }
    const target = part.getWorldPosition(new THREE.Vector3()).add(delta);
    part.position.copy(part.parent ? part.parent.worldToLocal(target) : target);
  }
  stone.updateWorldMatrix(true, true);
}

/** Swap only after the complete Blender asset has loaded successfully. */
export function createCourtyardArchitecture(
  scene: THREE.Scene, site: ReturnType<typeof buildSite>,
  changed: (status: ArchitectureStatus) => void,
  prepare: PrepareModel = async () => {},
  registerDoors: (root: THREE.Object3D) => void = () => {},
) {
  const protection = inspectCourtyard(scene);
  let disposed = false;
  const report = { version: manifest.version, status: 'loading' as ArchitectureStatus, protectedStones: protection.stones.length, relocatedStones: 0 };
  scene.userData.courtyardArchitecture = report;
  const loader = new GLTFLoader();
  function release(root: THREE.Object3D) {
      const textures = new Set<THREE.Texture>();
      root.traverse(o => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.dispose();
        for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
          Object.values(material).forEach(v => { if (v instanceof THREE.Texture) textures.add(v); });
          material.dispose();
        }
      });
      textures.forEach(t => t.dispose());
  }
  const ready = loader.loadAsync('./models/courtyard-architecture-20260910.glb?v='+encodeURIComponent(manifest.asset_revision)).then(async gltf => {
    if (disposed) { release(gltf.scene); return; }
    const roofs: THREE.Object3D[] = [], walls: THREE.Mesh[] = [], openings: THREE.Mesh[] = [];
    let count = 0;
    gltf.scene.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return;
      count++;
      // Ground planes receive the building shadows without casting onto
      // themselves; large, nearly flat planes otherwise produce shadow acne.
      o.castShadow = o.userData.arch_role !== 'floor';
      o.receiveShadow = true;
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of materials) {
        const m = mat as THREE.MeshStandardMaterial;
        m.envMapIntensity = .35;
        if (m.map) m.map.anisotropy = 8;
        if (m.normalMap) m.normalMap.anisotropy = 8;
        if (m.transparent) { m.depthWrite = false; o.castShadow = false; }
      }
      if (o.userData.arch_role === 'roof') roofs.push(o);
      else if (o.userData.arch_role === 'wall') walls.push(o);
      else if (o.userData.arch_role === 'opening') openings.push(o);
    });
    if (!count || !roofs.length || !walls.length) {
      release(gltf.scene);
      report.status = 'error'; changed('error'); return;
    }
    registerDoors(gltf.scene);
    try { await prepare(gltf.scene); }
    catch (error) { release(gltf.scene); throw error; }
    if (disposed) { release(gltf.scene); return; }
    gltf.scene.name = 'courtyard_architecture_20260910';
    gltf.scene.userData.source = manifest.references;
    const retainRoof = (root: THREE.Object3D) => {
      let replaced = false;
      root.traverse(o => { if (protection.replacement.has(o as THREE.Mesh)) replaced = true; });
      return !replaced;
    };
    site.ROOFS.splice(0, site.ROOFS.length, ...site.ROOFS.filter(retainRoof), ...roofs);
    site.WALLS.splice(0, site.WALLS.length, ...site.WALLS.filter(o => !protection.replacement.has(o)), ...walls);
    site.OPENINGS.splice(0, site.OPENINGS.length, ...site.OPENINGS.filter(o => !protection.replacement.has(o)), ...openings);
    for (const object of protection.replacement.keys()) object.visible = false;
    const moves = manifest.stone_movements as Record<string, { world_delta: number[]; rotation_y?: number }>;
    for (const stone of protection.stones) {
      const move = moves[stone.userData.hps.id];
      if (move && !stone.userData.rearPlacementApplied) { translateStone(stone, move.world_delta, move.rotation_y); report.relocatedStones++; }
    }
    for (const [id, delta] of Object.entries(manifest.furnishing_movements)) {
      const object = protection.objectIds.get(id);
      if (object?.userData.showcase) translateStone(object, delta);
    }
    scene.add(gltf.scene);
    scene.updateMatrixWorld(true);
    report.status = 'ready'; changed('ready');
  }).catch(error => {
    if (!disposed) { console.error('院落建筑模型加载失败', error); report.status = 'error'; changed('error'); }
  });
  return { report, ready, dispose() { disposed = true; } };
}
