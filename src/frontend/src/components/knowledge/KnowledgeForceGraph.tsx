import { useEffect, useMemo, useRef, useState } from 'react'
import { init, use, type EChartsType, type ComposeOption } from 'echarts/core'
import { GraphChart, type GraphSeriesOption } from 'echarts/charts'
import { TooltipComponent, type TooltipComponentOption } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { LabelLayout } from 'echarts/features'
import { Focus, Minus, Plus } from 'lucide-react'
import { useApp } from '../../store/useApp'
import type { GraphData } from '../../lib/graphExploration'
import type { GraphPositions } from '../../lib/graphLayout'
import type { KnowledgeKind, KnowledgeNode } from '../../lib/knowledgeGraph'

use([GraphChart, TooltipComponent, CanvasRenderer, LabelLayout])
export const GRAPH_COLORS: Record<KnowledgeKind, string> = { stone: '#d6a444', story: '#a887dc', person: '#de735f', object: '#5294d8' }
export const GRAPH_LABELS: Record<KnowledgeKind, string> = { stone: '画像石', story: '故事', person: '人物', object: '物象' }
const RELATIONS: Record<string, string> = { depicts: '图像题材', has_character: '故事人物', has_object: '故事物象', typology_reference: '类型参照' }
export const graphRelation = (relation: string) => RELATIONS[relation] || '文献关联'
type ChartOption = ComposeOption<GraphSeriesOption | TooltipComponentOption>
const layouts = new WeakMap<GraphData, GraphPositions>()
interface Props { graph: GraphData; degrees: Map<string, number>; selectedId: string; overview: boolean; onSelect(id: string): void }

