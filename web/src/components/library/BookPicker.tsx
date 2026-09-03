import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, RefreshCw, Search } from 'lucide-react'
import type { DocumentInfo } from '../../types'
import { Badge, Button, Spinner } from '../ui'

const KIND_LABEL: Record<DocumentInfo['kind'], string> = { book: '专著', article: '论文', catalog: '图录', other: '其他' }
const pct = (d: DocumentInfo) => (d.page_count ? Math.round((100 * d.pages_done) / d.page_count) : 0)

/**
 * 选书下拉：按钮上是当前这本（编号 / 题名 / OCR 进度），展开后是可筛选的全部书目，
 * 每本带页数、OCR 进度、文段 / 插图数、体例、类型、作者年份；书多了也不用上下滚动找。
 */
export default function BookPicker({ docs, docId, runningDocId, busy, onSelect, onScan }: {
  docs: DocumentInfo[]
  docId: number | null
  /** 正在跑 OCR 作业的书 */
  runningDocId: number | null
  /** 正在扫描目录 */
  busy: boolean
  onSelect: (id: number) => void
  onScan: () => void
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cur = docs.find(d => d.id === docId) ?? null

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    setFilter('')
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    if (!f) return docs
    return docs.filter(d => [d.code, d.title, d.filename, d.authors, d.year].join(' ').toLowerCase().includes(f))
  }, [docs, filter])

  const pick = (id: number) => { onSelect(id); setOpen(false) }

  return (
    <div className="bpick" ref={rootRef}>
      <div className="bpick-row">
        <button type="button" className={`bpick-btn${open ? ' open' : ''}`} onClick={() => setOpen(o => !o)} title={cur ? cur.filename : '选择一本书'}>
          <span className="body">
            {cur ? (
              <>
                <span className="t"><span className="mono muted">{cur.code}</span><span className="truncate">{cur.title || cur.filename}</span></span>
                <span className="m">
                  <span>{cur.page_count} 页</span>
                  <span className="mono">{cur.pages_done}/{cur.page_count} 已 OCR</span>
                  {cur.pages_error > 0 && <span style={{ color: 'var(--red)' }}>{cur.pages_error} 错</span>}
                  <Badge mono outline>{cur.script === 'classical' ? '古籍' : '现代'}</Badge>
                  {runningDocId === cur.id && <Spinner />}
                </span>
                <span className="bar"><i style={{ width: `${pct(cur)}%` }} /></span>
              </>
            ) : (
              <span className="t muted">{docs.length ? `选择一本书（共 ${docs.length} 本）` : '书库为空'}</span>
            )}
          </span>
          <ChevronDown size={14} className="chev" />
        </button>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={onScan} disabled={busy} title="重新扫描 assets/library/" />
      </div>
      {open && (
        <div className="bpick-menu">
          {docs.length > 4 && (
            <div className="bpick-filter">
              <Search size={12} />
              <input ref={inputRef} className="input sm" placeholder="筛选：编号 / 题名 / 作者 / 年份" value={filter} onChange={e => setFilter(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && shown.length === 1) pick(shown[0].id) }} />
            </div>
          )}
          <div className="bpick-list">
            {shown.length === 0 && (
              <div className="hint" style={{ padding: '8px 10px' }}>
                {docs.length ? '没有匹配的书' : '把 PDF 放入 assets/library/（如 DOC-001_书名.pdf）后点右侧「扫描」'}
              </div>
            )}
            {shown.map(d => (
              <div key={d.id} className={`bpick-item${d.id === docId ? ' on' : ''}`} onClick={() => pick(d.id)} title={d.filename}>
                <div className="t">
                  <span className="mono muted">{d.code}</span>
                  <span className="truncate">{d.title || d.filename}</span>
                  {d.id === docId && <Check size={13} className="chk" />}
                </div>
                <div className="m">
                  <span>{d.page_count} 页</span>
                  <span className="mono">{d.pages_done}/{d.page_count}{d.page_count ? ` · ${pct(d)}%` : ''}</span>
                  {d.pages_error > 0 && <span style={{ color: 'var(--red)' }}>{d.pages_error} 错</span>}
                  <span>{d.segments} 段 · {d.figures} 图</span>
                  <Badge mono outline>{d.script === 'classical' ? '古籍' : '现代'}</Badge>
                  <Badge outline>{KIND_LABEL[d.kind]}</Badge>
                  {runningDocId === d.id && <Badge tone="amber">OCR 中</Badge>}
                  {(d.authors || d.year) && <span className="muted truncate">{[d.authors, d.year].filter(Boolean).join(' · ')}</span>}
                </div>
                <div className="bar"><i style={{ width: `${pct(d)}%` }} /></div>
              </div>
            ))}
          </div>
          <div className="bpick-foot">
            <span className="hint">共 {docs.length} 本 · PDF 放入 <span className="mono">assets/library/</span> 后点「扫描」登记</span>
          </div>
        </div>
      )}
    </div>
  )
}
