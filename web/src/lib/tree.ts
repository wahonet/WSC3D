import type { Annotation } from '../types'
import { LEVEL_RANK } from './constants'
import { hasReferences } from './references'

/** 结构树节点：标注 + 子节点 + 深度 */
export interface TreeNode { a: Annotation; children: TreeNode[]; depth: number }

/** 结构节点 = 标注 / 分割工具创建、且不是对齐记录（测量与对齐不进树） */
export const isStructural = (a: Pick<Annotation, 'tool' | 'atype'>) =>
  (a.tool === 'annotate' || a.tool === 'segment') && a.atype !== 'align'

export const hasGeometry = (a: Pick<Annotation, 'atype' | 'geometry'>) =>
  a.atype !== 'none' && a.geometry != null && Object.keys(a.geometry).length > 0

/** 同级排序：先 seq（空的排后），再层级权重，再 id */
function cmp(x: Annotation, y: Annotation) {
  const sx = x.seq ?? Infinity, sy = y.seq ?? Infinity
  if (sx !== sy) return sx - sy
  const rx = LEVEL_RANK[x.level] ?? 9, ry = LEVEL_RANK[y.level] ?? 9
  if (rx !== ry) return rx - ry
  return x.id - y.id
}

/** 由扁平标注列表建树；父级缺失（被删 / 非结构节点）的当作根 */
export function buildTree(rows: Annotation[]): TreeNode[] {
  const nodes = rows.filter(isStructural)
  const ids = new Set(nodes.map(a => a.id))
  const kids = new Map<number | null, Annotation[]>()
  for (const a of nodes) {
    const p = a.parent_id != null && ids.has(a.parent_id) ? a.parent_id : null
    const arr = kids.get(p) ?? []
    arr.push(a)
    kids.set(p, arr)
  }
  const make = (parent: number | null, depth: number, seen: Set<number>): TreeNode[] =>
    (kids.get(parent) ?? []).sort(cmp).flatMap(a => {
      if (seen.has(a.id)) return []          // 防御：数据成环时截断
      const s = new Set(seen); s.add(a.id)
      return [{ a, depth, children: make(a.id, depth + 1, s) }]
    })
  return make(null, 0, new Set())
}

/** 先序展开（跳过折叠节点的子树） */
export function flatten(tree: TreeNode[], collapsed: Set<number>): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) {
      out.push(n)
      if (!collapsed.has(n.a.id)) walk(n.children)
    }
  }
  walk(tree)
  return out
}

export function descendantIds(rows: Annotation[], rootId: number): Set<number> {
  const kids = new Map<number, number[]>()
  for (const a of rows) if (a.parent_id != null) (kids.get(a.parent_id) ?? kids.set(a.parent_id, []).get(a.parent_id)!).push(a.id)
  const out = new Set<number>()
  const stack = [rootId]
  while (stack.length) {
    const cur = stack.pop()!
    for (const k of kids.get(cur) ?? []) if (!out.has(k)) { out.add(k); stack.push(k) }
  }
  return out
}

/** 从节点向上到根的路径（不含自身），用于面包屑 */
export function ancestors(byId: Map<number, Annotation>, a: Annotation): Annotation[] {
  const out: Annotation[] = []
  let cur = a.parent_id != null ? byId.get(a.parent_id) : undefined
  const seen = new Set<number>([a.id])
  while (cur && !seen.has(cur.id)) { out.unshift(cur); seen.add(cur.id); cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined }
  return out
}

export interface Progress {
  total: number
  byLevel: Record<string, number>
  candidates: number
  noGeometry: number
  orphans: number
  linked: number
  withConcept: number
}

export function progress(rows: Annotation[]): Progress {
  const nodes = rows.filter(isStructural)
  const p: Progress = { total: nodes.length, byLevel: {}, candidates: 0, noGeometry: 0, orphans: 0, linked: 0, withConcept: 0 }
  for (const a of nodes) {
    p.byLevel[a.level] = (p.byLevel[a.level] ?? 0) + 1
    if (a.review_status === 'candidate') p.candidates++
    if (!hasGeometry(a)) p.noGeometry++
    if (a.parent_id == null && a.level !== 'whole' && a.review_status !== 'candidate') p.orphans++
    if (hasReferences(a)) p.linked++
    if (a.concept_ids.length) p.withConcept++
  }
  return p
}
