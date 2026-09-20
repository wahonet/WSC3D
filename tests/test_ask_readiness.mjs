/** Exercise index progress, resumption and cancellation without model/API calls. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const require = createRequire(process.env.WSC_NODE_MODULES + '/package.json')
const { build } = require('esbuild')
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/frontend/src/lib/askArchive.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })
const pending = { route: 'retrieval_pending' }, answer = { route: 'online', answer: '有据可查[1]' }
const building = { ready: true, dense_ready: false, dense_building: true, dense_done: 30, dense_n: 100 }
const ready = { ...building, dense_ready: true, dense_building: false }
function client(responses, clock = Date) {
  const calls = [], messages = [], resumed = []
  const context = { module: { exports: {} }, Date: clock, setTimeout: fn => setTimeout(fn, 1), clearTimeout,
    fetch: async (url, options) => { calls.push({ url, ...options }); assert.ok(responses.length, 'unexpected request');
      return { ok: true, json: async () => responses.shift() } } }
  vm.runInNewContext(bundle.outputFiles[0].text, context)
  return { calls, messages, resumed, ask: signal => context.module.exports.askWhenReady('西王母', true, signal,
    value => messages.push(value), () => resumed.push(true)) }
}
let count = 0
async function test(name, run) { await run(); count++; console.log('PASS:', name) }
await test('ready question calls the model endpoint once', async () => {
  const c = client([answer]); assert.equal((await c.ask(new AbortController().signal)).route, 'online')
  assert.equal(c.calls.length, 1); assert.equal(c.resumed.length, 0)
})
await test('preparation polls progress, then resumes once with the same question and scope', async () => {
  const c = client([pending, building, ready, answer])
  await c.ask(new AbortController().signal)
  const posts = c.calls.filter(call => call.method === 'POST')
  assert.equal(posts.length, 2); assert.equal(posts[0].body, posts[1].body)
  assert.equal(JSON.parse(posts[1].body).include_extension, true)
  assert.equal(c.resumed.length, 1); assert.ok(c.messages.some(text => text.includes('30%')))
})
await test('failed preparation never resubmits a model request', async () => {
  const c = client([pending, { ...building, dense_error: 'model missing' }])
  await assert.rejects(c.ask(new AbortController().signal), /准备失败/)
  assert.equal(c.calls.filter(call => call.method === 'POST').length, 1)
})
await test('changing the question aborts progress polling and prevents a stale answer', async () => {
  const c = client([pending, building, ready, answer]), abort = new AbortController()
  c.messages.push = () => abort.abort()
  await assert.rejects(c.ask(abort.signal), error => error.name === 'AbortError')
  assert.equal(c.calls.length, 2); assert.equal(c.resumed.length, 0)
})
await test('long preparation has a bounded wait', async () => {
  let calls = 0
  const c = client([pending, building], { now: () => calls++ ? 16 * 60 * 1000 : 0 })
  await assert.rejects(c.ask(new AbortController().signal), /已暂停本次等待/)
  assert.equal(c.calls.length, 2)
})
console.log(`${count} readiness checks passed.`)
