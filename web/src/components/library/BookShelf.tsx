import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, Play, Square } from 'lucide-react'
import { cancelOcr, libraryScan, listDocPages, listDocuments, ocrStatus, patchDocument, startOcr } from '../../api'
import { fmtBytes } from '../../lib/format'
import { toast } from '../../store/useToast'
import type { DocumentInfo, OcrEngine, OcrStatus, PageBrief, SearchHit } from '../../types'
import { Badge, Button, Empty, Field, Spinner } from '../ui'
import BookPicker from './BookPicker'
import LibrarySearch from './LibrarySearch'

const STATUS_TONE: Record<string, string> = { done: 'var(--green)', running: 'var(--amber)', error: 'var(--red)', pending: 'var(--bg-4)', skipped: 'var(--text-3)' }

/**
 * 书库左栏：顶部固定的全库检索框（有输入时结果接管整栏）；
 * 其下是选书下拉（当前书 + 可筛选书目）-> 选中文献的元数据、OCR 作业控制、页格（按状态着色）。
 */
export default function BookShelf({ docId, pageId, activeSegment, onSelectDoc, onSelectPage, onOpenHit, onSearchChange }: {
  docId: number | null
  pageId: number | null
  activeSegment: number | null
  onSelectDoc: (id: number | null) => void
  onSelectPage: (id: number) => void
  onOpenHit: (h: SearchHit, q: string) => void
  onSearchChange: (q: string) => void
}) {
  const [docs, setDocs] = useState<DocumentInfo[]>([])
  const [pages, setPages] = useState<PageBrief[]>([])
  const [status, setStatus] = useState<OcrStatus | null>(null)
  const [engine, setEngine] = useState<OcrEngine | ''>('')
  const [backend, setBackend] = useState('')
  const [redo, setRedo] = useState(false)
  const [range, setRange] = useState('')
  const [searchOn, setSearchOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const onSearchActive = useCallback((active: boolean, q: string) => { setSearchOn(active); onSearchChange(active ? q : '') }, [onSearchChange])

  const doc = useMemo(() => docs.find(d => d.id === docId) ?? null, [docs, docId])

  const reloadDocs = useCallback(async () => {
    try { setDocs(await listDocuments()) } catch (e) { toast.error(e) }
  }, [])
  const reloadPages = useCallback(async () => {
    if (docId == null) { setPages([]); return }
    try { setPages(await listDocPages(docId)) } catch (e) { toast.error(e) }
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
  // 作业运行时每 2 秒刷新进度与页状态
  const running = !!status?.job.running
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => { reloadStatus(); reloadPages(); reloadDocs() }, 2000)
    return () => window.clearInterval(t)
  }, [running, reloadStatus, reloadPages, reloadDocs])

  const scan = async () => {
    setBusy(true)
    try {
      const r = await libraryScan()
      toast.ok(`扫描完成：文献 ${r.documents} · 新增 ${r.added} · 更新 ${r.updated}`)
      await reloadDocs()
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  const parseRange = (): number[] | null => {
    const s = range.trim()
    if (!s) return null
    const out = new Set<number>()
    for (const part of s.split(/[,，\s]+/)) {
      const m = /^(\d+)\s*[-–~]\s*(\d+)$/.exec(part)
      if (m) { for (let i = Number(m[1]); i <= Number(m[2]); i++) out.add(i) } else if (/^\d+$/.test(part)) out.add(Number(part))
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

  return (
    <div className="shelf">
      <LibrarySearch activeSegment={activeSegment} onOpenHit={onOpenHit} onActiveChange={onSearchActive} />
      {searchOn ? null : (<>
      <BookPicker docs={docs} docId={docId} runningDocId={job?.running ? job.document_id : null} busy={busy} onSelect={onSelectDoc} onScan={scan} />
      {docs.length === 0 && <Empty icon={<BookOpen size={22} />} title="书库为空">把 PDF 放入 assets/library/（如 DOC-001_书名.pdf）后点上方「扫描」</Empty>}

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
            <div className="layers-title">页 · {pages.length}<span className="hint" style={{ marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>绿=已 OCR · 黄=进行中 · 红=出错</span></div>
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
      </>)}
    </div>
  )
}
