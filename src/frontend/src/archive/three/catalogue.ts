import type * as THREE from 'three-inventory';

/** Apply the register identities after the geometry and its historical texture keys are built. */
export function applyCatalogue(scene: THREE.Scene, catalogue: {
  items: { legacy_id: string; id: string; name: string; catalogue_no: string }[];
  removed: string[];
}) {
  const identities = new Map(catalogue.items.map(item => [item.legacy_id, item]));
  scene.traverse(object => {
    const hps = object.userData.hps;
    if (!hps) return;
    if (catalogue.removed.includes(hps.id)) {
      for (const part of object.userData._parts || [object]) part.visible = false;
      delete object.userData.hps;
      return;
    }
    const entry = identities.get(hps.id);
    if (entry) {
      object.userData.hps = { ...hps, id: entry.id, name: entry.name, legacy_id: entry.legacy_id, catalogue_no: entry.catalogue_no };
    }
  });
}
