import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, FileText, Link2, Save } from 'lucide-react'
import { addAnnotationReference, figureImageUrl, getPageDetail, listDocPages, pageImageUrl, patchFigure, patchSegment } from '../../api'
import { buildTree, flatten } from '../../lib/tree'
import { useApp } from '../../store/useApp'
import { toast } from '../../store/useToast'
import type { DocFigure, DocSegment, PageDetail, SegmentKind, SegmentReview } from '../../types'
import { Badge, Button, Chip, Empty, Spinner } from '../ui'
import { Mark, splitWords } from './highlight'
import './library-references.css'

export const KIND_LABEL: Record<string, string> = {
  text: '正文', title: '标题', caption: '图注', footnote: '脚注', header: '页眉', page_number: '页码',
  table: '表格', equation: '公式', list: '列表', line: '行', other: '其他',
}
const KIND_COLOR: Record<string, string> = {
  text: '#4a90e2', title: '#e8a33d', caption: '#4caf7a', footnote: '#a06be0', header: '#7e766a', page_number: '#7e766a',
  table: '#39c2d7', equation: '#f06292', list: '#64b5f6', line: '#4a90e2', other: '#9ccc65',
}
const FIG_COLOR = '#d9573f'
const REVIEW: [SegmentReview, string][] = [['machine', '机器'], ['reviewed', '已校'], ['rejected', '否决']]

export interface SegmentFocus { segmentId?: number; figureId?: number }

interface ReferenceAction {
  linked: boolean
  busy: boolean
  targetLabel: string
  onLink: () => void
}

/**
 * 逐页校勘台：左 原刊页图（叠版面块）| 右 文段列表（机器底稿只读 + 校订稿）与插图。
 * `focus`：检索命中直达时要选中并滚到的文段（每个 focus 对象只应用一次）；`highlight`：在文段里高亮的检索词。
 */
