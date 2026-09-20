import * as THREE from 'three-inventory';
import { GLTFLoader } from 'three-inventory/examples/jsm/loaders/GLTFLoader';
import { createCenterLayer, disposeTree, type CenterStatus } from './hanwenhuaCenter';
import type { PrepareModel } from './assetScheduling';
import manifest from './siteContextManifest.json';

export type ContextStatus = CenterStatus;

/** One optional area: existing surroundings and the planned centre appear together.
 * The courtyard is neither reparented nor transformed by this layer. */
export function createSiteContextLayer(
  scene: THREE.Scene, onStatus: (status: ContextStatus) => void,
  prepareModel: PrepareModel = async () => {},
) {
  const group = new THREE.Group();
  group.name = 'site_context_and_center';
  group.visible = false;
  group.userData.siteContext = { version: manifest.version, status: 'idle' };
  scene.add(group);
  const center = createCenterLayer(group, './models/hanwenhua-center.glb', undefined, prepareModel);
  center.setVisible(true);
  let environment: THREE.Object3D | null = null;
  let status: ContextStatus = 'idle';
  let requested = false;
  let disposed = false;
  let promise: Promise<boolean> | null = null;
  function setStatus(value: ContextStatus) {
    status = value;
    group.userData.siteContext.status = value;
    onStatus(value);
  }
  async function loadEnvironment() {
    if (environment) return true;
    const gltf = await new GLTFLoader().loadAsync('./' + manifest.asset + '?v=' + manifest.version);
    const root = gltf.scene;
    if (disposed) { disposeTree(root); return false; }
    root.name = 'surrounding_environment';
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.userData.siteContext = true;
      object.raycast = () => {}; // Off-site scenery does not obstruct archive picking.
      object.castShadow = object.userData.context_role !== 'ground';
      object.receiveShadow = true;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        const m = material as THREE.MeshStandardMaterial;
        m.envMapIntensity = .35;
        if (m.map) m.map.anisotropy = 4;
      }
    });
    try { await prepareModel(root); }
    catch (error) { disposeTree(root); throw error; }
    if (disposed) { disposeTree(root); return false; }
    environment = root;
    group.add(root);
    return true;
  }
  function load(): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (status === 'ready') return Promise.resolve(true);
    if (promise) return promise;
    setStatus('loading');
    // allSettled waits for both attempts before enabling a retry, avoiding duplicate
    // environment imports when the other model fails sooner.
    promise = Promise.allSettled([center.load(), loadEnvironment()]).then(results => {
      if (disposed) return false;
      const ok = results.every(r => r.status === 'fulfilled' && r.value);
      if (!ok) {
        console.error('周边环境或传承中心加载失败', results.filter(r => r.status === 'rejected'));
        setStatus('error');
        return false;
      }
      group.visible = requested;
      setStatus('ready');
      return true;
    }).finally(() => { promise = null; });
    return promise;
  }
  return {
    group,
    get status() { return status; },
    load,
    setVisible(on: boolean) {
      requested = on;
      group.visible = on && status === 'ready' && !disposed;
    },
    dispose() {
      disposed = true;
      group.visible = false;
      group.removeFromParent();
      center.dispose();
      if (environment) disposeTree(environment);
    },
  };
}
