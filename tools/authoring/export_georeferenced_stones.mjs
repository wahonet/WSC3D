#!/usr/bin/env node
/** Export original stone anchors with provisional horizontal coordinates. No scene edits. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireWeb = createRequire(process.env.WSC_NODE_MODULES + '/package.json');
const THREE = requireWeb('three-inventory');
const { createCanvas, loadImage } = requireWeb('@napi-rs/canvas');
const outputIndex=process.argv.indexOf('--out');
const out = path.resolve(root, outputIndex>=0 ? process.argv[outputIndex+1] : 'resources/authoring/georeferencing');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('src/frontend/src/archive/three/buildSite.ts');
const coordinateSource = read('src/frontend/src/archive/three/georeference.ts');
const registration = JSON.parse(read('resources/georeferencing/courtyard-registration.json'));
const manifest = JSON.parse(read('src/frontend/src/archive/three/stoneTextureManifest.json'));
const plain = sourceText => stripTypeScriptTypes(sourceText).replace(/^import.*$/gm, '').replace(/\bexport\s+(?=function\b)/g, '');
const coordinates = vm.createContext({ Math });
new vm.Script(`${plain(coordinateSource)}\nglobalThis.convert = {worldToGeographic, geographicToWorldXZ};`).runInContext(coordinates);
const { worldToGeographic, geographicToWorldXZ } = coordinates.convert;

const stoneTextures = {};
for (const entry of manifest.entries) {
  const image = await loadImage(path.join(root, 'resources/scenes/textures/stones', entry.file));
  const texture = new THREE.Texture(image);
  texture.encoding = THREE.sRGBEncoding;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  const [x, y, w, h] = entry.crop, [width, height] = entry.imageSize;
  texture.repeat.set(w / width, h / height);
  texture.offset.set(x / width, 1 - (y + h) / height);
  texture.userData = { ...entry, loadState: 'loaded' };
  stoneTextures[entry.id] = texture;
}
const context = vm.createContext({ THREE, Math, console, document: {
  createElement(tag) { assert.equal(tag, 'canvas'); return createCanvas(1, 1); },
} });
new vm.Script(`${plain(source)}\nglobalThis.construct = buildSite;`).runInContext(context);
const scene = new THREE.Scene();
context.construct(scene, stoneTextures);
scene.updateMatrixWorld(true);
assert.equal(JSON.stringify(scene.userData.georeference), JSON.stringify(registration), 'Embedded registration is stale');

const archive = new Map();
const catalogue = JSON.parse(read('config/catalogue/stones.json'));
const identities = JSON.parse(read('config/catalogue/identities.json')).items;
for (const directory of fs.readdirSync(path.join(root, 'resources/stones'), { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const metaFile = path.join(root, 'resources/stones', directory.name, 'metadata/catalogue.json');
  if (!fs.existsSync(metaFile)) continue;
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const registered = catalogue.find(item => item.directory === directory.name);
  assert.ok(registered, `Unregistered stone directory: ${directory.name}`);
  const id = registered.id;
  const identity = identities.find(item => item.catalogue_no === id);
  meta.sceneId = identity?.legacy_id || id;
  assert.ok(!archive.has(id), `Duplicate archive ID ${id}`);
  archive.set(id, meta);
}
const masters = new Map();
let overlays = 0;
scene.traverse(object => {
  if (object.userData.isStoneTexture) { overlays++; return; }
  if (!object.isMesh || !object.userData.hps) return;
  const id = object.userData.hps.id;
  assert.ok(!masters.has(id), `Multiple original primary meshes for ${id}`);
  masters.set(id, object);
});
assert.equal(archive.size, 150);
// Some texture entries belong to replaced scene meshes. Report visible overlays;
// the coordinate export validates every registered stone anchor below.
const rows = [...archive.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([id, meta]) => {
  const mesh = masters.get(meta.sceneId) || masters.get(id);
  assert.ok(mesh, `Archive stone has no primary scene mesh: ${id}`);
  const position = mesh.getWorldPosition(new THREE.Vector3());
  return {
    id, name: meta.name || id, location: meta.location || '',
    modelXMetres: position.x, modelZMetres: position.z,
    ...worldToGeographic(registration, position),
  };
});
assert.equal(new Set(rows.map(row => row.id)).size, 150);

const controlChecks = registration.controls.map(control => {
  const world = geographicToWorldXZ(registration, control.latitudeDeg, control.longitudeDeg);
  const geographic = worldToGeographic(registration, { ...world, y: 0 });
  const angularError = Math.max(Math.abs(geographic.latitudeDeg - control.latitudeDeg), Math.abs(geographic.longitudeDeg - control.longitudeDeg));
  const enuError = Math.hypot(geographic.eastMetres - control.enu[0], geographic.northMetres - control.enu[1]);
  assert.ok(angularError < 1e-6);
  assert.ok(enuError < 1e-6);
  return { pointId: control.id, roundTripMaxDegrees: angularError, controlEnuErrorMetres: enuError };
});
let maxWorldRoundTripError = 0, maxDistanceChange = 0;
for (const row of rows) {
  const world = geographicToWorldXZ(registration, row.latitudeDeg, row.longitudeDeg);
  maxWorldRoundTripError = Math.max(maxWorldRoundTripError, Math.hypot(world.x - row.modelXMetres, world.z - row.modelZMetres));
  const raised = worldToGeographic(registration, { x: row.modelXMetres, y: row.modelYMetres + 100, z: row.modelZMetres });
  assert.equal(raised.latitudeDeg, row.latitudeDeg);
  assert.equal(raised.longitudeDeg, row.longitudeDeg);
}
for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
  const a = rows[i], b = rows[j];
  const modelDistance = Math.hypot(a.modelXMetres - b.modelXMetres, a.modelZMetres - b.modelZMetres);
  const enuDistance = Math.hypot(a.eastMetres - b.eastMetres, a.northMetres - b.northMetres);
  maxDistanceChange = Math.max(maxDistanceChange, Math.abs(modelDistance - enuDistance));
}
assert.ok(maxWorldRoundTripError < 1e-6);
assert.ok(maxDistanceChange < 1e-9);
const qa = {
  status: 'PASS', archivedStoneCount: archive.size, exportedStoneCount: rows.length,
  photoOverlaysExcluded: overlays,
  nonArchiveIdsExcluded: [...masters.keys()].filter(id => ![...archive.values()].some(meta => meta.sceneId === id)),
  controls: controlChecks,
  maxWorldRoundTripErrorMetres: maxWorldRoundTripError,
  maxHorizontalPairwiseDistanceChangeMetres: maxDistanceChange,
  pairwiseDistancesChecked: rows.length * (rows.length - 1) / 2,
  modelYDoesNotChangeHorizontalCoordinates: true,
  absoluteHeightExported: false,
};
const metadata = {
  status: 'provisional', coordinateMeaning: 'Model-derived horizontal location; not an individual stone RTK measurement.',
  anchor: 'Original primary stone mesh origin in complete-scene world coordinates, retaining the local metre frame.',
  modelYMeaning: 'Original model Y only. No absolute elevation is inferred from the 29.388 m control-height record.',
  horizontalDatum: registration.datum.horizontal, verticalDatum: registration.datum.vertical,
  calculationEllipsoid: 'WGS84', horizontalProjection: 'worldXZ → ENU at origin, U=0 → ECEF → geographic',
  registrationFile: 'resources/georeferencing/courtyard-registration.json',
  sceneSha256: createHash('sha256').update(source).digest('hex'),
  coordinateModuleSha256: createHash('sha256').update(coordinateSource).digest('hex'),
  registrationQuality: registration.quality,
};
const columns = [
  ['id', '石刻编号'], ['name', '档案名称'], ['location', '位置'],
  ['modelXMetres', '模型局部X米'], ['modelYMetres', '模型局部Y米_非绝对高程'], ['modelZMetres', '模型局部Z米'],
  ['eastMetres', '东向米_相对ENU原点'], ['northMetres', '北向米_相对ENU原点'],
  ['latitudeDeg', '纬度度_暂定'], ['longitudeDeg', '经度度_暂定'],
  ['status', '配准状态'], ['horizontalDatum', '水平基准'], ['verticalDatum', '高程基准'],
];
const csvCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
const csv = [columns.map(([, label]) => csvCell(label)).join(','), ...rows.map(row => columns.map(([key]) => csvCell(row[key])).join(','))].join('\r\n');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'georeferenced-stones.json'), `${JSON.stringify({ metadata, registration, stones: rows }, null, 2)}\n`);
fs.writeFileSync(path.join(out, '石刻暂定坐标.csv'), `\ufeff${csv}\r\n`);
fs.writeFileSync(path.join(out, 'coordinate-validation.json'), `${JSON.stringify(qa, null, 2)}\n`);
console.log(JSON.stringify(qa, null, 2));
