import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Focus, Minus, Plus } from 'lucide-react'
import type { KnowledgeEdge, KnowledgeNode } from '../../lib/knowledgeGraph'
import { FOCUS_COLORS, FOCUS_LABELS, focusPositions } from '../../lib/graphFocus'

const lines = (label: string, width = 8) => Array.from({ length: Math.ceil(label.length / width) }, (_, i) => label.slice(i * width, (i + 1) * width))
const relation = (value: string) => ({ depicts: '图像题材', has_character: '故事人物', has_object: '故事物象' }[value] || '文献关联')

/** Focus + concentric neighbourhood interaction inspired by Cytoscape's Wine & Cheese Map. */
export default function KnowledgeFocusGraph({ center, neighbors, edges, onSelect }: {
  center: KnowledgeNode; neighbors: KnowledgeNode[]; edges: KnowledgeEdge[]; onSelect(id: string): void;
}) {
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null)
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 })
  const [hover, setHover] = useState('')
  const [bounds, setBounds] = useState({ width: 840, height: 700 })
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setBounds({ width: entry.contentRect.width, height: entry.contentRect.height }))
    if (svg.current) observer.observe(svg.current)
    return () => observer.disconnect()
  }, [])
  const positions = useMemo(() => focusPositions(neighbors, bounds.width, bounds.height), [neighbors, bounds])
  const compact = bounds.width < 500
  useEffect(() => { setCamera({ x: 0, y: 0, zoom: 1 }); setHover('') }, [center.id, neighbors])
  const zoom = (factor: number) => setCamera(c => ({ ...c, zoom: Math.min(2.6, Math.max(.6, c.zoom * factor)) }))
  return <div className="kgx-canvas">
    <svg ref={svg} viewBox={`${camera.x - bounds.width / 2 / camera.zoom} ${camera.y - bounds.height / 2 / camera.zoom} ${bounds.width / camera.zoom} ${bounds.height / camera.zoom}`}
      aria-label={`${center.label}的关联图，节点可点击或使用键盘选择`} onPointerDown={event => {
        if ((event.target as Element).closest('[data-node]') || event.button !== 0) return
        drag.current = { x: event.clientX, y: event.clientY, startX: camera.x, startY: camera.y }
        event.currentTarget.setPointerCapture(event.pointerId)
      }} onPointerMove={event => {
        const p = drag.current, host = svg.current
        if (!p || !host) return
        const scale = camera.zoom
        setCamera(c => ({ ...c, x: p.startX - (event.clientX - p.x) / scale, y: p.startY - (event.clientY - p.y) / scale }))
      }} onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
      onPointerCancel={() => { drag.current = null }}>
      <ellipse className="kgx-orbit" rx={Math.max(85, (bounds.width - (compact ? 136 : 168)) / 2)} ry={Math.max(100, (bounds.height - 148) / 2)} />
      {positions.map(({ node, x, y }) => {
        const edge = edges.find(e => (e.source === center.id && e.target === node.id) || (e.target === center.id && e.source === node.id))
        return <g key={node.id} className={`kgx-edge${hover === node.id ? ' on' : ''}`}>
          <path d={`M0,0 Q${x * .32 - y * .09},${y * .32 + x * .09} ${x},${y}`} />
          {hover === node.id && <text x={x * .53} y={y * .53 - 8} textAnchor="middle">{relation(edge?.relation || '')}</text>}
        </g>
      })}
      {positions.map(({ node, x, y }) => <g key={node.id} data-node={node.id} className="kgx-node" role="button" tabIndex={0}
        aria-label={`探索${node.label}`} transform={`translate(${x},${y})`} style={{ '--node-color': FOCUS_COLORS[node.kind] } as CSSProperties}
        onClick={() => onSelect(node.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id) } }}
        onMouseEnter={() => setHover(node.id)} onMouseLeave={() => setHover('')} onFocus={() => setHover(node.id)} onBlur={() => setHover('')}>
        <title>{node.label} · {FOCUS_LABELS[node.kind]} · 点击继续探索</title>
        <rect x={compact ? -56 : -68} y="-37" width={compact ? 112 : 136} height="74" rx="10" />
        <circle cx={compact ? -43 : -51} cy="-22" r="3" /><text className="kgx-node-kind" x={compact ? -35 : -42} y="-18">{node.stone_id || FOCUS_LABELS[node.kind]}</text>
        {lines(node.label, compact ? 7 : 8).slice(0, 2).map((line, i) => <text key={i} textAnchor="middle" y={lines(node.label, compact ? 7 : 8).length > 1 ? 3 + i * 19 : 13}>{i === 1 && node.label.length > (compact ? 14 : 16) ? line.slice(0, -1) + '…' : line}</text>)}
      </g>)}
      <g className="kgx-center" style={{ '--node-color': FOCUS_COLORS[center.kind] } as CSSProperties}>
        <circle r={compact ? 54 : 70} /><circle className="kgx-center-ring" r={compact ? 60 : 78} />
        <text className="kgx-center-kind" y="-36" textAnchor="middle">{FOCUS_LABELS[center.kind]}{center.stone_id ? ` · ${center.stone_id}` : ''}</text>
        {lines(center.label, compact ? 6 : 7).slice(0, 3).map((line, i, all) => <text key={i} style={{ fontSize: compact ? 16 : 18 }} y={12 - (all.length - 1) * 10 + i * 20} textAnchor="middle">{line}{i === 2 && center.label.length > (compact ? 18 : 21) ? '…' : ''}</text>)}
      </g>
    </svg>
    <div className="kgx-zoom"><button aria-label="缩小图谱" onClick={() => zoom(1 / 1.2)}><Minus size={15} /></button><span>{Math.round(camera.zoom * 100)}%</span><button aria-label="放大图谱" onClick={() => zoom(1.2)}><Plus size={15} /></button><button aria-label="适应画布" onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}><Focus size={16} /></button></div>
    <p className="kgx-canvas-tip">点击节点继续探索 · 拖动画布平移</p>
  </div>
}
