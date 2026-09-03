import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Search, X } from 'lucide-react'
import { searchLibrary } from '../../api'
import { toast } from '../../store/useToast'
import type { SearchHit, SearchOut } from '../../types'
import { Button, Chip, Spinner } from '../ui'
import { KIND_LABEL } from './PageWorkbench'
import { Snippet } from './highlight'

const PAGE = 50

/** 深链 #…&q=<检索词>：读取 / 回写（仅在书库页） */
const readHashQ = () => new URLSearchParams(location.hash.replace(/^#/, '')).get('q') ?? ''
const writeHashQ = (q: string) => {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''))
  if (q) h.set('q', q); else h.delete('q')
  history.replaceState(null, '', `#${h.toString()}`)
}

/**
 * 全库检索 OCR 文本：输入即搜（防抖），多词以空格分隔为「且」；
 * 结果按 书 -> 页 -> 段 的阅读顺序分组，点一条直达该页并选中该文段；
 * 各书命中数做成书签可筛选。三字以上走 FTS5 trigram 索引，两字以内退回子串匹配。
 */
export default function LibrarySearch({ activeSegment, onOpenHit, onActiveChange }: {
  activeSegment: number | null
  onOpenHit: (h: SearchHit, q: string) => void
  /** 搜索态开关（有输入即为搜索态）与当前已执行的查询词，供父级隐藏书架、页面高亮 */
  onActiveChange: (active: boolean, q: string) => void
}) {
  const [q, setQ] = useState(readHashQ)
  const [res, setRes] = useState<SearchOut | null>(null)
  const [scope, setScope] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const scopeRef = useRef<number | null>(null)
  const seq = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const run = useCallback(async (query: string, doc: number | null, offset = 0) => {
    const my = ++seq.current
    setBusy(true)
    try {
      const r = await searchLibrary(query, { documentId: doc, limit: PAGE, offset })
      if (my !== seq.current) return
      writeHashQ(query)
      setRes(prev => (offset > 0 && prev && prev.q === r.q ? { ...r, hits: [...prev.hits, ...r.hits] } : r))
    } catch (e) {
      if (my === seq.current) toast.error(e)
    } finally {
      if (my === seq.current) setBusy(false)
    }
  }, [])

  // 输入防抖：两字起自动搜，一字需回车；退到一字以内时清掉旧结果，避免结果与输入不对应
  useEffect(() => {
    const s = q.trim()
    if (s.length < 2) { seq.current++; setRes(null); setBusy(false); return }
    const t = window.setTimeout(() => run(s, scopeRef.current), 350)
    return () => window.clearTimeout(t)
  }, [q, run])

  const active = q.trim().length > 0
  const doneQ = res?.q ?? ''
  useEffect(() => { onActiveChange(active, active ? doneQ : '') }, [active, doneQ, onActiveChange])

  const clear = () => { seq.current++; setQ(''); setRes(null); setBusy(false); writeHashQ(''); inputRef.current?.focus() }
  const pickScope = (d: number | null) => {
    scopeRef.current = d
    setScope(d)
    const s = q.trim()
    if (s) run(s, d)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); clear() }
    if (e.key === 'Enter') { const s = q.trim(); if (s) run(s, scopeRef.current) }
  }

  const groups = useMemo(() => {
    const out: { id: number; code: string; title: string; hits: SearchHit[] }[] = []
    for (const h of res?.hits ?? []) {
      const g = out[out.length - 1]
      if (g && g.id === h.document_id) g.hits.push(h)
      else out.push({ id: h.document_id, code: h.document_code, title: h.document_title, hits: [h] })
    }
    return out
  }, [res])
  const allCount = res?.facets.reduce((n, f) => n + f.count, 0) ?? 0
  const showFacets = !!res && (res.facets.length > 1 || scope !== null)

  return (
    <div className={`lsearch${active ? ' active' : ''}`}>
      <div className="lsearch-box">
        <Search size={13} />
        <input ref={inputRef} className="input sm" placeholder="检索全库 OCR 文本（多词用空格分隔）" value={q}
          onChange={e => setQ(e.target.value)} onKeyDown={onKey} spellCheck={false} />
        {busy
          ? <span className="lsearch-side"><Spinner /></span>
          : q && <button type="button" className="lsearch-side clear" onClick={clear} title="清空（Esc）"><X size={12} /></button>}
      </div>
      {active && (
        <div className="sres">
          {res && (
            <div className="sres-sum">
              <span>共 <b>{res.total}</b> 处{res.facets.length > 1 ? ` · ${res.facets.length} 本` : ''}</span>
              {showFacets && (
                <span className="chips">
                  <Chip size="sm" on={scope === null} onClick={() => pickScope(null)}>全库 {allCount}</Chip>
                  {res.facets.map(f => (
                    <Chip key={f.document_id} size="sm" on={scope === f.document_id} title={f.document_title}
                      onClick={() => pickScope(scope === f.document_id ? null : f.document_id)}>{f.document_code} {f.count}</Chip>
                  ))}
                </span>
              )}
            </div>
          )}
          {!res && q.trim().length < 2 && <div className="hint" style={{ padding: '2px 4px' }}>再输入一个字，或按回车搜索</div>}
          {res && res.total === 0 && (
            <div className="hint" style={{ padding: '2px 4px' }}>
              没有命中。三字以上按全文索引精确匹配，两字以内按子串匹配；多个词之间是「且」的关系。
            </div>
          )}
          {groups.map(g => (
            <div key={g.id} className="sres-grp">
              <div className="sres-doc" title={g.title}>
                <span className="mono">{g.code}</span><span className="truncate">{g.title}</span><span className="n">{g.hits.length}</span>
              </div>
              {g.hits.map(h => (
                <div key={h.segment_id} className={`hit${h.segment_id === activeSegment ? ' on' : ''}`} onClick={() => onOpenHit(h, doneQ || q)}>
                  <span className="pg mono">p{h.page_no}</span>
                  <span className="snip">
                    <Snippet s={h.snippet} />
                    {h.kind !== 'text' && h.kind !== 'line' && <span className="kind">{KIND_LABEL[h.kind] ?? h.kind}</span>}
                  </span>
                </div>
              ))}
            </div>
          ))}
          {res && res.hits.length < res.total && (
            <Button size="xs" variant="ghost" block disabled={busy} onClick={() => run(res.q, scopeRef.current, res.hits.length)}>
              更多（已显示 {res.hits.length} / {res.total}）
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
