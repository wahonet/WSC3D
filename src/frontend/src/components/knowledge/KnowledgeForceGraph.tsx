import { useEffect, useMemo, useRef, useState } from 'react'
import { init, use, type EChartsType, type ComposeOption } from 'echarts/core'
import { GraphChart, type GraphSeriesOption } from 'echarts/charts'
import { TooltipComponent, type TooltipComponentOption } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { LabelLayout } from 'echarts/features'
import { Focus, Minus, Plus } from 'lucide-react'
import { useApp } from '../../store/useApp'
import type { GraphData } from '../../lib/graphExploration'
import type { KnowledgeKind, KnowledgeNode } from '../../lib/knowledgeGraph'

use([GraphChart, TooltipComponent, CanvasRenderer, LabelLayout])

// Match the reference project's type palette and force-directed graph treatment.
export const GRAPH_COLORS: Record<KnowledgeKind, string> = {
  stone: '#e6a23c', story: '#b37feb', person: '#f56c6c', object: '#409eff',
}
export const GRAPH_LABELS: Record<KnowledgeKind, string> = {
  stone: '画像石', story: '故事', person: '人物', object: '物象',
}
const RELATIONS: Record<string, string> = { depicts: '图像题材', has_character: '故事人物', has_object: '故事物象' }
export const graphRelation = (relation: string) => RELATIONS[relation] || '文献关联'
type ChartOption = ComposeOption<GraphSeriesOption | TooltipComponentOption>

interface Props {
  graph: GraphData
  degrees: Map<string, number>
  selectedId: string
  overview: boolean
  onSelect(id: string): void
}

