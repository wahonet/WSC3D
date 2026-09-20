import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ArrowUpRight, BookOpen, Check, ChevronDown, FileText, Layers3, LoaderCircle, MapPin, RotateCcw, Sparkles } from 'lucide-react'
import { marked } from 'marked'
import { useApp } from '../store/useApp'
import type { DocumentTarget } from '../lib/navigation'
import { askWhenReady, readResponse as read } from '../lib/askArchive'
import './search.css'

interface Hit {
  id: string | number; scope: string; name?: string; title?: string; text?: string; snippet?: string;
  thumbnail?: string; location?: string; catalogue_no?: string; page_no?: number; document_id?: number;
  segment_id?: number; book_id?: string; kind?: string; review_status?: string; pdf?: string;
  nodes?: { id: number; label: string; asset_id: number; review_status: string }[];
  match_reason?: string;
}
interface Group { scope: string; label: string; count: number; offset?: number; items: Hit[]; error?: string; excluded?: boolean }
interface Results { query: string; groups: Group[]; dense?: boolean }
interface Citation { number: number; id?: string; scope: string; title: string; text: string; page_no?: number; document_id?: number; segment_id?: number; book_id?: string }
interface Answer { answer: string | null; model?: string; provider?: string; route: string; notice?: string; citations: Citation[]; retrieval?: { dense: boolean } }
interface Props { active: boolean; query: string; submissionId?: number; onQuery(q: string): void; onStone(id: string): void; onDocument(target: DocumentTarget): void; onExtension(id: string, page: number): void }

