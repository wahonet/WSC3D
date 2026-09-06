/** Store / shortcut / reference regressions. All network calls are mocked; no platform data is read or written. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const webRoot = fileURLToPath(new URL('../web/', import.meta.url))
const require = createRequire(new URL('../web/package.json', import.meta.url))
const { build } = require('esbuild')
const bundle = await build({
  stdin: {
    contents: `
      export { useApp } from './src/store/useApp';
      export { useShortcuts } from './src/hooks/useShortcuts';
      export { annotationReferences, hasReferences, referenceSource } from './src/lib/references';
      export { openAnnotationReference, openReferenceLibrary } from './src/lib/referenceNavigation';
    `,
    resolveDir: webRoot, loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
  plugins: [{ name: 'hook-fixture', setup(build) {
    build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      export const useEffect = effect => effect();
      export const useCallback = callback => callback;
      export const useDebugValue = () => {};
      export const useSyncExternalStore = (_, snapshot) => snapshot();
      export default { useEffect, useCallback, useDebugValue, useSyncExternalStore };
    ` }))
  } }],
})

const listeners = new Set()
const location = { hash: '#p=segment&e=sam3.1', pathname: '/' }
const requests = []
const dispatched = []
const context = vm.createContext({
  exports: {}, URLSearchParams, console,
  CustomEvent: class {
    constructor(type, options) { this.type = type; this.detail = options?.detail }
  },
  requestAnimationFrame: callback => callback(),
  location,
  localStorage: { getItem: () => null, setItem: () => {} },
  document: { documentElement: { dataset: {} } },
  history: { replaceState: (_, __, url) => { location.hash = url.startsWith('#') ? url : '' } },
  window: {
    addEventListener: (name, listener) => { if (name === 'keydown') listeners.add(listener) },
    removeEventListener: (name, listener) => { if (name === 'keydown') listeners.delete(listener) },
    dispatchEvent: event => { dispatched.push(event); return true },
    setTimeout: () => {},
  },
  fetch: async (path, init) => {
    assert.equal(init?.method ?? 'GET', 'GET', 'Tests must never issue a write request')
    requests.push(path)
    const responses = {
      '/api/stones': [{ id: 1, groups: [] }],
      '/api/stats': {}, '/api/concepts': [], '/api/taxonomy': {},
    }
    assert.ok(path in responses, `Unexpected API call: ${path}`)
    return { ok: true, json: async () => responses[path] }
  },
})
context.module = { exports: context.exports }
vm.runInContext(bundle.outputFiles[0].text, context)
const { useApp, useShortcuts, annotationReferences, hasReferences, referenceSource,
  openAnnotationReference, openReferenceLibrary } = context.module.exports
const state = () => useApp.getState()

await state().boot()
assert.equal(state().backendOk, true)
assert.equal(state().page, 'segment')
assert.equal(state().tool, 'select', 'A direct link to segmentation must start in navigation mode')
assert.equal(state().seg.engine, 'sam3.1', 'An engine deep link must not activate a drawing tool')

const pages = ['home', 'align', 'segment', 'annotate', 'library']
for (const destination of pages) {
  for (const tool of ['annotate', 'segment', 'measure', 'select']) {
    useApp.setState({ page: 'segment', tool, multiSel: [1, 2] })
    state().setPage(destination)
    assert.equal(state().tool, 'select', `${tool} must not survive navigation to ${destination}`)
    assert.equal(state().multiSel.length, 0)
  }
}
state().setPage('segment')
state().setShape('ellipse')
assert.equal(state().tool, 'annotate', 'Explicit shape selection activates drawing')
assert.equal(state().shape, 'ellipse')
state().setPage('segment')
assert.equal(state().tool, 'select', 'Clicking the current module also exits drawing')

state().setPage('align')
state().setTool('segment')
state().setShape('rect')
assert.equal(state().tool, 'select', 'Global drawing tools must remain unavailable in alignment')

useShortcuts(true)
const key = (value, target = { tagName: 'DIV' }) => {
  const event = { key: value, target, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true } }
  for (const listener of listeners) listener(event)
}
state().setPage('segment')
useApp.setState({ curAsset: { id: 1, kind: 'photo' }, selectedId: 42 })
for (const target of [{ tagName: 'DIV' }, { tagName: 'INPUT' }, { tagName: 'TEXTAREA' },
  { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
  for (const tool of ['annotate', 'segment']) {
    state().setTool(tool)
    key('Escape', target)
    assert.equal(state().tool, 'select', `Escape must exit ${tool} while ${target.tagName} has focus`)
    assert.equal(state().selectedId, 42, 'Exiting a tool must preserve the selected annotation')
  }
}
key('Escape')
assert.equal(state().selectedId, null, 'Escape in navigation mode still clears selection')
key('a', { tagName: 'INPUT' })
assert.equal(state().tool, 'select', 'Typing a prompt must not activate a shortcut')
key('a')
assert.equal(state().tool, 'annotate')
key('v')
assert.equal(state().tool, 'select')
key('s')
assert.equal(state().tool, 'segment')
state().setPage('library')
key('a')
key('s')
assert.equal(state().tool, 'select', 'Library shortcuts must not activate hidden drawing tools')

location.hash = '#p=library&lib=books&doc=3&pg=5&seg=7&fig=9&src=layer%3A2&off=0'
state().setPage('library')
const hash = () => new URLSearchParams(location.hash.slice(1))
assert.equal(hash().get('seg'), '7')
assert.equal(hash().get('fig'), '9')
assert.equal(hash().get('src'), 'layer:2', 'Navigation must preserve the description source')
assert.equal(hash().get('off'), '0', 'A description starting at zero must retain its offset')
for (const destination of pages.filter(page => page !== 'library')) {
  location.hash = '#p=library&src=description&off=12&seg=7&fig=9'
  state().setPage(destination)
  for (const key of ['src', 'off', 'seg', 'fig']) assert.equal(hash().has(key), false)
}

const legacyNode = { id: 42, desc_source: 'layer:2', desc_start: 0, desc_end: 4, desc_text: '江河日月' }
const legacyRefs = annotationReferences(legacyNode)
assert.equal(legacyRefs.length, 1)
assert.equal(legacyRefs[0].id, -42)
assert.equal(legacyRefs[0].annotation_id, 42)
assert.equal(legacyRefs[0].kind, 'description')
assert.equal(legacyRefs[0].desc_start, 0)
assert.equal(legacyRefs[0].text, '江河日月')
assert.equal(referenceSource(legacyRefs[0]), '第 2 层释文')
assert.equal(hasReferences(legacyNode), true, 'Legacy associations still mark a node as linked')
for (const absent of [{ desc_text: '' }, { desc_start: null }, { desc_end: null }]) {
  assert.equal(hasReferences({ ...legacyNode, ...absent }), false)
}
assert.equal(hasReferences({ ...legacyNode, references: [] }), false,
  'An explicit empty reference collection must not resurrect removed legacy references')

const segmentRef = { ...legacyRefs[0], id: 101, kind: 'segment', desc_source: null,
  desc_start: null, desc_end: null, document_id: 3, document_code: 'DOC-003', document_title: '测试文献',
  page_id: 500, page_no: 5, segment_id: 7, figure_id: null }
const figureRef = { ...segmentRef, id: 102, kind: 'figure', text: '', segment_id: null, figure_id: 9 }
for (const ref of [legacyRefs[0], segmentRef, figureRef, { ...figureRef, source_missing: true }]) {
  const node = { id: 42, desc_text: '', desc_start: null, desc_end: null, references: [ref] }
  assert.equal(hasReferences(node), true, `${ref.kind} snapshots must count as references`)
  assert.strictEqual(annotationReferences(node)[0], ref, 'Existing references must retain their source metadata')
}
assert.equal(referenceSource(segmentRef), 'DOC-003 · 测试文献 · 物理页 5')
assert.equal(referenceSource({ ...legacyRefs[0], desc_source: null }), '总述')
const combined = [legacyRefs[0], segmentRef, figureRef]
assert.strictEqual(annotationReferences({ ...legacyNode, references: combined }), combined,
  'Multiple explicit references must take precedence over the legacy projection')

state().setPage('segment')
state().setTool('segment')
location.hash = '#a=1&p=segment&lib=link&doc=88&pg=99&q=old&fig=19&src=layer%3A3&off=23'
openAnnotationReference(segmentRef)
assert.equal(state().page, 'library')
assert.equal(state().tool, 'select', 'Opening a citation exits active image tools')
for (const [key, value] of Object.entries({ a: '1', p: 'library', lib: 'books', doc: '3', pg: '5', seg: '7' })) {
  assert.equal(hash().get(key), value)
}
for (const key of ['fig', 'q', 'src', 'off']) assert.equal(hash().has(key), false)
assert.equal(dispatched.at(-1).type, 'stonelab:open-reference')
assert.equal(dispatched.at(-1).detail.pageId, 500, 'Events carry the page ID, not the physical page number')
assert.equal(dispatched.at(-1).detail.pageNo, 5)
assert.equal(dispatched.at(-1).detail.segmentId, 7)

openAnnotationReference(figureRef)
assert.equal(hash().get('fig'), '9')
assert.equal(hash().has('seg'), false, 'Opening an image clears the previous paragraph anchor')
assert.equal(dispatched.at(-1).detail.figureId, 9)
assert.equal(dispatched.at(-1).detail.segmentId, undefined)

openAnnotationReference({ ...legacyRefs[0], annotation_id: 77 })
assert.equal(state().selectedId, 77)
assert.equal(hash().get('lib'), 'link')
assert.equal(hash().get('src'), 'layer:2')
assert.equal(hash().get('off'), '0')
for (const key of ['seg', 'fig', 'q']) assert.equal(hash().has(key), false)
assert.equal(dispatched.at(-2).type, 'stonelab:open-description')
assert.equal(dispatched.at(-1).type, 'stonelab:locate-description')
assert.equal(dispatched.at(-1).detail.annotation_id, 77)
openAnnotationReference({ ...legacyRefs[0], desc_source: null, desc_start: null })
assert.equal(hash().get('src'), 'description')
assert.equal(hash().get('off'), '0')

location.hash = '#a=1&p=library&lib=link&doc=3&pg=5&seg=7&fig=9&src=description&off=12'
openReferenceLibrary()
assert.equal(hash().get('lib'), 'books')
assert.equal(hash().get('doc'), '3', 'The add-reference action preserves the selected book')
assert.equal(hash().get('pg'), '5')
for (const key of ['seg', 'fig', 'src', 'off']) assert.equal(hash().has(key), false)
assert.equal(dispatched.at(-1).type, 'stonelab:open-reference')
assert.equal(Object.keys(dispatched.at(-1).detail).length, 0)

for (const missing of ['document_id', 'page_id', 'page_no']) {
  state().setPage('annotate')
  const originalHash = location.hash
  const eventCount = dispatched.length
  openAnnotationReference({ ...segmentRef, [missing]: null })
  assert.equal(state().page, 'annotate', 'Incomplete source anchors must not navigate to an unrelated page')
  assert.equal(location.hash, originalHash)
  assert.equal(dispatched.length, eventCount)
}
assert.equal(requests.length, 4, 'State and shortcut tests must not fetch additional resources')
console.log('Frontend regressions passed: tool lifecycle, shortcuts, legacy / multiple references, and source navigation.')