export default function KnowledgeForceGraph({ graph, degrees, selectedId, overview, onSelect }: Props) {
  const host = useRef<HTMLDivElement>(null), chart = useRef<EChartsType | null>(null)
  const fitted = useRef<GraphPositions | null>(null), selectRef = useRef(onSelect)
  selectRef.current = onSelect
  const theme = useApp(state => state.theme)
  const [layout, setLayout] = useState<{ graph: GraphData; positions: GraphPositions; ms: number } | null>(null)
  const [layoutError, setLayoutError] = useState(false)
  const [zoom, setZoom] = useState(100), zoomValue = useRef(1)

  useEffect(() => {
    setLayoutError(false)
    const cached = layouts.get(graph)
    if (cached) { setLayout({ graph, positions: cached, ms: 0 }); return }
    const start = performance.now()
    let worker: Worker | undefined, live = true
    const fallback = () => {
      if (!live) return
      const positions: GraphPositions = Object.fromEntries(graph.nodes.map((node, i) => {
        const angle = i * 2.399963, radius = Math.sqrt(i + 1) * 40
        return [node.id, [Math.cos(angle) * radius, Math.sin(angle) * radius]]
      }))
      setLayoutError(true); setLayout({ graph, positions, ms: performance.now() - start }); worker?.terminate()
    }
    try {
      worker = new Worker(new URL('../../workers/graphLayout.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<GraphPositions>) => {
        if (!live) return
        layouts.set(graph, event.data); setLayout({ graph, positions: event.data, ms: performance.now() - start }); worker?.terminate()
      }
      worker.onerror = fallback
      worker.postMessage({ nodes: graph.nodes.map(({ id }) => ({ id })), edges: graph.edges.map(({ source, target }) => ({ source, target })) })
    } catch { fallback() }
    return () => { live = false; worker?.terminate() }
  }, [graph])

  const ready = layout?.graph === graph
  const option = useMemo<ChartOption>(() => {
    const styles = getComputedStyle(document.documentElement)
    const text = styles.getPropertyValue('--text').trim() || '#d3dce6'
    const panel = styles.getPropertyValue('--bg-1').trim() || '#161d25'
    const line = styles.getPropertyValue('--line-2').trim() || '#33404e'
    const maxDegree = Math.max(1, ...graph.nodes.map(node => degrees.get(node.id) || 0))
    const labelled = new Set([...graph.nodes].sort((a, b) => (degrees.get(b.id) || 0) - (degrees.get(a.id) || 0)).slice(0, 55).map(node => node.id))
    return {
      backgroundColor: 'transparent', animation: false,
      tooltip: { confine: true, renderMode: 'richText', backgroundColor: panel, borderColor: line, textStyle: { color: text, fontSize: 12 },
        formatter: params => {
          const param = Array.isArray(params) ? params[0] : params
          const item = param.data as { name?: string; kind?: KnowledgeKind; degree?: number; relation?: string }
          return param.dataType === 'edge' ? graphRelation(item.relation || '') : `${item.name || ''}\n${item.kind ? GRAPH_LABELS[item.kind] : ''} · ${item.degree || 0} 条关系`
        } },
      series: [{
        id: 'knowledge', type: 'graph', layout: 'none', roam: true, draggable: true,
        left: 'center', top: 'center', scaleLimit: { min: .1, max: 5 },
        label: { show: true, position: 'right', color: text, fontSize: 11, distance: 4,
          textBorderColor: theme === 'light' ? '#f3f0e7' : '#181714', textBorderWidth: 2 },
        labelLayout: { hideOverlap: true },
        emphasis: { focus: 'adjacency', scale: 1.15, label: { show: true, fontSize: 14, fontWeight: 600 }, lineStyle: { width: 2, opacity: .9 } },
        blur: { itemStyle: { opacity: .16 }, lineStyle: { opacity: .07 }, label: { opacity: .22 } },
        edgeSymbol: ['none', overview ? 'none' : 'arrow'], edgeSymbolSize: [0, 5],
        lineStyle: { color: 'source', curveness: .08, opacity: .3, width: 1 },
        data: ready ? graph.nodes.map(node => {
          const degree = degrees.get(node.id) || 0, active = node.id === selectedId
          const [x, y] = layout.positions[node.id]
          return { id: node.id, name: node.label, kind: node.kind, degree, x, y,
            symbolSize: (active ? 20 : overview ? 7 : 13) + Math.round(Math.sqrt(degree / maxDegree) * 22),
            itemStyle: { color: GRAPH_COLORS[node.kind], borderColor: theme === 'light' ? '#312820' : '#fff4dc', borderWidth: active ? 2 : 0 },
            label: { show: active || graph.nodes.length <= 80 || labelled.has(node.id), fontWeight: active ? 600 : 400 } }
        }) : [],
        links: ready ? graph.edges.map(edge => ({ source: edge.source, target: edge.target, relation: edge.relation })) : [],
      }],
    }
  }, [graph, degrees, selectedId, overview, theme, layout, ready])

  useEffect(() => {
    const element = host.current
    if (!element) return
    const instance = init(element, undefined, { renderer: 'canvas', devicePixelRatio: Math.min(devicePixelRatio, 2) })
    chart.current = instance
    instance.on('click', params => { if (params.dataType === 'node') selectRef.current((params.data as KnowledgeNode).id) })
    instance.on('graphroam', event => {
      const factor = (event as { zoom?: number }).zoom
      if (factor == null) return
      zoomValue.current = Math.max(.1, Math.min(5, zoomValue.current * factor)); setZoom(Math.round(zoomValue.current * 100))
    })
    let frame = 0
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { if (element.clientWidth && element.clientHeight) instance.resize() })
    })
    resize.observe(element)
    return () => { resize.disconnect(); cancelAnimationFrame(frame); instance.dispose(); chart.current = null }
  }, [])

  function reset() {
    if (!chart.current) return
    chart.current.setOption({ ...option, series: (option.series as GraphSeriesOption[]).map(item => ({ ...item, zoom: 1, center: null })) }, { notMerge: true })
    zoomValue.current = 1; setZoom(100)
  }
  useEffect(() => {
    if (!chart.current) return
    if (ready && fitted.current !== layout.positions) { fitted.current = layout.positions; reset() }
    else chart.current.setOption(option)
  }, [option])
  function changeZoom(factor: number) {
    if (!chart.current) return
    zoomValue.current = Math.max(.1, Math.min(5, zoomValue.current * factor))
    chart.current.setOption({ series: [{ id: 'knowledge', zoom: zoomValue.current }] }); setZoom(Math.round(zoomValue.current * 100))
  }
  return <div className="kg-force-stage" data-layout-ms={ready ? Math.round(layout.ms) : undefined}>
    <div className="kg-chart" ref={host} role="img" aria-label={`知识图谱：${graph.nodes.length} 个节点、${graph.edges.length} 条关系。拖动节点调整位置；左侧目录可用键盘选择节点。`} />
    {!ready && <div className="kg-chart-empty" role="status">正在排列节点…</div>}
    {ready && !graph.nodes.length && <div className="kg-chart-empty">当前筛选下没有节点</div>}
    <div className="kg-canvas-count">{graph.nodes.length} 节点 · {graph.edges.length} 关系{layoutError && ' · 简化排列'}</div>
    <div className="kg-zoom" aria-label="图谱缩放">
      <button onClick={() => changeZoom(1.2)} aria-label="放大图谱" title="放大"><Plus size={16} /></button><span>{zoom}%</span>
      <button onClick={() => changeZoom(1 / 1.2)} aria-label="缩小图谱" title="缩小"><Minus size={16} /></button>
      <i /><button onClick={reset} aria-label="复位图谱" title="复位布局"><Focus size={16} /></button>
    </div>
  </div>
}
