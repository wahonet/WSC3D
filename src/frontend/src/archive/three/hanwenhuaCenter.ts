import * as THREE from 'three-inventory';
import { GLTFLoader } from 'three-inventory/examples/jsm/loaders/GLTFLoader';
import placement from './hanwenhuaCenterPlacement.json';
import type { PrepareModel } from './assetScheduling';

/**
 * 汉文化保护传承中心叠加图层。模型保持自身米制几何，整体按
 * resources/georeferencing/hanwenhua-center-placement.json
 * 的刚性变换放入院落场景；仅作显示，不参与石刻拾取、漫游碰撞与阴影。
 */
export type CenterStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface CenterLayer {
  readonly group: THREE.Group;
  readonly status: CenterStatus;
  /** 首次调用时下载并挂载 GLB；重复调用返回同一 Promise。 */
  load(): Promise<boolean>;
  setVisible(on: boolean): void;
  dispose(): void;
}

export const CENTER_PLACEMENT = placement;
/** Invisible quads that cut the scene backdrop over below-grade openings (build_center_blender.py). */
const OPENING_MASK = '遮罩_下沉开口';
/** The courtyard shows the closed building. Storey views and zone colours belong to the
 * centre project module (center/centerModel.ts): the basement mask and the coloured zone
 * floors stay hidden here. */
const HIDDEN_ROLES = new Set(['b1_mask', 'zone']);

export function disposeTree(root: THREE.Object3D) {
  const textures = new Set<THREE.Texture>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh instanceof THREE.InstancedMesh) mesh.dispose();
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      Object.values(material).forEach(value => { if (value instanceof THREE.Texture) textures.add(value); });
      material.dispose();
    }
  });
  textures.forEach(texture => texture.dispose());
}

export function createCenterLayer(
  scene: THREE.Object3D, url: string, onStatus?: (status: CenterStatus) => void,
  prepareModel: PrepareModel = async () => {},
): CenterLayer {
  const group = new THREE.Group();
  group.name = placement.layer.name;
  group.userData.hanwenhuaCenter = { status: placement.status, source: placement.source.model };
  const t = placement.transform;
  group.position.set(t.translation[0], t.translation[1], t.translation[2]);
  group.rotation.y = THREE.MathUtils.degToRad(t.rotationYDeg);
  group.visible = false;
  scene.add(group);

  let status: CenterStatus = 'idle';
  let promise: Promise<boolean> | null = null;
  let disposed = false;
  const setStatus = (next: CenterStatus) => { status = next; onStatus?.(next); };

  function prepare(root: THREE.Object3D) {
    const cameras: THREE.Object3D[] = [];
    root.traverse(object => {
      if ((object as THREE.Camera).isCamera) cameras.push(object);
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      // The courtyard's shadow frustum (±108 m) does not reach the centre; skipping shadow
      // passes and raycasts keeps the overlay out of picking and walking.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.raycast = () => {};
      mesh.userData.hanwenhuaCenter = true;
      if (HIDDEN_ROLES.has(mesh.userData.center_role)) { mesh.visible = false; return; }
      const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshPhysicalMaterial[];
      if (materials.some(material => material.name === OPENING_MASK)) {
        // Drawn first and colourless, they mark the stencil so the scene backdrop
        // (sceneTheme.ts) leaves the below-grade geometry visible.
        for (const material of materials) {
          Object.assign(material, { colorWrite: false, depthWrite: false, stencilWrite: true, stencilRef: 1,
            stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp, side: THREE.DoubleSide });
        }
        mesh.renderOrder = -1;
        return;
      }
      for (const material of materials) {
        material.side = THREE.DoubleSide;
        // r147 transmission needs an extra scene pass; the delivered web viewer uses plain alpha glass too.
        if ((material.transmission ?? 0) > 0.1) {
          material.transmission = 0;
          material.transparent = true;
          material.opacity = /低铁|超白/.test(material.name) ? 0.08 : 0.22;
          material.depthWrite = false;
        }
        if (material.metalness > 0.8) material.metalness = 0.65;
        material.needsUpdate = true;
      }
    });
    // Exhibit-room cameras from the delivery viewer are irrelevant inside the courtyard scene.
    cameras.forEach(camera => camera.removeFromParent());
  }

  function load() {
    if (promise) return promise;
    setStatus('loading');
    promise = new GLTFLoader().loadAsync(url).then(async gltf => {
      if (disposed) { disposeTree(gltf.scene); return false; }
      prepare(gltf.scene);
      try { await prepareModel(gltf.scene); }
      catch (error) { disposeTree(gltf.scene); throw error; }
      if (disposed) { disposeTree(gltf.scene); return false; }
      gltf.scene.name = 'hanwenhua_center_glb';
      group.add(gltf.scene);
      setStatus('ready');
      return true;
    }).catch(error => {
      if (disposed) return false;
      console.error('汉文化保护传承中心模型加载失败', error);
      promise = null;
      setStatus('error');
      return false;
    });
    return promise;
  }

  return {
    group,
    get status() { return status; },
    load,
    setVisible(on) { group.visible = on; },
    dispose() {
      disposed = true;
      group.removeFromParent();
      disposeTree(group);
    },
  };
}
