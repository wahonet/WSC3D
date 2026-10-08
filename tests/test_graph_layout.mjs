/** Worker layout guarantees: all nodes retained, deterministic, finite and bounded. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
const require = createRequire(process.env.WSC_NODE_MODULES + '/package.json')
const { build } = require('esbuild')
const bundle = await build({entryPoints:[fileURLToPath(new URL('../src/frontend/src/lib/graphLayout.ts', import.meta.url))],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'})
const context = vm.createContext({module:{exports:{}},Math,Map,Float64Array,Number,Object}); vm.runInContext(bundle.outputFiles[0].text,context)
const {layoutGraph}=context.module.exports
assert.equal(Object.keys(layoutGraph({nodes:[],edges:[]})).length,0)
const small={nodes:[{id:'a'},{id:'b'},{id:'isolated'}],edges:[{source:'a',target:'b'},{source:'a',target:'missing'},{source:'b',target:'b'}]}
const before=JSON.stringify(small), positions=layoutGraph(small)
assert.equal(JSON.stringify(small),before,'does not mutate input')
assert.equal(Object.keys(positions).length,3,'retains disconnected nodes')
assert.ok(Object.values(positions).flat().every(Number.isFinite))
assert.equal(JSON.stringify(positions),JSON.stringify(layoutGraph({...small,nodes:[...small.nodes].reverse()})),'stable regardless of node input order')
assert.ok(Math.hypot(positions.a[0]-positions.b[0],positions.a[1]-positions.b[1])>1,'linked nodes do not overlap')
const single=layoutGraph({nodes:[{id:'only'}],edges:[]}); assert.ok(single.only.every(Number.isFinite))
const graph={nodes:Array.from({length:879},(_,i)=>({id:String(i)})),edges:Array.from({length:1407},(_,i)=>({source:String(i%879),target:String((i*17+3)%879)}))}
const t=performance.now(), result=layoutGraph(graph), ms=performance.now()-t
assert.equal(Object.keys(result).length,879)
assert.ok(Object.values(result).flat().every(Number.isFinite))
assert.ok(ms<5000,`bounded layout: ${ms.toFixed(0)} ms`)
console.log(`PASS empty / single / disconnected / invalid edges / deterministic / immutable / 879 nodes + 1407 edges: ${ms.toFixed(0)} ms`)
