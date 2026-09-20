import * as THREE from 'three-inventory';
import { SCENE_WAYPOINTS, type WaypointKey } from './sceneWaypoints';
import './sceneNavigation.css';

/** Project accessible buttons onto real building positions. No pickable geometry
 * is added, so navigation never changes stone selection, doors or collisions. */
export function createSceneNavigation(
  host: HTMLElement,
  camera: THREE.PerspectiveCamera,
  state: () => { active: boolean; contextOn: boolean },
  navigate: (key: WaypointKey) => void,
) {
  const root = document.createElement('nav');
  root.className = 'scene-waypoints';
  root.setAttribute('aria-label', '院落地点导航');
  root.hidden = true;
  const status = document.createElement('span');
  status.className = 'scene-waypoint-announcement';
  status.setAttribute('role', 'status');
  root.appendChild(status);
  let selected: WaypointKey | null = null;
  const entries = SCENE_WAYPOINTS.map(waypoint => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scene-waypoint';
    button.dataset.waypoint = waypoint.key;
    button.dataset.anchor = waypoint.anchor.join(',');
    const dot = document.createElement('span');
    dot.className = 'scene-waypoint-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'scene-waypoint-label';
    label.textContent = waypoint.label;
    const suffix = document.createElement('span');
    suffix.className = 'scene-waypoint-suffix';
    label.appendChild(suffix);
    button.append(dot, label);
    button.addEventListener('pointerdown', event => event.stopPropagation());
    button.addEventListener('click', event => {
      event.stopPropagation();
      selected = waypoint.key;
      for (const entry of entries) entry.button.setAttribute('aria-pressed', String(entry.key === selected));
      status.textContent = `前往${waypoint.label}`;
      navigate(waypoint.key);
    });
    button.setAttribute('aria-pressed', 'false');
    root.appendChild(button);
    return { ...waypoint, button, suffix, position: new THREE.Vector3(...waypoint.anchor), lastTransform: '', lastLabel: '', lastEdge: false };
  });
  host.appendChild(root);
  const projected = new THREE.Vector3();
  const view = new THREE.Vector3();
  let disposed = false;

  function update() {
    if (disposed) return;
    const current = state();
    const width = host.clientWidth, height = host.clientHeight;
    root.hidden = !current.active || width < 160 || height < 160;
    if (root.hidden) return;
    const card = host.parentElement?.querySelector('.sc-card')?.getBoundingClientRect();
    const hostRect = card ? host.getBoundingClientRect() : null;
    for (const entry of entries) {
      view.copy(entry.position).applyMatrix4(camera.matrixWorldInverse);
      projected.copy(entry.position).project(camera);
      const inFront = view.z < -camera.near;
      let x = (projected.x + 1) * width / 2;
      let y = (1 - projected.y) * height / 2;
      const marginX = Math.min(86, width / 4);
      const top = Math.min(112, height / 3), bottom = height - 100;
      const inside = inFront && projected.z >= -1 && projected.z <= 1 &&
        x >= marginX && x <= width - marginX && y >= top && y <= bottom;
      // The proposed centre is north of the courtyard. Keep a direction marker
      // at the viewport edge until it is in view, including before its layer loads.
      const edge = entry.key === 'center' && !inside;
      entry.button.hidden = !inside && !edge;
      if (entry.button.hidden) continue;
      if (edge) {
        let dx = inFront ? x - width / 2 : view.x;
        let dy = inFront ? y - height / 2 : -view.y;
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < .01) { dx = 0; dy = -1; }
        const radiusX = width / 2 - marginX;
        const radiusY = Math.max(20, (bottom - top) / 2);
        const scale = 1 / Math.max(Math.abs(dx) / radiusX, Math.abs(dy) / radiusY, .0001);
        x = width / 2 + dx * scale;
        y = (top + bottom) / 2 + dy * scale;
        // Keep an offscreen direction point reachable when the selected stone's
        // information card covers the right side of the panorama.
        if (card && hostRect && y + 60 > card.top - hostRect.top && y - 22 < card.bottom - hostRect.top && x + 86 > card.left - hostRect.left) {
          x = Math.max(marginX, card.left - hostRect.left - 100);
        }
      }
      if (entry.lastEdge !== edge) { entry.button.dataset.edge = String(edge); entry.lastEdge = edge; }
      const transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
      if (entry.lastTransform !== transform) { entry.button.style.transform = transform; entry.lastTransform = transform; }
      const reveal = entry.key === 'center' && !current.contextOn;
      const label = `前往${entry.label}${reveal ? '，同时显示周边环境' : ''}`;
      if (entry.lastLabel !== label + edge) {
        entry.suffix.textContent = reveal ? ' · 显示周边' : edge ? ' · 前往' : '';
        entry.button.setAttribute('aria-label', label);
        entry.button.title = `点击前往${entry.label}${reveal ? '，同时显示周边环境及传承中心' : ''}`;
        entry.lastLabel = label + edge;
      }
    }
  }

  return { update, dispose() { disposed = true; root.remove(); } };
}
