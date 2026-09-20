import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, BookOpen, Check, Link2, Search } from 'lucide-react'
import { addAnnotationReference, searchLibrary } from '../../api'
import { openDocument } from '../../lib/navigation'
import type { CandidateEvidence, StoneCandidates } from '../../lib/knowledgeCandidates'
import { useApp } from '../../store/useApp'
import { toast } from '../../store/useToast'
import { Button } from '../ui'
import './workbench.css'
import ExcerptText from '../library/ExcerptText'
import { stageReferenceExcerpt } from '../../lib/annotationDraft'
import type { ReferenceExcerpt } from '../../types'

export default function StoneReading({ data, focus }: { data: StoneCandidates | null; focus?: string | null }) {
  const [book, setBook] = useState('')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(30)
  const [busy, setBusy] = useState<number | null>(null)
  const [scope, setScope] = useState('stone')
  const [searchResults, setSearchResults] = useState<CandidateEvidence[]>([])
  const [searchTotal, setSearchTotal] = useState(0)
  const [searching, setSearching] = useState(false)
  const [offset, setOffset] = useState(0)
  const selectedId = useApp(s => s.selectedId)
  const annotation = useApp(s => s.stoneAnnos.find(a => a.id === s.selectedId))
  useEffect(() => { setBook(''); setQuery(''); setLimit(30); setScope('stone') }, [data?.stone_id])
  useEffect(() => { if (focus) { setQuery(focus); setScope('topic'); setLimit(30) } }, [focus])
  useEffect(() => {
    if (scope !== 'all' || !query.trim()) { setSearchResults([]); setSearchTotal(0); setSearching(false); return }
    let active = true
    if (offset === 0) { setSearchResults([]); setSearchTotal(0) }
    setSearching(true)
    const timer = setTimeout(() => {
      searchLibrary(query.trim(), { collection: 'core', documentId: book ? Number(book) : undefined, limit: 30, offset })
        .then(result => {
          if (!active) return
          setSearchTotal(result.total)
          const batch: CandidateEvidence[] = result.hits.map(hit => ({ ...hit, id: 'search:' + hit.segment_id, excerpt: hit.text, review_status: 'machine', source_available: true, source_status: 'available' }))
          setSearchResults(previous => offset === 0 ? batch : [...previous, ...batch])
        }).catch(reason => { if (active) toast.error(reason) }).finally(() => { if (active) setSearching(false) })
    }, 300)
    return () => { active = false; clearTimeout(timer) }
  }, [scope, query, book, offset])
  const all = data?.passages ?? []
  const passages = useMemo(() => scope === 'all' ? searchResults : all.filter(p => (scope === 'topic' || p.method !== 'topic') &&
    (!book || String(p.document_id) === book) && (!query.trim() || p.excerpt.includes(query.trim()))), [all, book, query, scope, searchResults])
  const linked = new Set(annotation?.references.map(ref => ref.segment_id))
  const add = async (entry: CandidateEvidence) => {
    if (!selectedId || !entry.segment_id || busy) return
    setBusy(entry.segment_id)
    try {
      await addAnnotationReference(selectedId, { kind: 'segment', segment_id: entry.segment_id })
      await useApp.getState().refreshAnnos()
      toast.ok('已添加文献')
    } catch (reason) { toast.error(reason) } finally { setBusy(null) }
  }
  const pick = async (entry: CandidateEvidence, excerpt: ReferenceExcerpt) => {
    if (!annotation || !entry.segment_id || busy) return
    setBusy(entry.segment_id)
    try {
      const updated = await addAnnotationReference(annotation.id, { kind: 'segment', segment_id: entry.segment_id })
      const ref = updated.references.find(item => item.segment_id === entry.segment_id && !item.source_missing)
      if (!ref || Array.from(ref.text).slice(excerpt.start, excerpt.end).join('') !== excerpt.text) throw new Error('原文已变化，请重新选择')
      stageReferenceExcerpt(updated, { ...excerpt, reference_id: ref.id })
      await useApp.getState().refreshAnnos()
      toast.ok(excerpt.field === 'pre_iconographic' ? '已填入直观描述' : '已填入故事描述')
    } catch (reason) { toast.error(reason) } finally { setBusy(null) }
  }
  return <section className="stone-reading" aria-label="本石文献原文">
    <header className="reading-heading"><BookOpen size={16} /><strong>{data?.stone_name || '本石文献'}</strong><span>{scope === 'all' ? searchTotal : passages.length} 段</span></header>
    <div className="reading-tools">
      <select className="select sm" aria-label="文献关联范围" value={scope} onChange={e => { setScope(e.target.value); setLimit(30); setOffset(0) }}><option value="stone">本石原文</option><option value="topic">包含同题文献</option><option value="all">全库查找</option></select>
      <select className="select sm" aria-label="原文书目" value={book} onChange={e => { setBook(e.target.value); setLimit(30); setOffset(0) }}>
        <option value="">全部核心文献</option>{data?.books?.map(item => <option key={item.id} value={item.id}>{item.title}{scope !== 'all' ? `（${all.filter(p => p.document_id === item.id && (scope === 'topic' || p.method !== 'topic')).length}）` : ''}</option>)}
      </select>
      <label><Search size={13} /><input className="input sm" aria-label="筛选本石原文" placeholder="搜索原文" value={query} onChange={e => { setQuery(e.target.value); setLimit(30); setOffset(0) }} /></label>
    </div>
    <div className="reading-list">
      {searching && <p className="reading-empty">正在查找…</p>}
      {!data ? <p className="reading-empty">正在读取文献…</p> : !passages.length ? <p className="reading-empty">暂无匹配原文</p> : null}
      {passages.slice(0, limit).map(entry => <article className="reading-passage" key={entry.id}>
        <header><b>{entry.document_title}</b><button onClick={() => entry.document_id && openDocument({ collection: 'core', documentId: entry.document_id, pageNo: entry.page_no || 1, segmentId: entry.segment_id })}>第 {entry.page_no} 页<ArrowUpRight size={12} /></button></header>
        {entry.heading && <small>{entry.heading}</small>}
        <ExcerptText text={entry.excerpt} onPick={annotation ? excerpt => void pick(entry, excerpt) : undefined} disabled={!!busy} />
        <footer><Button size="xs" icon={linked.has(entry.segment_id) ? <Check size={12} /> : <Link2 size={12} />} disabled={!annotation || !!busy || linked.has(entry.segment_id)} onClick={() => void add(entry)}>
          {linked.has(entry.segment_id) ? '已引用' : '添加到所选标注'}
        </Button></footer>
      </article>)}
      {(scope === 'all' ? searchTotal > searchResults.length : passages.length > limit) && <Button size="sm" disabled={searching} onClick={() => { if (scope === 'all') setOffset(searchResults.length); setLimit(value => value + 30) }}>继续显示</Button>}
    </div>
  </section>
}
