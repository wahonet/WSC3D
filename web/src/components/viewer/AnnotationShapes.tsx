import type { MouseEvent } from 'react'
import { COLORS } from '../../lib/constants'
import type { Pt } from '../../lib/geometry'
import type { Annotation, ProjectedAnnotation } from '../../types'

type ToEl = (p: Pt) => Pt

const label = (x: number, y: number, text: string, key?: string) => (
  <text key={key} x={x} y={y} fill="#fff" stroke="#14120f" strokeWidth={3} paintOrder="stroke"
    fontSize={12} fontWeight={600} textAnchor="middle" fontFamily="var(--font-mono)">{text}</text>
)

/** 已保存的 2D 标注（矩形 / 多边形 / 点 / 测距线） */
export function AnnoShape({ a, toEl, selected, interactive, onSelect, linkedTint }: {
  a: Annotation; toEl: ToEl; selected: boolean; interactive: boolean
  onSelect?: (id: number) => void
  /** 研究模块：已图文关联的标注用橙色 */
  linkedTint?: boolean
}) {
  if (a.atype === 'align' || a.atype === 'point3d' || a.atype === 'line3d') return null
  const isSeg = a.tool === 'segment'
  const stroke = selected ? COLORS.select : linkedTint && a.desc_text ? COLORS.linked : (a.color || COLORS.amber)
  const common = {
    stroke, strokeWidth: selected ? 2.6 : isSeg ? 1.8 : 1.6,
    fill: stroke, fillOpacity: selected ? 0.2 : isSeg ? 0.13 : 0.11,
    strokeDasharray: isSeg ? '7 5' : undefined,
    strokeLinejoin: 'round' as const,
    className: interactive ? 'hit' : undefined,
    onClick: interactive ? (e: MouseEvent) => { e.stopPropagation(); onSelect?.(a.id) } : undefined,
  }
  const g = a.geometry as Record<string, unknown>
  const title = <title>{a.label}{a.note && !isSeg ? ` - ${a.note.slice(0, 60)}` : ''}</title>

  if (a.atype === 'rect') {
    const [x1, y1] = toEl([g.x as number, g.y as number])
    const [x2, y2] = toEl([(g.x as number) + (g.w as number), (g.y as number) + (g.h as number)])
    return <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} rx={1.5} {...common}>{title}</rect>
  }
  if (a.atype === 'polygon') {
    const pts = (g.points as Pt[]).map(p => toEl(p).join(',')).join(' ')
    return <polygon points={pts} {...common}>{title}</polygon>
  }
  if (a.atype === 'point') {
    const [x, y] = toEl(g.p as Pt)
    return (
      <g {...common}>
        {title}
        <circle cx={x} cy={y} r={selected ? 8 : 6} fill={stroke} fillOpacity={0.9} stroke="#fff" strokeWidth={1.6} />
        <circle cx={x} cy={y} r={1.8} fill="#fff" stroke="none" />
      </g>
    )
  }
  if (a.atype === 'line') {
    const [x1, y1] = toEl(g.p1 as Pt), [x2, y2] = toEl(g.p2 as Pt)
    return (
      <g {...common} fill="none">
        {title}
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={selected ? 3 : 2} />
        <circle cx={x1} cy={y1} r={3.5} fill={stroke} />
        <circle cx={x2} cy={y2} r={3.5} fill={stroke} />
        {a.value != null && label((x1 + x2) / 2, (y1 + y2) / 2 - 9, `${a.value.toFixed(0)} px`)}
      </g>
    )
  }
  return null
}

