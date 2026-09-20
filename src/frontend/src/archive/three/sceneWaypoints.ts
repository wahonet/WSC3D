import type { ViewKey } from '../types';
import { CENTER_PLACEMENT } from './hanwenhuaCenter';
import contextManifest from './siteContextManifest.json';

/** One source for the established camera positions and their scene navigation. */
export const VIEWPOINTS: Record<ViewKey, { p: number[]; t: number[] }> = {
  pan:  { p: [98, 86, 120], t: [-2, 0, 2] },
  gate: { p: [-52, 5, -42], t: [-38, 2, -26] },
  que:  { p: [6, 15, 8], t: [-13, 2, -11] },
  xcl:  { p: [-12, 5, 2], t: [-16, 2, 20] },
  hall: { p: [30, 18, 45], t: [8.4, 3, 21] },
  bl:   { p: [20, 11, -22], t: [6, 1, -38] },
  center: { p: CENTER_PLACEMENT.viewpoint.p, t: CENTER_PLACEMENT.viewpoint.t },
  site: { p: contextManifest.viewpoint.p, t: contextManifest.viewpoint.t },
};

export type WaypointKey = Exclude<ViewKey, 'pan' | 'site'>;
export interface SceneWaypoint {
  key: WaypointKey;
  label: string;
  anchor: [number, number, number];
}

// The same CAD-to-world conversion and building centres used by buildSite.ts.
// Marker height keeps the yellow point above its roof without moving the model.
function courtyardAnchor(x: number, z: number, height: number): [number, number, number] {
  return [(423.1 - 687) * .17639 + Math.SQRT1_2 * (x - z), height,
    (124.6 - 314) * .17639 + Math.SQRT1_2 * (x + z)];
}

export const SCENE_WAYPOINTS: readonly SceneWaypoint[] = [
  { key: 'gate', label: '大门', anchor: courtyardAnchor(1.49, 0, 6.4) },
  { key: 'que', label: '阙室', anchor: courtyardAnchor(39.34, 0, 10.3) },
  { key: 'xcl', label: '西长廊', anchor: courtyardAnchor(58.62, 14.88, 6.4) },
  { key: 'hall', label: '后展厅', anchor: courtyardAnchor(77.4, 0, 10.3) },
  { key: 'bl', label: '北长廊', anchor: courtyardAnchor((20.86 + 47.17) / 2, (-34.72 - 55.10) / 2, 4.0) },
  { key: 'center', label: '传承中心', anchor: [VIEWPOINTS.center.t[0], 18, VIEWPOINTS.center.t[2]] },
];
