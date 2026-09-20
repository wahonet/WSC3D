/** Pagination of high-degree hubs must expose every neighbor without unrelated nodes. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
const require = createRequire(process.env.WSC_NODE_MODULES + '/package.json')
const { build } = require('esbuild')
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/frontend/src/lib/graphFocus.ts', import.meta.url))], nodePaths: [process.env.WSC_NODE_MODULES], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })
const context = vm.createContext({ module: { exports: {} } })
vm.runInContext(bundle.outputFiles[0].text, context)
const { focusNeighbors, focusPage, focusPositions } = context.module.exports
const nodes = Array.from({ length: 30 }, (_, i) => ({ id: String(i), kind: i % 2 ? 'stone' : 'story', label: `节点${i}` }))
const edges = nodes.slice(1, 28).map(node => ({ source: '0', target: node.id }))
edges.push({ source: '1', target: '0' }, { source: '28', target: '29' })
const neighbors = focusNeighbors({ nodes, edges }, '0')
assert.equal(neighbors.length, 27)
assert.equal(new Set(neighbors.map(n => n.id)).size, 27)
const pages = [0, 1, 2].map(p => focusPage(neighbors, p, 12))
assert.deepEqual(pages.map(p => p.nodes.length), [12, 12, 3])
assert.equal(new Set(pages.flatMap(p => p.nodes.map(n => n.id))).size, 27)
assert.equal(focusPage(neighbors, 99, 12).page, 2)
assert.equal(focusPage([], 5).page, 0)
const positions = focusPositions(pages[0].nodes)
for (const point of positions) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y))
for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
  assert.ok(Math.abs(positions[i].x - positions[j].x) >= 136 || Math.abs(positions[i].y - positions[j].y) >= 74, 'neighbor labels must not overlap')
}
console.log('PASS: unique neighbors, complete pagination, bounds, finite layout, no label overlap')
for (const [width, height, count, cardWidth] of [[742, 383, 8, 136], [850, 574, 12, 136], [560, 374, 8, 136], [390, 364, 4, 112]]) {
  const points = focusPositions(neighbors.slice(0, count), width, height)
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    assert.ok(Math.abs(points[i].x - points[j].x) >= cardWidth || Math.abs(points[i].y - points[j].y) >= 74, `overlap at ${width}x${height}`)
  }
}
console.log('PASS: desktop, compact desktop and mobile label spacing')
