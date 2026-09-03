import type { AlignChain, AlignGeometry, Annotation, AssetBrief, OverlayTransform } from '../types'

export type Pt = [number, number]

type Sim = { s: number; theta_deg: number; tx: number; ty: number }

/** 先 b 后 a：compose(a, b)(p) = a(b(p))（与后端 transforms.compose 一致） */
export function composeSim(a: Sim, b: Sim): Sim {
  const th = (a.theta_deg * Math.PI) / 180
  const c = Math.cos(th), s = Math.sin(th)
  return {
    s: a.s * b.s, theta_deg: a.theta_deg + b.theta_deg,
    tx: a.s * (c * b.tx - s * b.ty) + a.tx, ty: a.s * (s * b.tx + c * b.ty) + a.ty,
  }
}
export function invertSim(t: Sim): Sim {
  const th = (t.theta_deg * Math.PI) / 180
  const c = Math.cos(th), s = Math.sin(th)
  const k = 1 / t.s
  return { s: k, theta_deg: -t.theta_deg, tx: -k * (c * t.tx + s * t.ty), ty: -k * (-s * t.tx + c * t.ty) }
}

/** 由两张已入链图的坐标链算出把 other 叠到 base 上的叠加参数（other 像素 -> base 像素） */
export function overlayFromChains(base: AssetBrief, other: AssetBrief): OverlayTransform | null {
  const cb = base.extra.align_to_master as AlignChain | null | undefined
  const co = other.extra.align_to_master as AlignChain | null | undefined
  if (!cb || !co) return null
  const t = composeSim(invertSim(cb), co)
  return alignGeomToOverlay({
    target_asset_id: other.id, pairs: [], s: t.s, theta_deg: t.theta_deg, tx: t.tx, ty: t.ty, rmse_px: 0,
    wl: base.width, hl: base.height, wr: other.width, hr: other.height,
  })
}

/** 由保存的对齐几何计算 OSD 叠加参数（左图视口宽 = 1） */
export function alignGeomToOverlay(g: AlignGeometry): OverlayTransform {
  const th = (g.theta_deg * Math.PI) / 180
  const c = Math.cos(th), s = Math.sin(th)
  const cx = g.wr / 2, cy = g.hr / 2
  const mx = g.s * (c * cx - s * cy) + g.tx
  const my = g.s * (s * cx + c * cy) + g.ty
  const wVp = (g.s * g.wr) / g.wl
  const hVp = wVp * (g.hr / g.wr)
  return { xVp: mx / g.wl - wVp / 2, yVp: my / g.wl - hVp / 2, wVp, deg: g.theta_deg }
}

/** Umeyama 2D 相似变换（右图像素 -> 左图像素）+ RMSE */
export function solveSimilarity(L: Pt[], R: Pt[]) {
  const n = L.length
  const ma = [0, 0], mb = [0, 0]
  for (let i = 0; i < n; i++) { ma[0] += L[i][0]; ma[1] += L[i][1]; mb[0] += R[i][0]; mb[1] += R[i][1] }
  ma[0] /= n; ma[1] /= n; mb[0] /= n; mb[1] /= n
  let P = 0, Q = 0, nb = 0
  for (let i = 0; i < n; i++) {
    const ax = L[i][0] - ma[0], ay = L[i][1] - ma[1]
    const bx = R[i][0] - mb[0], by = R[i][1] - mb[1]
    P += ax * bx + ay * by
    Q += ay * bx - ax * by
    nb += bx * bx + by * by
  }
  const theta = Math.atan2(Q, P)
  const s = nb > 0 ? Math.hypot(P, Q) / nb : 1
  const c = Math.cos(theta), si = Math.sin(theta)
  const tx = ma[0] - s * (c * mb[0] - si * mb[1])
  const ty = ma[1] - s * (si * mb[0] + c * mb[1])
  let se = 0
  for (let i = 0; i < n; i++) {
    const px = s * (c * R[i][0] - si * R[i][1]) + tx
    const py = s * (si * R[i][0] + c * R[i][1]) + ty
    se += (px - L[i][0]) ** 2 + (py - L[i][1]) ** 2
  }
  return { s, theta_deg: (theta * 180) / Math.PI, tx, ty, rmse: Math.sqrt(se / n) }
}

/** 2D 标注在归一化坐标下的外接矩形 [x, y, w, h]；非 2D 几何返回 null */
export function annotationBounds(a: Pick<Annotation, 'atype' | 'geometry'>): [number, number, number, number] | null {
  const g = a.geometry as Record<string, unknown>
  let pts: Pt[] = []
  if (a.atype === 'rect') {
    const x = g.x as number, y = g.y as number, w = g.w as number, h = g.h as number
    return [x, y, w, h]
  }
  if (a.atype === 'ellipse') {
    const cx = g.cx as number, cy = g.cy as number, rx = g.rx as number, ry = g.ry as number
    return [cx - rx, cy - ry, 2 * rx, 2 * ry]
  }
  if (a.atype === 'polygon') pts = g.points as Pt[]
  else if (a.atype === 'point') pts = [g.p as Pt]
  else if (a.atype === 'line') pts = [g.p1 as Pt, g.p2 as Pt]
  else return null
  if (!pts?.length) return null
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  return [x0, y0, Math.max(x1 - x0, 0.0005), Math.max(y1 - y0, 0.0005)]
}
