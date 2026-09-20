import * as THREE from 'three-inventory';

/** A real task boundary (Promise.resolve would keep starving input/paint). */
export function yieldToBrowser(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

export type PrepareModel = (root: THREE.Object3D) => Promise<void>;

/** One upload per browser task, shared by all scene loaders. */
export function createGpuQueue(renderer: THREE.WebGLRenderer) {
  let tail = Promise.resolve();
  let disposed = false;
  const uploaded = new WeakMap<THREE.Texture, number>();
  const compiled = new WeakMap<THREE.Material, Set<string>>();
  const geometries = new WeakSet<THREE.BufferGeometry>();
  let lightingScene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  const target = new THREE.WebGLRenderTarget(2, 2);
  function configure(scene: THREE.Scene, view: THREE.PerspectiveCamera) { lightingScene = scene; camera = view; }
  function upload(texture: THREE.Texture) {
    if (disposed || uploaded.get(texture) === texture.version) return Promise.resolve();
    const work = tail.then(async () => {
      await yieldToBrowser();
      if (disposed || uploaded.get(texture) === texture.version) return;
      renderer.initTexture(texture);
      uploaded.set(texture, texture.version);
    });
    tail = work.catch(() => {});
    return work;
  }
  async function warm(root: THREE.Object3D) {
    if (!lightingScene || !camera || disposed) return;
    const samples: { mesh: THREE.Mesh; material: THREE.Material; key: string }[] = [];
    root.traverseVisible(o => {
      if (!(o instanceof THREE.Mesh)) return;
      const key = o.type + ':' + Object.keys(o.geometry.attributes).sort().join(',');
      for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!material.visible || (compiled.get(material)?.has(key) && geometries.has(o.geometry))) continue;
        if (!samples.some(s => s.material === material && s.mesh.geometry === o.geometry && s.key === key)) samples.push({ mesh: o, material, key });
      }
    });
    const sampleScene = new THREE.Scene();
    sampleScene.fog = lightingScene.fog; sampleScene.environment = lightingScene.environment;
    lightingScene.traverseVisible(o => { if (o instanceof THREE.Light) sampleScene.add(o.clone()); });
    let index = 0;
    while (index < samples.length && !disposed) {
      const work = tail.then(async () => {
        await yieldToBrowser();
        if (disposed) return;
        const started = performance.now();
        do {
          const { mesh, material, key } = samples[index++];
          // Keep the actual instancing attributes so this pass warms the same
          // shader and GPU instance buffer used by the visible tree group.
          const sample = mesh instanceof THREE.InstancedMesh ? mesh.clone() : new THREE.Mesh(mesh.geometry, material);
          sample.material = material;
          if (sample instanceof THREE.InstancedMesh && mesh instanceof THREE.InstancedMesh) {
            sample.instanceMatrix = mesh.instanceMatrix;
            sample.instanceColor = mesh.instanceColor;
            sample.count = Math.min(1, mesh.count);
          }
          sample.receiveShadow = mesh.receiveShadow;
          sample.frustumCulled = false;
          sampleScene.add(sample);
          const previous = renderer.getRenderTarget();
          const shadows = renderer.shadowMap.needsUpdate;
          const range = { ...mesh.geometry.drawRange };
          try {
            // The beauty pass draws into a linear target, so precompile exactly that
            // variant. Short batches keep driver preparation out of one huge draw.
            renderer.setRenderTarget(target);
            renderer.shadowMap.needsUpdate = false;
            mesh.geometry.setDrawRange(range.start, Math.min(3, range.count));
            // A tiny offscreen draw also uploads vertex/index buffers. Compiling alone
            // leaves all geometry uploads queued for the first visible frame.
            renderer.render(sampleScene, camera!);
            geometries.add(mesh.geometry);
            if (!compiled.has(material)) compiled.set(material, new Set());
            compiled.get(material)!.add(key);
          } finally {
            mesh.geometry.setDrawRange(range.start, range.count);
            renderer.shadowMap.needsUpdate = shadows;
            sampleScene.remove(sample); renderer.setRenderTarget(previous);
          }
        } while (index < samples.length && !disposed && performance.now() - started < 8);
      });
      tail = work.catch(() => {});
      await work;
    }
  }
  const prepare: PrepareModel = async root => {
    const textures = new Set<THREE.Texture>();
    root.traverseVisible(o => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
        Object.values(material).forEach(v => { if (v instanceof THREE.Texture && v.image) textures.add(v); });
      }
    });
    for (const texture of textures) await upload(texture);
    await warm(root);
    await yieldToBrowser();
  };
  return { upload, prepare, warm, configure, dispose() { disposed = true; target.dispose(); } };
}
