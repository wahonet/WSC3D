import { useMemo, useState } from 'react'
import { Crosshair, Link2, ListChecks, Palette, Pencil, Trash2 } from 'lucide-react'
import { ATYPE_LABEL, COLORS, PALETTE } from '../lib/constants'
import { fmtTime, fmtValue } from '../lib/format'
import { selectIs2d, useApp } from '../store/useApp'
import type { Annotation } from '../types'
import { Badge, Button, Chip, Empty } from './ui'

type Filter = 'all' | 'annotate' | 'measure' | 'segment' | 'align'
const FILTERS: [Filter, string][] = [['all', '全部'], ['annotate', '标注'], ['measure', '测量'], ['segment', '分割'], ['align', '对齐']]

export default function AnnotationPanel() {
  const annos = useApp(s => s.annos)
  const selectedId = useApp(s => s.selectedId)
  const asset = useApp(s => s.curAsset)
  const is2d = useApp(selectIs2d)
  const select = useApp(s => s.select)
  const flyTo = useApp(s => s.flyToAnnotation)
  const update = useApp(s => s.updateAnnotation)
  const remove = useApp(s => s.removeAnnotation)
  const recolorAll = useApp(s => s.recolorAll)

  const [filter, setFilter] = useState<Filter>('all')
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmDel, setConfirmDel] = useState<number | null>(null)
  const [confirmRecolor, setConfirmRecolor] = useState(false)

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: annos.length, annotate: 0, measure: 0, segment: 0, align: 0 }
    for (const a of annos) {
      const k = (a.tool in c ? a.tool : 'annotate') as Filter
      c[k]++
    }
    return c
  }, [annos])
  const shown = filter === 'all' ? annos : annos.filter(a => (a.tool in counts ? a.tool : 'annotate') === filter)

  const commitLabel = async (a: Annotation) => {
    const label = draft.trim()
    setEditing(null)
    if (label && label !== a.label) await update(a.id, { label })
  }

  if (!asset) return <Empty icon={<ListChecks size={22} />} title="暂无对象">打开素材后，这里列出它的标注、测量与对齐记录</Empty>
  if (annos.length === 0) {
    return <Empty icon={<ListChecks size={22} />} title="当前对象暂无标注">用左侧「标注 / 测量 / 分割 / 对齐」工具在中央窗口创建</Empty>
  }

  return (
    <>
      <div className="anno-filters">
        {FILTERS.filter(([k]) => k === 'all' || counts[k] > 0).map(([k, lb]) => (
          <Chip key={k} size="sm" on={filter === k} onClick={() => setFilter(k)}>{lb} {counts[k]}</Chip>
        ))}
        <span style={{ flex: 1 }} />
        {confirmRecolor ? (
          <>
            <Button size="xs" variant="primary" onClick={() => { recolorAll(); setConfirmRecolor(false) }}>确认重配色</Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmRecolor(false)}>取消</Button>
          </>
        ) : (
          <Button size="xs" variant="ghost" icon={<Palette size={12} />} onClick={() => setConfirmRecolor(true)}
            title="按调色板给本图全部标注重新分配互不相同的颜色（会覆盖已手动选择的颜色）">自动配色</Button>
        )}
      </div>
      <div className="anno-list">
        {shown.map(a => {
          const on = selectedId === a.id
          const isAlign = a.atype === 'align'
          const isSeg = a.tool === 'segment'
          const swatch = isAlign ? COLORS.align : a.color
          return (
            <div key={a.id} className={`anno${on ? ' on' : ''}`} onClick={() => select(on ? null : a.id)}>
              <div className="head">
                <span className="sw" style={{ background: swatch }} />
                <span className="label" onDoubleClick={e => { e.stopPropagation(); setEditing(a.id); setDraft(a.label) }}>
                  {editing === a.id ? (
                    <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
                      onBlur={() => commitLabel(a)}
                      onKeyDown={e => { if (e.key === 'Enter') commitLabel(a); if (e.key === 'Escape') setEditing(null) }}
                      onClick={e => e.stopPropagation()} />
                  ) : a.label}
                </span>
                {a.desc_text && <Badge tone="amber" title="已图文关联"><Link2 size={10} /></Badge>}
                <Badge mono outline>{ATYPE_LABEL[a.atype] ?? a.atype}</Badge>
              </div>
              <div className="meta">
                {a.value != null && <span className="val">{fmtValue(a.value, a.unit, a.atype)}</span>}
                {isSeg && <span>机器候选</span>}
                <span>{fmtTime(a.created_at)}</span>
              </div>
              {a.note && !isSeg && <div className="note">{a.note}</div>}
              {isAlign && on && <div className="note" style={{ color: 'var(--green)' }}>已按此记录应用叠加，透明度在左侧「图层」调节</div>}
              {on && (
                <div className="ops" onClick={e => e.stopPropagation()}>
                  {is2d && !isAlign && (
                    <Button size="xs" icon={<Crosshair size={12} />} onClick={() => flyTo(a.id)} title="视图定位到该标注">定位</Button>
                  )}
                  <Button size="xs" icon={<Pencil size={12} />} onClick={() => { setEditing(a.id); setDraft(a.label) }}>改名</Button>
                  {!isAlign && (
                    <span className="swatches" title="标注颜色">
                      {PALETTE.map(c => (
                        <button key={c} className={a.color === c ? 'on' : ''} style={{ background: c }}
                          onClick={() => update(a.id, { color: c })} aria-label={c} />
                      ))}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  {confirmDel === a.id ? (
                    <>
                      <Button size="xs" variant="danger" onClick={() => { remove(a.id); setConfirmDel(null) }}>确认删除</Button>
                      <Button size="xs" variant="ghost" onClick={() => setConfirmDel(null)}>取消</Button>
                    </>
                  ) : (
                    <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} onClick={() => setConfirmDel(a.id)} title="删除（Del）">删除</Button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
