/** Saved alignments must render an overlay in the alignment module, with usable opacity controls. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const require = createRequire(process.env.WSC_NODE_MODULES + '/package.json')
const { build } = require('esbuild')
const result = await build({
  stdin: {
    contents: `
      import { createElement } from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import AlignView from './src/components/AlignView';
      import AlignSidebar from './src/components/AlignSidebar';
      import Viewer2D from './src/components/viewer/Viewer2D';
      export const renderView = asset => renderToStaticMarkup(createElement(AlignView, {leftAsset: asset}));
      export const renderSidebar = () => renderToStaticMarkup(createElement(AlignSidebar));
      export const renderViewer = asset => renderToStaticMarkup(createElement(Viewer2D, {asset}));
    `,
    resolveDir: fileURLToPath(new URL('../src/frontend/', import.meta.url)), loader: 'tsx',
  },
  nodePaths: [process.env.WSC_NODE_MODULES], bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react/jsx-runtime', 'react-dom/server'], logLevel: 'silent',
  plugins: [{ name: 'alignment-fixtures', setup(build) {
    build.onResolve({ filter: /\/store\/useApp$/ }, () => ({ path: 'store', namespace: 'fixture' }))
    build.onResolve({ filter: /\/useOsd$/ }, () => ({ path: 'osd', namespace: 'fixture' }))
    build.onResolve({ filter: /^openseadragon$/ }, () => ({ path: 'osd-package', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'store' ? `
      export const useApp = select => select(globalThis.alignmentState);
      useApp.getState = () => globalThis.alignmentState;
      export const selectIs2d = s => s.curAsset != null && !s.curAsset.kind.startsWith('model');
    ` : path === 'osd' ? `
      export const useOsd = src => {
        globalThis.osdSources.push(src);
        return { hostRef: {current: null}, viewerRef: {current: null}, ready: true,
          toEl: p => p, toNorm: (x,y) => [x,y], eventPos: () => [0,0],
          zoomBy: () => {}, goHome: () => {}, fitNorm: () => {} };
      };
    ` : `export default { Point: class { constructor(x,y) {this.x=x;this.y=y;} } };` }))
  } }],
})

const left = { id: 1, filename: 'master.jpg', kind: 'rubbing', kind_label: '拓片',
  is_master: true, in_frame: true, extra: {}, width: 2540, height: 3437 }
const right = { ...left, id: 2, filename: 'photo.tif', kind: 'photo', kind_label: '高清照片', is_master: false }
const record = { id: 10, asset_id: 1, atype: 'align', value: 10.7, created_at: '2026-10-01T12:00:00',
  geometry: { target_asset_id: 2, pairs: [], s: 1, theta_deg: 0, tx: 0, ty: 0,
    wl: 2540, hl: 3437, wr: 2540, hr: 3437 } }
const alignmentState = {
  curStone: { id: '武010', groups: [{ key: 'rubbing', assets: [left] }, { key: 'photo', assets: [right] }] },
  curAsset: left, stoneAnnos: [record], overlay: null, page: 'align', tool: 'select',
  annos: [{ id: 20, atype: 'rect', geometry: { x: 0, y: 0, w: .1, h: .1 }, level: '', review_status: 'reviewed' }],
  showAnnoLayer: true, showCandidates: true, showLabels: true, hiddenLevels: [], hiddenAnnotations: [],
  projOn: true, projItems: [], seg: { engine: 'mobilesam', preprocess: 'enhance', viewPreprocessed: true,
    invert: false, dets: [], points: [], boxes: [], excluded: [] },
}
for (const name of ['onAligned', 'removeOverlay', 'sendViewerCmd', 'openAsset', 'makeMaster',
  'removeAnnotation', 'setOverlayOpacity', 'setOverlaySpec', 'select', 'createShape',
  'addSegPoint', 'addSegBox', 'toggleSegExcluded']) alignmentState[name] = () => {}

const context = vm.createContext({ module: { exports: {} }, console, require, alignmentState, osdSources: [] })
vm.runInContext(result.outputFiles[0].text, context)
const { renderView, renderSidebar, renderViewer } = context.module.exports

assert.match(renderView(left), /class="align-panes"/, 'Alignment initially offers two panes for picking')
assert.doesNotMatch(renderSidebar(), /type="range"/, 'No inactive opacity control is shown')

// The same overlay state is produced by opening a saved record and by committing a new alignment.
alignmentState.overlay = { assetId: 2, opacity: .5, transform: { xVp: 0, yVp: 0, wVp: 1, deg: 0 } }
for (const opacity of [.5, 0, .24, .86, 1]) {
  alignmentState.overlay = { ...alignmentState.overlay, opacity }
  context.osdSources.length = 0
  const view = renderView(left), sidebar = renderSidebar(), percent = `${Math.round(opacity * 100)}%`
  assert.match(view, /aria-label="图像对齐叠加预览"/)
  assert.match(view, /class="viewport tool-select"/, 'Saved records must use the viewer that draws the overlay')
  assert.doesNotMatch(view, /class="align-panes"/, 'The point picker cannot stand in for an overlay preview')
  assert.match(view, /返回取点/)
  assert.ok(view.includes('底图：master.jpg') && view.includes('叠加：photo.tif'))
  assert.ok(view.includes(`<b>${percent}</b>`))
  assert.match(sidebar, /aria-label="叠加透明度"/)
  assert.ok(sidebar.includes(`value="${opacity}"`) && sidebar.includes(`<output>${percent}</output>`))
  assert.doesNotMatch(view, /class="svg-overlay"/, 'Annotation shapes cannot cover the comparison')
  assert.doesNotMatch(view, /预处理视图/)
  assert.deepEqual([...context.osdSources], ['/api/assets/1/preview'], 'Comparison uses the original preview')
}

// Preview preferences must not change annotation layers or preprocessing in the normal viewer.
context.osdSources.length = 0
assert.match(renderViewer(left), /class="svg-overlay"/)
assert.match(context.osdSources[0], /preprocessed/)
alignmentState.overlay = null
assert.match(renderView(left), /class="align-panes"/, 'Removing the overlay returns to point picking')
assert.doesNotMatch(renderSidebar(), /type="range"/)
assert.equal(alignmentState.showAnnoLayer, true)
assert.equal(alignmentState.seg.viewPreprocessed, true)
console.log('PASS: saved alignment preview, opacity endpoints, return to picking, and viewer preferences')
