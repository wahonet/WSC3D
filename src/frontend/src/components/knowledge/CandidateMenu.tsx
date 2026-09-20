import { useEffect, useMemo, useState } from 'react'
import { BookOpen, ChevronDown, ChevronRight, Link2, Search } from 'lucide-react'
import { attachCandidate, candidateKey, getStoneCandidates, type KnowledgeCandidate, type StoneCandidates } from '../../lib/knowledgeCandidates'
import { goToSection, openDocument } from '../../lib/navigation'
import { hasGeometry } from '../../lib/tree'
import { useApp } from '../../store/useApp'
import { toast } from '../../store/useToast'
import { Button } from '../ui'
import './workbench.css'

export default function CandidateMenu({ requestedStoryId, onData, onTopic }: {
  requestedStoryId?: string | null; onData?(value: StoneCandidates): void; onTopic?(label: string): void
}) {
  const stoneId = useApp(s => s.curStone?.id)
  const annos = useApp(s => s.stoneAnnos)
  const selectedId = useApp(s => s.selectedId)
  const [data, setData] = useState<StoneCandidates | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!stoneId) return
    const abort = new AbortController()
    setData(null); setError(''); setSelected(null)
    getStoneCandidates(stoneId, abort.signal).then(value => {
      if (!abort.signal.aborted) { setData(value); onData?.(value) }
    }).catch(reason => { if (!abort.signal.aborted) setError(String(reason)) })
    return () => abort.abort()
  }, [stoneId, revision])
  const nodes = useMemo(() => data ? [...data.stories, ...data.entities] : [], [data])
  const current = nodes.find(node => candidateKey(node) === selected)
  const region = annos.find(a => a.id === selectedId && hasGeometry(a))
  const sources = data?.evidence.filter(item => current?.evidence_ids.includes(item.id)) ?? []
  const recommended = (node: KnowledgeCandidate) => {
    const options = data?.evidence.filter(item => node.evidence_ids.includes(item.id) && item.source_available) ?? []
    options.sort((a, b) => Number(b.method === 'chapter' || b.method === 'name') - Number(a.method === 'chapter' || a.method === 'name') ||
      Number(b.excerpt.length > 60) - Number(a.excerpt.length > 60))
    const books = new Set<number | null>()
    return options.filter(item => { if (books.has(item.document_id)) return false; books.add(item.document_id); return true }).map(item => item.id)
  }
  const choose = (node: KnowledgeCandidate) => {
    setSelected(candidateKey(node))
    const existing = region && node.annotation_ids.includes(region.id)
      ? data?.evidence.filter(item => node.evidence_ids.includes(item.id) && region.references.some(ref => ref.segment_id === item.segment_id)).map(item => item.id)
      : null
    setChecked(new Set(existing ?? recommended(node)))
    onTopic?.(node.label)
  }
  useEffect(() => {
    const story = data?.stories.find(item => item.id === requestedStoryId)
    if (story) { choose(story); setCollapsed(new Set(data?.stories.filter(item => item.id !== story.id).map(item => item.id))) }
  }, [requestedStoryId, data?.stone_id])
  const attach = async (node: KnowledgeCandidate, annotationId: number, evidenceIds?: string[]) => {
    if (!stoneId || busy) return
    setBusy(true)
    try {
      const ids = evidenceIds ?? recommended(node)
      await attachCandidate(stoneId, annotationId, node, ids)
      await useApp.getState().refreshAnnos()
      useApp.getState().select(annotationId)
      setRevision(value => value + 1)
      toast.ok(`已挂接「${node.label}」`)
    } catch (reason) { toast.error(reason) } finally { setBusy(false) }
  }
  const row = (node: KnowledgeCandidate, child = false) => <button type="button" key={candidateKey(node)}
    className={`wb-topic${child ? ' child' : ''}${candidateKey(node) === selected ? ' on' : ''}`}
    onClick={() => choose(node)} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'link' }}
    onDrop={event => { event.preventDefault(); const id = Number(event.dataTransfer.getData('application/x-wsc-annotation')); if (annos.some(a => a.id === id && hasGeometry(a))) void attach(node, id) }}>
      <span>{node.label}</span><small>{node.source_count}</small>
      {node.annotation_ids.some(id => annos.some(a => a.id === id && hasGeometry(a))) && <Link2 size={11} />}
  </button>
  const matches = (node: KnowledgeCandidate) => !query || [node.label, ...(node.aliases || [])].some(name => name.includes(query))
  return <div className="wb-candidates">
    <div className="wb-candidate-search"><Search size={13} /><input className="input sm" placeholder="故事、人物、器物" aria-label="筛选文献题材" value={query} onChange={e => setQuery(e.target.value)} />
      <button title="查看全部原文" aria-label="查看全部原文" onClick={() => goToSection('research', { p: 'library' })}><BookOpen size={15} /></button>
    </div>
    <div className="wb-topic-list">
      {error && <p className="wb-error">{error}<Button size="xs" onClick={() => setRevision(v => v + 1)}>重试</Button></p>}
      {!data && !error && <p className="reading-empty">正在读取…</p>}
      {data?.stories.map(story => {
        const children = data.entities.filter(item => item.story_id === story.id && (matches(item) || matches(story)))
        if (!matches(story) && !children.length) return null
        const closed = collapsed.has(story.id) && !query
        return <div className="wb-story" key={story.id}>
          <div className="wb-story-row"><button className="wb-disclosure" aria-label={`${closed ? '展开' : '收起'}${story.label}`} onClick={() => setCollapsed(old => { const next = new Set(old); next.has(story.id) ? next.delete(story.id) : next.add(story.id); return next })}>{closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>{row(story)}</div>
          {!closed && children.map(item => row(item, true))}
        </div>
      })}
      {data?.entities.filter(item => !item.story_id && matches(item)).map(item => row(item))}
      {data && !nodes.length && <p className="reading-empty">暂无题材条目</p>}
    </div>
    {current && <div className="wb-attach">
      <div className="wb-attach-title"><b>{current.label}</b><Button size="xs" variant="primary" icon={<Link2 size={12} />} disabled={!region || busy || !current.source_available} onClick={() => region && void attach(current, region.id, [...checked])}>{busy ? '保存中…' : '挂接所选区域'}</Button></div>
      <details className="wb-citations"><summary>引用文献 · {checked.size}</summary>
        {sources.map(source => <label key={source.id}><input type="checkbox" checked={checked.has(source.id)} disabled={!source.source_available} onChange={e => setChecked(old => { const next = new Set(old); e.target.checked ? next.add(source.id) : next.delete(source.id); return next })} /><span title={source.excerpt}>{source.document_title} · 第 {source.page_no} 页</span><button title="查看原页" onClick={event => { event.preventDefault(); if (source.document_id) openDocument({ collection: 'core', documentId: source.document_id, pageNo: source.page_no || 1, segmentId: source.segment_id }) }}><BookOpen size={12} /></button></label>)}
      </details>
    </div>}
  </div>
}
