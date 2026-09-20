/** Graph exploration semantics; fixtures are in memory and do not write project data. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const require = createRequire(process.env.WSC_NODE_MODULES + '/package.json')
const { build } = require('esbuild')
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/frontend/src/lib/graphExploration.ts', import.meta.url))],
  nodePaths: [process.env.WSC_NODE_MODULES], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
})
const context = vm.createContext({ module: { exports: {} } })
vm.runInContext(bundle.outputFiles[0].text, context)
const { neighbourhood, inducedGraph, graphDegrees } = context.module.exports
const node = (id, kind) => ({ id, kind, label: id })
const edge = (source, target) => ({ id: source + '→' + target, source, target })
const graph = {
  nodes: [node('stone1', 'stone'), node('stone2', 'stone'), node('story1', 'story'),
    node('story2', 'story'), node('person', 'person'), node('object', 'object'), node('isolated', 'story')],
  edges: [edge('stone1', 'story1'), edge('stone2', 'story2'), edge('story1', 'person'),
    edge('story2', 'person'), edge('story1', 'object'), edge('story2', 'object')],
}
const ids = value => Array.from(value.nodes, item => item.id).sort()
const original = JSON.stringify(graph)
let passed = 0
function test(name, run) { run(); passed++; console.log('PASS:', name) }

test('one hop includes incoming and outgoing relationships', () => {
  assert.deepEqual(ids(neighbourhood(graph, 'story1', 1)), ['object', 'person', 'stone1', 'story1'])
  assert.equal(neighbourhood(graph, 'story1', 1).edges.length, 3)
})
test('two hops discover a shared entity in another story without including a third-hop stone', () => {
  const result = neighbourhood(graph, 'story1', 2)
  assert.deepEqual(ids(result), ['object', 'person', 'stone1', 'story1', 'story2'])
  assert.equal(result.edges.length, 5)
})
test('empty and missing centres do not leak unrelated nodes', () => {
  assert.equal(neighbourhood(graph, 'missing', 2).nodes.length, 0)
  assert.deepEqual(ids(neighbourhood(graph, 'isolated', 2)), ['isolated'])
  assert.equal(neighbourhood({ nodes: [], edges: [] }, 'person', 1).edges.length, 0)
})
test('layer filtering removes incident edges', () => {
  const filtered = inducedGraph(graph, new Set(graph.nodes.filter(item => item.kind !== 'story').map(item => item.id)))
  assert.equal(filtered.edges.length, 0)
})
test('degrees count both relationship directions and exploration leaves source data unchanged', () => {
  assert.equal(graphDegrees(graph).get('story1'), 3)
  assert.equal(graphDegrees(graph).get('isolated'), 0)
  assert.equal(JSON.stringify(graph), original)
})
console.log(`${passed} graph exploration checks passed.`)
