import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
const require = createRequire(process.env.WSC_NODE_MODULES + '/package.json')
const { build } = require('esbuild')
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/frontend/src/lib/geometry.ts', import.meta.url))],
  nodePaths: [process.env.WSC_NODE_MODULES], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })
const context = vm.createContext({ module: { exports: {} } })
vm.runInContext(bundle.outputFiles[0].text, context)
const { alignGeomToOverlay, overlayFromChains } = context.module.exports
const h = [[1.1, .03, 12], [-.02, 1.2, -8], [.0001, -.00002, 1]]
const t = { model: 'homography', homography: h, s: 1, theta_deg: 0, tx: 12, ty: -8, master_asset_id: 10 }
const base = { id: 1, width: 1200, height: 900, extra: { align_to_master: { s: 2, theta_deg: 0, tx: 20, ty: 40, master_asset_id: 10 } } }
const right = { id: 2, width: 1200, height: 900, extra: { align_to_master: t } }
const p = [343, 250]
function map(matrix, point) {
  const x = point[0], y = point[1], den = matrix[2][0]*x+matrix[2][1]*y+matrix[2][2]
  return [(matrix[0][0]*x+matrix[0][1]*y+matrix[0][2])/den, (matrix[1][0]*x+matrix[1][1]*y+matrix[1][2])/den]
}
const warped = overlayFromChains(base, right), inMaster = map(h, p)
assert.ok(warped.warpMatrix)
const result = map(warped.warpMatrix, p)
assert.ok(Math.abs(result[0]-(inMaster[0]-20)/2) < 1e-10)
assert.ok(Math.abs(result[1]-(inMaster[1]-40)/2) < 1e-10)
assert.deepEqual(Array.from(alignGeomToOverlay({ ...t, wl: 1200, hl: 900, wr: 1200, hr: 900 }).warpMatrix[2]), h[2])
assert.equal(overlayFromChains(base, { ...right, extra: { align_to_master: { ...t, master_asset_id: 99 } } }), null)
assert.equal(alignGeomToOverlay({ ...t, homography: [[1, 0, 0], [0, 0, 0], [0, 0, 1]] }), null,
  'Invalid perspective records must not silently display the approximate similarity')
assert.equal(alignGeomToOverlay({ ...t, homography: undefined }), null)
const legacy = alignGeomToOverlay({ s: 1, theta_deg: 0, tx: 0, ty: 0, wl: 100, hl: 80, wr: 100, hr: 80 })
assert.equal(legacy.wVp, 1); assert.equal(legacy.deg, 0); assert.equal(legacy.warpMatrix, undefined)
console.log('PASS: relative projective chains, original-pixel matrices, incompatible frame rejection and legacy similarity')
