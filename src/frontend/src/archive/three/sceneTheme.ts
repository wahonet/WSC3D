import * as THREE from 'three-inventory';

/** Match the day-mode workspace without recolouring the buildings or stone images. */
export function watchSceneTheme(scene: THREE.Scene, invalidate: () => void) {
  const sky = scene.getObjectByName('sky');
  const previousSkyVisible = sky?.visible ?? true;
  const previousBackground = scene.background;
  const previousFog = scene.fog?.color.clone();
  const backdrops = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  const daylightBackdrop = new THREE.MeshBasicMaterial({ toneMapped: false });
  function apply() {
    scene.traverse(object => {
      if (!(object instanceof THREE.Mesh) || backdrops.has(object)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      // The asynchronous Blender architecture replaces the fallback earth plane.
      // This named material belongs only to its one outer background floor.
      if (object.name === 'courtyard_backdrop' || materials.some(material => material.name === '场外_中性地表')) {
        backdrops.set(object, object.material);
      }
    });
    const light = document.documentElement.dataset.theme === 'light';
    if (sky) sky.visible = light ? false : previousSkyVisible;
    if (light) {
      const token = getComputedStyle(document.documentElement).getPropertyValue('--viewport').trim();
      const background = new THREE.Color(token || '#e2e5e7').convertSRGBToLinear();
      scene.background = background;
      scene.fog?.color.copy(background);
      daylightBackdrop.color.copy(background);
      backdrops.forEach((_, backdrop) => { backdrop.material = daylightBackdrop; });
    } else {
      scene.background = previousBackground;
      if (previousFog) scene.fog?.color.copy(previousFog);
      backdrops.forEach((material, backdrop) => { backdrop.material = material; });
    }
    invalidate();
  }
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  apply();
  return { refresh: apply, dispose() {
    observer.disconnect();
    backdrops.forEach((material, backdrop) => { backdrop.material = material; });
    daylightBackdrop.dispose();
  } };
}
