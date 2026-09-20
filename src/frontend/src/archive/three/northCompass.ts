import * as THREE from 'three-inventory';
import type { Georeference } from './georeference';

export interface NorthCompass {
  update(): void;
  setSize(width: number, height: number): void;
  dispose(): void;
}

/** Invert just the linear world-X/Z → east/north transform; translation is irrelevant. */
export function registeredNorth(ref?: Georeference): THREE.Vector3 | null {
  const matrix = ref?.transform?.matrix2x3;
  if (!matrix || matrix.length !== 2 || matrix.some(row => row.length !== 3 || !row.every(Number.isFinite))) return null;
  const [[a, b], [c, d]] = matrix;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-12) return null;
  return new THREE.Vector3(-b / determinant, 0, a / determinant).normalize();
}

/** Clockwise dial angle from screen-up. The horizontal camera-right axis is stable
 * at a vertical bird's-eye view, where the horizontal view direction vanishes. */
export function compassAngle(north: THREE.Vector3, camera: THREE.Camera): number | null {
  const elements = camera.matrixWorld.elements;
  const rightX = elements[0], rightZ = elements[2];
  if (Math.hypot(rightX, rightZ) < 1e-8) return null;
  const screenRight = north.x * rightX + north.z * rightZ;
  const screenUp = north.x * rightZ - north.z * rightX;
  return Math.atan2(screenRight, screenUp) * 180 / Math.PI;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const css = `
.wsc-compass{position:absolute;right:18px;bottom:17px;z-index:7;width:112px;pointer-events:none;user-select:none;color:#ded4bf;font-family:"Microsoft YaHei",sans-serif;text-align:center;filter:drop-shadow(0 3px 9px #0003)}
.wsc-compass[hidden]{display:none!important}
.wsc-compass svg{display:block;width:100%;height:auto;overflow:visible}
.wsc-compass-caption{display:block;margin-top:1px;font-size:11px;letter-spacing:2px;line-height:20px;text-shadow:0 1px 3px #17232c,0 0 5px #17232c}
.wsc-compass[data-compact="true"]{width:78px;right:10px;bottom:9px}
.wsc-compass[data-compact="true"] .wsc-compass-caption{font-size:10px;line-height:16px;letter-spacing:1px}
`;

/** A light DOM compass shared by both viewers, independent of the RTK panel. */
export function createNorthCompass(
  renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
): NorthCompass {
  const host = renderer.domElement.parentElement;
  if (!host) return { update() {}, setSize() {}, dispose() {} };
  const root = document.createElement('div');
  root.className = 'wsc-compass'; root.hidden = true;
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', '指北针，红金色箭头指向北方，随观察方向转动');
  root.title = '北向依据院落坐标匹配，随视角转动';
  const style = document.createElement('style'); style.textContent = css; root.appendChild(style);
  const dial = document.createElementNS(SVG_NS, 'svg');
  dial.setAttribute('viewBox', '0 0 112 112'); dial.setAttribute('aria-hidden', 'true'); root.appendChild(dial);
  function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>, parent: SVGElement = dial) {
    const element = document.createElementNS(SVG_NS, tag);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    parent.appendChild(element); return element;
  }
  svg('circle', { cx: 56, cy: 56, r: 51, fill: '#19232bea', stroke: '#c4aa7466', 'stroke-width': 1 });
  svg('circle', { cx: 56, cy: 56, r: 44, fill: 'none', stroke: '#d5c19528', 'stroke-width': .7 });
  const rose = svg('g', { class: 'wsc-compass-rose' });
  for (let i = 0; i < 36; i++) {
    svg('line', { x1: 56, y1: 8, x2: 56, y2: i % 3 === 0 ? 12 : 10,
      stroke: i % 3 === 0 ? '#b9ab89' : '#80909b66', 'stroke-width': .8,
      transform: `rotate(${i * 10} 56 56)` }, rose);
  }
  svg('path', { d: 'M56 28 L66 60 L56 55 Z', fill: '#e1bb6c' }, rose);
  svg('path', { d: 'M56 28 L46 60 L56 55 Z', fill: '#be5748' }, rose);
  svg('path', { d: 'M56 84 L46 60 L56 55 Z', fill: '#bac7cf' }, rose);
  svg('path', { d: 'M56 84 L66 60 L56 55 Z', fill: '#697c8a' }, rose);
  svg('circle', { cx: 56, cy: 56, r: 3, fill: '#f3dfb5', stroke: '#17232c', 'stroke-width': 1 }, rose);
  const labels = [
    { text: '北 N', x: 56, y: 20, north: true },
    { text: 'E', x: 94, y: 56, north: false },
    { text: 'S', x: 56, y: 94, north: false },
    { text: 'W', x: 18, y: 56, north: false },
  ].map(label => {
    const group = svg('g', {}, rose);
    svg('text', { x: label.x, y: label.y, 'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: label.north ? '#efd098' : '#9badb9', 'font-size': label.north ? 11 : 10,
      'font-weight': label.north ? 700 : 500 }, group).textContent = label.text;
    return { ...label, group };
  });
  const caption = document.createElement('span'); caption.className = 'wsc-compass-caption';
  caption.textContent = '指北针'; root.appendChild(caption); host.appendChild(root);

  let width = 0, height = 0, disposed = false;
  let reference: Georeference | undefined, north: THREE.Vector3 | null = null;
  let lastAngle = '';
  function update() {
    if (disposed) return;
    const nextReference = scene.userData.georeference as Georeference | undefined;
    if (reference !== nextReference) { reference = nextReference; north = registeredNorth(reference); }
    const available = !!north && width >= 180 && height >= 150 && !document.hidden && renderer.domElement.isConnected;
    if (root.hidden === available) root.hidden = !available;
    if (!available || !north) return;
    const angle = compassAngle(north, camera);
    if (angle === null) return;
    const value = angle.toFixed(2);
    if (value === lastAngle) return;
    lastAngle = value;
    rose.setAttribute('transform', `rotate(${value} 56 56)`);
    // Counter-rotate the labels so north, east, south and west stay readable.
    labels.forEach(label => label.group.setAttribute('transform', `rotate(${-Number(value)} ${label.x} ${label.y})`));
  }
  function setSize(nextWidth: number, nextHeight: number) {
    width = nextWidth; height = nextHeight;
    root.dataset.compact = String(width < 580 || height < 380);
    update();
  }
  return { update, setSize, dispose() { disposed = true; root.remove(); } };
}
