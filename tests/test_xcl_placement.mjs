/** Execute the shipped layout client's real save/load functions with two mock tabs. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const html = await readFile(new URL('../src/frontend/public/tools/xcl-placement.html', import.meta.url), 'utf8')
const helpers = html.slice(html.indexOf('function mergePlacement('), html.indexOf('const photoTextures={};'))
const persistence = html.slice(html.indexOf('function fromInit(){'), html.indexOf('/* ---------- three 场景 ---------- */'))
const initial = [0, 1].map(i => ({ id: `T${i}`, name: `stone${i}`, wall: 'W', L: 1, H: 1, T: .2,
  along: 1 + i, off: 1, y: 1, rotY: 0 }))
let server = { updated_at: 'v0', stones: structuredClone(initial) }
let writes = 0
const storage = () => {
  const data = new Map()
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
}
function tab(localStorage = storage()) {
  const toasts = []
  const timers = new Map()
  let nextTimer = 0
  const context = vm.createContext({
    INIT: initial, LEGACY_IDS: {}, LS_KEY: 'layout', stones: [], sel: -1, localStorage,
    location: { origin: 'http://127.0.0.1:8030' }, window: {}, console,
    $: () => ({ disabled: false }), rebuildAll: () => {}, toast: message => toasts.push(message),
    confirm: () => true,
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer },
    clearTimeout: id => timers.delete(id),
    fetch: async (_, options) => {
      if (options.method === 'POST') {
        writes++
        const body = JSON.parse(options.body)
        if (body.base_updated_at !== server.updated_at) return { ok: false, json: async () => ({ detail: 'version conflict' }) }
        server = { updated_at: `v${Number(server.updated_at.slice(1)) + 1}`, stones: body.stones }
        return { ok: true, json: async () => ({ updated_at: server.updated_at }) }
      }
      return { ok: true, json: async () => structuredClone(server) }
    },
  })
  vm.runInContext(helpers + '\n' + persistence, context)
  return { context, toasts, localStorage, run: code => vm.runInContext(code, context),
    flushTimers: () => { for (const callback of timers.values()) callback(); timers.clear() } }
}
const a = tab(), b = tab()
await a.run('loadFromSystem(true)'); await b.run('loadFromSystem(true)')
a.run('stones[0].along=3'); await a.run('applyToSystem()')
assert.equal(server.stones[0].along, 3)
assert.equal(a.run('systemUpdatedAt'), 'v1')
assert.equal(JSON.parse(a.localStorage.getItem('layout')).base_updated_at, 'v1')
b.run('stones[1].along=4; markDirty()'); await b.run('applyToSystem()')
b.flushTimers()
assert.equal(server.stones[0].along, 3)
assert.equal(server.stones[1].along, 2)
assert.equal(b.run('stones[1].along'), 4, 'A rejected save must retain the local draft')
assert.equal(b.run('systemUpdatedAt'), 'v0')
assert.match(b.toasts.at(-1), /version conflict/)
assert.equal(JSON.parse(b.localStorage.getItem('layout')).stones[1].along, 4,
  'A conflict must persist the draft without an autosave toast hiding the error')

const restored = tab(a.localStorage)
assert.equal(restored.run('loadLS()'), true)
assert.equal(restored.run('systemUpdatedAt'), 'v1')
restored.run('stones[1].along=5'); await restored.run('applyToSystem()')
assert.equal(server.stones[1].along, 5)
assert.equal(server.updated_at, 'v2')

const legacyStorage = storage()
legacyStorage.setItem('layout', JSON.stringify({ stones: initial }))
const legacy = tab(legacyStorage)
assert.equal(legacy.run('loadLS()'), true)
const before = writes
legacy.run('stones[0].along=7; markDirty()')
await legacy.run('applyToSystem()')
legacy.flushTimers()
assert.equal(writes, before, 'An unversioned old draft cannot claim the current server version')
assert.match(legacy.toasts.at(-1), /备份/)
assert.equal(JSON.parse(legacyStorage.getItem('layout')).stones[0].along, 7)
await b.run('loadFromSystem(false)')
b.run('stones[0].along=6'); await b.run('applyToSystem()')
assert.equal(server.stones[0].along, 6)
assert.equal(server.updated_at, 'v3')
console.log('PASS: two tabs, repeat saves, restored drafts, legacy drafts and conflict recovery')
