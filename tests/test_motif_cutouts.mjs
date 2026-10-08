/** Pixel-level regressions for cited cutouts. No live platform files, network or DB writes. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const require = createRequire(process.env.WSC_NODE_MODULES + '/package.json')
const { build } = require('esbuild'), { createCanvas, Image, loadImage } = require('@napi-rs/canvas')
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/frontend/src/lib/motifCutouts.ts', import.meta.url))],
  nodePaths: [process.env.WSC_NODE_MODULES], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })
const fixture = createCanvas(80, 50), ctx = fixture.getContext('2d')
ctx.fillStyle = 'rgb(40,70,120)'; ctx.fillRect(0, 0, 80, 50)
const bytes = fixture.toBuffer('image/png'), requests = []
class SourceImage extends Image {
  get naturalWidth() { return this.width }
  get naturalHeight() { return this.height }
  set src(value) { requests.push(value); super.src = bytes }
}
const context = vm.createContext({ exports: {}, Blob, Image: SourceImage, Map, Set, location: { origin: 'https://fixture.example' },
  document: { createElement(tag) {
    assert.equal(tag, 'canvas')
    const canvas = createCanvas(1, 1)
    canvas.toBlob = callback => callback(new Blob([canvas.toBuffer('image/png')], { type: 'image/png' }))
    return canvas
  } },
})
context.module = { exports: context.exports }; vm.runInContext(bundle.outputFiles[0].text, context)
const { collectMotifs, cutoutPlan, renderMotifCutout, motifProvenance, motifReferenceScope } = context.module.exports
const asset = { id: 4, filename: 'fixture.jpg', kind: 'rubbing', extra: {} }
const stone = { id: '武152', name: '孔子见老子石', groups: [{ assets: [asset] }] }
const reference = { id: 1, kind: 'segment', segment_id: 705, source_missing: false }
const scene = { id: 3, asset_id: 4, parent_id: null, label: '问礼', level: 'scene', concept_ids: [8] }
const annotation = { id: 5, asset_id: 4, stone_id: '武152', parent_id: 3, tool: 'segment', atype: 'polygon', level: 'figure',
  geometry: { points: [[.2, .2], [.7, .2], [.2, .8]] }, label: '孔子', references: [reference], review_status: 'reviewed',
  note: '依据榜题与文献核对', semantics: {}, concept_ids: [9] }
let motifs = collectMotifs(stone, [scene, annotation])
assert.equal(motifs.length, 1)
assert.equal(motifs[0].ancestors[0].id, 3)
for (const change of [{ level: 'scene' }, { level: 'whole' }, { atype: 'rect' }, { tool: 'measure' }, { review_status: 'rejected' },
  { references: [] }, { references: [{ ...reference, source_missing: true }] }, { asset_id: 99 }, { label: '' },
  { geometry: { points: [[0, 0], [1, 1], [1.01, 0]] } }, { geometry: { points: [[0, 0], [.1, .1], [.2, .2]] } }]) {
  assert.equal(collectMotifs(stone, [scene, { ...annotation, ...change }]).length, 0)
}
assert.equal(collectMotifs(stone, [{ ...annotation, review_status: 'candidate', note: '' }]).length, 0)
assert.equal(collectMotifs(stone, [{ ...annotation, review_status: 'candidate' }]).length, 1)
assert.equal(collectMotifs(stone, [{ ...annotation, level: 'band' }]).length, 1,
  'A named, cited, saved whole ornament band is a usable cutout')
assert.equal(collectMotifs(stone, [{ ...scene, asset_id: 9 }, annotation])[0].ancestors.length, 0)
const plan = cutoutPlan(motifs[0].points, 80, 50)
assert.equal(plan.x, 13); assert.equal(plan.y, 7)
assert.equal(plan.outputWidth, 46); assert.equal(plan.outputHeight, 36)
const png = await renderMotifCutout(motifs[0]), image = await loadImage(Buffer.from(await png.arrayBuffer()))
assert.equal(image.width, 46); assert.equal(image.height, 36)
const output = createCanvas(image.width, image.height), pixels = output.getContext('2d')
pixels.drawImage(image, 0, 0)
assert.deepEqual([...pixels.getImageData(0, 0, 1, 1).data], [0, 0, 0, 0], 'Cutout corners outside the outline stay transparent')
assert.deepEqual([...pixels.getImageData(17, 13, 1, 1).data], [40, 70, 120, 255], 'The shape contains exact source pixels, with no overlay colour')
assert.equal(pixels.getImageData(40, 29, 1, 1).data[3], 0, 'The bounding rectangle must not become an opaque crop')
motifs[0].asset.extra.cutout_rotation_ccw = 90
const rotated = await renderMotifCutout(motifs[0]), upright = await loadImage(Buffer.from(await rotated.arrayBuffer()))
assert.equal(upright.width, 36); assert.equal(upright.height, 46)
assert.deepEqual(requests, ['/api/assets/4/preview'], 'Figures on a shared source reuse its decoded image')
const provenance = motifProvenance(motifs[0])
assert.equal(provenance.annotation_id, 5); assert.equal(provenance.references[0].segment_id, 705)
assert.deepEqual([...provenance.concept_ids].sort(), [8, 9])
assert.equal(provenance.orientation_ccw, 90)
assert.equal(motifReferenceScope(motifs[0]), 'source_reference', 'A source citation does not assert object identity')
const comparison = { ...motifs[0], ancestors: [{ ...scene, note: '文献关联性质：类型参照。\n这幅书图为同类纹样示例。' }] }
assert.equal(motifReferenceScope(comparison), 'typology', 'A child cutout inherits the explicit scope of its source scene')
assert.equal(motifProvenance(comparison).reference_scope, 'typology', 'Exported provenance must retain comparison scope')
assert.equal(motifReferenceScope({ ...motifs[0], annotation: { ...annotation, note: '已排除错误的类型参照，按原书本石核对。' } }), 'source_reference', 'Incidental prose must not be mistaken for an explicit scope marker')
console.log('Motif cutout eligibility, transparent pixels, original colours, rotation and provenance: PASS')
