/* Dump the candidate texture faces of registered stones from the built Three scene.
   For every stone id (all, or those given as arguments) and every axis-aligned normal in the stone's
   local geometry space, report the planar face extents exactly as buildSite.ts' applyStoneTexture will
   measure them, plus the world direction of that normal and of the image-up axis, so the texture
   preparation script can compute face aspect / orientation without re-parsing buildSite.ts.

   usage: tools/run.ps1 tools/authoring/dump_stone_faces.mjs [--parts] [id ...]  > stone-faces.json                  */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const requireWeb=createRequire(process.env.WSC_NODE_MODULES + '/package.json');
const THREE=requireWeb('three-inventory');
const {createCanvas}=requireWeb('@napi-rs/canvas');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const wanted = new Set(args.filter(a => !a.startsWith('--')));

const source = fs.readFileSync(path.join(root, 'src/frontend/src/archive/three/buildSite.ts'), 'utf8')
  .replace(/import \* as THREE from 'three-inventory';/, '')
  .replace(/export interface SiteHandles \{[\s\S]*?\n\}/, '')
  .replace(/export function buildSite[^\n]+\{/, 'function buildSite(scene, stoneTextures = {}) {');
const builder = new Function('THREE', 'document', source + '\nreturn buildSite;')(THREE, { createElement: () => createCanvas(1, 1) });
const scene = new THREE.Scene();
builder(scene, {});
scene.updateMatrixWorld(true);

const AXES = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };

function faceExtents(master, parts, normal, up) {
  const vAxis = up.clone().addScaledVector(normal, -up.dot(normal)).normalize();
  const uAxis = vAxis.clone().cross(normal).normalize();
  const toMaster = master.matrixWorld.clone().invert();
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, triangles = 0;
  const centre = new THREE.Vector3();
  let count = 0;
  for (const part of parts) {
    const input = part.geometry;
    const geo = input.index ? input.toNonIndexed() : input;
    const pos = geo.attributes.position, norms = geo.attributes.normal;
    const toCommon = toMaster.clone().multiply(part.matrixWorld);
    if (!norms) continue;
    for (let i = 0; i < pos.count; i += 3) {
      let front = true;
      for (let j = 0; j < 3; j++) if (new THREE.Vector3().fromBufferAttribute(norms, i + j).dot(normal) < 0.995) { front = false; break; }
      if (!front) continue;
      triangles++;
      for (let j = 0; j < 3; j++) {
        const common = new THREE.Vector3().fromBufferAttribute(pos, i + j).applyMatrix4(toCommon);
        const u = common.dot(uAxis), v = common.dot(vAxis);
        uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
        centre.add(common.applyMatrix4(master.matrixWorld)); count++;
      }
    }
    if (geo !== input) geo.dispose();
  }
  if (!triangles) return null;
  const worldNormal = normal.clone().transformDirection(master.matrixWorld);
  const worldUp = vAxis.clone().transformDirection(master.matrixWorld);
  return {
    triangles, width: +(uMax - uMin).toFixed(4), height: +(vMax - vMin).toFixed(4),
    aspect: +((uMax - uMin) / (vMax - vMin)).toFixed(4),
    worldNormal: worldNormal.toArray().map(v => +v.toFixed(3)),
    worldUp: worldUp.toArray().map(v => +v.toFixed(3)),
    worldCentre: centre.divideScalar(count).toArray().map(v => +v.toFixed(3)),
  };
}

const out = {};
scene.traverse(master => {
  if (!master.isMesh || !master.userData.hps) return;
  const id = master.userData.hps.id;
  if (wanted.size && !wanted.has(id)) return;
  const originalParts = master.userData._parts || [master];
  const partNames = originalParts.map(p => p.name || '');
  const selections = { '': originalParts.length > 1 && !(id === 'C-2' || id === 'X-3') ? [master] : originalParts };
  for (const p of originalParts) if (p.name) selections[p.name] = [p];
  const entry = { partNames, faces: {} };
  for (const [sel, parts] of Object.entries(selections)) {
    for (const [axis, n] of Object.entries(AXES)) {
      const normal = new THREE.Vector3(...n);
      const up = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(0, 0, -Math.sign(normal.y)) : new THREE.Vector3(0, 1, 0);
      const f = faceExtents(master, parts, normal, up);
      if (f) entry.faces[(sel ? sel + '|' : '') + axis] = f;
    }
  }
  const wp = master.getWorldPosition(new THREE.Vector3());
  entry.worldPosition = wp.toArray().map(v => +v.toFixed(3));
  out[id] = entry;
});
process.stdout.write(JSON.stringify(out, null, 1));