export default function PageWorkbench({ pageId, onSelectPage, onLoaded, focus = null, highlight = '' }: {
  pageId: number | null; onSelectPage: (id: number) => void; onLoaded?: (p: PageDetail) => void
  focus?: SegmentFocus | null; highlight?: string
}) {
  const [page, setPage] = useState<PageDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState<number | null>(null)          // 选中文段 id
  const [selFigure, setSelFigure] = useState<number | null>(null)
  const [pendingLinks, setPendingLinks] = useState<Set<string>>(new Set())
  const pendingRef = useRef(new Set<string>())
  const selectedId = useApp(s => s.selectedId)
  const stoneAnnos = useApp(s => s.stoneAnnos)
  const curStone = useApp(s => s.curStone)
  const nodes = useMemo(() => flatten(buildTree(stoneAnnos), new Set()), [stoneAnnos])
  const target = nodes.find(n => n.a.id === selectedId)?.a ?? null
  const [hideKinds, setHideKinds] = useState<Set<string>>(new Set(['header', 'page_number']))
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const imgBoxRef = useRef<HTMLDivElement>(null)
  const applied = useRef<SegmentFocus | null>(null)
  const loadTicket = useRef(0)
  const words = useMemo(() => splitWords(highlight), [highlight])

  const reload = useCallback(async () => {
    const ticket = ++loadTicket.current
    if (pageId == null) { setPage(null); return }
    setLoading(true)
    try {
      const p = await getPageDetail(pageId)
      if (ticket !== loadTicket.current) return
      setPage(p)
      onLoaded?.(p)
    } catch (e) { if (ticket === loadTicket.current) toast.error(e) }
    finally { if (ticket === loadTicket.current) setLoading(false) }
  }, [pageId, onLoaded])
  useEffect(() => {
    setPage(null)
    reload()
    setSel(null)
    setSelFigure(null)
    setImgSize(null)
    return () => { loadTicket.current++ }
  }, [reload])

  const selectSegment = (id: number) => { setSel(id); setSelFigure(null) }
  const selectFigure = (id: number) => { setSelFigure(id); setSel(null) }
  const linkReference = async (kind: 'segment' | 'figure', sourceId: number) => {
    if (!target) return
    const key = `${target.id}:${kind}:${sourceId}`
    if (pendingRef.current.has(key)) return
    pendingRef.current.add(key)
    setPendingLinks(new Set(pendingRef.current))
    try {
      const updated = await addAnnotationReference(target.id, kind === 'segment'
        ? { kind, segment_id: sourceId } : { kind, figure_id: sourceId })
      useApp.setState(s => ({
        annos: s.annos.map(a => a.id === updated.id ? updated : a),
        stoneAnnos: s.stoneAnnos.map(a => a.id === updated.id ? updated : a),
      }))
      toast.ok(`已关联到「${target.label || `节点 #${target.id}`}」`)
      await useApp.getState().refreshAnnos().catch(() => toast.warn('关联已保存，节点列表刷新失败，可稍后重新打开'))
    } catch (e) { toast.error(e) } finally {
      pendingRef.current.delete(key)
      setPendingLinks(new Set(pendingRef.current))
    }
  }
  const referenceAction = (kind: 'segment' | 'figure', sourceId: number): ReferenceAction => ({
    linked: !!target?.references?.some(r => !r.source_missing && r.kind === kind && (kind === 'segment' ? r.segment_id : r.figure_id) === sourceId),
    busy: pendingLinks.has(`${target?.id}:${kind}:${sourceId}`),
    targetLabel: target ? target.label || `节点 #${target.id}` : '',
    onLink: () => { void linkReference(kind, sourceId) },
  })

  const gotoPage = async (delta: number) => {
    if (!page) return
    const target = page.page_no + delta
    if (target < 1 || target > page.page_count) return
    try {
      const rows = await listDocPages(page.document_id, target - 1, 1)
      if (rows[0]) onSelectPage(rows[0].id)
    } catch (e) { toast.error(e) }
  }

  const segments = useMemo(() => (page?.segments ?? []).filter(s => !hideKinds.has(s.kind)), [page, hideKinds])
  const kinds = useMemo(() => {
    const c: Record<string, number> = {}
    for (const s of page?.segments ?? []) c[s.kind] = (c[s.kind] ?? 0) + 1
    return c
  }, [page])

  // 检索命中直达：页面数据就位后选中该文段（若其类别被隐藏则放开），同一 focus 对象只应用一次
  useEffect(() => {
    if (!page || !focus || applied.current === focus) return
    if (focus.figureId != null) {
      if (!page.figures.some(f => f.id === focus.figureId)) return
      applied.current = focus
      setSelFigure(focus.figureId)
      setSel(null)
    } else {
      const s = page.segments.find(x => x.id === focus.segmentId)
      if (!s) return
      applied.current = focus
      setHideKinds(h => (h.has(s.kind) ? new Set([...h].filter(k => k !== s.kind)) : h))
      setSel(s.id)
      setSelFigure(null)
    }
  }, [page, focus])

  useEffect(() => {
    const selector = selFigure != null ? `[data-fig="${selFigure}"]` : sel != null ? `[data-seg="${sel}"]` : null
    if (!selector) return
    listRef.current?.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: 'nearest' })
    imgBoxRef.current?.querySelector<SVGGElement>(selector)?.scrollIntoView({ block: 'center' })
  }, [sel, selFigure, imgSize, focus])

  if (pageId == null) return <Empty icon={<FileText size={22} />} title="选择一页">在左侧页格里点一页，这里显示原刊页图、机器底稿与校订稿</Empty>
  if (!page) return <div className="loading-mask" style={{ position: 'relative', background: 'transparent' }}><Spinner />载入…</div>

  const onImgLoad = () => { const el = imgRef.current; if (el) setImgSize({ w: el.clientWidth, h: el.clientHeight }) }

  return (
    <div className="pwb">
      <div className="pwb-bar">
        <Button size="xs" variant="ghost" icon={<ChevronLeft size={13} />} onClick={() => gotoPage(-1)} disabled={page.page_no <= 1} />
        <b>{page.document_code}</b><span className="truncate" style={{ maxWidth: 200 }}>{page.document_title}</span>
        <span className="mono">p{page.page_no} / {page.page_count}</span>
        <Button size="xs" variant="ghost" icon={<ChevronRight size={13} />} onClick={() => gotoPage(1)} disabled={page.page_no >= page.page_count} />
        <Badge tone={page.status === 'done' ? 'green' : page.status === 'error' ? 'red' : 'amber'}>{page.status}</Badge>
        {page.engine && <Badge mono outline>{page.engine}</Badge>}
        {loading && <Spinner />}
        <span style={{ flex: 1 }} />
        <span className="chips">
          {Object.entries(kinds).map(([k, n]) => (
            <Chip key={k} size="sm" on={!hideKinds.has(k)} onClick={() => setHideKinds(h => { const s = new Set(h); if (s.has(k)) s.delete(k); else s.add(k); return s })}
              style={{ borderColor: KIND_COLOR[k] }}>{KIND_LABEL[k] ?? k} {n}</Chip>
          ))}
          {page.figures.length > 0 && <Chip size="sm" on style={{ borderColor: FIG_COLOR }}>插图 {page.figures.length}</Chip>}
        </span>
      </div>
      {page.error && <div className="note-box error" style={{ margin: '0 10px' }}>{page.error}</div>}
      <div className="pwb-body">
        <div className="pwb-img" ref={imgBoxRef}>
          <div className="pwb-imgwrap">
            <img ref={imgRef} src={pageImageUrl(page.id)} alt="" onLoad={onImgLoad} draggable={false} />
            {imgSize && (
              <svg className="pwb-overlay" width={imgSize.w} height={imgSize.h}>
                {page.figures.map(f => <Box key={`f${f.id}`} figureId={f.id} bbox={f.bbox} size={imgSize} color={FIG_COLOR} dashed label={f.label || '图'} on={f.id === selFigure} onClick={() => selectFigure(f.id)} />)}
                {segments.map(s => (
                  <Box key={s.id} id={s.id} bbox={s.bbox} size={imgSize} color={KIND_COLOR[s.kind] ?? '#999'} on={s.id === sel} onClick={() => selectSegment(s.id)} />
                ))}
              </svg>
            )}
          </div>
        </div>
        <div className="pwb-reference-column">
          <div className="pwb-reference-target">
            <label htmlFor="library-reference-node"><Link2 size={12} />关联到节点</label>
            <select id="library-reference-node" className="select sm" value={target?.id ?? ''} disabled={!nodes.length}
              onChange={e => useApp.getState().select(Number(e.target.value) || null)}>
              <option value="">{!curStone ? '请先打开一块画像石' : !nodes.length ? '当前画像石还没有结构节点' : '选择当前画像石的节点'}</option>
              {nodes.map(({ a, depth }) => <option key={a.id} value={a.id}>{'　'.repeat(depth)}{a.label || '未命名'} · #{a.id}</option>)}
            </select>
            {target && <span className="hint">已关联 {target.references?.length || (target.desc_text ? 1 : 0)} 条，可继续添加文段或插图</span>}
          </div>
          <div className="pwb-list" ref={listRef}>
          {page.status !== 'done' && page.segments.length === 0 && (
            <Empty>这页还没有 OCR 结果。在左侧「OCR 作业」里填页范围（如 {page.page_no}）后开始。</Empty>
          )}
          {page.figures.map(f => <FigureCard key={f.id} f={f} on={f.id === selFigure} onSelect={() => selectFigure(f.id)} onSaved={reload} reference={referenceAction('figure', f.id)} />)}
          {segments.map(s => <SegmentCard key={s.id} s={s} words={words} on={s.id === sel} onSelect={() => selectSegment(s.id)} onSaved={reload} reference={referenceAction('segment', s.id)} />)}
          </div>
        </div>
      </div>
    </div>
  )
}

function Box({ id, figureId, bbox, size, color, on, dashed, label, onClick }: {
  id?: number; figureId?: number; bbox: [number, number, number, number]; size: { w: number; h: number }; color: string; on?: boolean; dashed?: boolean; label?: string; onClick?: () => void
}) {
  const [x0, y0, x1, y1] = bbox
  const x = x0 * size.w, y = y0 * size.h, w = Math.max(1, (x1 - x0) * size.w), h = Math.max(1, (y1 - y0) * size.h)
  return (
    <g className={onClick ? 'hit' : undefined} data-seg={id} data-fig={figureId} onClick={onClick}>
      <rect x={x} y={y} width={w} height={h} fill={color} fillOpacity={on ? 0.28 : 0.08} stroke={on ? '#ff5a45' : color}
        strokeWidth={on ? 2.2 : 1.2} strokeDasharray={dashed ? '5 3' : undefined} />
      {label && <text x={x + 3} y={y + 12} fontSize={11} fill={color} fontWeight={700} stroke="#14120f" strokeWidth={2.5} paintOrder="stroke">{label}</text>}
    </g>
  )
}

function SegmentCard({ s, words, on, onSelect, onSaved, reference }: { s: DocSegment; words: string[]; on: boolean; onSelect: () => void; onSaved: () => void; reference: ReferenceAction }) {
  const [edit, setEdit] = useState(s.text_edit)
  const [saving, setSaving] = useState(false)
  useEffect(() => { setEdit(s.text_edit) }, [s.text_edit, s.id])
  const dirty = edit !== s.text_edit
  const save = async (extra?: { review_status?: SegmentReview; kind?: SegmentKind }) => {
    setSaving(true)
    try {
      await patchSegment(s.id, { text_edit: dirty ? edit : undefined, base_revision: s.revision, ...extra })
      onSaved()
    } catch (e) { toast.error(e) } finally { setSaving(false) }
  }
  return (
    <div className={`segc${on ? ' on' : ''} rv-${s.review_status}`} data-seg={s.id} onClick={onSelect}>
      <div className="segc-h">
        <span className="sw" style={{ background: KIND_COLOR[s.kind] ?? '#999' }} />
        <select className="select sm" style={{ width: 84 }} value={s.kind} onChange={e => save({ kind: e.target.value as SegmentKind })} onClick={e => e.stopPropagation()}>
          {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="mono muted">#{s.seq}{s.confidence != null ? ` · ${(s.confidence * 100).toFixed(0)}%` : ''}</span>
        <span style={{ flex: 1 }} />
        {REVIEW.map(([k, lb]) => (
          <button key={k} className={`chip sm${s.review_status === k ? ' on' : ''}`} onClick={e => { e.stopPropagation(); save({ review_status: k }) }}>{lb}</button>
        ))}
      </div>
      <div className="segc-machine">{s.text ? <Mark text={s.text} words={words} /> : <span className="muted">（空）</span>}</div>
      {on && (
        <div className="segc-edit" onClick={e => e.stopPropagation()}>
          <textarea className="textarea nd-ta" placeholder="校订稿（留空 = 采用机器底稿）" value={edit} onChange={e => setEdit(e.target.value)}
            onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save() } }} />
          <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
            <span className="hint">v{s.revision}{dirty ? ' · 未保存' : ''}</span>
            <Button size="xs" variant="primary" icon={<Save size={11} />} disabled={!dirty || saving} onClick={() => save()}>保存</Button>
          </div>
        </div>
      )}
      {!on && s.text_edit && <div className="segc-edited">校：<Mark text={s.text_edit} words={words} /></div>}
      <ReferenceButton action={reference} dirty={dirty} />
    </div>
  )
}

