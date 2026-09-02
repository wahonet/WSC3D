import { useRef, useState } from 'react'
import { Link2, Pencil, X } from 'lucide-react'
import type { Annotation, StoneInfo } from '../../types'
import { Button } from '../ui'

export interface TextSource { key: string; title: string; seq: number | null; text: string }
export interface PendingSel { source: string; start: number; end: number; text: string }

interface Seg { start: number; end: number; annoId: number | null; label?: string }

export function buildSources(info: StoneInfo): TextSource[] {
  return [
    { key: 'description', title: '总述', seq: null, text: info.description },
    ...info.layers.map(l => ({ key: `layer:${l.seq}`, title: `第${l.seq}层 · ${l.name}`, seq: l.seq, text: l.summary })),
  ]
}

function buildSegments(text: string, links: Annotation[]): Seg[] {
  const sorted = [...links].sort((a, b) => (a.desc_start ?? 0) - (b.desc_start ?? 0))
  const segs: Seg[] = []
  let pos = 0
  for (const a of sorted) {
    const s = a.desc_start ?? 0, e = a.desc_end ?? 0
    if (s > pos) segs.push({ start: pos, end: s, annoId: null })
    segs.push({ start: s, end: e, annoId: a.id, label: a.label })
    pos = e
  }
  if (pos < text.length) segs.push({ start: pos, end: text.length, annoId: null })
  return segs
}

/**
 * 简介 = 总述 + 分层释文。支持：编辑（受锁定保护）、拖选文字形成待关联选区、
 * 点击橙色已关联文字反选标注。
 */
export default function TextCard({ sources, links, selectedId, selectedLabel, pending, onPending, onSelectAnno,
  onSave, onLink, onError }: {
  sources: TextSource[]
  links: Annotation[]
  selectedId: number | null
  selectedLabel: string | null
  pending: PendingSel | null
  onPending: (p: PendingSel | null) => void
  onSelectAnno: (id: number) => void
  onSave: (sourceKey: string, text: string) => Promise<boolean>
  onLink: () => void
  onError: (msg: string) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  const sourceTitle = (key: string) => sources.find(s => s.key === key)?.title ?? key

  const startEdit = (src: TextSource) => { setDraft(src.text); setEditing(src.key); onPending(null) }
  const saveEdit = async () => {
    if (!editing) return
    if (await onSave(editing, draft)) setEditing(null)
  }

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
      const span = el?.closest?.('[data-s]') as HTMLElement | null
      const blk = el?.closest?.('[data-src]') as HTMLElement | null
      if (!span || !blk) return null
      return { src: blk.dataset.src!, off: Number(span.dataset.s) + o }
    }
    const A = locate(range.startContainer, range.startOffset)
    const B = locate(range.endContainer, range.endOffset)
    if (!A || !B) { onPending(null); return }
    if (A.src !== B.src) { onError('选区不能跨越不同段落（总述/各层）'); onPending(null); return }
    let a = A.off, b = B.off
    if (a > b) [a, b] = [b, a]
    if (a === b) { onPending(null); return }
    const srcText = sources.find(s => s.key === A.src)?.text ?? ''
    for (const l of links.filter(x => x.desc_source === A.src)) {
      if (!(b <= (l.desc_start ?? 0) || a >= (l.desc_end ?? 0))) {
        onError('选区与已关联的文字重叠，请换一段'); onPending(null); return
      }
    }
    onPending({ source: A.src, start: a, end: b, text: srcText.slice(a, b) })
  }

  return (
    <section className="rcard">
      <div className="rcard-h">简介与释文<span className="grow" /><span className="hint" style={{ textTransform: 'none', letterSpacing: 0 }}>拖选文字可关联到选中标注</span></div>
      <div ref={boxRef} onMouseUp={onMouseUp}>
        {sources.map(src => {
          const segs = buildSegments(src.text, links.filter(l => l.desc_source === src.key))
          const isEditing = editing === src.key
          return (
            <div className="rsec" key={src.key}>
              <div className="rsec-h">
                {src.seq != null && <span className="seq">{src.seq}</span>}
                <span className="truncate">{src.title}</span>
                <span className="ops">
                  {!isEditing && !editing && <Button size="xs" variant="ghost" icon={<Pencil size={11} />} onClick={() => startEdit(src)}>编辑</Button>}
                  {isEditing && (
                    <>
                      <Button size="xs" variant="primary" onClick={saveEdit}>保存</Button>
                      <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>取消</Button>
                    </>
                  )}
                </span>
              </div>
              {isEditing ? (
                <textarea className="textarea" style={{ minHeight: 200 }} value={draft} onChange={e => setDraft(e.target.value)} />
              ) : (
                <div className="rdesc" data-src={src.key}>
                  {segs.map((sg, i) => {
                    const t = src.text.slice(sg.start, sg.end)
                    if (sg.annoId == null) return <span key={i} data-s={sg.start}>{t}</span>
                    return (
                      <span key={i} data-s={sg.start} className={`dlink${sg.annoId === selectedId ? ' on' : ''}`}
                        title={`已关联标注：${sg.label ?? ''}（点击选中）`}
                        onClick={() => onSelectAnno(sg.annoId!)}>{t}</span>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {pending && (
        <div className="rpending">
          <Link2 size={13} />
          <span>已选 {pending.text.length} 字（{sourceTitle(pending.source)}）：
            <q>{pending.text.length > 26 ? pending.text.slice(0, 26) + '…' : pending.text}</q>
          </span>
          {selectedLabel
            ? <Button size="sm" variant="primary" onClick={onLink}>关联到「{selectedLabel}」</Button>
            : <span className="muted">（先在下方或图上选中一个标注）</span>}
          <Button size="sm" variant="ghost" icon={<X size={12} />}
            onClick={() => { onPending(null); window.getSelection()?.removeAllRanges() }}>放弃</Button>
        </div>
      )}
      <div className="hint" style={{ marginTop: 8 }}>
        橙色文字为已关联（锁定）：编辑时删改这些文字会被拒绝保存；其他改动正常保存并自动重定位关联区间。
      </div>
    </section>
  )
}
