import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, ChevronDown, LoaderCircle, Network, PanelLeftClose, PanelRightClose, Search, X } from 'lucide-react'
import KnowledgeForceGraph, { GRAPH_COLORS, GRAPH_LABELS, graphRelation } from '../components/knowledge/KnowledgeForceGraph'
import { fetchKnowledgeGraph, type KnowledgeGraph, type KnowledgeKind, type KnowledgeNode } from '../lib/knowledgeGraph'
import { graphDegrees, inducedGraph, neighbourhood, type GraphData } from '../lib/graphExploration'
import { goToSection, openDocument } from '../lib/navigation'
import './knowledgeGraph.css'

const KINDS: KnowledgeKind[] = ['story', 'person', 'object', 'stone']
type View = 'overview' | 'entity'
interface Snapshot { id: string; view: View; stone: string }
const EMPTY: GraphData = { nodes: [], edges: [] }
const readHash = () => new URLSearchParams(location.hash.slice(1))

export default function KnowledgeGraphPage() {
  const initial = useRef(readHash())
  const [data, setData] = useState<KnowledgeGraph | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [selectedId, setSelectedId] = useState(initial.current.get('kg_node') || '')
  const [view, setView] = useState<View>(initial.current.get('kg_node') ? 'entity' : 'overview')
  const [stoneId, setStoneId] = useState(initial.current.get('kg_stone') || '')
  const [depth, setDepth] = useState<1 | 2>(1)
  const [history, setHistory] = useState<Snapshot[]>([])
  const [hidden, setHidden] = useState<Set<KnowledgeKind>>(new Set())
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const [catalogKind, setCatalogKind] = useState<KnowledgeKind>('story')
  const [listLimit, setListLimit] = useState(80)
  const [leftOpen, setLeftOpen] = useState(() => innerWidth > 760)
  const [rightOpen, setRightOpen] = useState(() => !!initial.current.get('kg_node') && innerWidth > 1100)
  const [documentsOpen, setDocumentsOpen] = useState(false)
  const modalRef = useRef<HTMLElement>(null)
  const [detailTab, setDetailTab] = useState<'relations' | 'sources'>('relations')

  useEffect(() => {
    const abort = new AbortController()
    setLoading(true); setError('')
    void fetchKnowledgeGraph(abort.signal).then(result => {
      if (abort.signal.aborted) return
      setData(result)
      setSelectedId(current => result.nodes.some(node => node.id === current) ? current : '')
      if (initial.current.get('kg_node') && !result.nodes.some(node => node.id === initial.current.get('kg_node'))) setView('overview')
    }).catch(reason => { if (!abort.signal.aborted) setError(reason.message) })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [reload])

  useEffect(() => {
    const onHash = () => {
      const hash = readHash()
      if (hash.get('section') !== 'graph') return
      const id = hash.get('kg_node') || ''
      setSelectedId(id); setView(id ? 'entity' : 'overview'); setStoneId(hash.get('kg_stone') || '')
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => { setListLimit(80) }, [catalogKind, stoneId])
  useEffect(() => { document.querySelector('.kg-workbench-scroll')?.scrollTo(0, 0) }, [selectedId, detailTab])
  useEffect(() => {
    if (!documentsOpen) return
    const previous = document.activeElement as HTMLElement | null
    const modal = modalRef.current
    const buttons = () => Array.from(modal?.querySelectorAll<HTMLElement>('button:not(:disabled),[href],[tabindex="0"]') || [])
    buttons()[0]?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDocumentsOpen(false); return }
      if (event.key !== 'Tab') return
      const items = buttons(), first = items[0], last = items[items.length - 1]
      if (!first) return
      if (event.shiftKey && (document.activeElement === first || !modal?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !modal?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', trap, true)
    return () => { window.removeEventListener('keydown', trap, true); previous?.focus() }
  }, [documentsOpen])

  const nodeMap = useMemo(() => new Map(data?.nodes.map(node => [node.id, node]) || []), [data])
  const degrees = useMemo(() => graphDegrees(data || EMPTY), [data])
  const selected = nodeMap.get(selectedId)
  const stones = useMemo(() => data?.nodes.filter(node => node.kind === 'stone').sort((a, b) => (a.stone_id || '').localeCompare(b.stone_id || '')) || [], [data])
  const scope = useMemo<GraphData>(() => {
    if (!data) return EMPTY
    if (!stoneId) return data
    const stone = stones.find(node => node.stone_id === stoneId)
    return stone ? neighbourhood(data, stone.id, 2) : EMPTY
  }, [data, stoneId, stones])
  const visibleScope = useMemo(() => inducedGraph(scope, new Set(scope.nodes.filter(node => !hidden.has(node.kind)).map(node => node.id))), [scope, hidden])
  const activeGraph = useMemo<GraphData>(() => {
    return view === 'entity' && selectedId ? neighbourhood(visibleScope, selectedId, depth) : visibleScope
  }, [view, selectedId, visibleScope, depth])
  const catalog = useMemo(() => scope.nodes.filter(node => node.kind === catalogKind).sort((a, b) => a.label.localeCompare(b.label, 'zh')), [scope, catalogKind])
  const hubs = useMemo(() => [...scope.nodes].filter(node => node.kind === 'person' || node.kind === 'story').sort((a, b) => (degrees.get(b.id) || 0) - (degrees.get(a.id) || 0)).slice(0, 8), [scope, degrees])
  const searchResults = useMemo(() => {
    const text = query.trim().toLocaleLowerCase()
    return text ? scope.nodes.filter(node => [node.label, ...node.aliases, node.stone_id || ''].some(name => name.toLocaleLowerCase().includes(text))).slice(0, 50) : []
  }, [scope, query])
  const relations = useMemo(() => data?.edges.filter(edge => edge.source === selectedId || edge.target === selectedId) || [], [data, selectedId])
  const evidence = useMemo(() => {
    const ids = new Set([...(selected?.evidence_ids || []), ...relations.flatMap(edge => edge.evidence_ids)])
    return data?.evidence.filter(source => ids.has(source.id)) || []
  }, [data, selected, relations])
  const stories = selected?.kind === 'story' ? [selected] : relations.map(edge => nodeMap.get(edge.source === selectedId ? edge.target : edge.source)).filter((node): node is KnowledgeNode => node?.kind === 'story')
  const relatedStones = stones.filter(stone => stone.id === selectedId || data?.edges.some(edge => (edge.source === stone.id && stories.some(story => story.id === edge.target)) || (edge.target === stone.id && stories.some(story => story.id === edge.source))))

  function persist(id: string, stone: string) {
    const hash = readHash()
    if (id) hash.set('kg_node', id); else hash.delete('kg_node')
    if (stone) hash.set('kg_stone', stone); else hash.delete('kg_stone')
    window.history.replaceState(null, '', '#' + hash.toString())
  }
  function remember() { setHistory(previous => [...previous, { id: selectedId, view, stone: stoneId }]) }
  function focus(id: string) {
    if (!nodeMap.has(id)) return
    if (id !== selectedId || view !== 'entity') remember()
    if (!scope.nodes.some(node => node.id === id)) setStoneId('')
    setSelectedId(id); setView('entity'); setDetailTab('relations'); setRightOpen(true)
    setHidden(previous => { const next = new Set(previous); next.delete(nodeMap.get(id)!.kind); return next })
    persist(id, scope.nodes.some(node => node.id === id) ? stoneId : '')
    if (innerWidth <= 760) { setLeftOpen(false); setRightOpen(false) }
  }
  function pick(id: string) {
    setQuery(''); setSearchOpen(false)
    focus(id)
  }
  function back() {
    const last = history.at(-1)
    if (!last) return
    setHistory(previous => previous.slice(0, -1)); setSelectedId(last.id); setView(last.view); setStoneId(last.stone)
    persist(last.id, last.stone)
  }
  function overview() {
    if (view !== 'overview' || selectedId) remember()
    setView('overview'); setSelectedId(''); setRightOpen(false); persist('', stoneId)
  }
  function changeStone(id: string) {
    remember(); setStoneId(id); setSelectedId(''); setView('overview'); persist('', id)
  }
  function openStone(stone: KnowledgeNode) {
    if (stone.stone_id) goToSection('archive', { stone: stone.stone_id })
  }
  const nodeButton = (node: KnowledgeNode) => <button key={node.id} className={`kg-node-row${node.id === selectedId ? ' selected' : ''}`} onClick={() => pick(node.id)} title={`${node.label} · ${GRAPH_LABELS[node.kind]} · ${degrees.get(node.id) || 0} 条关联`}><i style={{ background: GRAPH_COLORS[node.kind] }} /><span>{node.label}</span><small>{degrees.get(node.id) || 0}</small></button>

  return <div className="kg-page" aria-label="知识图谱工作区">
    <div className="kg-toolbar" role="toolbar" aria-label="图谱工具">
      <button className="kg-icon-button" aria-label={leftOpen ? '收起候选目录' : '展开候选目录'} title="候选目录" aria-pressed={leftOpen} onClick={() => { setLeftOpen(value => !value); if (innerWidth <= 760) setRightOpen(false) }}><PanelLeftClose size={17} /></button>
      <button className="kg-icon-button" aria-label="返回上一个图谱节点" title="返回（空白处右键）" disabled={!history.length} onClick={back}><ArrowLeft size={16} /></button>
      <div className="kg-search-wrap" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false) }} onKeyDown={event => { if (event.key === 'Escape') { searchRef.current?.focus(); setQuery(''); setSearchOpen(false) } }}>
        <label className="kg-search"><Search size={15} /><input ref={searchRef} aria-label="搜索故事、人物或物品" placeholder="搜索故事、人物、物品…" value={query} onChange={event => { setQuery(event.target.value); setSearchOpen(true) }} onFocus={() => setSearchOpen(true)} onKeyDown={event => { if (event.key === 'Enter' && searchResults[0]) { event.preventDefault(); pick(searchResults[0].id) } if (event.key === 'ArrowDown') { event.preventDefault(); event.currentTarget.closest('.kg-search-wrap')?.querySelector<HTMLButtonElement>('.kg-search-results button')?.focus() } }} />{query && <button aria-label="清空图谱搜索" onClick={() => { setQuery(''); setSearchOpen(false); searchRef.current?.focus() }}><X size={13} /></button>}</label>
        {searchOpen && query.trim() && <div className="kg-search-results" aria-label="实体搜索结果" onKeyDown={event => { if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return; event.preventDefault(); const items = Array.from(event.currentTarget.querySelectorAll('button')); const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus() }}>{searchResults.map(node => <button key={node.id} onClick={() => pick(node.id)}><i style={{ background: GRAPH_COLORS[node.kind] }} /><span>{node.label}</span><small>{GRAPH_LABELS[node.kind]}</small></button>)}{!searchResults.length && <p>没有匹配的实体</p>}</div>}
      </div>
      <select className="kg-stone-select" aria-label="按画像石筛选候选" value={stoneId} onChange={event => changeStone(event.target.value)}><option value="">全部画像石</option>{stones.map(stone => <option key={stone.id} value={stone.stone_id}>{stone.stone_id} {stone.label}</option>)}</select>
      <div className="kg-depth" role="group" aria-label="展开层级">{([1, 2] as const).map(value => <button key={value} className={depth === value ? 'on' : ''} aria-pressed={depth === value} onClick={() => setDepth(value)}>{value} 跳</button>)}</div>
      <button className={`kg-tool-button${view === 'overview' ? ' on' : ''}`} onClick={overview}><Network size={15} />全景</button>
      <span className="kg-toolbar-spacer" />
      <button className="kg-icon-button" aria-label="核心书籍来源" title="核心书籍来源" onClick={() => setDocumentsOpen(true)}><BookOpen size={17} /></button>
      <button className="kg-icon-button" aria-label={rightOpen ? '收起节点详情' : '展开节点详情'} title="节点详情" aria-pressed={rightOpen} onClick={() => { setRightOpen(value => !value); if (innerWidth <= 760) setLeftOpen(false) }}><PanelRightClose size={17} /></button>
    </div>

    <div className={`kg-workspace${leftOpen ? '' : ' left-collapsed'}${rightOpen ? '' : ' right-collapsed'}`}>
      {leftOpen && <aside className="kg-library" aria-label="候选目录">
        <section className="kg-block kg-layers"><h2>图层</h2><div className="kg-layer-chips">{KINDS.map(kind => <button key={kind} className={hidden.has(kind) ? 'off' : ''} aria-label={`${hidden.has(kind) ? '显示' : '隐藏'}${GRAPH_LABELS[kind]}图层`} aria-pressed={!hidden.has(kind)} onClick={() => setHidden(previous => { const next = new Set(previous); if (next.has(kind)) next.delete(kind); else next.add(kind); return next })}><i style={{ background: GRAPH_COLORS[kind] }} />{GRAPH_LABELS[kind]}</button>)}</div></section>
        <details className="kg-hubs"><summary>核心节点<ChevronDown size={13} /></summary><div>{hubs.map(nodeButton)}</div></details>
        <section className="kg-block kg-catalog"><h2>候选目录 <span>{catalog.length}</span></h2><div className="kg-kind-tabs" role="tablist" aria-label="候选类型">{KINDS.map(kind => <button key={kind} role="tab" aria-selected={catalogKind === kind} onClick={() => setCatalogKind(kind)}>{GRAPH_LABELS[kind]}</button>)}</div><div className="kg-catalog-list">{catalog.slice(0, listLimit).map(nodeButton)}{catalog.length > listLimit && <button className="kg-more" onClick={() => setListLimit(value => value + 80)}>显示更多<ChevronDown size={13} /></button>}{!catalog.length && <p className="kg-muted">暂无候选</p>}</div></section>
      </aside>}

      <section className="kg-stage" aria-label="知识图谱" onContextMenu={event => { event.preventDefault(); back() }}>
        {loading ? <div className="kg-state" role="status"><LoaderCircle size={24} className="kg-spin" /><span>载入图谱…</span></div> : error ? <div className="kg-state" role="alert"><p>{error}</p><button className="kg-tool-button" onClick={() => setReload(value => value + 1)}>重试</button></div> : <KnowledgeForceGraph graph={activeGraph} degrees={degrees} selectedId={view === 'entity' ? selectedId : ''} overview={view === 'overview'} onSelect={pick} />}
        {data?.meta.truncated && <div className="kg-truncated">当前显示部分节点</div>}
      </section>

      {rightOpen && <aside className="kg-workbench" aria-label="节点详情">
        {selected ? <>
          <header className="kg-workbench-heading"><i className="kg-entity-dot" style={{ background: GRAPH_COLORS[selected.kind] }} /><div><h2>{selected.label}</h2><span>{GRAPH_LABELS[selected.kind]} · 文献候选</span></div></header>
          <div className="kg-detail-tabs" role="tablist" aria-label="节点信息"><button role="tab" aria-selected={detailTab === 'relations'} onClick={() => setDetailTab('relations')}>关系 {relations.length}</button><button role="tab" aria-selected={detailTab === 'sources'} onClick={() => setDetailTab('sources')}>出处 {evidence.length}</button></div>
          <div className="kg-workbench-scroll">
            {detailTab === 'relations' ? <>
              {!!selected.aliases.length && <div className="kg-aliases">{selected.aliases.map(alias => <span key={alias}>{alias}</span>)}</div>}
              <div className="kg-relations">{relations.map(edge => { const other = nodeMap.get(edge.source === selectedId ? edge.target : edge.source); return other && <button key={edge.id} onClick={() => focus(other.id)}><small>{edge.source === selectedId ? '→' : '←'} {graphRelation(edge.relation)}</small><span><i style={{ background: GRAPH_COLORS[other.kind] }} />{other.label}<ArrowUpRight size={12} /></span></button> })}{!relations.length && <p className="kg-muted">尚无关联记录</p>}</div>
              {!!relatedStones.length && <section className="kg-block kg-related-stones"><h3>关联画像石</h3>{relatedStones.map(stone => <div key={stone.id}><button onClick={() => focus(stone.id)}><small>{stone.stone_id}</small>{stone.label}</button><button onClick={() => openStone(stone)} title={`打开${stone.stone_id}的文物档案`} aria-label={`文物档案：${stone.stone_id} ${stone.label}`}><ArrowRight size={15} /></button></div>)}</section>}
              {selected.kind === 'stone' && selected.stone_id && <button className="kg-open-archive" onClick={() => goToSection('archive', { stone: selected.stone_id })}>打开文物档案<ArrowUpRight size={14} /></button>}
              {selected.description && <details className="kg-node-note"><summary>整理说明</summary><p>{selected.description}</p></details>}
            </> : <div className="kg-evidence">{!evidence.length && <p className="kg-muted">暂无可回查出处</p>}{evidence.map(source => <article key={source.id}><button className="kg-source-link" disabled={!source.source_available} onClick={() => openDocument({ collection: 'core', documentId: source.document_id, pageNo: source.page_no, segmentId: source.segment_id })}><BookOpen size={13} /><span>{source.document_title}<small>PDF 第 {source.page_no} 页</small></span><ArrowUpRight size={13} /></button><blockquote>{source.excerpt}</blockquote><small>{source.source_available ? (source.review_status === 'reviewed' ? '已校订文字' : '识别文字 · 待核对') : source.source_notice || '出处待核验'}</small></article>)}</div>}
          </div>
        </> : <><header className="kg-workbench-heading"><Network size={17} /><strong>核心节点</strong></header><div className="kg-workbench-scroll kg-overview-nodes">{hubs.map(nodeButton)}</div></>}
      </aside>}
    </div>

    {documentsOpen && <div className="kg-modal-backdrop" onClick={() => setDocumentsOpen(false)}><section className="kg-sources-modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="kg-sources-title" onClick={event => event.stopPropagation()}><header><h2 id="kg-sources-title">核心书籍来源</h2><button aria-label="关闭来源说明" onClick={() => setDocumentsOpen(false)}><X size={19} /></button></header><p>文献候选，待核对原页与石面。</p><div className="kg-document-coverage">{data?.documents.map((document, index) => <button key={document.document_id} onClick={() => openDocument({ collection: 'core', documentId: document.document_id, pageNo: 1 })}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{document.title}</strong><small>{document.readable_pages} / {document.total_pages} 页有文字 · {document.evidence_count || 0} 条出处</small></div><ArrowUpRight size={14} /></button>)}</div></section></div>}
  </div>
}