export default function KnowledgeForceGraph({ graph, degrees, selectedId, overview, onSelect }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const chart = useRef<EChartsType | null>(null)
  const selectRef = useRef(onSelect)
  selectRef.current = onSelect
  const theme = useApp(state => state.theme)
  const [zoom, setZoom] = useState(100)
  const option = useMemo<ChartOption>(() => {
    const styles = getComputedStyle(document.documentElement)
    const text = styles.getPropertyValue('--text').trim() || '#d3dce6'
    const panel = styles.getPropertyValue('--bg-1').trim() || '#161d25'
    const line = styles.getPropertyValue('--line-2').trim() || '#33404e'
    const maxDegree = Math.max(1, ...graph.nodes.map(node => degrees.get(node.id) || 0))
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
    return {
      backgroundColor: 'transparent',
      animationDurationUpdate: reducedMotion ? 0 : 280,
      tooltip: {
        confine: true, renderMode: 'richText', backgroundColor: panel, borderColor: line,
        textStyle: { color: text, fontSize: 12 },
        formatter: params => {
          const param = Array.isArray(params) ? params[0] : params
          const item = param.data as { name?: string; kind?: KnowledgeKind; degree?: number; relation?: string }
          return param.dataType === 'edge' ? graphRelation(item.relation || '')
            : `${item.name || ''}\n${item.kind ? GRAPH_LABELS[item.kind] : ''} · ${item.degree || 0} 条关联`
        },
      },
      series: [{
        id: 'knowledge', type: 'graph', layout: 'force', roam: true, draggable: true,
        zoom: 1, scaleLimit: { min: .1, max: 4 },
        label: { show: true, position: 'right', color: text, fontSize: 12, distance: 5,
          textBorderColor: theme === 'light' ? '#f3f5f8' : '#10151b', textBorderWidth: 3 },
        labelLayout: { hideOverlap: true },
        emphasis: { focus: 'adjacency', scale: 1.2, label: { show: true, fontSize: 14, fontWeight: 600 },
          lineStyle: { width: 2.5, opacity: .95 } },
        blur: { itemStyle: { opacity: .16 }, lineStyle: { opacity: .07 }, label: { opacity: .22 } },
        force: { initLayout: 'circular', repulsion: overview ? (graph.nodes.length > 80 ? 90 : 180) : 300,
          edgeLength: overview ? [75, 155] : [110, 205], gravity: overview ? .09 : .075, friction: .08,
          layoutAnimation: !reducedMotion },
        edgeSymbol: ['none', 'arrow'], edgeSymbolSize: [0, 5],
        lineStyle: { color: 'source', curveness: .1, opacity: .43 },
        data: graph.nodes.map(node => {
          const degree = degrees.get(node.id) || 0
          const active = node.id === selectedId
          return {
            id: node.id, name: node.label, kind: node.kind, degree,
            symbolSize: (node.id === selectedId ? 24 : 10) + Math.round(Math.sqrt(degree / maxDegree) * 28),
            itemStyle: { color: GRAPH_COLORS[node.kind], borderColor: active ? (theme === 'light' ? '#fff' : '#ecf2f9') : 'transparent',
              borderWidth: active ? 2.5 : 0, shadowBlur: active ? 15 : 0, shadowColor: GRAPH_COLORS[node.kind] },
            label: node.id === selectedId ? { fontWeight: 600, fontSize: 14 }
              : overview && graph.nodes.length > 80 ? { show: node.kind === 'stone' || degree >= 5 } : undefined,
            emphasis: { label: { show: true } },
          }
        }),
        links: graph.edges.map(edge => ({
          source: edge.source, target: edge.target, relation: edge.relation,
          lineStyle: { type: edge.relation === 'depicts' ? 'dashed' : 'solid',
            opacity: edge.relation === 'depicts' ? .3 : .48,
            width: 1.2 },
        })),
      }],
    }
  }, [graph, degrees, selectedId, overview, theme])

  useEffect(() => {
    const element = host.current
    if (!element) return
    const instance = init(element, undefined, { renderer: 'canvas' })
    chart.current = instance
    instance.on('click', params => {
      if (params.dataType === 'node') selectRef.current((params.data as KnowledgeNode).id)
    })
    instance.on('graphroam', () => {
      const series = instance.getOption().series as GraphSeriesOption[]
      setZoom(Math.round((series[0]?.zoom || 1) * 100))
    })
    const resize = new ResizeObserver(() => { if (element.clientWidth && element.clientHeight) instance.resize() })
    resize.observe(element)
    return () => { resize.disconnect(); instance.dispose(); chart.current = null }
  }, [])

  function fitLayout(instance: EChartsType) {
    const densityScale = Math.min(1, Math.pow(42 / Math.max(1, graph.nodes.length), .48))
    const viewportScale = Math.min(instance.getWidth(), instance.getHeight()) / 543
    const initialZoom = Math.max(.1, Math.min(1, densityScale * viewportScale))
    const series = (option.series as GraphSeriesOption[]).map(item => ({ ...item, zoom: initialZoom }))
    instance.setOption({ ...option, series }, { notMerge: true })
    setZoom(Math.round(initialZoom * 100))
  }

  useEffect(() => { if (chart.current) fitLayout(chart.current) }, [option])

  function changeZoom(factor: number) {
    const instance = chart.current
    if (!instance) return
    const series = instance.getOption().series as GraphSeriesOption[]
    const nextZoom = Math.max(.1, Math.min(4, (series[0]?.zoom || 1) * factor))
    // graphRoam's action only updates the model. setOption also redraws the view,
    // while preserving the force layout's existing node positions and centre.
    instance.setOption({ series: [{ id: 'knowledge', zoom: nextZoom }] })
    setZoom(Math.round(nextZoom * 100))
  }
  function reset() { if (chart.current) fitLayout(chart.current) }

  return <div className="kg-force-stage">
    <div className="kg-chart" ref={host} role="img" aria-label={`知识图谱：${graph.nodes.length} 个节点、${graph.edges.length} 条关系。拖动节点调整位置；左侧目录可用键盘选择节点。`} />
    {!graph.nodes.length && <div className="kg-chart-empty">当前筛选下没有节点</div>}
    <div className="kg-canvas-count">{graph.nodes.length} 节点 · {graph.edges.length} 关系</div>
    <div className="kg-zoom" aria-label="图谱缩放">
      <button onClick={() => changeZoom(1.2)} aria-label="放大图谱" title="放大"><Plus size={16} /></button>
      <span>{zoom}%</span>
      <button onClick={() => changeZoom(1 / 1.2)} aria-label="缩小图谱" title="缩小"><Minus size={16} /></button>
      <i /><button onClick={reset} aria-label="复位图谱" title="复位布局"><Focus size={16} /></button>
    </div>
  </div>
}
