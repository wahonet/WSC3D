import { useEffect, useRef } from 'react'
import { rgba } from '../../lib/format'
import type { Annotation, AnnotationReference, StoneInfo } from '../../types'

/** 一个文本源：总述（description）或某一层释文（layer:N）；关联区间按源内偏移记录 */
export interface TextSource { key: string; title: string; seq: number | null; name: string; text: string }
export interface PendingSel { source: string; start: number; end: number; text: string }

interface Seg { start: number; end: number; annoId: number | null; label?: string; color?: string }

export function buildSources(info: StoneInfo): TextSource[] {
  return [
    { key: 'description', title: '总述', seq: null, name: '总述', text: info.description },
    ...info.layers.map(l => ({ key: `layer:${l.seq}`, title: `第${l.seq}层 · ${l.name}`, seq: l.seq, name: l.name, text: l.summary })),
  ]
}

/* ---------------- 整篇编辑：文章 <-> 各源 的拼装与拆分 ---------------- */
const MARK = /^## 第(\d+)层(?:\s*[·:：]\s*(.*))?\s*$/

/** 把各源拼成一篇可编辑的全文：层以 "## 第N层 · 名称" 行分隔 */
export function joinArticle(sources: TextSource[]): string {
  return sources.map(s => (s.seq == null ? s.text : `## 第${s.seq}层 · ${s.name}\n${s.text}`)).join('\n\n')
}

