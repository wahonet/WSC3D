import * as THREE from 'three-inventory';

export interface CoordinateOverlay {
  update(): void;
  setSize(width: number, height: number): void;
  dispose(): void;
}

type Pair = [number, number];
type Control = {
  id: string | number;
  name: string;
  latitudeDms: string;
  longitudeDms: string;
  latitudeDeg: number;
  longitudeDeg: number;
  heightM: number;
  modelVertexIndex: number;
  modelWorldXZ: Pair;
  enu: Pair;
  fittedEnu: Pair;
  residualM: number;
};
type Georeference = {
  status: string;
  sourceType: string;
  datum: { horizontal: string; vertical: string; calculationEllipsoid: string };
  origin: { latitudeDeg: number; longitudeDeg: number; heightM: number };
  transform: { matrix2x3: [number[], number[]]; rotationDeg: number; scale: number };
  quality: { rmsM: number; maxM: number };
  surveyAreaM2: number;
  modelAreaM2: number;
  boundaryWorldXZ: Pair[];
  controls: Control[];
  notes: string[];
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const css = `
.wsc-coord{position:absolute;inset:0;z-index:8;pointer-events:none;overflow:hidden;color:#e3e7e9;font-family:"Microsoft YaHei",sans-serif;font-size:12px;line-height:1.5}
.wsc-coord [hidden]{display:none!important}
.wsc-coord button{font:inherit;cursor:pointer;pointer-events:auto;touch-action:manipulation}
.wsc-coord button:focus-visible{outline:2px solid #e5c381;outline-offset:3px}
.wsc-coord-toggle{position:absolute;bottom:16px;left:16px;z-index:4;border:1px solid #b798626b;border-radius:18px;padding:7px 13px;background:rgba(27,34,39,.92);color:#edce94;box-shadow:0 3px 14px #0004;backdrop-filter:blur(8px)}
.wsc-coord-toggle[aria-expanded="true"]{background:#51432c;border-color:#c5a36d}
.wsc-coord-panel{position:absolute;bottom:57px;left:16px;z-index:3;width:340px;max-width:calc(100% - 32px);max-height:calc(100% - 73px);box-sizing:border-box;overflow:auto;overscroll-behavior:contain;pointer-events:auto;touch-action:pan-y;background:rgba(24,31,37,.96);border:1px solid #c7a87355;border-radius:12px;box-shadow:0 10px 34px #0005;backdrop-filter:blur(12px);padding:13px 14px 12px;scrollbar-width:thin;scrollbar-color:#647079 transparent}
.wsc-coord-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:3px}
.wsc-coord-title{font-size:14px;font-weight:600;color:#ecd19b}
.wsc-coord-actions{display:flex;align-items:center;gap:8px}
.wsc-coord-export{padding:2px 6px;border:1px solid #c7a87355;border-radius:5px;background:transparent;color:#d7bb82;font-size:10px!important}
.wsc-coord-close{border:0;background:transparent;color:#a5b0b6;padding:0 4px;font-size:18px!important;line-height:1.3}
.wsc-coord-datum{color:#c1b394;font-size:11px}
.wsc-coord-quality{display:flex;gap:14px;margin:9px 0 8px;color:#b7c2c8;font-size:11px}
.wsc-coord-quality strong{font-weight:500;color:#eee2c9;font-variant-numeric:tabular-nums}
.wsc-coord-points{display:flex;gap:5px;flex-wrap:wrap;margin:8px 0}
.wsc-coord-point{min-width:29px;padding:3px 7px;border:1px solid #75818d77;border-radius:6px;background:#34404955;color:#c6d0d6}
.wsc-coord-point[aria-pressed="true"]{background:#b89150;color:#141a20;border-color:#e1c491;font-weight:600}
.wsc-coord-map{display:block;width:100%;height:auto;max-height:190px;box-sizing:border-box;border-radius:8px;background:#10191f;border:1px solid #6b829438}
.wsc-coord-map [role="button"]{cursor:pointer;outline:none}
.wsc-coord-map [role="button"]:focus-visible circle{stroke:#fff;stroke-width:2.5}
.wsc-coord-legend{display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 11px;color:#adbcc5;font-size:10px}
.wsc-coord-legend span{display:inline-flex;align-items:center;gap:4px}
.wsc-coord-legend i{display:inline-block;width:14px;border-top:2px solid #d8b66f}
.wsc-coord-legend .model{border-color:#6fa6bb;border-top-style:dashed}
.wsc-coord-legend .error{border-color:#cf9584;border-top-style:dashed}
.wsc-coord-detail{border-top:1px solid #d8e3ed1b;padding-top:9px}
.wsc-coord-name{font-size:12px;font-weight:600;color:#e7d4ac;margin-bottom:5px;overflow-wrap:anywhere}
.wsc-coord-fields{display:grid;grid-template-columns:44px minmax(0,1fr);gap:4px 8px;margin:0;font-variant-numeric:tabular-nums}
.wsc-coord-fields dt{color:#97a8b4}.wsc-coord-fields dd{margin:0;color:#dce3e7;overflow-wrap:anywhere}
.wsc-coord-foot{margin-top:10px;padding-top:8px;border-top:1px solid #d8e3ed15;color:#9aaab5;font-size:10px;line-height:1.65}
.wsc-coord-note{margin:4px 0 0;color:#a8b6bf}
.wsc-coord-foot summary{cursor:pointer;color:#cdb884;margin-top:5px}
.wsc-coord-markers{position:absolute;inset:0;pointer-events:none;z-index:1}
.wsc-coord-marker{position:absolute;top:0;left:0;min-width:26px;height:26px;padding:0 6px;box-sizing:border-box;border:1px solid #e0c17c;border-radius:50%;background:rgba(27,35,42,.93);color:#f0d799;box-shadow:0 2px 7px #0009;font-size:11px!important;font-weight:600!important;line-height:24px;will-change:transform}
.wsc-coord-marker[aria-pressed="true"]{background:#ddb76b;color:#1d252b;box-shadow:0 0 0 3px #ddb76b38,0 2px 9px #0008;z-index:2}
`;

function finitePair(value: unknown): value is Pair {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
}

/** Read-only survey overlay. All survey graphics are DOM/SVG and never enter the Three scene. */
export function createCoordinateOverlay(
  renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
): CoordinateOverlay {
  const host = renderer.domElement.parentElement;
  if (!host) return { update() {}, setSize() {}, dispose() {} };

  const root = document.createElement('div');
  root.className = 'wsc-coord';
  root.hidden = true;
  const style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);
  const markers = document.createElement('div');
  markers.className = 'wsc-coord-markers'; markers.hidden = true;
  root.appendChild(markers);

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement) {
    const node = document.createElement(tag); node.className = className; parent.appendChild(node); return node;
  }
  const toggle = element('button', 'wsc-coord-toggle', root);
  toggle.type = 'button'; toggle.textContent = '院落坐标'; toggle.setAttribute('aria-expanded', 'false');
  const panel = element('section', 'wsc-coord-panel', root);
  panel.setAttribute('aria-label', '院落 RTK 坐标初步匹配'); panel.hidden = true;
  const head = element('div', 'wsc-coord-head', panel);
  const title = element('div', 'wsc-coord-title', head);
  const actions = element('div', 'wsc-coord-actions', head);
  const download = element('button', 'wsc-coord-export', actions);
  download.type = 'button'; download.textContent = '导出坐标';
  download.title = '下载原始 RTK 测点、拟合参数与误差 JSON';
  const close = element('button', 'wsc-coord-close', actions);
  close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '收起院落坐标');
  const datum = element('div', 'wsc-coord-datum', panel);
  const quality = element('div', 'wsc-coord-quality', panel);
  const pointBar = element('div', 'wsc-coord-points', panel);
  pointBar.setAttribute('aria-label', '选择测点');
  const map = document.createElementNS(SVG_NS, 'svg');
  map.setAttribute('class', 'wsc-coord-map'); map.setAttribute('viewBox', '0 0 308 190');
  map.setAttribute('role', 'group'); map.setAttribute('aria-label', '北向朝上的 RTK 测点、模型边界及残差叠图');
  panel.appendChild(map);
  const legend = element('div', 'wsc-coord-legend', panel);
  for (const [className, text] of [['', 'RTK 测点连线'], ['model', '拟合模型边界'], ['error', '偏差']]) {
    const item = element('span', '', legend); element('i', className, item); item.appendChild(document.createTextNode(text));
  }
  const detail = element('div', 'wsc-coord-detail', panel);
  detail.setAttribute('aria-live', 'polite'); detail.setAttribute('aria-atomic', 'true');
  const pointName = element('div', 'wsc-coord-name', detail);
  const fields = element('dl', 'wsc-coord-fields', detail);
  const values: Record<string, HTMLElement> = {};
  for (const label of ['纬度', '经度', '高程', '偏差']) {
    element('dt', '', fields).textContent = label; values[label] = element('dd', '', fields);
  }
  const foot = element('div', 'wsc-coord-foot', panel);
  host.appendChild(root);

  let width = renderer.domElement.clientWidth, height = renderer.domElement.clientHeight;
  let data: Georeference | undefined;
  let sourceReference: unknown;
  let open = false, selected = 0, disposed = false, projectionDirty = true;
  let controls: Control[] = [];
  let markerButtons: HTMLButtonElement[] = [], pointButtons: HTMLButtonElement[] = [];
  let mapPoints: SVGGElement[] = [];
  let projected: Array<{ position: THREE.Vector3; last: string; visible: boolean }> = [];
  let matrix: [number[], number[]] | undefined;
  const cameraElements: number[] = [];
  const viewPosition = new THREE.Vector3(), clipPosition = new THREE.Vector3();
  const listeners: Array<() => void> = [], dynamicListeners: Array<() => void> = [];
  const downloadUrls = new Set<string>(), downloadTimers = new Set<number>();
  const number = (value: number, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—';

  function listen(node: EventTarget, type: string, handler: EventListener, dynamic = false) {
    node.addEventListener(type, handler);
    (dynamic ? dynamicListeners : listeners).push(() => node.removeEventListener(type, handler));
  }
  function setOpen(value: boolean) {
    open = value; panel.hidden = !value; markers.hidden = !value;
    toggle.setAttribute('aria-expanded', String(value)); projectionDirty = true;
  }
  listen(toggle, 'click', event => { event.stopPropagation(); setOpen(!open); update(); });
  listen(close, 'click', event => { event.stopPropagation(); setOpen(false); toggle.focus(); });
  listen(download, 'click', event => {
    event.stopPropagation();
    if (!data) return;
    const blob = new Blob([JSON.stringify(scene.userData.georeference, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    downloadUrls.add(url); anchor.href = url; anchor.download = 'wushici-rtk-coordinate-match.json';
    anchor.hidden = true; root.appendChild(anchor); anchor.click(); anchor.remove();
    const timer = window.setTimeout(() => {
      URL.revokeObjectURL(url); downloadUrls.delete(url); downloadTimers.delete(timer);
    }, 1000);
    downloadTimers.add(timer);
  });
  listen(panel, 'keydown', event => {
    if ((event as KeyboardEvent).key === 'Escape') { event.stopPropagation(); setOpen(false); toggle.focus(); }
  });
  for (const node of [toggle, panel, markers]) {
    listen(node, 'pointerdown', event => event.stopPropagation());
    listen(node, 'dblclick', event => event.stopPropagation());
  }
  listen(panel, 'wheel', event => event.stopPropagation());

  function select(index: number) {
    if (!controls[index]) return;
    selected = index;
    const control = controls[index];
    pointName.textContent = `${control.id} · ${control.name || '测点'}`;
    values['纬度'].textContent = control.latitudeDms || `${number(control.latitudeDeg, 7)}°`;
    values['经度'].textContent = control.longitudeDms || `${number(control.longitudeDeg, 7)}°`;
    values['高程'].textContent = `${number(control.heightM, 3)} 米`;
    values['偏差'].textContent = `${number(control.residualM)} 米`;
    pointButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
    markerButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
    mapPoints.forEach((group, i) => {
      group.setAttribute('aria-pressed', String(i === index));
      group.querySelector('circle')?.setAttribute('fill', i === index ? '#d8b66f' : '#16242c');
      group.querySelector('text')?.setAttribute('fill', i === index ? '#14212a' : '#f0d9a1');
    });
  }

  function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>, parent: SVGElement = map) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
    parent.appendChild(node); return node;
  }
  function fit(point: Pair): Pair {
    const [[a, b, tx], [c, d, ty]] = matrix!;
    return [a * point[0] + b * point[1] + tx, c * point[0] + d * point[1] + ty];
  }

  function rebuild(source: unknown) {
    dynamicListeners.splice(0).forEach(remove => remove());
    pointBar.replaceChildren(); markers.replaceChildren(); map.replaceChildren(); quality.replaceChildren(); foot.replaceChildren();
    markerButtons = []; pointButtons = []; mapPoints = []; projected = []; controls = []; data = undefined; matrix = undefined;
    if (!source || typeof source !== 'object') return;
    const candidate = source as Georeference, transform = candidate.transform?.matrix2x3;
    if (!Array.isArray(transform) || transform.length !== 2 ||
      !transform.every(row => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite))) return;
    const [[a, b, tx], [c, d, ty]] = transform;
    const determinant = a * d - b * c;
    if (Math.abs(determinant) < 1e-10 || !Array.isArray(candidate.controls)) return;
    controls = candidate.controls.filter(control => finitePair(control.enu));
    if (!controls.length) return;
    data = candidate; matrix = transform;
    title.textContent = `${candidate.sourceType || 'RTK'} · 初步匹配`;
    const horizontal = candidate.datum?.horizontal || '待确认', vertical = candidate.datum?.vertical || '待确认';
    datum.textContent = horizontal.includes('待') && vertical.includes('待')
      ? '水平/高程基准待确认' : `水平：${horizontal} · 高程：${vertical}`;
    for (const [label, value] of [['RMS', candidate.quality?.rmsM], ['最大偏差', candidate.quality?.maxM]] as const) {
      const item = element('span', '', quality); item.appendChild(document.createTextNode(`${label} `));
      element('strong', '', item).textContent = `${number(value)} 米`;
    }
    const boundary = (candidate.boundaryWorldXZ || []).filter(finitePair).map(fit);
    const all = [...controls.map(control => control.enu), ...boundary];
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    all.forEach(([east, north]) => { minE = Math.min(minE, east); maxE = Math.max(maxE, east); minN = Math.min(minN, north); maxN = Math.max(maxN, north); });
    const scale = Math.min(260 / Math.max(maxE - minE, 1), 150 / Math.max(maxN - minN, 1));
    const toSvg = ([east, north]: Pair): Pair => [154 + (east - (minE + maxE) / 2) * scale, 95 - (north - (minN + maxN) / 2) * scale];
    const points = (vertices: Pair[]) => vertices.map(point => toSvg(point).map(value => number(value)).join(',')).join(' ');
    if (boundary.length > 2) svg('polygon', { points: points(boundary), fill: '#6fa6bb08', stroke: '#6fa6bb', 'stroke-width': '1.4', 'stroke-dasharray': '4 3' });
    if (controls.length > 2) svg('polygon', { points: points(controls.map(control => control.enu)), fill: '#d8b66f08', stroke: '#d8b66f', 'stroke-width': '1.5' });
    controls.forEach(control => {
      const fitted = finitePair(control.fittedEnu) ? control.fittedEnu : finitePair(control.modelWorldXZ) ? fit(control.modelWorldXZ) : undefined;
      if (!fitted) return;
      const from = toSvg(fitted), to = toSvg(control.enu);
      svg('line', { x1: number(from[0]), y1: number(from[1]), x2: number(to[0]), y2: number(to[1]), stroke: '#cf9584', 'stroke-width': '1.2', 'stroke-dasharray': '2 2' });
      svg('circle', { cx: number(from[0]), cy: number(from[1]), r: '2', fill: '#6fa6bb' });
    });
    controls.forEach((control, index) => {
      const label = String(control.id), accessible = `选择测点 ${label} ${control.name || ''}`;
      const button = element('button', 'wsc-coord-point', pointBar); button.type = 'button'; button.textContent = label;
      button.setAttribute('aria-label', accessible); pointButtons.push(button);
      listen(button, 'click', () => select(index), true);
      const marker = element('button', 'wsc-coord-marker', markers); marker.type = 'button'; marker.textContent = label;
      marker.setAttribute('aria-label', accessible); marker.title = `${label} · ${control.name || 'RTK 测点'}`; marker.hidden = true;
      markerButtons.push(marker);
      listen(marker, 'click', event => { event.stopPropagation(); select(index); setOpen(true); update(); }, true);
      const east = control.enu[0] - tx, north = control.enu[1] - ty;
      projected.push({ position: new THREE.Vector3((d * east - b * north) / determinant, 0.3, (-c * east + a * north) / determinant), last: '', visible: false });
      const [x, y] = toSvg(control.enu);
      const group = svg('g', { transform: `translate(${number(x)} ${number(y)})`, role: 'button', tabindex: '0', 'aria-label': accessible });
      svg('circle', { r: '8.5', fill: '#16242c', stroke: '#e3c384', 'stroke-width': '1.2' }, group);
      const text = svg('text', { x: '0', y: '3.4', 'text-anchor': 'middle', fill: '#f0d9a1', 'font-size': '9', 'font-family': 'sans-serif', 'font-weight': '600' }, group);
      text.textContent = label; mapPoints.push(group);
      listen(group, 'click', () => select(index), true);
      listen(group, 'keydown', event => {
        if (['Enter', ' '].includes((event as KeyboardEvent).key)) { event.preventDefault(); select(index); }
      }, true);
    });
    svg('path', { d: 'M288 29 V9 M284 15 L288 9 L292 15', fill: 'none', stroke: '#aabcc8', 'stroke-width': '1.3' });
    svg('text', { x: '288', y: '42', fill: '#aabcc8', 'font-size': '9', 'text-anchor': 'middle' }).textContent = '北 N';
    element('div', '', foot).textContent = `${controls.length} 点连线示意 · 不代表已测全所有墙角`;
    const explanation = element('details', '', foot);
    element('summary', '', explanation).textContent = '匹配说明';
    element('div', '', explanation).textContent = `点连线围合 ${number(candidate.surveyAreaM2)} ㎡ · 模型边界 ${number(candidate.modelAreaM2)} ㎡`;
    element('div', '', explanation).textContent = `计算椭球：${candidate.datum?.calculationEllipsoid || '待确认'} · 初步匹配供位置核对`;
    if (Array.isArray(candidate.notes)) candidate.notes.forEach(note => { element('p', 'wsc-coord-note', explanation).textContent = String(note); });
    select(Math.min(selected, controls.length - 1)); projectionDirty = true;
  }

  function update() {
    if (disposed) return;
    const source = scene.userData.georeference;
    if (sourceReference !== source) { sourceReference = source; rebuild(source); }
    const available = Boolean(data) && width >= 580 && height >= 320 && !document.hidden && renderer.domElement.isConnected;
    if (root.hidden === available) root.hidden = !available;
    if (!available || !open) return;
    let changed = projectionDirty;
    const view = camera.matrixWorldInverse.elements, projection = camera.projectionMatrix.elements;
    for (let i = 0; i < 16; i++) {
      if (cameraElements[i] !== view[i] || cameraElements[i + 16] !== projection[i]) changed = true;
      cameraElements[i] = view[i]; cameraElements[i + 16] = projection[i];
    }
    if (!changed) return;
    projectionDirty = false;
    projected.forEach((point, index) => {
      viewPosition.copy(point.position).applyMatrix4(camera.matrixWorldInverse);
      clipPosition.copy(point.position).project(camera);
      const x = (clipPosition.x + 1) * width / 2, y = (1 - clipPosition.y) * height / 2;
      const visible = viewPosition.z < 0 && clipPosition.z >= -1 && clipPosition.z <= 1 &&
        Number.isFinite(x) && Number.isFinite(y) && x >= 14 && x <= width - 14 && y >= 14 && y <= height - 14;
      if (visible !== point.visible) { markerButtons[index].hidden = !visible; point.visible = visible; }
      if (!visible) return;
      const transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-50%)`;
      if (transform !== point.last) { markerButtons[index].style.transform = transform; point.last = transform; }
    });
  }

  function setSize(nextWidth: number, nextHeight: number) {
    const w = Number.isFinite(nextWidth) ? Math.max(0, nextWidth) : 0;
    const h = Number.isFinite(nextHeight) ? Math.max(0, nextHeight) : 0;
    if (w !== width || h !== height) { width = w; height = h; projectionDirty = true; }
    update();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    downloadTimers.forEach(timer => window.clearTimeout(timer)); downloadTimers.clear();
    downloadUrls.forEach(url => URL.revokeObjectURL(url)); downloadUrls.clear();
    dynamicListeners.splice(0).forEach(remove => remove()); listeners.splice(0).forEach(remove => remove());
    root.remove(); projected = []; markerButtons = []; pointButtons = []; mapPoints = [];
  }
  update();
  return { update, setSize, dispose };
}