function FigureCard({ f, on, onSelect, onSaved, reference }: { f: DocFigure; on: boolean; onSelect: () => void; onSaved: () => void; reference: ReferenceAction }) {
  const [caption, setCaption] = useState(f.caption)
  const [label, setLabel] = useState(f.label)
  useEffect(() => { setCaption(f.caption); setLabel(f.label) }, [f.caption, f.label, f.id])
  const dirty = caption !== f.caption || label !== f.label
  const save = async () => { try { await patchFigure(f.id, { caption, label }); onSaved() } catch (e) { toast.error(e) } }
  return (
    <div className={`figc${on ? ' on' : ''}`} data-fig={f.id} onClick={onSelect}>
      {f.has_image ? <img src={figureImageUrl(f.id)} alt="" /> : <div className="figc-empty">无裁片</div>}
      <div className="figc-b">
        <div className="row" style={{ gap: 6 }}>
          <Badge tone="red">插图</Badge>
          <input className="input sm" style={{ width: 110 }} placeholder="图号" value={label} onChange={e => setLabel(e.target.value)} />
          <span className="mono muted">#{f.seq}</span>
        </div>
        <textarea className="textarea nd-ta" placeholder="图注" value={caption} onChange={e => setCaption(e.target.value)} />
        {dirty && <div className="row" style={{ justifyContent: 'flex-end' }}><Button size="xs" variant="primary" icon={<Save size={11} />} onClick={save}>保存</Button></div>}
        <ReferenceButton action={reference} dirty={dirty} />
      </div>
    </div>
  )
}

function ReferenceButton({ action, dirty }: { action: ReferenceAction; dirty: boolean }) {
  const title = action.linked ? `已关联到「${action.targetLabel}」`
    : !action.targetLabel ? '请先在上方选择关联节点'
      : dirty ? '请先保存校订内容，再关联到节点' : `关联到「${action.targetLabel}」`
  return <div className="pwb-reference-action" onClick={e => e.stopPropagation()}>
    {dirty && !action.linked && <span className="hint">先保存校订内容</span>}
    <Button size="xs" variant="ghost" icon={action.linked ? <Check size={11} /> : <Link2 size={11} />}
      title={title} disabled={!action.targetLabel || action.linked || action.busy || dirty} onClick={action.onLink}>
      {action.linked ? '已关联' : action.busy ? '关联中…' : '关联到节点'}
    </Button>
  </div>
}
