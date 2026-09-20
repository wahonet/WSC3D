import * as THREE from 'three-inventory';

export interface WallXray {
  readonly on: boolean;
  set(on: boolean, transparency?: number): void;
  dispose(): void;
}

/** Edges sharper than this (degrees) are drawn as the wall outline. */
const EDGE_THRESHOLD = 40;

/**
 * 墙体透明查看: 默认50%透明, 门窗随墙透明; 100%时墙面和轮廓线完全消失。透明期间墙体不投影,
 * 拾取按既有规则穿透(材质 transparent 且 opacity < 0.6), 轮廓线不参与拾取。
 * 切换后调用方需刷新阴影贴图与 SSAO 的排除列表。
 */
export function createWallXray(walls: THREE.Mesh[], openings: THREE.Mesh[]): WallXray {
  const ghostByMaterial = new Map<THREE.Material, THREE.Material>();
  const edgesByGeometry = new Map<THREE.BufferGeometry, THREE.EdgesGeometry>();
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x2f3438, transparent: true, opacity: 0.8, depthWrite: false });
  const outlines: THREE.LineSegments[] = [];
  const originals = new Map<THREE.Mesh, { material: THREE.Material | THREE.Material[]; castShadow: boolean }>();

  const ghost = (material: THREE.Material) => {
    let g = ghostByMaterial.get(material);
    if (!g) {
      g = material.clone();
      g.name = material.name + '_xray';
      g.transparent = true;
      g.depthWrite = false;
      // a plain tinted slab: brick/rubble patterns at low opacity only clutter what lies behind
      const std = g as THREE.MeshStandardMaterial;
      if ('map' in std) { std.map = null; std.bumpMap = null; std.roughnessMap = null; }
      ghostByMaterial.set(material, g);
    }
    return g;
  };

  for (const wall of new Set(walls)) {
    originals.set(wall, { material: wall.material, castShadow: wall.castShadow });
    let edges = edgesByGeometry.get(wall.geometry);
    if (!edges) {
      edges = new THREE.EdgesGeometry(wall.geometry, EDGE_THRESHOLD);
      edgesByGeometry.set(wall.geometry, edges);
    }
    const outline = new THREE.LineSegments(edges, edgeMaterial);
    outline.name = 'wall_outline';
    outline.visible = false;
    outline.raycast = () => { /* outline is a display aid only */ };
    outline.userData.wallOutline = true;
    wall.add(outline);
    outlines.push(outline);
  }
  for (const opening of openings) {
    if (!originals.has(opening)) originals.set(opening, { material: opening.material, castShadow: opening.castShadow });
  }

  let on = false;
  let transparency = 50;
  function set(next: boolean, value = transparency) {
    const percent = Number.isFinite(value) ? THREE.MathUtils.clamp(value, 0, 100) : transparency;
    if (next === on && percent === transparency) return;
    on = next;
    transparency = percent;
    const opacity = 1 - percent / 100;
    // Iterate the captured meshes: model loading can replace the caller's wall arrays.
    for (const [mesh, original] of originals) {
      mesh.material = next
        ? (Array.isArray(original.material) ? original.material.map(ghost) : ghost(original.material))
        : original.material;
      mesh.castShadow = next ? false : original.castShadow;
    }
    for (const [original, material] of ghostByMaterial) {
      material.opacity = original.opacity * opacity;
      // Do not change mesh.visible: restoring it could resurrect superseded architecture.
      material.visible = original.visible && opacity > 0;
    }
    edgeMaterial.opacity = .8 * opacity;
    for (const outline of outlines) outline.visible = next && opacity > 0;
  }
  return {
    get on() { return on; },
    set,
    dispose() {
      set(false);
      for (const outline of outlines) outline.removeFromParent();
      edgesByGeometry.forEach(g => g.dispose());
      ghostByMaterial.forEach(m => m.dispose());
      edgeMaterial.dispose();
    },
  };
}
