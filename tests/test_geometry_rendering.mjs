/** Bad legacy geometry must not throw while rendering or focusing an annotation. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const require = createRequire(process.env.WSC_NODE_MODULES + '/package.json')
const { build } = require('esbuild')
const result = await build({
  stdin: { contents: `export { AnnoShape, ProjectedShape } from './src/components/viewer/AnnotationShapes';
    export { annotationBounds } from './src/lib/geometry';`,
    resolveDir: fileURLToPath(new URL('../src/frontend/', import.meta.url)), loader: 'tsx' },
  nodePaths: [process.env.WSC_NODE_MODULES], bundle: true, write: false, platform: 'node', format: 'cjs',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
})
const context = vm.createContext({ module: { exports: {} }, console, require })
vm.runInContext(result.outputFiles[0].text, context)
const { AnnoShape, ProjectedShape, annotationBounds } = context.module.exports
for (const [atype, geometry] of [
  ['polygon', {}], ['polygon', { points: [[0, 0], [1, 1]] }],
  ['polygon', { points: [[0, 0], [1, 1], null] }],
  ['point', { p: [NaN, 0] }], ['line', { p1: [0, 0] }],
  ['ellipse', { cx: 0, cy: 0, rx: -1, ry: 1 }], ['rect', null],
]) {
  const a = { id: 1, atype, geometry, level: '', review_status: 'reviewed', label: 'legacy' }
  assert.equal(AnnoShape({ a, toEl: p => p, selected: false, interactive: false }), null)
  assert.equal(ProjectedShape({ p: a, toEl: p => p }), null)
  assert.equal(annotationBounds(a), null)
}
const a = { id: 2, atype: 'polygon', geometry: { points: [[-.2, 0], [1.2, 0], [0, 1]] },
  level: '', review_status: 'reviewed', label: 'valid', references: [] }
assert.ok(AnnoShape({ a, toEl: p => p, selected: false, interactive: false }))
assert.ok(ProjectedShape({ p: a, toEl: p => p }))
assert.ok(annotationBounds(a))
console.log('PASS: invalid legacy shapes are safe; valid off-image shapes still render and focus')
