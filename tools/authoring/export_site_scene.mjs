#!/usr/bin/env node
/**
 * Export the real web model to explicit mesh buffers for Blender/offline rendering.
 * Run from the repository root:
 *   tools/run.ps1 tools/authoring/export_site_scene.mjs --out resources/authoring/scene-textures/scene --seed 20260905
 * Optional: --manifest <json> --texture-dir <directory>; --skip-stone-textures exports architecture alone.
 *
 * Requires Node >= 22.13 and the existing web dependencies: three, @napi-rs/canvas.
 * Does not need a browser, GPU, WebGL context, or changes to buildSite.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireWeb = createRequire(process.env.WSC_NODE_MODULES + '/package.json');
const THREE = requireWeb('three-inventory');
const { createCanvas, Image, ImageData, loadImage } = requireWeb('@napi-rs/canvas');

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[index + 1];
}
const outputDir = path.resolve(root, option('--out', 'resources/authoring/scene-textures/scene'));
const sourceFile = path.resolve(root, option('--source', 'src/frontend/src/archive/three/buildSite.ts'));
const manifestFile = path.resolve(root, option('--manifest', 'src/frontend/src/archive/three/stoneTextureManifest.json'));
const stoneTextureDir = path.resolve(root, option('--texture-dir', 'resources/scenes/textures/stones'));
const skipStoneTextures = args.includes('--skip-stone-textures');
const seed = Number(option('--seed', '20260905'));
if (!Number.isSafeInteger(seed)) throw new Error('--seed must be a safe integer');
const source = fs.readFileSync(sourceFile, 'utf8');
const manifestSource = skipStoneTextures ? null : fs.readFileSync(manifestFile, 'utf8');
const manifest = manifestSource === null ? { entries: [] } : JSON.parse(manifestSource);
if (!Array.isArray(manifest.entries)) throw new Error('Stone texture manifest must contain an entries array');

async function loadStoneTextures() {
  const result = Object.create(null);
  const images = new Map();
  for (const entry of manifest.entries) {
    const key = entry.id + (entry.faceKey ? ':' + entry.faceKey : '');
    if (typeof entry.id !== 'string' || !entry.id || Object.hasOwn(result, key)) {
      throw new Error(`Missing or duplicate stone texture ID: ${entry.id}`);
    }
    if (typeof entry.file !== 'string' || !entry.file) throw new Error(`Missing texture file for ${entry.id}`);
    // Accept both a manifest-local filename and the public URL used by the web app.
    const relativeFile = entry.file.replace(/^\/?textures\/stones\//, '');
    const absoluteFile = path.resolve(stoneTextureDir, relativeFile);
    const relativeToRoot = path.relative(stoneTextureDir, absoluteFile);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Stone texture file escapes the texture directory: ${entry.file}`);
    }
    if (!images.has(absoluteFile)) images.set(absoluteFile, await loadImage(absoluteFile));
    const image = images.get(absoluteFile);
    const [width, height] = entry.imageSize || [];
    if (width !== image.width || height !== image.height) {
      throw new Error(`Image size mismatch for ${entry.id}: manifest ${width}x${height}, image ${image.width}x${image.height}`);
    }
    const crop = entry.crop;
    if (!Array.isArray(crop) || crop.length !== 4 || !crop.every(Number.isFinite)) {
      throw new Error(`Invalid crop for ${entry.id}`);
    }
    const [x, y, w, h] = crop;
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > width || y + h > height) {
      throw new Error(`Crop outside source image for ${entry.id}: ${crop}`);
    }
    if (!Array.isArray(entry.normal) || entry.normal.length !== 3 || !entry.normal.every(Number.isFinite)
        || !entry.normal.some(value => value !== 0)) {
      throw new Error(`Missing or invalid local face normal for ${entry.id}`);
    }
    const texture = new THREE.Texture(image);
    texture.name = `stone_${entry.id}`;
    texture.encoding = THREE.sRGBEncoding;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.repeat.set(w / width, h / height);
    texture.offset.set(x / width, 1 - (y + h) / height);
    texture.anisotropy = 8;
    texture.userData = { ...entry, loadState: 'loaded' };
    texture.needsUpdate = true;
    result[key] = texture;
  }
  return result;
}

function mulberry32(value) {
  let state = value >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let result = state;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}
const realRandom = Math.random;
let scene;
let handles;
let stoneTextures;
try {
  // Also seed Three's UUID creation so repeated exports have identical texture names.
  Math.random = mulberry32(seed);
  scene = new THREE.Scene();
  // Await real image decoding before buildSite decides whether photo overlays are visible.
  stoneTextures = await loadStoneTextures();
  const plainJs = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+['"]three-inventory['"];?\s*$/m, '')
    .replace(/\bexport\s+(?=function\s+buildSite\b)/, '');
  if (/^\s*import\s/m.test(plainJs)) {
    throw new Error('buildSite.ts now has additional imports; add explicit export-runner bindings before continuing.');
  }
  const context = vm.createContext({
    THREE, Math, console, Image, ImageData,
    document: {
      createElement(tag) {
        if (tag === 'canvas') return createCanvas(1, 1);
        throw new Error(`Unsupported DOM element in model construction: ${tag}`);
      },
    },
  });
  new vm.Script(`${plainJs}\n;globalThis.__buildSite = buildSite;`, { filename: sourceFile })
    .runInContext(context, { timeout: 120000 });
  handles = context.__buildSite(scene, stoneTextures);
  if (args.includes('--courtyard-baseline') || args.includes('--presentation-snapshot')) {
    function runModule(file, binding) {
      const js = stripTypeScriptTypes(fs.readFileSync(path.join(root,file),'utf8'),{mode:'strip'})
        .replace(/^import .+;\s*$/mg,'').replace(/\bexport (?=function)/g,'');
      new vm.Script(js + `\nglobalThis.__moduleResult = ${binding};`).runInContext(context);
      return context.__moduleResult;
    }
    const catalogue = JSON.parse(fs.readFileSync(path.join(root,'src/frontend/src/archive/three/catalogueMap.json'),'utf8'));
    runModule('src/frontend/src/archive/three/catalogue.ts','applyCatalogue')(scene,catalogue);
    const presentation = args.includes('--presentation-snapshot');
    let layout;
    if (presentation) layout = JSON.parse(fs.readFileSync(path.join(root,'data/layouts/xcl.json'),'utf8'));
    else {
      const response=await fetch('http://127.0.0.1:8002/api/layouts/xcl');
      if(!response.ok) throw new Error('Cannot freeze live west-corridor layout');
      layout=await response.json();
    }
    fs.mkdirSync(outputDir,{recursive:true});
    fs.writeFileSync(path.join(outputDir,'live-xcl-layout.json'),JSON.stringify(layout,null,2));
    runModule('src/frontend/src/archive/three/xclLayout.ts','applyXclLayout')(scene,layout.stones);
    const protection=runModule('src/frontend/src/archive/three/courtyardProtection.ts','inspectCourtyard')(scene);
    protection.north.traverse(o=>{o.userData.courtyardNorthProtected=true;});
    protection.replacement.forEach((zone,o)=>{o.userData.courtyardReplacement=zone;});
    protection.protectedMeshes.forEach(o=>{o.userData.courtyardProtected=true;});
    if (presentation) {
      const architecture = JSON.parse(fs.readFileSync(path.join(root,'src/frontend/src/archive/three/courtyardArchitectureManifest.json'),'utf8'));
      const rearFile = ['data/layouts/rear.json','data/layouts/rear-default.json'].map(p=>path.join(root,p)).find(p=>fs.existsSync(p));
      const rearLayout = JSON.parse(fs.readFileSync(rearFile,'utf8'));
      const rearByNo = new Map(rearLayout.stones.map(r=>[r.id,r]));
      for (const stone of protection.stones) {
        const row = rearByNo.get(stone.userData.hps.catalogue_no);
        if (stone.parent?.name !== 'HPS_HALL_IN' || !row) continue;
        stone.position.set(row.x,row.y,row.z); stone.rotation.set(row.rx,row.ry,row.rz);
        stone.userData.rearPlacementApplied = true;
      }
      scene.updateMatrixWorld(true);
      const translateStone = runModule('src/frontend/src/archive/three/courtyardArchitecture.ts','translateStone');
      for (const stone of protection.stones) {
        const move = architecture.stone_movements[stone.userData.hps.id];
        if (move && !stone.userData.rearPlacementApplied) translateStone(stone,move.world_delta,move.rotation_y);
      }
      for (const [id,delta] of Object.entries(architecture.furnishing_movements)) {
        const object = protection.objectIds.get(id);
        if (object?.userData.showcase) translateStone(object,delta);
      }
      fs.writeFileSync(path.join(outputDir,'live-rear-layout.json'),JSON.stringify(rearLayout,null,2));
      fs.writeFileSync(path.join(outputDir,'architecture-manifest.json'),JSON.stringify(architecture,null,2));
    }
  }
  scene.updateMatrixWorld(true);
} finally {
  Math.random = realRandom;
}

fs.mkdirSync(path.join(outputDir, 'textures'), { recursive: true });
const round = (value, precision = 6) => {
  if (!Number.isFinite(value)) throw new Error(`Non-finite scene number: ${value}`);
  const rounded = Number(value.toFixed(precision));
  return Object.is(rounded, -0) ? 0 : rounded;
};
const roundedArray = (array, precision = 6) => Array.from(array, value => round(value, precision));
const colorArray = color => color ? roundedArray([color.r, color.g, color.b]) : null;
const vectors = vector => vector ? roundedArray(vector.toArray()) : null;
const geometries = [];
const materials = [];
const textures = [];
const objects = [];
const lights = [];
const geometryRefs = new WeakMap();
const geometrySignatures = new Map();
const materialRefs = new WeakMap();
const textureRefs = new WeakMap();
const objectRefs = new WeakMap();
const roofRoots = new Set(handles.ROOFS || []);
const warnings = [];

let objectCounter = 0;
scene.traverse(object => objectRefs.set(object, `o${String(++objectCounter).padStart(5, '0')}`));

function bufferValues(attribute) {
  if (!attribute) return null;
  const values = [];
  for (let index = 0; index < attribute.count; index++) {
    const components = [attribute.getX(index)];
    if (attribute.itemSize > 1) components.push(attribute.getY(index));
    if (attribute.itemSize > 2) components.push(attribute.getZ(index));
    if (attribute.itemSize > 3) components.push(attribute.getW(index));
    values.push(...components.map(value => round(value)));
  }
  return values;
}

function exportGeometry(original) {
  if (geometryRefs.has(original)) return geometryRefs.get(original);
  if (!original.isBufferGeometry || !original.attributes.position) {
    throw new Error(`Cannot export geometry without an explicit position buffer: ${original.type}`);
  }
  let geometry = original;
  if (!geometry.attributes.normal) {
    geometry = original.clone();
    geometry.computeVertexNormals();
  }
  const record = {
    positions: bufferValues(geometry.attributes.position),
    normals: bufferValues(geometry.attributes.normal),
    uv: bufferValues(geometry.attributes.uv),
    uv2: bufferValues(geometry.attributes.uv2),
    colors: bufferValues(geometry.attributes.color),
    colorItemSize: geometry.attributes.color?.itemSize ?? null,
    index: geometry.index ? Array.from(geometry.index.array) : null,
    groups: geometry.groups.map(group => ({ ...group })),
    drawRange: {
      start: geometry.drawRange.start,
      count: Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.count : null,
    },
  };
  // Distinct BoxGeometry instances often share the same buffers. Deduplicate them too.
  const signature = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  if (geometrySignatures.has(signature)) {
    const id = geometrySignatures.get(signature);
    geometryRefs.set(original, id);
    if (geometry !== original) geometry.dispose();
    return id;
  }
  const id = `g${String(geometries.length + 1).padStart(5, '0')}`;
  geometry.computeBoundingBox();
  geometries.push({
    id,
    sourceType: original.type,
    ...record,
    bounds: { min: vectors(geometry.boundingBox.min), max: vectors(geometry.boundingBox.max) },
  });
  geometryRefs.set(original, id);
  geometrySignatures.set(signature, id);
  if (geometry !== original) geometry.dispose();
  return id;
}

function exportTexture(texture) {
  if (textureRefs.has(texture)) return textureRefs.get(texture);
  const id = texture.uuid;
  textureRefs.set(texture, id);
  const image = texture.image;
  let canvas = image;
  if (!image || !image.width || !image.height) throw new Error(`Texture ${id} has no loaded image`);
  if (typeof canvas.toBuffer !== 'function') {
    canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    if (image.data) {
      ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    } else {
      ctx.drawImage(image, 0, 0);
    }
  }
  const file = `textures/${id}.png`;
  fs.writeFileSync(path.join(outputDir, file), canvas.toBuffer('image/png'));
  texture.updateMatrix();
  const isSrgb = texture.colorSpace === 'srgb' || texture.encoding === THREE.sRGBEncoding;
  textures.push({
    id, name: texture.name || '', file,
    width: image.width, height: image.height,
    encoding: isSrgb ? 'srgb' : 'linear',
    repeat: vectors(texture.repeat), offset: vectors(texture.offset), center: vectors(texture.center),
    rotation: round(texture.rotation),
    matrix: roundedArray(texture.matrix.elements, 9),
    flipY: texture.flipY,
    wrapS: texture.wrapS, wrapT: texture.wrapT,
    magFilter: texture.magFilter, minFilter: texture.minFilter,
    mapping: texture.mapping, premultiplyAlpha: texture.premultiplyAlpha,
    userData: JSON.parse(JSON.stringify(texture.userData || {})),
  });
  return id;
}

function exportMaterial(material) {
  if (materialRefs.has(material)) return materialRefs.get(material);
  const id = `m${String(materials.length + 1).padStart(4, '0')}`;
  materialRefs.set(material, id);
  const maps = {};
  for (const [key, value] of Object.entries(material)) {
    if (value?.isTexture) maps[key] = exportTexture(value);
  }
  const roughness = material.roughness ?? (material.isMeshPhongMaterial
    ? Math.sqrt(2 / ((material.shininess ?? 30) + 2))
    : 0.87);
  const record = {
    id, name: material.name || '', type: material.type,
    color: colorArray(material.color) ?? [1, 1, 1], colorSpace: 'linear',
    roughness: round(roughness), metalness: round(material.metalness ?? 0),
    opacity: round(material.opacity ?? 1), transparent: Boolean(material.transparent),
    alphaTest: round(material.alphaTest ?? 0),
    side: material.side, visible: material.visible,
    depthWrite: material.depthWrite, wireframe: Boolean(material.wireframe),
    emissive: colorArray(material.emissive), emissiveIntensity: material.emissiveIntensity ?? 0,
    specular: colorArray(material.specular), shininess: material.shininess ?? null,
    flatShading: Boolean(material.flatShading), vertexColors: Boolean(material.vertexColors),
    transmission: material.transmission ?? 0, ior: material.ior ?? 1.5,
    normalScale: vectors(material.normalScale), bumpScale: material.bumpScale ?? 1,
    maps,
  };
  if (material.isShaderMaterial) {
    record.shaderUniformColors = {};
    for (const [key, value] of Object.entries(material.uniforms || {})) {
      if (value.value?.isColor) record.shaderUniformColors[key] = colorArray(value.value);
    }
  }
  materials.push(record);
  return id;
}

function isRoof(object) {
  for (let parent = object; parent; parent = parent.parent) {
    if (roofRoots.has(parent)) return true;
  }
  return false;
}

function isVisible(object) {
  for (let parent = object; parent; parent = parent.parent) {
    if (!parent.visible) return false;
  }
  return true;
}

function userDataFor(object) {
  const data = {};
  for (const [key, value] of Object.entries(object.userData || {})) {
    if (value?.isObject3D) data[key] = { objectId: objectRefs.get(value) ?? null };
    else if (Array.isArray(value) && value.some(item => item?.isObject3D)) {
      data[key] = value.map(item => item?.isObject3D ? { objectId: objectRefs.get(item) ?? null } : item);
    } else if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) data[key] = value;
    else {
      try { data[key] = JSON.parse(JSON.stringify(value)); }
      catch { warnings.push(`Skipped non-serializable userData ${objectRefs.get(object)}.${key}`); }
    }
  }
  return data;
}

scene.traverse(object => {
  const objectMaterials = object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
  const hps = object.userData.hps || object.userData.hpsRef?.userData?.hps || null;
  const record = {
    id: objectRefs.get(object),
    name: object.name || (hps?.id ? `HPS-${hps.id}` : `${object.type}_${objectRefs.get(object)}`),
    parentId: object.parent ? objectRefs.get(object.parent) : null,
    type: object.type,
    matrixWorld: roundedArray(object.matrixWorld.elements, 9),
    visible: isVisible(object),
    roof: isRoof(object), roofRoot: roofRoots.has(object),
    hps, userData: userDataFor(object),
    castShadow: object.castShadow, receiveShadow: object.receiveShadow,
  };
  if (object.isInstancedMesh) throw new Error('InstancedMesh needs explicit expansion in the exporter.');
  if (object.isMesh) {
    record.geometryId = exportGeometry(object.geometry);
    record.materialIds = objectMaterials.map(exportMaterial);
    // The web's custom sky shader is represented by the Blender World instead.
    record.skipRender = objectMaterials.some(material => material.isShaderMaterial);
    record.skipReason = record.skipRender ? 'Web sky/custom shader; use Blender world background' : null;
  } else if (object.isLine || object.isPoints || object.isSprite) {
    warnings.push(`Non-mesh render object was preserved only as metadata: ${record.id} ${object.type}`);
  }
  if (object.isLight) {
    lights.push({
      objectId: record.id, type: object.type, color: colorArray(object.color),
      groundColor: colorArray(object.groundColor), intensity: object.intensity,
      position: vectors(new THREE.Vector3().setFromMatrixPosition(object.matrixWorld)),
      target: object.target ? vectors(new THREE.Vector3().setFromMatrixPosition(object.target.matrixWorld)) : null,
      distance: object.distance ?? null, decay: object.decay ?? null,
    });
  }
  objects.push(record);
});

const bounds = new THREE.Box3();
scene.traverse(object => {
  if (!object.isMesh || !isVisible(object)) return;
  const mats = Array.isArray(object.material) ? object.material : [object.material];
  if (mats.some(material => material.isShaderMaterial)) return;
  object.geometry.computeBoundingBox();
  bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
});
const result = {
  metadata: {
    schema: 'wushici.explicit-scene', version: 1,
    source: path.relative(root, sourceFile).replaceAll('\\', '/'),
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    stoneTextureManifest: manifestSource === null ? null : {
      source: path.relative(root, manifestFile).replaceAll('\\', '/'),
      sourceSha256: createHash('sha256').update(manifestSource).digest('hex'),
      loadedCount: Object.keys(stoneTextures).length,
    },
    seed, threeRevision: THREE.REVISION,
    units: 'meters', coordinateSystem: 'right-handed: X=east, Y=up, Z=south',
    matrixLayout: 'column-major; positions are geometry-local; apply matrixWorld once',
    blenderCoordinateHint: 'Rotate +90 degrees about X: (x, y, z) -> (x, -z, y).',
    colorNote: 'Material colors are linear RGB. PNG textures use their declared encoding. Multiply map RGB by material color.',
    uvNote: 'UVs use Three geometry conventions. Apply each texture matrix/repeat/offset; PNG file origin is top-left. Blender image nodes already use bottom-left UVs for CanvasTexture flipY=true.',
    indexNote: 'Triangle list. Unindexed geometry uses sequential vertices. groups start/count refer to index entries or unindexed vertices, not faces.',
    bounds: { min: vectors(bounds.min), max: vectors(bounds.max) },
    roofRootIds: [...roofRoots].map(object => objectRefs.get(object)),
    warnings,
  },
  objects, geometries, materials, textures, lights,
};
const scenePath = path.join(outputDir, 'scene.json');
fs.writeFileSync(scenePath, JSON.stringify(result));
const meshes = objects.filter(object => object.geometryId);
const geometryById = new Map(geometries.map(geometry => [geometry.id, geometry]));
const triangleCount = geometry => (geometry.index?.length ?? geometry.positions.length / 3) / 3;
const stats = {
  scenePath: path.relative(root, scenePath).replaceAll('\\', '/'),
  seed, sourceSha256: result.metadata.sourceSha256,
  objectCount: objects.length, meshCount: meshes.length,
  uniqueGeometryCount: geometries.length, materialCount: materials.length, textureCount: textures.length,
  loadedStoneTextureCount: Object.keys(stoneTextures).length,
  exportedStoneTextureCount: textures.filter(texture => texture.userData.loadState === 'loaded' && texture.userData.id).length,
  roofRootCount: roofRoots.size, roofMeshCount: meshes.filter(object => object.roof).length,
  hpsMeshCount: meshes.filter(object => object.hps).length,
  uniqueHpsCount: new Set(meshes.filter(object => object.hps).map(object => object.hps.id)).size,
  storedVertexCount: geometries.reduce((sum, geometry) => sum + geometry.positions.length / 3, 0),
  storedTriangleCount: geometries.reduce((sum, geometry) => sum + triangleCount(geometry), 0),
  instantiatedTriangleCount: meshes.reduce((sum, object) => sum + triangleCount(geometryById.get(object.geometryId)), 0),
  sceneJsonBytes: fs.statSync(scenePath).size,
  textureBytes: textures.reduce((sum, texture) => sum + fs.statSync(path.join(outputDir, texture.file)).size, 0),
  bounds: result.metadata.bounds, warnings,
};
fs.writeFileSync(path.join(outputDir, 'stats.json'), `${JSON.stringify(stats, null, 2)}\n`);
console.log(JSON.stringify(stats, null, 2));