/** 跨图投影标注：沿用标注自身颜色、以点划线表示"投影自其他图层"；可选中（研究模块）与高亮 */
export function ProjectedShape({ p, toEl, selected, linkedTint, interactive, onSelect }: {
  p: ProjectedAnnotation; toEl: ToEl; selected?: boolean; linkedTint?: boolean
  interactive?: boolean; onSelect?: (id: number) => void
}) {
  const g = p.geometry as Record<string, unknown>
  const c = selected ? COLORS.select : linkedTint ? COLORS.linked : (p.color || COLORS.proj)
  const style = {
    stroke: c, strokeWidth: selected ? 2.6 : 1.7, strokeDasharray: selected ? '5 3' : '2 4',
    fill: c, fillOpacity: selected ? 0.18 : 0.07,
  }
  const groupProps = {
    className: interactive ? 'hit' : undefined,
    onClick: interactive ? (e: MouseEvent) => { e.stopPropagation(); onSelect?.(p.id) } : undefined,
  }
  const title = <title>{`[投影自 ${p.source_filename}] ${p.label}`}</title>
  if (p.atype === 'polygon') {
    const pts = (g.points as Pt[]).map(q => toEl(q).join(',')).join(' ')
    return <g {...groupProps}>{title}<polygon points={pts} {...style} /></g>
  }
  if (p.atype === 'point') {
    const [x, y] = toEl(g.p as Pt)
    return (
      <g {...groupProps}>
        {title}
        <circle cx={x} cy={y} r={selected ? 8 : 6} fill="none" stroke={c} strokeWidth={1.7} strokeDasharray="2 3" />
        <circle cx={x} cy={y} r={2} fill={c} />
      </g>
    )
  }
  if (p.atype === 'line') {
    const [x1, y1] = toEl(g.p1 as Pt), [x2, y2] = toEl(g.p2 as Pt)
    return <g {...groupProps}>{title}<line x1={x1} y1={y1} x2={x2} y2={y2} {...style} fill="none" /></g>
  }
  return null
}

/** 分割候选掩膜：青色虚线；可点击剔除（剔除后红色淡显）；显示分数 */
export function SegCandidate({ poly, score, excluded, interactive, onToggle, toEl }: {
  poly: Pt[]; score?: number; excluded?: boolean; interactive?: boolean; onToggle?: () => void; toEl: ToEl
}) {
  const c = excluded ? COLORS.negPoint : COLORS.seg
  const pts = poly.map(p => toEl(p))
  let top = pts[0] ?? [0, 0]
  for (const p of pts) if (p[1] < top[1]) top = p
  return (
    <g className={interactive ? 'hit' : undefined}
      onClick={interactive ? (e: MouseEvent) => { e.stopPropagation(); onToggle?.() } : undefined}>
      <title>{excluded ? '已剔除，点击恢复' : `候选 ${score != null ? score.toFixed(2) : ''}（点击剔除）`}</title>
      <polygon points={pts.map(p => p.join(',')).join(' ')}
        fill={c} fillOpacity={excluded ? 0.05 : 0.16} stroke={c} strokeOpacity={excluded ? 0.5 : 1}
        strokeWidth={2} strokeDasharray={excluded ? '3 5' : '7 4'} />
      {score != null && !excluded && label(top[0], top[1] - 6, score.toFixed(2))}
    </g>
  )
}

/** SAM3 示例框：正例绿实线 / 负例红虚线 */
export function ExemplarBoxShape({ box, index, toEl }: {
  box: { cx: number; cy: number; w: number; h: number; label: 0 | 1 }; index: number; toEl: ToEl
}) {
  const [x1, y1] = toEl([box.cx - box.w / 2, box.cy - box.h / 2])
  const [x2, y2] = toEl([box.cx + box.w / 2, box.cy + box.h / 2])
  const c = box.label === 1 ? COLORS.posPoint : COLORS.negPoint
  return (
    <g>
      <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill={c} fillOpacity={0.06}
        stroke={c} strokeWidth={2} strokeDasharray={box.label === 1 ? undefined : '6 4'} />
      {label(x1 + 22, y1 - 6, `${box.label === 1 ? '示例+' : '示例-'}${index + 1}`)}
    </g>
  )
}

/** 分割点提示：正点绿十字，负点红十字带圈 */
export function SegPointMark({ p, positive, toEl }: { p: Pt; positive: boolean; toEl: ToEl }) {
  const [x, y] = toEl(p)
  const c = positive ? COLORS.posPoint : COLORS.negPoint
  return (
    <g stroke={c} strokeWidth={2.4} strokeLinecap="round">
      <line x1={x - 7} y1={y} x2={x + 7} y2={y} />
      <line x1={x} y1={y - 7} x2={x} y2={y + 7} />
      {!positive && <circle cx={x} cy={y} r={10} fill="none" strokeWidth={1.6} />}
    </g>
  )
}

export const measureLabel = label
