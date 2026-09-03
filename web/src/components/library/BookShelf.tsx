import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, Play, RefreshCw, Search, Square } from 'lucide-react'
import { cancelOcr, libraryScan, listDocPages, listDocuments, ocrStatus, patchDocument, searchLibrary, startOcr } from '../../api'
import { fmtBytes } from '../../lib/format'
import { toast } from '../../store/useToast'
import type { DocumentInfo, OcrEngine, OcrStatus, PageBrief, SearchHit } from '../../types'
import { Badge, Button, Chip, Empty, Field, Spinner } from '../ui'

const STATUS_TONE: Record<string, string> = { done: 'var(--green)', running: 'var(--amber)', error: 'var(--red)', pending: 'var(--bg-4)', skipped: 'var(--text-3)' }

/**
 * 书库左栏：文献列表 -> 选中文献的元数据、OCR 作业控制、页格（按状态着色）、全文检索。
 */
export default function BookShelf({ docId, pageId, onSelectDoc, onSelectPage }: {
  docId: number | null
  pageId: number | null
  onSelectDoc: (id: number | null) => void
  onSelectPage: (id: number) => void
}) {
  const [docs, setDocs] = useState<DocumentInfo[]>([])
  const [pages, setPages] = useState<PageBrief[]>([])
  const [status, setStatus] = useState<OcrStatus | null>(null)
  const [engine, setEngine] = useState<OcrEngine | ''>('')
  const [backend, setBackend] = useState('')
  const [redo, setRedo] = useState(false)
  const [range, setRange] = useState('')
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [busy, setBusy] = useState(false)

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
  useEffect(() => { reloadPages() }, [reloadPages])
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
  const search = async () => {
    const s = q.trim()
    if (!s) { setHits(null); return }
    try { setHits(await searchLibrary(s, docId)) } catch (e) { toast.error(e) }
  }

  const job = status?.job

  return (
    <div className="shelf">
      <div className="shelf-head">
        <span className="hint">PDF 放入 <span className="mono">assets/library/</span> 后扫描</span>
        <span style={{ flex: 1 }} />
        <Button size="xs" variant="ghost" icon={<RefreshCw size={12} />} onClick={scan} disabled={busy}>扫描</Button>
      </div>
      {docs.length === 0 && <Empty icon={<BookOpen size={22} />} title="书库为空">把 PDF 放入 assets/library/（如 DOC-001_书名.pdf）后点「扫描」</Empty>}
      <div className="shelf-docs">
        {docs.map(d => (
          <div key={d.id} className={`shelf-doc${d.id === docId ? ' on' : ''}`} onClick={() => onSelectDoc(d.id === docId ? null : d.id)}>
            <div className="t"><span className="mono muted">{d.code}</span> {d.title || d.filename}</div>
            <div className="m">
              <span>{d.page_count} 页</span>
              <span className="mono">{d.pages_done}/{d.page_count} 已 OCR</span>
              {d.pages_error > 0 && <span style={{ color: 'var(--red)' }}>{d.pages_error} 错</span>}
              <span>{d.segments} 文段 · {d.figures} 图</span>
              <Badge mono outline>{d.script === 'classical' ? '古籍' : '现代'}</Badge>
            </div>
            <div className="bar"><i style={{ width: `${d.page_count ? (100 * d.pages_done) / d.page_count : 0}%` }} /></div>
          </div>
        ))}
      </div>

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

          <div className="shelf-sec">
            <div className="tree-search" style={{ padding: '4px 10px' }}>
              <div className="wrap"><Search size={13} /><input className="input sm" placeholder="全文检索（本书）" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search() }} /></div>
              <Button size="sm" onClick={search}>搜</Button>
            </div>
            {hits && (
              <div className="hits">
                {hits.length === 0 && <div className="hint" style={{ padding: '0 10px' }}>没有命中</div>}
                {hits.map(h => (
                  <div key={h.segment_id} className="hit" onClick={() => onSelectPage(h.page_id)}>
                    <Chip size="sm">p{h.page_no}</Chip>
                    <span dangerouslySetInnerHTML={{ __html: h.snippet.replace(/</g, '&lt;').replace(/\[\[/g, '<mark>').replace(/\]\]/g, '</mark>') }} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
