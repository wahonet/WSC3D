import * as THREE from 'three-inventory';
import { EffectComposer } from 'three-inventory/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three-inventory/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three-inventory/examples/jsm/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three-inventory/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three-inventory/examples/jsm/postprocessing/ShaderPass.js';
import { GammaCorrectionShader } from 'three-inventory/examples/jsm/shaders/GammaCorrectionShader.js';
import { FXAAShader } from 'three-inventory/examples/jsm/shaders/FXAAShader.js';
import { createCoordinateOverlay } from './coordinateOverlay';
import { createNorthCompass } from './northCompass';
import { loadMetric } from './loadDiagnostics';
export { worldToGeographic, geographicToWorldXZ } from './georeference';

export interface RenderLook {
  render(): void;
  setSize(width: number, height: number): void;
  /** Re-scan the scene after objects are added or removed (e.g. an overlay layer loads). */
  refresh(): void;
  dispose(): void;
}

/** A neutral, local sky reflection: no network HDR asset or changes to stone imagery. */
function makeEnvironment(renderer: THREE.WebGLRenderer, sun: THREE.Vector3) {
  const environment = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    toneMapped: false,
    uniforms: { sunDirection: { value: sun.clone().normalize() } },
    vertexShader: `varying vec3 direction;
      void main() { direction = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 direction; uniform vec3 sunDirection;
      void main() {
        vec3 d = normalize(direction);
        vec3 sky = mix(vec3(.62, .67, .70), vec3(.22, .35, .52), pow(max(d.y, 0.0), .55));
        sky = mix(vec3(.14, .16, .12), sky, smoothstep(-.2, .08, d.y));
        float alignment = max(dot(d, sunDirection), 0.0);
        sky += vec3(1.0, .82, .57) * (pow(alignment, 32.0) * .35 + pow(alignment, 512.0) * 2.0);
        gl_FragColor = vec4(sky, 1.0);
      }`,
  });
  const geometry = new THREE.SphereGeometry(30, 32, 16);
  environment.add(new THREE.Mesh(geometry, material));
  const generator = new THREE.PMREMGenerator(renderer);
  const target = generator.fromScene(environment, 0, 0.1, 100);
  target.texture.name = 'wushici_afternoon_sky_reflection';
  generator.dispose();
  material.dispose();
  geometry.dispose();
  return target;
}

/** Keep beauty sharp; only contact-shadow buffers use half resolution. */
class CourtyardSSAO extends SSAOPass {
  private excluded: THREE.Object3D[] = [];

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    super(scene, camera, 2, 2);
    this.normalMaterial.side = THREE.DoubleSide;
    this.rescan(scene);
    // In r147 distances are normalized by the camera's clipping range, radius is in metres.
    this.kernelRadius = 1.1;
    this.minDistance = 0.018 / (camera.far - camera.near);
    this.maxDistance = 1.5 / (camera.far - camera.near);
    this.kernelSize = 16;
    this.kernel.length = 0;
    for (let i = 0; i < this.kernelSize; i++) {
      const z = (i + 0.5) / this.kernelSize;
      const r = Math.sqrt(1 - z * z), angle = i * 2.39996323;
      this.kernel.push(new THREE.Vector3(r * Math.cos(angle), r * Math.sin(angle), z)
        .multiplyScalar(0.1 + 0.9 * ((i + 1) / this.kernelSize) ** 2));
    }
    this.ssaoMaterial.defines.KERNEL_SIZE = this.kernelSize;
    this.ssaoMaterial.uniforms.kernel.value = this.kernel;
    // Gentle contact shade rather than black halos along silhouettes.
    this.ssaoMaterial.fragmentShader = this.ssaoMaterial.fragmentShader.replace(
      'vec3( 1.0 - occlusion )', 'vec3( 1.0 - occlusion * 0.65 )');
  }

  /** Glass and photo faces must stay out of the normal/depth pass; overlays added later too. */
  rescan(scene: THREE.Scene) {
    const excluded: THREE.Object3D[] = [];
    scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (object.userData.isStoneTexture || object.name === 'sky' ||
          materials.every(material => material.transparent || !material.depthWrite)) {
        excluded.push(object);
      }
    });
    this.excluded = excluded;
  }

  override setSize(width: number, height: number) {
    super.setSize(width, height);
    const w = Math.max(1, Math.round(width * 0.5));
    const h = Math.max(1, Math.round(height * 0.5));
    this.normalRenderTarget.setSize(w, h);
    this.ssaoRenderTarget.setSize(w, h);
    this.blurRenderTarget.setSize(w, h);
    this.ssaoMaterial.uniforms.resolution.value.set(w, h);
    this.blurMaterial.uniforms.resolution.value.set(w, h);
  }

  override renderOverride(
    renderer: THREE.WebGLRenderer, material: THREE.Material, target: THREE.WebGLRenderTarget,
    clearColor?: THREE.ColorRepresentation, clearAlpha?: number,
  ) {
    // Glass must not become an opaque box in the normal/depth pass. The stone beneath
    // each photographic face still contributes depth, while the photo stays in beauty.
    const visible = this.excluded.map(object => object.visible);
    this.excluded.forEach(object => { object.visible = false; });
    try {
      super.renderOverride(renderer, material, target, clearColor, clearAlpha);
    } finally {
      this.excluded.forEach((object, index) => { object.visible = visible[index]; });
    }
  }
}

