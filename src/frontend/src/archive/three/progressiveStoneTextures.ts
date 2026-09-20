import * as THREE from 'three-inventory';
import stoneTextureManifest from './stoneTextureManifest.json';
import stoneTextureManifestBL from './stoneTextureManifestBL.json';
import stoneTextureManifestOutdoor from './stoneTextureManifestOutdoor.json';
import stoneTextureManifestXCL from './stoneTextureManifestXCL.json';
import levels from './stoneTextureLevels.json';
import catalogue from './catalogueMap.json';
import { yieldToBrowser } from './assetScheduling';
import { loadMetric } from './loadDiagnostics';

type Entry = typeof stoneTextureManifest.entries[number] & { faceKey?: string };
type Item = {
  entry: Entry; texture: THREE.Texture; anchor?: THREE.Mesh; radius: number;
  preview?: ImageBitmap; detail?: ImageBitmap; busy: boolean; previewDone: boolean;
  detailFailed: boolean; distance: number; wanted: boolean;
};
const MAX_DETAILS = 8;

/** Keep every original UV crop/identity. Only the resolution of the sampled image changes. */
export function createStoneTextures(upload: (t: THREE.Texture) => Promise<void>, changed: () => void,
  progress: (loaded: number, total: number) => void = () => {}) {
  const abort = new AbortController();
  const textures: Record<string, THREE.Texture> = {};
  const entries = [...stoneTextureManifest.entries, ...stoneTextureManifestBL.entries,
    ...stoneTextureManifestOutdoor.entries, ...stoneTextureManifestXCL.entries]
    .filter(e => !catalogue.removed.includes(e.id)) as Entry[];
  const items: Item[] = entries.map(entry => {
    const texture = new THREE.Texture();
    texture.name = 'stone_image_' + entry.id;
    texture.userData = { ...entry, loadState: 'loading' };
    texture.encoding = THREE.sRGBEncoding;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = 4;
    const [x, y, width, height] = entry.crop, [iw, ih] = entry.imageSize;
    texture.repeat.set(width / iw, height / ih);
    texture.offset.set(x / iw, 1 - (y + height) / ih);
    textures[entry.id + (entry.faceKey ? ':' + entry.faceKey : '')] = texture;
    return { entry, texture, radius: 1, busy: false, previewDone: false, detailFailed: false, distance: Infinity, wanted: false };
  });
  const files = levels.files as Record<string, { preview: { file: string }; detail: { file: string } }>;
  const previewImages = new Map<string, Promise<ImageBitmap>>();
  const bitmaps = new Set<ImageBitmap>();
  const report = { previews: 0, total: items.length, details: 0, failed: 0 };
  let active = 0, started = false;
  function bind(scene: THREE.Scene) {
    const anchors = new Map<string, THREE.Mesh>();
    scene.traverse(o => {
      if (o instanceof THREE.Mesh && o.userData.hps) anchors.set(o.userData.hps.legacy_id || o.userData.hps.id, o);
    });
    for (const item of items) {
      item.anchor = anchors.get(item.entry.id);
      if (item.anchor) {
        item.anchor.geometry.computeBoundingSphere();
        item.radius = item.anchor.geometry.boundingSphere?.radius || 1;
      }
    }
    scene.userData.progressiveTextures = report;
  }
  async function decode(file: string) {
    const response = await fetch('/textures/stones/' + file.split('/').map(encodeURIComponent).join('/'), { signal: abort.signal });
    if (!response.ok) throw new Error(`石刻贴图 ${response.status}: ${file}`);
    const bitmap = await createImageBitmap(await response.blob(), {
      imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
    });
    if (abort.signal.aborted) { bitmap.close(); throw new DOMException('Disposed', 'AbortError'); }
    bitmaps.add(bitmap);
    return bitmap;
  }
  async function install(item: Item, bitmap: ImageBitmap) {
    item.texture.image = bitmap;
    item.texture.needsUpdate = true;
    // Upload before revealing the surface: the next scene draw has no decode/upload burst.
    await upload(item.texture);
    if (abort.signal.aborted) return;
    item.texture.userData.loadState = 'loaded';
    changed();
  }
  async function load(item: Item, detail: boolean) {
    item.busy = true; active++;
    try {
      const file = files[item.entry.file]?.[detail ? 'detail' : 'preview'].file;
      if (!file) throw new Error('Missing stone image level: ' + item.entry.file);
      if (detail) {
        item.detail = await decode(file);
        if (!abort.signal.aborted) await install(item, item.detail);
      } else {
        if (!previewImages.has(file)) previewImages.set(file, decode(file));
        item.preview = await previewImages.get(file)!;
        if (!abort.signal.aborted) await install(item, item.preview);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        if (detail) item.detailFailed = true;
        else { item.texture.userData.loadState = 'error'; report.failed++; changed(); }
        console.warn('石刻图像载入失败', item.entry.id, error);
      }
    } finally {
      if (!detail) { item.previewDone = true; report.previews++; }
      item.busy = false; active--;
      report.details = items.filter(i => i.detail).length;
      loadMetric('stoneTextures', { ...report });
      if (!detail && report.previews === items.length) loadMetric('previewsReady');
      if (!abort.signal.aborted && !detail) progress(report.previews, items.length);
      if (!abort.signal.aborted) { await yieldToBrowser(); pump(); }
    }
  }
  function pump() {
    if (!started || abort.signal.aborted) return;
    // Two decodes at a time, plus the shared one-at-a-time GPU upload queue.
    while (active < 2) {
      const next = items.filter(i => !i.busy && !i.previewDone).sort((a, b) => a.distance - b.distance)[0];
      if (next) { void load(next, false); continue; }
      const close = items.find(i => !i.busy && i.preview && i.wanted && !i.detail && !i.detailFailed);
      if (close) { void load(close, true); continue; }
      break;
    }
  }
  function update(camera: THREE.PerspectiveCamera, selected: string | null, viewportHeight: number) {
    const position = new THREE.Vector3();
    const projected = viewportHeight / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const visible = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const close: Item[] = [];
    for (const item of items) {
      if (!item.anchor) continue;
      item.anchor.getWorldPosition(position);
      const distance = camera.position.distanceTo(position);
      const chosen = item.anchor.userData.hps.id === selected;
      item.distance = chosen ? -1 : distance;
      item.wanted = false;
      if (chosen || (visible.containsPoint(position) && item.radius * projected / Math.max(1, distance) > 380)) close.push(item);
    }
    close.sort((a, b) => a.distance - b.distance).slice(0, MAX_DETAILS).forEach(i => { i.wanted = true; });
    // Bound GPU/decoded-image memory while walking through the whole collection.
    for (const item of items) if (item.detail && !item.wanted && !item.busy && item.preview) {
      const old = item.detail;
      item.detail = undefined; item.busy = true;
      void install(item, item.preview).catch(error => {
        if (!abort.signal.aborted) console.warn('石刻预览切换失败', item.entry.id, error);
      }).finally(() => {
        old.close(); bitmaps.delete(old); item.busy = false;
        report.details = items.filter(i => i.detail).length;
        pump();
      });
    }
    pump();
  }
  return {
    textures, report, bind, update,
    start() { started = true; pump(); },
    dispose() { abort.abort(); items.forEach(i => i.texture.dispose()); bitmaps.forEach(b => b.close()); bitmaps.clear(); },
  };
}
