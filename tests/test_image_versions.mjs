/** Explicit source provenance, rather than identical labels, links native versions. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const require = createRequire(process.env.WSC_NODE_MODULES + '/package.json')
const { build } = require('esbuild')
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/frontend/src/lib/imageVersions.ts', import.meta.url))],
  nodePaths: [process.env.WSC_NODE_MODULES], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
})
const context = vm.createContext({ module: { exports: {} } })
vm.runInContext(bundle.outputFiles[0].text, context)
const { imageVersion, imageVersionLabel, associatedImageVersions, preferredImageVersion, displayImageVersions, galleryImageVersionGroups } = context.module.exports
const base = { stone: { id: '武010' }, asset: { id: 185, kind: 'rubbing', filename: 'image1.jpeg' },
  annotation: { id: 139, level: 'figure', label: '齐继母', geometry: {} } }
const meta = { format: 'wsc-segmentation-version-1', canonical_annotation_id: 139, canonical_asset_id: 185,
  source_asset_id: 182, source_filename: '东壁（2024年阮浩）.jpg', source_sha256: '0'.repeat(64),
  source_label: '2024年阮浩', native_boundary_reviewed: true, segmentation: {} }
const photo = { ...base, asset: { id: 182, kind: 'photo', filename: meta.source_filename },
  annotation: { ...base.annotation, id: 6000, geometry: { image_version: meta } } }
const changed = overrides => ({ ...photo, annotation: { ...photo.annotation, geometry: { image_version: { ...meta, ...overrides } } } })
const unrelated = { ...base, annotation: { ...base.annotation, id: 6010 } }
const otherStone = { ...photo, stone: { id: '武011' } }
const cyclic = { ...base, annotation: { ...base.annotation, geometry: { image_version: { ...meta,
  canonical_annotation_id: 6000, canonical_asset_id: 182, source_asset_id: 185, source_filename: 'image1.jpeg' } } } }
const ids = rows => Array.from(rows, row => row.annotation.id)
assert.deepEqual(ids(associatedImageVersions(base, [base, photo, unrelated, otherStone])), [139, 6000])
assert.deepEqual(ids(associatedImageVersions(photo, [base, photo, unrelated])), [139, 6000])
assert.deepEqual(ids(associatedImageVersions(photo, [cyclic, photo])), [6000], 'Cycles cannot establish correspondence')
const rectangleAnchor = { ...base.annotation, stone_id: '武010', asset_id: 185, atype: 'rect' }
const anchoredPhoto = { ...photo, canonicalAnnotation: rectangleAnchor }
const anotherAnchoredPhoto = { ...anchoredPhoto, annotation: { ...photo.annotation, id: 6100 },
  asset: { ...photo.asset, id: 183, filename: 'another.tif' } }
anotherAnchoredPhoto.annotation = { ...anotherAnchoredPhoto.annotation, geometry: { image_version: {
  ...meta, source_asset_id: 183, source_filename: 'another.tif', source_sha256: '2'.repeat(64) } } }
assert.deepEqual(ids(associatedImageVersions(anchoredPhoto, [anchoredPhoto, anotherAnchoredPhoto])), [6000,6100],
  'An existing rectangle anchor links checked native versions without exhibiting the rectangle as a silhouette')
const invalidAnchorPhoto = { ...anchoredPhoto, canonicalAnnotation: { ...rectangleAnchor, stone_id: '武011' } }
assert.deepEqual(ids(associatedImageVersions(invalidAnchorPhoto, [invalidAnchorPhoto, anotherAnchoredPhoto])), [6000],
  'A cross-stone anchor cannot link native versions')
for (const overrides of [{ source_asset_id: 999 }, { source_filename: 'unrelated.jpg' },
  { source_sha256: 'bad' }, { native_boundary_reviewed: false }, { canonical_annotation_id: 0 }]) {
  assert.equal(imageVersion(changed(overrides)), null)
}
for (const overrides of [{ canonical_asset_id: 999 }, { canonical_annotation_id: 6010 }]) {
  assert.deepEqual(ids(associatedImageVersions(changed(overrides), [base, changed(overrides)])), [6000])
}
assert.equal(imageVersionLabel(photo), '2024年阮浩拍摄版本')
assert.equal(imageVersionLabel(changed({ source_label: '2024年阮浩拍摄版本' })), '2024年阮浩拍摄版本')
assert.match(imageVersionLabel(base), /image1.jpeg.*批次未注明/)
assert.doesNotMatch(imageVersionLabel(base), /202[45]|阮浩|任超/)
assert.equal(imageVersionLabel({ ...base, asset: { ...base.asset, filename: '东壁（1998年拓片）.tif' } }), '1998年拓片')
const preciseMask = { format: 'wsc-binary-mask-rle-1', size: [1, 1], extent: [0, 0, 1, 1], counts: [0, 1],
  foreground_pixels: 1, binary_sha256: '1'.repeat(64) }
const sameSource = { ...base, asset: { ...base.asset, sha256: '2'.repeat(64) } }
const upgraded = { ...sameSource, annotation: { ...base.annotation, id: 6100, review_status: 'reviewed', geometry: {
  native_mask: preciseMask, image_version: { ...meta, source_asset_id: base.asset.id, source_filename: base.asset.filename,
    source_sha256: sameSource.asset.sha256 } } } }
assert.deepEqual(ids(associatedImageVersions(sameSource, [sameSource, upgraded, photo])), [6000, 6100], 'Same SHA upgrade is one source; distinct photograph remains')
assert.equal(preferredImageVersion(sameSource, [sameSource, upgraded, photo]), upgraded, 'Old URL resolves directly to accepted precise record')
assert.equal(preferredImageVersion(photo, [sameSource, upgraded, photo]), photo, 'A different source is never replaced by a preferred source')
const gallery = galleryImageVersionGroups([base, photo, unrelated, otherStone])
assert.equal(gallery.length, 3, 'One object card, while unrelated same-label records and other stones stay separate')
const firstGroup = gallery.find(g => g.key === '武010:139')
assert.equal(firstGroup.representative.annotation.id, 139, 'A rubbing represents an object that also has photographs')
assert.equal(firstGroup.versions.length, 2, 'The object count and source cutout count are distinct')
assert.equal(preferredImageVersion(photo, [base, photo]), photo, 'Choosing a photo in details never forces the rubbing')
const photoOnly = galleryImageVersionGroups([anchoredPhoto, anotherAnchoredPhoto])
assert.equal(photoOnly.length, 1); assert.equal(photoOnly[0].versions.length, 2)
assert.equal(photoOnly[0].representative.annotation.id, 6000, 'Photographs provide a stable fallback when no rubbing is available')
const candidateRubbing = { ...base, annotation: { ...base.annotation, review_status: 'candidate' } }
const reviewedPhoto = { ...photo, annotation: { ...photo.annotation, review_status: 'reviewed' } }
assert.equal(galleryImageVersionGroups([candidateRubbing, reviewedPhoto])[0].representative.annotation.id, 6000,
  'A hidden candidate rubbing does not hide the reviewed photographic object')
assert.equal(galleryImageVersionGroups([candidateRubbing, reviewedPhoto], true)[0].representative.annotation.id, 139)
const sameSourceGallery = galleryImageVersionGroups([sameSource, upgraded, photo])
assert.equal(sameSourceGallery.length, 1); assert.equal(sameSourceGallery[0].versions.length, 2,
  'Same-source upgrades do not inflate the displayed cutout total')
assert.deepEqual(ids(displayImageVersions([sameSource, upgraded, photo, unrelated])), [6100, 6000, 6010], 'Cards and counts omit coarse duplicates without merging unrelated labels')
const legacyPayload = { ...sameSource, asset: { ...base.asset } }
assert.equal(preferredImageVersion(legacyPayload, [legacyPayload, upgraded]), upgraded, 'Explicit version SHA establishes same-asset identity in older payloads')
const candidate = { ...upgraded, annotation: { ...upgraded.annotation, review_status: 'candidate' } }
assert.equal(preferredImageVersion(sameSource, [sameSource, candidate]), sameSource, 'Candidate boundaries cannot displace accepted originals')
const objectReviewedCandidate = { ...candidate, annotation: { ...candidate.annotation, quality: 'weak', geometry: {
  ...candidate.annotation.geometry, image_version: { ...candidate.annotation.geometry.image_version,
    segmentation: { review_policy: 'object-level-extraction-20261004', micro_boundary_exhaustive: false } } } } }
assert.equal(preferredImageVersion(sameSource, [sameSource, objectReviewedCandidate]), objectReviewedCandidate,
  'A visually checked source mask is usable while its historical reading remains a candidate')
assert.equal(objectReviewedCandidate.annotation.review_status, 'candidate')
assert.equal(objectReviewedCandidate.annotation.quality, 'weak')
const broken = { ...upgraded, annotation: { ...upgraded.annotation, geometry: { ...upgraded.annotation.geometry, native_mask: { ...preciseMask, counts: [3] } } } }
assert.equal(preferredImageVersion(sameSource, [sameSource, broken]), sameSource, 'Malformed masks cannot displace originals')
assert.equal(imageVersion({ ...upgraded, asset: { ...upgraded.asset, sha256: '3'.repeat(64) } }), null, 'Metadata cannot spoof the asset SHA')
const identicalFileOtherAsset = { ...upgraded, asset: { ...upgraded.asset, id: 199 }, annotation: { ...upgraded.annotation, id: 6101,
  geometry: { ...upgraded.annotation.geometry, image_version: { ...upgraded.annotation.geometry.image_version, source_asset_id: 199 } } } }
assert.deepEqual(ids(associatedImageVersions(sameSource, [sameSource, upgraded, identicalFileOtherAsset])), [6101], 'Duplicate asset entries with identical SHA are still one photographic source')
// Wu008 has independently identified original scenes on a different photograph.
const layout = { stone: { id: '武008' }, asset: { id: 811, kind: 'rubbing', filename: 'layout.jpg', sha256: '5'.repeat(64) },
  annotation: { id: 2972, level: 'scene', label: '三字布局', geometry: {} } }
const originalAlias = { ...layout, asset: { id: 806, kind: 'photo', filename: 'front.tif', sha256: '6'.repeat(64) },
  annotation: { ...layout.annotation, id: 3001, label: '三字实物布局' } }
const identity = { format: 'wsc-source-identity-evidence-1', status: 'accepted', stone_id: '武008', level: 'scene',
  canonical_annotation_id: 2972, source_sha256: originalAlias.asset.sha256, verified_original_alias_ids: [3001],
  evidence: [{ path: 'resources/authoring/research/accepted-original-alias-review.json', sha256: '7'.repeat(64) }] }
const preciseAlias = { ...originalAlias, annotation: { ...originalAlias.annotation, id: 6004, review_status: 'reviewed', geometry: {
  native_mask: preciseMask, image_version: { ...meta, canonical_annotation_id: 2972, canonical_asset_id: 811,
    source_asset_id: 806, source_filename: 'front.tif', source_sha256: originalAlias.asset.sha256,
    verified_original_alias_ids: [3001], source_identity_evidence: identity } } } }
const aliasRows = [layout, originalAlias, preciseAlias], beforeAliases = JSON.stringify(aliasRows)
assert.deepEqual(ids(associatedImageVersions(originalAlias, aliasRows)), [2972, 6004], 'Confirmed original alias joins the canonical identity with one source per SHA')
assert.equal(preferredImageVersion(originalAlias, aliasRows), preciseAlias, 'Original photograph alias URL resolves to its accepted native upgrade')
assert.equal(preferredImageVersion(layout, aliasRows), layout, 'A different-source canonical URL remains on that source')
assert.deepEqual(ids(displayImageVersions(aliasRows)), [2972, 6004], 'Original alias and native same-source card are displayed once')
assert.equal(JSON.stringify(aliasRows), beforeAliases, 'Protected original rows and references are untouched')
for (const proof of [undefined, { ...identity, status: 'candidate' }, { ...identity, level: 'figure' },
  { ...identity, source_sha256: layout.asset.sha256 }, { ...identity, evidence: [] },
  { ...identity, evidence: [{ path: 'review.json', sha256: 'bad' }] }, { ...identity, verified_original_alias_ids: [3002] }]) {
  const invalid = { ...preciseAlias, annotation: { ...preciseAlias.annotation, geometry: { ...preciseAlias.annotation.geometry,
    image_version: { ...preciseAlias.annotation.geometry.image_version, source_identity_evidence: proof } } } }
  assert.equal(preferredImageVersion(originalAlias, [layout, originalAlias, invalid]), originalAlias, 'Missing or mismatched identity evidence cannot establish an alias')
}
for (const original of [{ ...originalAlias, asset: { ...originalAlias.asset, sha256: '8'.repeat(64) } },
  { ...originalAlias, asset: { ...originalAlias.asset, sha256: undefined } },
  { ...originalAlias, annotation: { ...originalAlias.annotation, level: 'figure' } },
  { ...originalAlias, stone: { id: '武009' } }]) {
  assert.equal(preferredImageVersion(original, [layout, original, preciseAlias]), original, 'Alias identity requires the original actual SHA, stone, and level')
}
const competingRoot = { ...layout, annotation: { ...layout.annotation, id: 2979 } }
const competingVersion = { ...preciseAlias, annotation: { ...preciseAlias.annotation, id: 6005, geometry: {
  ...preciseAlias.annotation.geometry, image_version: { ...preciseAlias.annotation.geometry.image_version,
    canonical_annotation_id: 2979, source_identity_evidence: { ...identity, canonical_annotation_id: 2979 } } } } }
assert.equal(preferredImageVersion(originalAlias, [layout, competingRoot, originalAlias, preciseAlias, competingVersion]), originalAlias,
  'Conflicting accepted canonical claims require new evidence; the original remains separate')
console.log('PASS: explicit version identity, source provenance, cycle rejection, and honest unknown labels')