/** Shared by the React workbench and the self-contained HTML viewer (Three r147). */
export function createRenderLook(
  renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera,
): RenderLook {
  renderer.setPixelRatio(Math.min(renderer.getPixelRatio(), 1.5));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.93;

  const previousEnvironment = scene.environment;
  let sun: THREE.DirectionalLight | undefined;
  scene.traverse(object => {
    if (object instanceof THREE.DirectionalLight && object.castShadow) sun = object;
  });
  const environment = makeEnvironment(renderer, sun?.position ?? new THREE.Vector3(-82, 96, -58));
  scene.environment = environment.texture;

  const composer = new EffectComposer(renderer);
  const beauty = new RenderPass(scene, camera);
  const ao = renderer.capabilities.isWebGL2 ? new CourtyardSSAO(scene, camera) : null;
  const bloom = new UnrealBloomPass(new THREE.Vector2(2, 2), 0.075, 0.2, 0.88);
  const gamma = new ShaderPass(GammaCorrectionShader);
  const aa = new ShaderPass(FXAAShader);
  // r147 applies ACES in the beauty materials even offscreen. Render targets are linear;
  // encode once here. Applying an additional tone-mapping pass would wash out the scene.
  gamma.material.toneMapped = false;
  aa.material.toneMapped = false;
  // The stock shader's -100 LOD bias exceeds ANGLE/D3D's supported range. These
  // targets have no mipmaps; the legal minimum produces the same base-level sample.
  aa.material.fragmentShader = aa.material.fragmentShader.replaceAll('-100.0', '-16.0');
  composer.addPass(beauty);
  if (ao) composer.addPass(ao);
  composer.addPass(bloom);
  composer.addPass(gamma);
  composer.addPass(aa);
  if (new URLSearchParams(location.search).has('diagnostics')) {
    for (const [index, pass] of composer.passes.entries()) {
      const render = pass.render.bind(pass);
      let first = true;
      pass.render = (...args: Parameters<typeof render>) => {
        const start = performance.now();
        render(...args);
        if (first) { first = false; loadMetric('pass_' + index, Math.round(performance.now() - start)); }
      };
    }
  }
  const coordinates = createCoordinateOverlay(renderer, scene, camera);
  const compass = createNorthCompass(renderer, scene, camera);

  let lastWidth = 0, lastHeight = 0;
  const setSize = (width: number, height: number) => {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (width === lastWidth && height === lastHeight) return;
    lastWidth = width;
    lastHeight = height;
    coordinates.setSize(width, height);
    compass.setSize(width, height);
    // The ledger's small overview does not need a second geometry pass or glow buffers.
    const detailed = width >= 580 && height >= 320;
    if (ao) ao.enabled = detailed;
    beauty.enabled = !ao || !detailed;
    bloom.enabled = detailed && !!ao;
    composer.setSize(width, height);
    const dpr = renderer.getPixelRatio();
    aa.material.uniforms.resolution.value.set(1 / (width * dpr), 1 / (height * dpr));
  };
  const size = renderer.getSize(new THREE.Vector2());
  setSize(size.x, size.y);

  return {
    render() { composer.render(); coordinates.update(); compass.update(); },
    setSize,
    refresh() { ao?.rescan(scene); },
    dispose() {
      coordinates.dispose();
      compass.dispose();
      scene.environment = previousEnvironment;
      environment.dispose();
      if (ao) {
        ao.dispose();
        // These resources are omitted by SSAOPass.dispose() in r147.
        ao.ssaoMaterial.dispose();
        ao.noiseTexture.dispose();
      }
      bloom.dispose();
      bloom.materialHighPassFilter.dispose();
      gamma.dispose();
      aa.dispose();
      composer.dispose();
    },
  };
}
