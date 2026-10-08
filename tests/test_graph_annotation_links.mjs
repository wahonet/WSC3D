/** Association highlighting must follow identities and current stone bindings. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const require = createRequire(process.env.WSC_NODE_MODULES + '/package.json')
const { build } = require('esbuild')
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/frontend/src/lib/graphAnnotationLinks.ts', import.meta.url))],
  nodePaths: [process.env.WSC_NODE_MODULES], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
})
const context = vm.createContext({ module: { exports: {} } })
vm.runInContext(bundle.outputFiles[0].text, context)
const { globalAnnotationCounts, stoneAnnotationCounts } = context.module.exports
const nodes = [
  { id: 'stone1', kind: 'stone', stone_id: '武001', concept_id: null },
  { id: 'stone2', kind: 'stone', stone_id: '武002', concept_id: null },
  { id: 'story', kind: 'story', concept_id: 11, label: '楼阁' },
  { id: 'object', kind: 'object', concept_id: 12, label: '楼阁' },
  { id: 'unbound', kind: 'person', concept_id: 13 },
  { id: 'unmaterialized', kind: 'person', concept_id: null },
]
const annotations = [
  { id: 1, review_status: 'reviewed' }, { id: 2, review_status: 'candidate' },
  { id: 3, review_status: 'rejected' }, { id: 4, review_status: 'reviewed' },
]
const menu = {
  stone_id: '武001', dataset_id: 'core10',
  stories: [{ id: 'story', annotation_ids: [1] }],
  entities: [
    { id: 'object', story_id: 'story', annotation_ids: [2, 2, 3, 99, 0, '4'] },
    { id: 'object', story_id: null, annotation_ids: [2, 4] },
    { id: 'unbound', annotation_ids: [] },
    { id: 'unknown', annotation_ids: [1] },
  ],
}
let passed = 0
function test(name, run) { run(); passed++; console.log('PASS:', name) }

test('materialized concepts need actual positive usage to glow', () => {
  const result = globalAnnotationCounts(nodes, [{ id: 11, usage: 2 }, { id: 12, usage: 0 }, { id: 13, usage: NaN }])
  assert.equal(result.get('story'), 2)
  assert.equal(result.size, 1)
})
test('matching labels do not transfer association between a story and an object', () => {
  const result = globalAnnotationCounts(nodes, [{ id: 12, usage: 3 }])
  assert.equal(result.get('object'), 3)
  assert.equal(result.has('story'), false)
})
test('stone associations deduplicate entity occurrences and include candidates', () => {
  const result = stoneAnnotationCounts(nodes, '武001', 'core10', menu, annotations)
  assert.equal(result.get('object'), 2)
  assert.equal(result.get('story'), 1)
  assert.equal(result.get('stone1'), 3)
  assert.equal(result.has('unbound'), false)
  assert.equal(result.has('stone2'), false)
})
test('rejected, deleted and malformed annotation IDs do not count', () => {
  const result = stoneAnnotationCounts(nodes, '武001', 'core10', { ...menu, stories: [],
    entities: [{ id: 'object', annotation_ids: [3, 99, 0, '4', 1.5] }] }, annotations)
  assert.equal(result.size, 0)
})
test('a delayed response from another stone or dataset cannot light the current graph', () => {
  assert.equal(stoneAnnotationCounts(nodes, '武002', 'core10', menu, annotations).size, 0)
  assert.equal(stoneAnnotationCounts(nodes, '武001', 'replacement', menu, annotations).size, 0)
})
test('loading or empty stone bindings never borrow global associations', () => {
  assert.equal(stoneAnnotationCounts(nodes, '武001', 'core10', null, annotations).size, 0)
  assert.equal(stoneAnnotationCounts(nodes, '武001', 'core10', menu, []).size, 0)
})
test('counting associations leaves API data unchanged', () => {
  const before = JSON.stringify({ nodes, menu, annotations })
  stoneAnnotationCounts(nodes, '武001', 'core10', menu, annotations)
  assert.equal(JSON.stringify({ nodes, menu, annotations }), before)
})
console.log(`${passed} graph annotation association checks passed.`)
