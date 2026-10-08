/** Verify native masks in actual PNG exports, including holes and separated one-pixel pieces. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const require = createRequire(process.env.WSC_NODE_MODULES + '/package.json')
const { build } = require('esbuild'), { createCanvas, Image, loadImage, Path2D } = require('@napi-rs/canvas')
const bundle = await build({
  stdin: { contents: `export * from './src/lib/motifCutouts'; export * from './src/lib/nativeMasks'; export * from './src/lib/storyCutouts'; export * from './src/lib/sourceFrames'; export {annotationBounds} from './src/lib/geometry';`,
    resolveDir: fileURLToPath(new URL('../src/frontend/', import.meta.url)), loader: 'ts' },
  nodePaths: [process.env.WSC_NODE_MODULES], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
})
const fixture = createCanvas(80, 50), source = fixture.getContext('2d')
source.fillStyle = 'rgb(40,70,120)'; source.fillRect(0, 0, 80, 50)
const bytes = fixture.toBuffer('image/png')
const wide = createCanvas(2401, 3), wideContext = wide.getContext('2d')
wideContext.fillStyle = 'rgb(7,91,146)'; wideContext.fillRect(0, 0, 2401, 3)
const wideBytes = wide.toBuffer('image/png')
const requests = []
const bitmapOptions = []
class SourceImage extends Image {
  get naturalWidth() { return this.width }
  get naturalHeight() { return this.height }
  set src(url) { requests.push(url); super.src = url.includes('/77/') ? wideBytes : bytes }
}
const context = vm.createContext({ module: { exports: {} }, Blob, Image: SourceImage, location: { origin: 'https://fixture.example' },
  fetch: async url => { requests.push(url); return { ok: true, blob: async () => new Blob([url.includes('/77/') ? wideBytes : bytes]) } },
  createImageBitmap: async (blob, options) => { bitmapOptions.push(options); return loadImage(Buffer.from(await blob.arrayBuffer())) },
  document: { createElement(tag) {
    assert.equal(tag, 'canvas')
    const canvas = createCanvas(1, 1)
    canvas.toBlob = callback => callback(new Blob([canvas.toBuffer('image/png')], { type: 'image/png' }))
    return canvas
  } },
})
vm.runInContext(bundle.outputFiles[0].text, context)
const { collectMotifs, cutoutPlan, renderMotifCutout, renderMotifPreview, nativeMask, nativeMaskBounds, nativeMaskPaths, nativeMaskCanvas, nativeMaskPreviewCanvas, MAX_NATIVE_MASK_PIXELS, annotationBounds, collectStories, renderStoryCutout, renderStoryPreview, motifProvenance, storyProvenance, cutoutSource } = context.module.exports
const binary = new Uint8Array(80 * 50)
for (let y = 5; y < 30; y++) for (let x = 5; x < 30; x++) binary[y * 80 + x] = 1
for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) binary[y * 80 + x] = 0
for (let y = 2; y < 40; y++) binary[y * 80 + 50] = 1
binary[45 * 80 + 65] = 1
const counts = [0]
for (const bit of binary) { if ((counts.length - 1) % 2 === bit) counts[counts.length - 1]++; else counts.push(1) }
const mask = { format: 'wsc-binary-mask-rle-1', size: [50, 80], extent: [0, 0, 1, 1], counts,
  foreground_pixels: binary.reduce((sum, bit) => sum + bit, 0), binary_sha256: createHash('sha256').update(binary).digest('hex') }
nativeMask(mask)
assert.deepEqual([...nativeMaskBounds(mask)], [5 / 80, 2 / 50, 66 / 80, 46 / 50])
const asset = { id: 4, filename: 'native-source.tif', kind: 'photo', extra: {} }
const stone = { id: '武010', name: '东壁', groups: [{ assets: [asset] }] }
const annotation = { id: 1, asset_id: 4, stone_id: stone.id, tool: 'segment', atype: 'polygon', level: 'figure',
  geometry: { points: [[5 / 80, 5 / 50], [30 / 80, 5 / 50], [30 / 80, 30 / 50], [5 / 80, 30 / 50]], native_mask: mask },
  label: 'native', references: [{ id: 1, kind: 'segment', source_missing: false }], review_status: 'reviewed', note: '', concept_ids: [], semantics: {} }
const motif = collectMotifs(stone, [annotation])[0]
assert.ok(motif)
assert.deepEqual([...annotationBounds(annotation)], [5/80, 2/50, 61/80, 44/50], 'Workbench focus includes every native component')
const svgPaths = nativeMaskPaths(mask), svg = createCanvas(80, 50), svgCtx = svg.getContext('2d')
svgCtx.fillStyle = 'white'; svgCtx.fill(new Path2D(svgPaths.fill))
for (let y = 0; y < 50; y++) for (let x = 0; x < 80; x++) {
  assert.equal(svgCtx.getImageData(x, y, 1, 1).data[3], binary[y*80+x]*255,
    `SVG workbench fill must match PNG alpha at ${x},${y}`)
}
svgCtx.clearRect(0, 0, 80, 50); svgCtx.strokeStyle = 'white'; svgCtx.lineWidth = .5
svgCtx.stroke(new Path2D(svgPaths.boundary))
assert.equal(svgCtx.getImageData(7, 7, 1, 1).data[3], 0, 'Outline does not draw internal row seams')
assert.equal(svgCtx.getImageData(12, 12, 1, 1).data[3], 0, 'Outline does not fill a hole')
assert.ok(svgCtx.getImageData(10, 15, 1, 1).data[3] > 0, 'Interior hole edge is outlined')
assert.ok(svgCtx.getImageData(65, 45, 1, 1).data[3] > 0, 'Isolated single-pixel piece is outlined')
const [x0, y0, x1, y1] = nativeMaskBounds(mask)
const plan = cutoutPlan([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], 80, 50)
const png = await renderMotifCutout(motif), image = await loadImage(Buffer.from(await png.arrayBuffer()))
assert.equal(requests[0], '/api/assets/4/work-image', 'Native masks must use the matching high-resolution source')
const canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d')
ctx.drawImage(image, 0, 0)
const pixel = (x, y) => [...ctx.getImageData(x - plan.x, y - plan.y, 1, 1).data]
for (const [x, y] of [[6, 6], [29, 29], [50, 2], [50, 39], [65, 45]]) {
  assert.deepEqual(pixel(x, y), [40, 70, 120, 255], `Native foreground at ${x},${y} must preserve source RGB`)
}
for (const [x, y] of [[12, 12], [49, 20], [51, 20], [65, 44], [4, 5]]) {
  assert.equal(pixel(x, y)[3], 0, `Background/hole at ${x},${y} must remain transparent`)
}
for (const invalid of [{ ...mask, counts: [4001] }, { ...mask, counts: [-1, 4001] },
  { ...mask, size: [50000, 50000] }, { ...mask, extent: [0, 0, 1.1, 1] },
  { ...mask, foreground_pixels: 0 }, { ...mask, binary_sha256: 'bad' }]) {
  assert.throws(() => nativeMask(invalid), /分割掩膜数据无效/)
  assert.equal(collectMotifs(stone, [{ ...annotation, geometry: { ...annotation.geometry, native_mask: invalid } }]).length, 0,
    'Invalid native masks must never be exhibited using the rough legacy polygon')
}
const legacy = { ...annotation, id: 2, parent_id: 9, geometry: { points: [[.4, .3], [.55, .3], [.55, .5], [.4, .5]] } }
const scene = { ...annotation, id: 9, atype: 'rect', level: 'scene', geometry: { x: 0, y: 0, w: .8, h: .8 } }
const story = collectStories(stone, [{ ...annotation, parent_id: 9 }, legacy, scene])[0]
assert.ok(story)
const combined = await renderStoryCutout(story, 'composition', 1200)
const compositionImage = await loadImage(Buffer.from(await combined.arrayBuffer()))
const composition = createCanvas(compositionImage.width, compositionImage.height), compositionCtx = composition.getContext('2d')
compositionCtx.drawImage(compositionImage, 0, 0)
assert.deepEqual([...compositionCtx.getImageData(35, 17, 1, 1).data], [40, 70, 120, 255], 'Legacy members join the native alpha union')
assert.equal(compositionCtx.getImageData(12, 12, 1, 1).data[3], 0, 'Native holes remain transparent in a mixed story')
assert.equal(compositionCtx.getImageData(50, 39, 1, 1).data[3], 255, 'Native thin components preserve their original scene positions')
assert.equal(compositionCtx.getImageData(65, 40, 1, 1).data[3], 0, 'Scene limits clip unrelated outer fragments')
await renderMotifCutout(collectMotifs(stone, [legacy])[0])
assert.equal(requests[requests.length-1], '/api/assets/4/preview', 'High-resolution and preview requests must not share the same cache entry')

function originalFrame(motif, width = 80, height = 50) {
  const sourceSHA = '2'.repeat(64), workingSHA = '3'.repeat(64), cropSHA = '4'.repeat(64)
  const frame = { format: 'wsc-original-pixel-frame-1', source_sha256: sourceSHA, frame_index: 0,
    original_size: [width, height], working_size: [width, height], working_sha256: workingSHA,
    working_conversion: "Pillow RGB, no resize", crop_pixels: [0, 0, width, height], crop_size: [width, height], crop_sha256: cropSHA }
  return { ...motif, asset: { ...motif.asset, width, height, sha256: sourceSHA }, annotation: { ...motif.annotation, geometry: {
    ...motif.annotation.geometry, image_version: { format: 'wsc-segmentation-version-1', canonical_annotation_id: 123,
      canonical_asset_id: motif.asset.id, source_asset_id: motif.asset.id, source_filename: motif.asset.filename,
      source_sha256: sourceSHA, source_label: '来源批次未注明', native_boundary_reviewed: true,
      segmentation: { work_image_sha256: workingSHA, crop_sha256: cropSHA, pixel_frame_record: 'verified.json', pixel_frame: frame } } } } }
}
const fullNative = originalFrame(motif)
const fastNative = originalFrame({ ...motif, asset: { ...asset, id: 79 }, annotation: { ...annotation, asset_id: 79 } })
const beforePreview = bitmapOptions.length
await renderMotifPreview(fastNative, 650)
assert.equal(requests.at(-1), '/api/assets/79/preview', 'Cards use the light preview even for a TIFF with a verified native frame')
await renderMotifPreview(fastNative, 1800)
assert.equal(requests.at(-1), '/api/assets/79/work-image', 'Details use the cached high-quality JPEG instead of downloading a full native PNG')
assert.equal(bitmapOptions.length, beforePreview, 'Browsing does not decode any full original pixel frame')
const fastStory = { ...story, asset: fastNative.asset, motifs: [fastNative] }
await renderStoryPreview(fastStory, 'composition', 650)
assert.equal(bitmapOptions.length, beforePreview, 'Story composition previews also avoid native frame decoding')
await assert.rejects(renderMotifPreview({ ...fastNative, annotation: { ...fastNative.annotation, geometry: {
  ...fastNative.annotation.geometry, image_version: { ...fastNative.annotation.geometry.image_version,
    segmentation: { pixel_frame_record: 'missing.json' } } } } }), /原像素来源记录不一致/,
  'A preview does not bypass invalid source provenance')
function withRgbFrame(item, rawSHA, workingSHA = '3'.repeat(64)) {
  const version = item.annotation.geometry.image_version
  return { ...item, annotation: { ...item.annotation, geometry: { ...item.annotation.geometry,
    image_version: { ...version, segmentation: { ...version.segmentation, work_image_sha256: workingSHA,
      pixel_frame: { ...version.segmentation.pixel_frame, working_sha256: workingSHA, working_rgb_sha256: rawSHA } } } } } }
}
const rgbNative = withRgbFrame(fullNative, '5'.repeat(64))
assert.match(cutoutSource(rgbNative).url, /working_rgb_sha256=5{64}$/)
const reencodedNative = withRgbFrame(fullNative, '5'.repeat(64), '6'.repeat(64))
assert.match(cutoutSource(rgbNative, [reencodedNative]).url, /native-frame/, 'Equal full original RGB can use different PNG encodings')
assert.throws(() => cutoutSource(rgbNative, [withRgbFrame(fullNative, '7'.repeat(64))]), /不同像素帧/)
assert.throws(() => cutoutSource(withRgbFrame(fullNative, 'bad')), /原像素来源记录不一致/)
assert.match(cutoutSource(fullNative, [rgbNative]).url, /working_rgb_sha256=5{64}$/, 'A mixed provenance group verifies its explicit full RGB hash')
const rawPNG = await renderMotifCutout(fullNative, Infinity)
const rawImage = await loadImage(Buffer.from(await rawPNG.arrayBuffer()))
assert.equal(requests[requests.length-1], '/api/assets/4/native-frame?source_sha256=' + '2'.repeat(64) + '&frame_index=0&working_sha256=' + '3'.repeat(64), 'Original frame never uses the JPEG work preview')
assert.equal(motifProvenance(fullNative).source_image_url, 'https://fixture.example' + requests[requests.length-1], 'Saved provenance names the exact renderer source')
assert.deepEqual(JSON.parse(JSON.stringify(bitmapOptions[0])), { colorSpaceConversion: 'none', imageOrientation: 'none', premultiplyAlpha: 'none' }, 'Original RGB decoding must ignore ICC and EXIF transformations')
const secondFrame = originalFrame({ ...motif, asset: { ...asset, id: 80 }, annotation: { ...annotation, asset_id: 80 } })
secondFrame.annotation.geometry.image_version.segmentation.pixel_frame.frame_index = 1
await renderMotifPreview(secondFrame, 650)
assert.match(requests.at(-1), /\/80\/native-frame\?.*&frame_index=1&/,
  'A nonzero TIFF page cannot silently use the JPEG preview of frame zero')
assert.deepEqual([rawImage.width, rawImage.height], [image.width, image.height])
const rawCanvas = createCanvas(rawImage.width, rawImage.height), rawContext = rawCanvas.getContext('2d'); rawContext.drawImage(rawImage, 0, 0)
for (let y = 0; y < rawImage.height; y++) for (let x = 0; x < rawImage.width; x++) {
  assert.deepEqual([...rawContext.getImageData(x, y, 1, 1).data], [...ctx.getImageData(x, y, 1, 1).data], 'Full original source preserves RGB and binary topology')
}
const mixedOriginalStory = { ...story, asset: fullNative.asset, motifs: [{ ...fullNative, annotation: { ...fullNative.annotation, parent_id: 9 } }] }
assert.match(storyProvenance(mixedOriginalStory, 'composition').source_image_url, /native-frame/, 'Legacy parent plus native child shares the original PNG in renderer and provenance')
const reduced = { ...motif, annotation: { ...motif.annotation, geometry: { ...motif.annotation.geometry,
  native_mask: { ...mask, size: [25, 40], counts: [0, 1000], foreground_pixels: 1000 } } } }
assert.throws(() => cutoutSource(mixedOriginalStory, [fullNative, reduced]), /禁止放大/, 'A downsampled legacy bitmap cannot join a full-original frame')
const brokenFrame = { ...fullNative, annotation: { ...fullNative.annotation, geometry: { ...fullNative.annotation.geometry,
  image_version: { ...fullNative.annotation.geometry.image_version, segmentation: { pixel_frame_record: 'missing.json' } } } } }
assert.throws(() => cutoutSource(brokenFrame), /原像素来源记录不一致/, 'Explicit frame failures never silently fall back to a resized source')
const wrongSize = originalFrame({ ...motif, asset: { ...asset, id: 78 }, annotation: { ...annotation, geometry: { ...annotation.geometry,
  native_mask: { ...mask, size: [50, 81], counts: [0, 4050], foreground_pixels: 4050 } } } }, 81, 50)
await assert.rejects(renderMotifCutout(wrongSize, Infinity), /返回来源图像的尺寸/, 'Server response with wrong dimensions is rejected')
const wideMotif = originalFrame({ ...motif, asset: { ...asset, id: 77 }, annotation: { ...annotation, geometry: { ...annotation.geometry,
  native_mask: { ...mask, size: [3, 2401], counts: [0, 7203], foreground_pixels: 7203 } } } }, 2401, 3)
const download = await loadImage(Buffer.from(await (await renderMotifCutout(wideMotif, Infinity)).arrayBuffer()))
assert.deepEqual([download.width, download.height], [2401, 3], 'Full-size download exceeds the UI 1800px limit without enlarging source or mask')
const downloadCanvas = createCanvas(2401, 3), downloadContext = downloadCanvas.getContext('2d'); downloadContext.drawImage(download, 0, 0)
assert.deepEqual([...downloadContext.getImageData(2400, 2, 1, 1).data], [7, 91, 146, 255], 'Original edge pixels survive a full-size download')
// 807's complete photographed letter layout must pass at its native 18.25M
// pixels. Its isolated corner pixels and a real internal gap survive alpha.
const photoWidth = 2450, photoHeight = 7450, photoTotal = photoWidth * photoHeight
const photoCounts = [0, 1, photoWidth - 1, photoTotal - 2 * photoWidth, photoWidth - 1, 1]
const photoMask = nativeMask({ ...mask, size: [photoHeight, photoWidth], counts: photoCounts,
  foreground_pixels: photoTotal - 2 * photoWidth + 2, extent: [0, 0, 1, 1] })
const smallAlpha = nativeMaskPreviewCanvas(photoMask, 256)
assert.ok(smallAlpha.width <= 256 && smallAlpha.height <= 256, 'Browsing does not allocate an 18.25M-pixel alpha canvas')
assert.equal(smallAlpha.getContext('2d').getImageData(0, 0, 1, 1).data[3], 255, 'Coverage sampling retains isolated tiny components')
assert.equal(smallAlpha.getContext('2d').getImageData(smallAlpha.width-1, smallAlpha.height-1, 1, 1).data[3], 255)
assert.equal(nativeMaskPreviewCanvas(photoMask, 256), smallAlpha, 'Repeated previews reuse the bounded mask canvas')
const smallHole = nativeMaskPreviewCanvas(mask, 40), smallHoleCtx = smallHole.getContext('2d')
assert.equal(smallHoleCtx.getImageData(7, 7, 1, 1).data[3], 0, 'Visible internal holes survive the lightweight mask')
assert.equal(smallHoleCtx.getImageData(25, 10, 1, 1).data[3], 255, 'Thin observed lines remain visible')
const photoAlpha = nativeMaskCanvas(photoMask), photoCtx = photoAlpha.getContext('2d')
assert.deepEqual([photoAlpha.width, photoAlpha.height], [2450, 7450], 'Large native mask keeps the entire observed photo frame')
assert.equal(photoCtx.getImageData(0, 0, 1, 1).data[3], 255, 'Isolated first pixel survives')
assert.equal(photoCtx.getImageData(1, 0, 1, 1).data[3], 0, 'External top-row gap stays transparent')
assert.equal(photoCtx.getImageData(1230, 4000, 1, 1).data[3], 255, 'Interior survives without downsampling')
assert.equal(photoCtx.getImageData(photoWidth - 1, photoHeight - 1, 1, 1).data[3], 255, 'Isolated last pixel survives')
assert.throws(() => nativeMask({ ...mask, size: [1, MAX_NATIVE_MASK_PIXELS + 1], counts: [0, MAX_NATIVE_MASK_PIXELS + 1], foreground_pixels: MAX_NATIVE_MASK_PIXELS + 1 }), /掩膜数据无效/)
console.log('PASS: native topology/RGB, full 18.25M-pixel alpha, high-resolution source, mixed story union/limits, and invalid-mask rejection')
