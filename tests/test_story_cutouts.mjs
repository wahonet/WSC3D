/** Scene membership and pixel regressions: keep spatial context, trace every source. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
const require = createRequire(process.env.WSC_NODE_MODULES + '/package.json')
const { build } = require('esbuild'), { createCanvas, Image, loadImage } = require('@napi-rs/canvas')
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/frontend/src/lib/storyCutouts.ts', import.meta.url))],
  nodePaths: [process.env.WSC_NODE_MODULES], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })
const fixture = createCanvas(80, 50), ctx = fixture.getContext('2d')
for (let x = 0; x < 80; x++) { ctx.fillStyle = `rgb(${x},70,120)`; ctx.fillRect(x, 0, 1, 50) }
const bytes = fixture.toBuffer('image/png')
class SourceImage extends Image {
  get naturalWidth() { return this.width } get naturalHeight() { return this.height }
  set src(value) { super.src = bytes }
}
const context = vm.createContext({ exports: {}, Blob, Image: SourceImage, Map, Set, location: { origin: 'https://fixture.example' },
  document: { createElement(tag) {
    assert.equal(tag, 'canvas'); const canvas = createCanvas(1, 1)
    canvas.toBlob = callback => callback(new Blob([canvas.toBuffer('image/png')], { type: 'image/png' })); return canvas
  } },
})
context.module = { exports: context.exports }; vm.runInContext(bundle.outputFiles[0].text, context)
const { collectStories, sceneOutline, storyReferences, storyConceptIds, renderStoryCutout, storyProvenance } = context.module.exports
const asset = { id: 4, kind: 'rubbing', filename: 'scene.jpg', extra: {} }
const stone = { id: '武152', name: 'fixture', groups: [{ assets: [asset] }] }
const ref = { id: 1, kind: 'segment', segment_id: 705, source_missing: false }
const scene = { id: 3, asset_id: 4, stone_id: '武152', parent_id: null, label: '问礼', level: 'scene', atype: 'rect',
  geometry: { x: 0, y: 0, w: 1, h: 1 }, geometry_intent: 'semantic_extent', review_status: 'reviewed',
  note: '文献关联性质：类型参照。', concept_ids: [8], references: [ref], semantics: {} }
const figure = { ...scene, id: 5, parent_id: 3, label: '左人物', level: 'figure', atype: 'polygon', tool: 'segment',
  geometry: { points: [[.1,.2],[.3,.2],[.3,.4],[.1,.4]] }, geometry_intent: 'visible_trace', concept_ids: [9] }
const right = { ...figure, id: 6, label: '右人物', concept_ids: [10],
  geometry: { points: [[.65,.2],[.65,.4],[.85,.4],[.85,.2]] } } // Opposite winding must still form a union.
const candidate = { ...figure, id: 7, review_status: 'candidate', note: '边缘磨蚀',
  geometry: { points: [[.4,.6],[.6,.6],[.6,.8],[.4,.8]] } }
let stories = collectStories(stone, [scene, figure, right, candidate])
assert.equal(stories.length, 1); assert.equal(stories[0].motifs.length, 3)
for (const change of [{ review_status: 'rejected' }, { level: 'figure' }, { stone_id: '武151' }, { asset_id: 99 },
  { atype: 'none' }, { references: [] }, { references: [{ ...ref, source_missing: true }] },
  { geometry_intent: 'reconstructed_extent' }, { geometry: { x: 0, y: 0, w: -1, h: 1 } },
  { geometry: { x: 0, y: 0, w: 1, h: Infinity } }, { geometry: { x: .9, y: 0, w: .3, h: 1 } },
  { parent_id: 99 }, { parent_id: 3 }, { review_status: 'candidate', note: '' }]) {
  assert.equal(collectStories(stone, [{ ...scene, ...change }, figure, right]).length, 0)
}
assert.equal(sceneOutline({ ...scene, geometry: { x: 0, y: .7, w: 1, h: .30000000000000004 } }).length, 4)
const otherScene = { ...scene, id: 20, label: '问礼' }
const unrelated = { ...right, id: 21, parent_id: 20 }
const crossImage = { ...figure, id: 22, asset_id: 9 }
const crossStone = { ...figure, id: 23, stone_id: '武151' }
const rejectedParent = { ...figure, id: 24, review_status: 'rejected' }
const hiddenChild = { ...figure, id: 25, parent_id: 24 }
stories = collectStories(stone, [scene, otherScene, figure, right, candidate, unrelated, crossImage, crossStone, rejectedParent, hiddenChild])
assert.deepEqual(Array.from(stories[0].descendants, a => a.id), [5,6,7], 'Same names, other images/stones and rejected ancestry never attach children')
assert.deepEqual([...storyConceptIds(stories[0])].sort((a,b) => a-b), [8,9,10])
assert.equal(storyReferences(stories[0]).length, 1, 'Repeated citations deduplicate by their source identity')
const nested = { ...figure, id: 30, level: 'component', parent_id: 5 }
assert.equal(collectStories(stone, [scene, figure, nested])[0].motifs.length, 2, 'Nested components keep their saved ancestry')
const versionMeta = (canonical, sourceAsset = 4) => ({ format: 'wsc-segmentation-version-1',
  canonical_annotation_id: canonical, canonical_asset_id: 4, source_asset_id: sourceAsset,
  source_filename: asset.filename, source_sha256: '0'.repeat(64), source_label: 'fixture',
  native_boundary_reviewed: true, segmentation: { review_policy: 'object-level-extraction-20261004' } })
const revisedScene = { ...scene, id: 31, atype: 'polygon', geometry: {
  points: [[0,0],[1,0],[1,1],[0,1]], image_version: versionMeta(3) } }
const revisedFigure = { ...figure, id: 32, parent_id: 31, geometry: { ...figure.geometry,
  native_mask: { format: 'wsc-binary-mask-rle-1', size: [1,1], extent: [.1,.2,.3,.4], counts: [0,1],
    foreground_pixels: 1, binary_sha256: '1'.repeat(64) }, image_version: versionMeta(5) } }
const retainedTool = { ...revisedFigure, tool: 'annotate', parent_id: 3 }
assert.equal(collectStories(stone, [scene, figure, retainedTool])[0].motifs.length, 1,
  'A checked native subject remains visible when its historical annotate tool is retained')
const nativeBand = { ...retainedTool, level: 'band', label: '整体双菱纹带' }
assert.equal(collectStories(stone, [scene, { ...figure, level: 'band' }, nativeBand])[0].motifs.length, 1,
  'A checked whole band can appear as one band without splitting decorative units')
for (const geometry of [figure.geometry, { ...retainedTool.geometry, native_mask: undefined },
  { ...retainedTool.geometry, image_version: { ...versionMeta(5), native_boundary_reviewed: false } },
  { ...retainedTool.geometry, native_mask: { ...retainedTool.geometry.native_mask, counts: [3] } }]) {
  assert.equal(collectStories(stone, [scene, { ...retainedTool, geometry }])[0].motifs.length, 0,
    'Coarse ranges, unverified sources and invalid masks cannot enter as native cutouts')
}
const olderFigureVersion = { ...revisedFigure, id: 33 }
const revisedMembers = collectStories(stone, [scene, figure, right, revisedScene, revisedFigure, olderFigureVersion])
assert.deepEqual(Array.from(revisedMembers.find(s => s.annotation.id === 31).motifs, m => m.annotation.id), [6,33],
  'A same-source scene replacement retains original members and shows only the preferred version of each figure')
const invalidReplacement = { ...revisedScene, geometry: { ...revisedScene.geometry, image_version: versionMeta(3,99) } }
assert.equal(collectStories(stone, [scene, figure, invalidReplacement]).find(s => s.annotation.id === 31).motifs.length, 0,
  'Unverified source identity cannot acquire original scene members')
const hiddenSceneAnchor = { ...scene, atype: 'none', geometry: {} }
const photoAsset = { ...asset, id: 9, kind: 'photo', filename: 'scene.tif' }
const photoScene = { ...revisedScene, id: 34, asset_id: photoAsset.id, geometry: {
  ...revisedScene.geometry, image_version: { ...versionMeta(3, photoAsset.id), source_filename: photoAsset.filename } } }
const anchoredStories = collectStories({ ...stone, groups: [{ assets: [asset, photoAsset] }] },
  [hiddenSceneAnchor, revisedScene, photoScene])
assert.equal(anchoredStories.length, 2, 'An identity-only anchor never becomes an extra story cutout')
assert.ok(anchoredStories.every(s => s.canonicalAnnotation?.id === scene.id),
  'Story source versions retain their checked identity when the original anchor has no eligible cutout')
async function pixels(blob) {
  const image = await loadImage(Buffer.from(await blob.arrayBuffer())), canvas = createCanvas(image.width, image.height)
  const result = canvas.getContext('2d'); result.drawImage(image, 0, 0)
  return { image, at: (x,y) => [...result.getImageData(x,y,1,1).data] }
}
const full = await pixels(await renderStoryCutout(stories[0], 'scene'))
assert.equal(full.image.width, 80); assert.equal(full.image.height, 50)
assert.deepEqual(full.at(40,25), [40,70,120,255], 'Context retains the original surface between people')
const union = await pixels(await renderStoryCutout(stories[0], 'composition'))
assert.equal(union.image.width, 80); assert.equal(union.image.height, 50)
assert.deepEqual(union.at(14,15), [14,70,120,255]); assert.deepEqual(union.at(60,15), [60,70,120,255])
assert.equal(union.at(40,25)[3], 0, 'The space between the two people stays transparent and unchanged in width')
assert.equal(union.at(40,35)[3], 0, 'Candidate fragments are off by default')
const withCandidate = await pixels(await renderStoryCutout(stories[0], 'composition', 1800, true))
assert.deepEqual(withCandidate.at(40,35), [40,70,120,255])
const overlap = { ...right, geometry: { points: [[.2,.2],[.2,.4],[.4,.4],[.4,.2]] } }
assert.deepEqual((await pixels(await renderStoryCutout(collectStories(stone, [scene, figure, overlap])[0], 'composition'))).at(20,15), [20,70,120,255], 'Overlapping opposite-winding shapes do not cancel')
const bounded = { ...scene, geometry: { x: .2, y: 0, w: .6, h: 1 } }
const clipped = await pixels(await renderStoryCutout(collectStories(stone, [bounded, figure, right])[0], 'composition'))
assert.equal(clipped.at(1,15)[3], 0, 'Saved child edges outside the scene are clipped, never moved')
const exportData = storyProvenance(stories[0], 'scene')
assert.equal(exportData.extraction, 'annotated_scene_crop'); assert.equal(exportData.scene_reference_scope, 'typology')
assert.equal(exportData.descendants[0].parent_id, 3); assert.equal(exportData.motifs.length, 2)
assert.equal(storyProvenance(stories[0], 'composition', true).motifs.length, 3)
await assert.rejects(renderStoryCutout(collectStories(stone, [scene])[0], 'composition'), /尚无/)
asset.extra.cutout_rotation_ccw = 90
const rotated = await pixels(await renderStoryCutout(stories[0], 'scene'))
assert.equal(rotated.image.width, 50); assert.equal(rotated.image.height, 80)
console.log('Story eligibility, hierarchy, source identity, original positions/pixels, union, candidate scope, clipping, rotation and provenance: PASS')
