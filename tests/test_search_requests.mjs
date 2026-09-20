/** Exercise the actual SearchPage effects with deferred requests and StrictMode cleanup. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const require = createRequire(process.env.WSC_NODE_MODULES + '/package.json')
const { build } = require('esbuild')
const webRoot = fileURLToPath(new URL('../src/frontend/', import.meta.url))
const bundle = await build({
  entryPoints: [webRoot + 'src/pages/SearchPage.tsx'], nodePaths: [process.env.WSC_NODE_MODULES], bundle: true, write: false,
  platform: 'node', format: 'cjs', logLevel: 'silent', loader: { '.css': 'empty' },
  plugins: [{ name: 'request-lifecycle-fixture', setup(build) {
    build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fixture' }))
    build.onResolve({ filter: /^lucide-react$/ }, () => ({ path: 'icons', namespace: 'fixture' }))
    build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx', namespace: 'fixture' }))
    build.onResolve({ filter: /store\/useApp$/ }, () => ({ path: 'store', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'icons'
      ? 'export const ArrowUp=()=>null,ArrowUpRight=ArrowUp,BookOpen=ArrowUp,Check=ArrowUp,ChevronDown=ArrowUp,FileText=ArrowUp,Layers3=ArrowUp,LoaderCircle=ArrowUp,MapPin=ArrowUp,RotateCcw=ArrowUp,Sparkles=ArrowUp;'
      : args.path === 'jsx' ? 'export const jsx = (type,props) => ({type,props}); export const jsxs = jsx; export const Fragment="fragment";'
      : args.path === 'store'
      ? 'export const useApp = {getState: () => ({})};'
      : 'export const useState = (...a) => fixture.state(...a); export const useRef = (...a) => fixture.ref(...a); export const useEffect = (...a) => fixture.effect(...a); export const useMemo = fn => fn(); export const forwardRef = fn => fn; export const createElement = (...a) => a;' }))
  } }],
})
let cursor = 0
let hookState = []
let effects = []
let pendingEffects = []
let requests = []
let timers = new Map()
let nextTimer = 0
const fixture = {
  state(initial) { const i = cursor++; if (!(i in hookState)) hookState[i] = initial; return [hookState[i], value => { hookState[i] = typeof value === 'function' ? value(hookState[i]) : value }] },
  ref(initial) { const i = cursor++; if (!(i in hookState)) hookState[i] = { current: initial }; return hookState[i] },
  effect(fn, deps) { const i = cursor++; const previous = effects[i]; if (!previous?.deps || deps.some((value, k) => !Object.is(value, previous.deps[k]))) pendingEffects.push(() => { previous?.cleanup?.(); effects[i] = { deps, cleanup: fn() } }) },
}
const context = vm.createContext({
  module: { exports: {} }, fixture, URLSearchParams, AbortController, console,
  window: { setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer } },
  clearTimeout(id) { timers.delete(id) },
  fetch(url, options = {}) { return new Promise((resolve, reject) => {
    const request = { url, options, resolve: body => resolve({ ok: true, json: async () => body }) }
    requests.push(request)
    options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  }) },
})
vm.runInContext(bundle.outputFiles[0].text, context)
const SearchPage = context.module.exports.default
let props = { active: true, query: '', submissionId: 0, onQuery() {}, onStone() {}, onDocument() {}, onExtension() {} }
function render(next = {}) { props = { ...props, ...next }; cursor = 0; pendingEffects = []; SearchPage(props); pendingEffects.forEach(run => run()) }
function tick() { const current = [...timers.values()]; timers.clear(); current.forEach(fn => fn()) }
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve() }
function asks() { return requests.filter(r => r.url === '/api/archive/ask') }
function strictReplay() { for (const effect of effects) effect?.cleanup?.(); effects = []; render() }

render(); tick()
assert.equal(requests.length, 0, 'empty query must not hit either endpoint')
render({ query: '武梁祠', submissionId: 1 })
strictReplay(); tick()
assert.equal(asks().length, 1, 'StrictMode must not duplicate the AI request')
const first = asks()[0]
assert.equal(JSON.parse(first.options.body).question, '武梁祠')
render({ submissionId: 2 }); tick(); render({ submissionId: 3 }); tick()
assert.equal(asks().length, 1, 'repeated Enter on the pending question must be ignored')
assert.equal(first.options.signal.aborted, false, 'deduplication must keep the original request alive')
render({ query: '西王母', submissionId: 4 }); tick()
assert.equal(asks().length, 2)
assert.equal(first.options.signal.aborted, true, 'a different question must cancel the previous fetch')
asks()[1].resolve({ answer: '当前问题的回答', route: 'online', citations: [] }); await flush()
render({ submissionId: 5 }); tick()
assert.equal(asks().length, 3, 'completed questions must support explicit resubmission')
const latest = asks()[2]
render({ query: '', submissionId: 6 }); tick(); await flush()
assert.equal(latest.options.signal.aborted, true, 'clearing the question must cancel the request')
assert.equal(asks().length, 3, 'empty resubmission must not request an answer')
strictReplay(); tick()
console.log('PASS: empty query, StrictMode, in-flight deduplication, cancellation, completed resubmission, and clearing.')