/** 把全文按层标记拆回各源；层数或层号与现有不一致时返回错误说明 */
export function splitArticle(text: string, sources: TextSource[]):
  { ok: true; parts: { key: string; text: string; name?: string }[] } | { ok: false; error: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const parts: { key: string; text: string; name?: string }[] = []
  let cur = { key: 'description', buf: [] as string[], name: undefined as string | undefined }
  const flush = () => parts.push({ key: cur.key, text: cur.buf.join('\n').trim(), name: cur.name })
  for (const ln of lines) {
    const m = MARK.exec(ln)
    if (m) { flush(); cur = { key: `layer:${m[1]}`, buf: [], name: (m[2] ?? '').trim() || undefined }; continue }
    cur.buf.push(ln)
  }
  flush()
  const want = sources.filter(s => s.seq != null).map(s => s.key)
  const got = parts.filter(p => p.key !== 'description').map(p => p.key)
  if (want.length !== got.length || want.some((k, i) => k !== got[i])) {
    return { ok: false, error: `层标记须与现有分层一致（${want.map(k => `## 第${k.split(':')[1]}层`).join('、')}），不能在这里增减或重排层` }
  }
  if (parts.filter(p => p.key === 'description').length !== 1) return { ok: false, error: '总述只能有一段（层标记之前的部分）' }
  return { ok: true, parts }
}

function buildSegments(text: string, links: Annotation[]): Seg[] {
  const sorted = [...links].sort((a, b) => (a.desc_start ?? 0) - (b.desc_start ?? 0))
  const segs: Seg[] = []
  const chars = Array.from(text)
  let pos = 0
  for (const a of sorted) {
    // API offsets count Unicode code points; DOM ranges count UTF-16 code units.
    const s = chars.slice(0, a.desc_start ?? 0).join('').length, e = chars.slice(0, a.desc_end ?? 0).join('').length
    if (s > pos) segs.push({ start: pos, end: s, annoId: null })
    segs.push({ start: s, end: e, annoId: a.id, label: a.label, color: a.color })
    pos = e
  }
  if (pos < text.length) segs.push({ start: pos, end: text.length, annoId: null })
  return segs
}

/**
 * 释文全文：总述与各层连成一篇文章阅读（层名为行内小标题）；拖选文字形成待关联选区，
 * 点已关联（带底色）的文字反选节点。editing 时整篇为一个文本框。
 */
export default function TextArticle({ sources, links, selectedId, onPending, onSelectAnno, onError, editing, draft, onDraft }: {
  sources: TextSource[]
  links: Annotation[]
  selectedId: number | null
  onPending: (p: PendingSel | null) => void
  onSelectAnno: (id: number) => void
  onError: (msg: string) => void
  editing: boolean
  draft: string
  onDraft: (v: string) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const scrollTo = (source: string | null, start: number) => {
      const section = Array.from(boxRef.current?.querySelectorAll<HTMLElement>('[data-src]') ?? [])
        .find(el => el.dataset.src === source)
      const text = sources.find(s => s.key === source)?.text || ''
      const offset = Array.from(text).slice(0, start).join('').length
      const span = Array.from(section?.querySelectorAll<HTMLElement>('[data-s]') ?? []).find(el => Number(el.dataset.s) === offset)
      ;(span || section)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    const locate = (e: Event) => {
      const r = (e as CustomEvent<AnnotationReference>).detail
      scrollTo(r.desc_source, r.desc_start ?? 0)
    }
    window.addEventListener('stonelab:locate-description', locate)
    // A jump from another module can happen before this article has mounted.
    const q = new URLSearchParams(location.hash.replace(/^#/, ''))
    if (q.get('lib') === 'link' && q.has('src')) scrollTo(q.get('src'), Number(q.get('off')) || 0)
    return () => window.removeEventListener('stonelab:locate-description', locate)
  }, [sources])

  /* 选区捕获：把 DOM 选区换算为某文本源中的字符区间 */
  const onMouseUp = () => {
    if (editing) return
    const sel = window.getSelection()
    const box = boxRef.current
    if (!sel || sel.isCollapsed || !box) { onPending(null); return }
    const range = sel.getRangeAt(0)
    if (!box.contains(range.startContainer) || !box.contains(range.endContainer)) return
    const locate = (node: Node, o: number): { src: string; off: number } | null => {
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement
      const blk = el?.closest?.('[data-src]') as HTMLElement | null
      if (!blk) return null
      const prefix = document.createRange()
      prefix.selectNodeContents(blk)
      prefix.setEnd(node, o)
      return { src: blk.dataset.src!, off: prefix.toString().length }
    }
    const A = locate(range.startContainer, range.startOffset)
    const B = locate(range.endContainer, range.endOffset)
    if (!A || !B) { onPending(null); return }
    if (A.src !== B.src) { onError('一次只能关联同一段落（总述或某一层）内的文字'); onPending(null); return }
    let a = A.off, b = B.off
    if (a > b) [a, b] = [b, a]
    if (a === b) { onPending(null); return }
    const srcText = sources.find(s => s.key === A.src)?.text ?? ''
    const start = Array.from(srcText.slice(0, a)).length, end = Array.from(srcText.slice(0, b)).length
    for (const l of links.filter(x => x.desc_source === A.src)) {
      if (!(end <= (l.desc_start ?? 0) || start >= (l.desc_end ?? 0))) {
        onError('选区与已关联的文字重叠，请换一段'); onPending(null); return
      }
    }
    onPending({ source: A.src, start, end, text: srcText.slice(a, b) })
  }

  if (editing) {
    return (
      <div className="article">
        <textarea className="textarea article-editor" value={draft} onChange={e => onDraft(e.target.value)} spellCheck={false} />
        <div className="hint">
          整篇一个文本框：层与层之间用 <span className="mono">## 第N层 · 层名</span> 一行分隔（可改层名，不能增减层）；
          带底色的已关联文字不能删改，其他改动保存后关联位置自动重定位。
        </div>
      </div>
    )
  }

  const empty = sources.every(s => !s.text)
  return (
    <div className="article" ref={boxRef} onMouseUp={onMouseUp}>
      {empty && <div className="hint">（暂无释文。点上方「编辑全文」录入，或在 meta.json 中提供 description / layers 后重新扫描）</div>}
      {sources.map(src => {
        if (!src.text && src.seq == null) return null
        const segs = buildSegments(src.text, links.filter(l => l.desc_source === src.key))
        return (
          <section className="art-sec" key={src.key}>
            {src.seq == null
              ? <h4 className="art-h"><span className="art-cap">总述</span></h4>
              : <h4 className="art-h"><span className="seq">{src.seq}</span>{src.name}</h4>}
            <p className="art-p" data-src={src.key}>
              {segs.map((sg, i) => {
                const t = src.text.slice(sg.start, sg.end)
                if (sg.annoId == null) return <span key={i} data-s={sg.start}>{t}</span>
                const c = sg.color || '#e08c1a'
                const on = sg.annoId === selectedId
                return (
                  <span key={i} data-s={sg.start} className={`dlink${on ? ' on' : ''}`}
                    style={{ background: rgba(c, on ? 0.5 : 0.28), borderBottomColor: c, boxShadow: on ? `0 0 0 1.5px ${c}` : undefined }}
                    title={`已关联节点：${sg.label ?? ''}（点击选中）`}
                    onClick={() => onSelectAnno(sg.annoId!)}>{t}</span>
                )
              })}
              {!src.text && <span className="muted">（本层暂无释文）</span>}
            </p>
          </section>
        )
      })}
    </div>
  )
}
