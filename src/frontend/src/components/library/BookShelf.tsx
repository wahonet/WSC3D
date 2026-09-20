import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Play, Square } from 'lucide-react'
import { cancelOcr, libraryScan, listDocPages, listDocuments, ocrStatus, patchDocument, startOcr } from '../../api'
import { fmtBytes } from '../../lib/format'
import { toast } from '../../store/useToast'
import type { DocumentInfo, LibraryCollection, OcrEngine, OcrStatus, PageBrief, SearchHit } from '../../types'
import { goToSection, refreshExtensionDocuments } from '../../lib/navigation'
import { useStore } from '../../archive/store'
import { Badge, Button, Empty, Field, Spinner } from '../ui'
import BookPicker from './BookPicker'
import LibrarySearch from './LibrarySearch'

const STATUS_TONE: Record<string, string> = { done: 'var(--green)', running: 'var(--amber)', error: 'var(--red)', pending: 'var(--bg-4)', skipped: 'var(--text-3)' }

/**
 * 书库左栏：顶部固定的全库检索框（有输入时结果接管整栏）；
 * 其下是选书下拉（当前书 + 可筛选书目）-> 选中文献的元数据、OCR 作业控制、页格（按状态着色）。
 */
export default function BookShelf({ collection, docId, pageId, activeSegment, onSelectDoc, onSelectPage, onOpenHit, onSearchChange }: {
  collection: LibraryCollection
  docId: number | null
  pageId: number | null
  activeSegment: number | null
  onSelectDoc: (id: number | null) => void
  onSelectPage: (id: number) => void
  onOpenHit: (h: SearchHit, q: string) => void
  onSearchChange: (q: string) => void
}) {
  const [docs, setDocs] = useState<DocumentInfo[]>([])
  const [docsLoaded, setDocsLoaded] = useState(false)
  const [pages, setPages] = useState<PageBrief[]>([])
  const [status, setStatus] = useState<OcrStatus | null>(null)
  const [engine, setEngine] = useState<OcrEngine | ''>('')
  const [backend, setBackend] = useState('')
  const [redo, setRedo] = useState(false)
  const [range, setRange] = useState('')
  const [searchOn, setSearchOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const pageRequest = useRef(0)
  const archiveBooks = useStore(s => s.books)
  const sourceBook = collection === 'extension' ? archiveBooks.find(b => b.id === docs.find(d => d.id === docId)?.book_id) : null
  const bibliographyOnly = collection === 'extension' ? archiveBooks.filter(b => !b.pdf) : []
  const onSearchActive = useCallback((active: boolean, q: string) => { setSearchOn(active); onSearchChange(active ? q : '') }, [onSearchChange])

  const doc = useMemo(() => docs.find(d => d.id === docId) ?? null, [docs, docId])

  const reloadDocs = useCallback(async () => {
    try { setDocs(await listDocuments(collection)) } catch (e) { toast.error(e) } finally { setDocsLoaded(true) }
  }, [collection])
  const reloadPages = useCallback(async () => {
    const ticket = ++pageRequest.current
    if (docId == null) { setPages([]); return }
    try {
      const all: PageBrief[] = []
      for (let offset = 0; ; offset += 500) {
        const batch = await listDocPages(docId, offset, 500)
        if (ticket !== pageRequest.current) return
        all.push(...batch)
        if (batch.length < 500) break
      }
      setPages(all)
    } catch (e) { if (ticket === pageRequest.current) toast.error(e) }
  }, [docId])
  const reloadStatus = useCallback(async () => {
    try { setStatus(await ocrStatus()) } catch { /* 忽略 */ }
  }, [])

  useEffect(() => { reloadDocs(); reloadStatus() }, [reloadDocs, reloadStatus])
  // 换书时先清空页格，避免短暂显示上一本的页
  useEffect(() => { setPages([]); reloadPages() }, [reloadPages])
  // 没选书或所选的书已不存在时，默认选第一本
  useEffect(() => {
    if (docs.length && (docId == null || !docs.some(d => d.id === docId))) onSelectDoc(docs[0].id)
  }, [docs, docId, onSelectDoc])
  // 空闲时也检查状态，以发现外部启动的作业和全库队列的下一本书。
  const running = !!status?.job.running
  useEffect(() => {
    const t = window.setInterval(reloadStatus, running ? 2000 : 5000)
    return () => window.clearInterval(t)
  }, [running, reloadStatus])
  useEffect(() => {
    reloadPages(); reloadDocs()
    if (!running) return
    const t = window.setInterval(() => { reloadPages(); reloadDocs() }, 2000)
    return () => window.clearInterval(t)
  }, [running, status?.job.document_id, status?.job.finished_at, reloadPages, reloadDocs])

  const scan = async () => {
    setBusy(true)
    try {
      const r = await libraryScan(collection)
      if (collection === 'extension') refreshExtensionDocuments()
      toast.ok(`扫描完成：文献 ${r.documents} · 新增 ${r.added} · 更新 ${r.updated}`)
      if (r.skipped.length) toast.warn(`${r.skipped.length} 条书目未登记：${r.skipped[0].reason}`)
      await reloadDocs()
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  const parseRange = (): number[] | null => {
    const s = range.trim().replace(/\s*([-–~])\s*/g, '$1')
    if (!s) return null
    const out = new Set<number>()
    for (const part of s.split(/[,，\s]+/)) {
      const m = /^(\d+)\s*[-–~]\s*(\d+)$/.exec(part)
      if (m) {
        const first = Number(m[1]), last = Number(m[2])
        if (first < 1 || last < first || last > (doc?.page_count || 0)) throw new Error('页范围超出本书页数或起止顺序有误')
        for (let i = first; i <= last; i++) out.add(i)
      } else if (/^\d+$/.test(part) && Number(part) >= 1 && Number(part) <= (doc?.page_count || 0)) out.add(Number(part))
      else throw new Error('请输入有效页码，例如 1-20, 35')
    }
    return [...out].sort((a, b) => a - b)
  }
  const run = async () => {
    if (!doc) return
    try {
      const j = await startOcr(doc.id, { engine: engine || null, pages: parseRange(), redo, backend })
      toast.ok(`已启动：${j.total} 页（${j.engine}）`)
      await reloadStatus()
    } catch (e) { toast.error(e) }
  }
  const stop = async () => { try { await cancelOcr(); await reloadStatus() } catch (e) { toast.error(e) } }
  const saveMeta = async (patch: Parameters<typeof patchDocument>[1]) => {
    if (!doc) return
    try { const d = await patchDocument(doc.id, patch); setDocs(ds => ds.map(x => (x.id === d.id ? d : x))) } catch (e) { toast.error(e) }
  }
  const job = status?.job

  if (!docsLoaded) return <div className="shelf" role="status"><Spinner /> 正在载入文献…</div>

  return (
    <div className="shelf">
      <LibrarySearch collection={collection} activeSegment={activeSegment} onOpenHit={onOpenHit} onActiveChange={onSearchActive} />
      {searchOn ? null : (<>
      <BookPicker collection={collection} docs={docs} docId={docId} runningDocId={job?.running ? job.document_id : null} busy={busy} onSelect={onSelectDoc} onScan={scan} />
      {busy && <div role="status" className="hint"><Spinner /> 正在核对原件并登记文献…</div>}
      {docs.length === 0 && <Empty icon={<BookOpen size={22} />} title="书库为空">{collection === 'extension' ? '点击上方刷新按钮登记扩展文献及已有文字。' : '当前没有已登记核心书目，请检查书库原件与配置'}</Empty>}

      {doc && (
        <>
          <div className="shelf-sec">
            <div className="layers-title">文献信息 · {fmtBytes(doc.bytes)}{doc.has_text_layer ? ' · 有文字层' : ' · 扫描件'}</div>
            <div className="rfields" style={{ padding: '0 10px' }}>
              <Field label="题名"><input className="input sm" defaultValue={doc.title} key={`t${doc.id}`} onBlur={e => e.target.value !== doc.title && saveMeta({ title: e.target.value })} /></Field>
              <Field label="作者"><input className="input sm" defaultValue={doc.authors} key={`a${doc.id}`} onBlur={e => e.target.value !== doc.authors && saveMeta({ authors: e.target.value })} /></Field>
              <Field label="年份"><input className="input sm" defaultValue={doc.year} key={`y${doc.id}`} onBlur={e => e.target.value !== doc.year && saveMeta({ year: e.target.value })} /></Field>
              <Field label="体例">
                <select className="select sm" value={doc.script} onChange={e => saveMeta({ script: e.target.value as DocumentInfo['script'] })}>
                  <option value="modern">现代横排（MinerU）</option>
                  <option value="classical">古籍竖排（NDL Lite）</option>
                </select>
              </Field>
              <Field label="类型">
                <select className="select sm" value={doc.kind} onChange={e => saveMeta({ kind: e.target.value as DocumentInfo['kind'] })}>
                  <option value="book">专著</option><option value="article">论文</option><option value="catalog">图录</option><option value="other">其他</option>
                </select>
              </Field>
            </div>
          </div>

          {sourceBook && <details className="shelf-sec" style={{ padding: '8px 10px' }}><summary>书目档案与相关原石</summary>
            <p className="hint">{[sourceBook.category, sourceBook.publisher, sourceBook.source].filter(Boolean).join(' · ')}</p>
            {sourceBook.note && <p className="hint">{sourceBook.note}</p>}
            {sourceBook.refs?.map((ref, index) => <Button key={index} size="xs" variant="ghost" onClick={() => goToSection('archive', { stone: ref.stone })}>{ref.stone} {ref.stone_name || ''}{ref.loc ? ` · ${ref.loc}` : ''}</Button>)}
          </details>}

          <div className="shelf-sec">
            <div className="layers-title">OCR 作业</div>
            <div className="shelf-ocr">
              <select className="select sm" value={engine} onChange={e => setEngine(e.target.value as OcrEngine | '')} title="引擎">
                <option value="">按体例自动</option><option value="mineru">MinerU（现代）</option><option value="ndl">NDL Lite（古籍）</option>
              </select>
              {(engine === 'mineru' || (!engine && doc.script === 'modern')) && (
                <select className="select sm" value={backend} onChange={e => setBackend(e.target.value)} title="MinerU 后端">
                  <option value="">hybrid-engine（默认）</option><option value="vlm-engine">vlm-engine</option><option value="pipeline">pipeline（无 VLM）</option>
                </select>
              )}
              <input className="input sm" placeholder="页范围，如 1-20, 35（空 = 全部未完成）" value={range} onChange={e => setRange(e.target.value)} />
              <label className="switch"><input type="checkbox" checked={redo} onChange={e => setRedo(e.target.checked)} /><span className="track" /><span>已完成的页也重做</span></label>
              <div className="row">
                {job?.running
                  ? <Button size="sm" variant="danger" icon={<Square size={12} />} onClick={stop}>{job.cancel_requested ? '正在停止…' : '取消'}</Button>
                  : <Button size="sm" variant="primary" icon={<Play size={12} />} onClick={run}>开始 OCR</Button>}
                {status && (
                  <span className="hint">
                    {status.workers.map(w => <span key={w.engine} style={{ marginRight: 8 }}>{w.engine}：{w.available ? (w.alive ? '运行中' : '就绪') : '未安装'}</span>)}
                  </span>
                )}
              </div>
              {job && (job.running || job.finished_at) && (
                <div className="shelf-job">
                  {job.running && <Spinner />}
                  {job.document_id != null && job.document_id !== doc.id && (
                    <Badge mono outline title="作业属于另一本书">{docs.find(d => d.id === job.document_id)?.code ?? `#${job.document_id}`}</Badge>
                  )}
                  <span>{job.message}</span>
                  <span className="mono">{job.done}/{job.total}{job.errors ? ` · 错 ${job.errors}` : ''}</span>
                  <div className="bar"><i style={{ width: `${job.total ? (100 * job.done) / job.total : 0}%` }} /></div>
                </div>
              )}
            </div>
          </div>

          <div className="shelf-sec grow">
            <div className="layers-title">页 · {pages.length}<span className="hint" style={{ marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>绿=已有文字 · 黄=进行中 · 红=出错</span></div>
            <div className="page-grid">
              {pages.map(p => (
                <button key={p.id} className={`pg${p.id === pageId ? ' on' : ''}`} style={{ background: STATUS_TONE[p.status] }}
                  onClick={() => onSelectPage(p.id)} title={`p${p.page_no} · ${p.status}${p.segments ? ` · ${p.segments} 段` : ''}${p.error ? `\n${p.error}` : ''}`}>
                  {p.page_no}
                </button>
              ))}
            </div>
          </div>

        </>
      )}
      {bibliographyOnly.length > 0 && <details className="shelf-sec" style={{ padding: '8px 10px' }}><summary>仅有书目记录 · {bibliographyOnly.length} 条</summary>{bibliographyOnly.map(b => <p key={b.id} className="hint">《{b.title}》{b.author && ` · ${b.author}`}（未收录 PDF）</p>)}</details>}
      </>)}
    </div>
  )
}