/** Model output and OCR are untrusted: retain Markdown structure, discard active HTML. */
function AnswerText({ text, onCitation }: { text: string; onCitation(number: number): void }) {
  const html = useMemo(() => {
    const source = text.replace(/\[(?:E)?(\d+)\](?!\()/g, '[ $1 ](#evidence-$1)')
    const doc = new DOMParser().parseFromString(marked.parse(source, { async: false }) as string, 'text/html')
    const allowed = new Set(['P', 'BR', 'STRONG', 'EM', 'DEL', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'CODE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR', 'A'])
    for (const el of Array.from(doc.body.querySelectorAll('*'))) {
      if (!allowed.has(el.tagName)) { el.replaceWith(doc.createTextNode(el.textContent || '')); continue }
      const href = el.getAttribute('href') || ''
      for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name)
      if (el.tagName === 'A' && /^(https?:\/\/|#evidence-\d+$)/i.test(href)) {
        el.setAttribute('href', href)
        if (!href.startsWith('#')) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer') }
      }
    }
    return doc.body.innerHTML
  }, [text])
  return <div className="answer-text" onClick={e => {
    const link = (e.target as HTMLElement).closest('a')
    const number = link?.getAttribute('href')?.match(/^#evidence-(\d+)$/)?.[1]
    if (number) { e.preventDefault(); onCitation(Number(number)) }
  }} dangerouslySetInnerHTML={{ __html: html }} />
}

export default function SearchPage({ active, query, submissionId, onQuery, onStone, onDocument, onExtension }: Props) {
  const [input, setInput] = useState(query)
  const [result, setResult] = useState<Results | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [answerError, setAnswerError] = useState('')
  const [extension, setExtension] = useState(false)
  const [asking, setAsking] = useState(false)
  const [answerProgress, setAnswerProgress] = useState('')
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [more, setMore] = useState('')
  const [documentScope, setDocumentScope] = useState('core')
  const [retry, setRetry] = useState(0)
  const [allCitations, setAllCitations] = useState(false)
  const generation = useRef(0)
  const inFlight = useRef<{ key: string; abort: AbortController; timer: number; pending: boolean } | null>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  useEffect(() => () => {
    generation.current++
    inFlight.current?.abort.abort()
    clearTimeout(inFlight.current?.timer)
    inFlight.current = null
  }, [])
  useEffect(() => {
    const requestKey = JSON.stringify([query.trim(), extension])
    // Global Enter may increment submissionId repeatedly. Keep the current
    // request alive for the same question; allow another after it completes.
    if (inFlight.current?.key === requestKey && inFlight.current.pending) return
    inFlight.current?.abort.abort()
    clearTimeout(inFlight.current?.timer)
    inFlight.current = null
    const token = ++generation.current
    const abort = new AbortController()
    setInput(query); setAnswer(null); setResult(null); setError(''); setAnswerError(''); setAnswerProgress(''); setMore(''); setAllCitations(false)
    pageRef.current?.scrollTo({ top: 0 })
    if (!query.trim()) { setBusy(false); setAsking(false); return }
    setBusy(true); setAsking(true)
    // Defer one tick so React's development StrictMode cannot double-submit a model request.
    const timer = window.setTimeout(() => {
      const search = () => fetch(`/api/archive/search?q=${encodeURIComponent(query)}&scope=all`, { signal: abort.signal }).then(r => read<Results>(r))
        .then(data => { if (token === generation.current) setResult(data) })
        .catch(e => { if (e.name !== 'AbortError' && token === generation.current) setError(e.message) })
        .finally(() => { if (token === generation.current) setBusy(false) })
      void search()
      void askWhenReady<Answer>(query, extension, abort.signal,
        message => { if (token === generation.current) setAnswerProgress(message) },
        () => { if (token === generation.current) { setBusy(true); void search() } },
      )
        .then(data => { if (token === generation.current) setAnswer(data) })
        .catch(e => { if (e.name !== 'AbortError' && token === generation.current) setAnswerError(e.message) })
        .finally(() => { if (token === generation.current) { setAsking(false); if (inFlight.current) inFlight.current.pending = false } })
    }, 0)
    inFlight.current = { key: requestKey, abort, timer, pending: true }
  }, [query, extension, submissionId, retry])

  function submit(value: string) {
    const next = value.trim()
    if (!next || (asking && next === query.trim())) return
    if (next === query && submissionId === undefined) setRetry(n => n + 1)
    else onQuery(next)
  }
  function open(hit: Hit | Citation) {
    if (hit.scope === 'stone' && hit.id != null) onStone(String(hit.id))
    else if ((hit.scope === 'core' || hit.scope === 'extension') && hit.document_id) onDocument({ collection: hit.scope, documentId: hit.document_id, pageNo: hit.page_no || 1, segmentId: hit.segment_id })
    else if (hit.scope === 'extension' && hit.book_id) onExtension(hit.book_id, hit.page_no || 1)
  }
  async function loadMore(group: Group) {
    if (more) return
    setMore(group.scope)
    const token = generation.current
    try {
      const data = await fetch(`/api/archive/search?q=${encodeURIComponent(query)}&scope=all&${group.scope}_offset=${group.items.length}`).then(r => read<Results>(r))
      const next = data.groups.find(g => g.scope === group.scope)
      if (next && token === generation.current) setResult(current => current && ({ ...current, groups: current.groups.map(g => g.scope === group.scope ? { ...g, items: [...g.items, ...next.items.filter(item => !g.items.some(existing => existing.id === item.id))] } : g) }))
    } catch (e) { if (token === generation.current) setError((e as Error).message) }
    finally { if (token === generation.current) setMore('') }
  }
  async function openNode(stoneId: string, node: { id: number; asset_id: number }) {
    const state = useApp.getState()
    const stone = state.stones.find(s => s.id === stoneId)
    const asset = stone?.groups.flatMap(g => g.assets).find(a => a.id === node.asset_id)
    try {
      if (stone && asset) { await state.openAsset(stone, asset); state.setPage('annotate'); state.select(node.id); state.flyToAnnotation(node.id); const q = new URLSearchParams(location.hash.slice(1)); q.set('section', 'research'); q.set('stone', stoneId); location.hash = q.toString() }
      else onStone(stoneId)
    } catch { setError('暂时无法定位标注，请打开文物档案重试。') }
  }
  const groups = result?.groups.filter(g => !g.excluded) || []
  const stones = groups.find(g => g.scope === 'stone')
  const documents = groups.find(g => g.scope === documentScope)
  const citations = answer?.citations || []
  const sourceLabel = (scope: string) => scope === 'extension' ? '扩展文献' : scope === 'core' ? '核心文献' : '文物档案'
  const moreButton = (group: Group) => group.items.length < group.count && <button className="load-more" disabled={!!more} onClick={() => void loadMore(group)}>{more === group.scope ? <LoaderCircle size={14} className="search-spin" /> : <ChevronDown size={14} />}{more === group.scope ? '正在载入' : `查看更多${group.scope === 'stone' ? '文物' : '文献'}`}</button>

  return <div ref={pageRef} className="search-page" style={{ display: active ? undefined : 'none' }}>
    <div className="search-content">
      <form className="search-query" onSubmit={e => { e.preventDefault(); submit(input) }}><Sparkles size={20} /><input aria-label="向 AI 提问" maxLength={1000} placeholder="问问武梁祠，或输入一个文物名称、编号…" value={input} onChange={e => setInput(e.target.value)} /><button type="submit" disabled={!input.trim() || (asking && input.trim() === query.trim())}><span>{asking && input.trim() === query.trim() ? '回答中' : '问 AI'}</span><ArrowUp size={17} /></button></form>
      <div className="search-options"><span><BookOpen size={14} />依据文物身份卡与核心文献回答</span><label><input type="checkbox" checked={extension} onChange={e => setExtension(e.target.checked)} />同时参考扩展文献</label></div>
      {!query && <section className="search-empty"><span className="empty-symbol"><Layers3 size={30} strokeWidth={1.1} /></span><h2>关于武氏祠，你想了解什么？</h2><p>直接提问，查看回答，也可以沿着引用回到原石和文献原页。</p><div className="question-suggestions">{['武梁祠', '西王母在武梁祠画像中有哪些特征？', '武011是什么文物？', '全馆有多少件文物？'].map(q => <button key={q} onClick={() => submit(q)}>{q}<ArrowUpRight size={15} /></button>)}</div></section>}
      {query && <>
        {error && <div role="alert" className="search-error">{error}<button onClick={() => setRetry(n => n + 1)}>重试</button></div>}
        <div className="search-layout">
          <div className="search-main">
            <section className="answer-panel" data-scope="answer" aria-label="AI 回答" aria-busy={asking}>
              <header className="answer-heading"><span className="answer-icon"><Sparkles size={18} /></span><div><h2>{['catalogue', 'stone_inventory'].includes(answer?.route || '') ? '资料回答' : 'AI 资料解答'}</h2>{asking && <p>正在查找资料…</p>}</div>{!asking && <button className="answer-retry" onClick={() => setRetry(n => n + 1)} title="重新回答" aria-label="重新回答"><RotateCcw size={15} /></button>}</header>
              <div className="answer-question">{query}</div>
              {asking && <div className="answer-loading" role="status"><div><LoaderCircle size={16} className="search-spin" /><span>{answerProgress || '正在查找与问题相关的资料…'}</span></div><div className="answer-skeleton"><i /><i /><i /></div><p>相关文物与文献将同步显示，你可以先行查阅。</p></div>}
              {answerError && <div className="search-error" role="alert">{answerError}<button onClick={() => setRetry(n => n + 1)}>重新回答</button></div>}
              {answer && <>
                {answer.notice && <p className="answer-notice" role="status">{answer.notice}</p>}
                {answer.answer ? <AnswerText text={answer.answer} onCitation={number => { const citation = citations.find(c => c.number === number); if (citation) open(citation) }} /> : <p className="answer-unavailable">暂时未能生成回答。你仍可查阅下方证据，或重新提问。</p>}
                {!!citations.length && <div className="answer-sources"><div className="answer-sources-heading"><span><Check size={13} />参考资料 · {citations.length}</span><small>点击回到原页</small></div><div className="citation-list">{(allCitations ? citations : citations.slice(0, 4)).map(c => <button key={c.number} className="citation-link" onClick={() => open(c)}><span className="citation-number">{c.number}</span><span><b>{c.title}</b><small>{sourceLabel(c.scope)}{c.page_no ? ` · PDF 第 ${c.page_no} 页` : ''}</small></span><ArrowUpRight size={14} /></button>)}</div>{citations.length > 4 && <button className="citation-toggle" onClick={() => setAllCitations(value => !value)}>{allCitations ? '收起引用' : `展开全部 ${citations.length} 条参考资料`}<ChevronDown size={13} /></button>}</div>}
                <footer className="answer-footer">{answer.provider || '研究助手'}{answer.model ? ` · ${answer.model}` : ''}</footer>
              </>}
            </section>
            <section className="search-group search-documents" aria-label="相关文献">
              <header className="document-heading"><h2><BookOpen size={16} />相关文献</h2><span>{result?.dense ? '已结合语义匹配' : busy ? '资料检索中' : '关键词匹配'}</span></header>
              <div className="document-tabs" role="tablist" aria-label="文献范围">{['core', 'extension'].map(key => <button key={key} role="tab" aria-selected={documentScope === key} onClick={() => setDocumentScope(key)}>{sourceLabel(key)}<span>{groups.find(g => g.scope === key)?.count ?? '—'}</span></button>)}</div>
              <div className="document-results" data-scope={documentScope}>
                {busy && <p className="group-empty" role="status">正在查找相关文献…</p>}
                {documents?.error && <p role="alert" className="search-error">{documents.error}</p>}
                {!busy && !documents?.items.length && <p className="group-empty">当前范围暂未找到相关文献，试试补充文物名称或画像主题。</p>}
                {documents?.items.map(hit => <article key={hit.id} className="search-hit document-hit"><span className="document-symbol"><FileText size={19} strokeWidth={1.4} /></span><div className="hit-body"><button className="hit-title" onClick={() => open(hit)}>{hit.title}<ArrowUpRight size={14} /></button><p className="hit-meta">{hit.page_no ? `PDF 第 ${hit.page_no} 页` : '书目信息'}{hit.review_status === 'machine' && ' · 机器识别，引用前核对原页'}{hit.review_status === 'reviewed' && ' · 已校订'}</p>{hit.snippet && <p className="hit-snippet">{hit.snippet}</p>}{hit.kind === 'bibliography' && <span className="bibliography-label">书目记录 · 正文观点请查阅原文</span>}</div></article>)}
              </div>{documents && moreButton(documents)}
            </section>
          </div>
          <aside className="search-stones search-group" data-scope="stone" aria-label="相关文物"><header><div><Layers3 size={16} /><h2>相关文物</h2></div><span>{stones ? `${stones.count} 件` : '检索中'}</span></header>
            {busy && <p className="group-empty" role="status">正在查找文物档案…</p>}
            {!busy && !stones?.items.length && <p className="group-empty">暂未匹配到文物档案。<br />可从相关文献继续了解。</p>}
            <div className="stone-results">{stones?.items.map(hit => <article key={hit.id} className="search-hit stone-hit"><button className="hit-image" aria-label={`打开${hit.name}档案`} onClick={() => open(hit)}>{hit.thumbnail ? <img src={hit.thumbnail} alt={hit.name || ''} loading="lazy" onError={e => { e.currentTarget.style.display = 'none' }} /> : <Layers3 size={26} strokeWidth={1} />}</button><div className="hit-body"><span className="stone-number">{hit.catalogue_no || hit.id}</span><button className="hit-title" onClick={() => open(hit)}>{hit.name}<ArrowUpRight size={13} /></button><p className="hit-meta"><MapPin size={11} />{hit.location || '文物档案'}</p>{hit.nodes?.slice(0, 2).map(node => <button key={node.id} className="node-link" onClick={() => void openNode(String(hit.id), node)}>定位：{node.label}</button>)}</div></article>)}</div>{stones && moreButton(stones)}
          </aside>
        </div>
      </>}
    </div>
  </div>
}
