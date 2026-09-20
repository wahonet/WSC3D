import { useMemo, useState } from 'react'
import { Crosshair, SquareDashed, Trash2 } from 'lucide-react'
import { ATYPE_LABEL } from '../../lib/constants'
import { fmtValue } from '../../lib/format'
import { isStructural } from '../../lib/tree'
import { useApp } from '../../store/useApp'
import type { Annotation } from '../../types'
import { Badge, Button, Empty } from '../ui'
import AnnotationForm from './AnnotationForm'

export default function NodeDetail() {
  const stoneAnnos = useApp(s => s.stoneAnnos)
  const annos = useApp(s => s.annos)
  const selectedId = useApp(s => s.selectedId)
  const multiSel = useApp(s => s.multiSel)
  const a = useMemo(() => stoneAnnos.find(x => x.id === selectedId) ?? annos.find(x => x.id === selectedId) ?? null,
    [stoneAnnos, annos, selectedId])
  if (multiSel.length > 1) return <Empty title={`已多选 ${multiSel.length} 个节点`} />
  if (!a) return <Empty icon={<SquareDashed size={22} />} title="请选择一个区域" />
  return isStructural(a) ? <AnnotationForm key={a.id} annotation={a} /> : <RecordDetail key={a.id} a={a} />
}

/* ------------------------------------------------------------------ 测量 / 对齐记录 */
function RecordDetail({ a }: { a: Annotation }) {
  const update = useApp(s => s.updateAnnotation)
  const remove = useApp(s => s.removeAnnotation)
  const flyTo = useApp(s => s.flyToAnnotation)
  const [label, setLabel] = useState(a.label)
  const [confirmDel, setConfirmDel] = useState(false)
  const isAlign = a.atype === 'align'
  return (
    <div className="ndetail">
      <div className="nd-head">
        <span className="sw" style={{ background: a.color }} />
        <input className="nd-label" value={label} onChange={e => setLabel(e.target.value)}
          onBlur={() => { const v = label.trim(); if (v && v !== a.label) update(a.id, { label: v }) }} />
        <Badge mono outline>{ATYPE_LABEL[a.atype] ?? a.atype}</Badge>
      </div>
      <div className="nd-row">
        <span className="nd-k">数值</span>
        <span className="mono">{fmtValue(a.value, a.unit, a.atype) || '—'}</span>
      </div>
      {isAlign && <div className="hint">对齐记录：在「对齐」模块左下可重新叠加查看配准效果。</div>}
      <div className="nd-row" style={{ justifyContent: 'flex-end' }}>
        {!isAlign && a.atype !== 'point3d' && a.atype !== 'line3d' && <Button size="xs" icon={<Crosshair size={12} />} onClick={() => flyTo(a.id)}>定位</Button>}
        {confirmDel ? (
          <>
            <Button size="xs" variant="danger" onClick={() => { remove(a.id); setConfirmDel(false) }}>确认删除</Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmDel(false)}>取消</Button>
          </>
        ) : <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} onClick={() => setConfirmDel(true)}>删除</Button>}
      </div>
    </div>
  )
}
