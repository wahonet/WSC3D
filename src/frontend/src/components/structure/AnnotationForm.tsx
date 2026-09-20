import { useEffect, useRef, useState } from 'react'
import { Crosshair, Film, Save, Trash2 } from 'lucide-react'
import { goToSection } from '../../lib/navigation'
import { ATYPE_LABEL, PALETTE } from '../../lib/constants'
import { hasGeometry } from '../../lib/tree'
import { appendExcerpt, draftEvent, initialAnnotationDraft, type AnnotationDraft } from '../../lib/annotationDraft'
import { usePersistentDraft } from '../../hooks/usePersistentDraft'
import { useApp } from '../../store/useApp'
import { toast } from '../../store/useToast'
import type { Annotation } from '../../types'
import { Badge, Button, Field } from '../ui'
import NodeReferences from '../library/NodeReferences'
import ConceptPicker from './ConceptPicker'
import './annotation-form.css'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export default function AnnotationForm({ annotation: a }: { annotation: Annotation }) {
  const [d, setD] = usePersistentDraft<AnnotationDraft>(`node.${a.id}`, initialAnnotationDraft(a))
  const base = useRef(initialAnnotationDraft(a))
  const [saving, setSaving] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const update = useApp(s => s.updateAnnotation)
  const remove = useApp(s => s.removeAnnotation)
  const flyTo = useApp(s => s.flyToAnnotation)
  const dirty = !same({ label: d.label, color: d.color, concept_ids: d.concept_ids, semantics: d.semantics },
    { label: initialAnnotationDraft(a).label, color: a.color, concept_ids: initialAnnotationDraft(a).concept_ids, semantics: initialAnnotationDraft(a).semantics }) || !!d.reference_excerpts?.length

  useEffect(() => {
    const next = initialAnnotationDraft(a)
    const previous = base.current
    setD(current => ({
      ...current,
      label: same(current.label, previous.label) ? next.label : current.label,
      color: same(current.color, previous.color) ? next.color : current.color,
      concept_ids: same(current.concept_ids, previous.concept_ids) ? next.concept_ids : current.concept_ids,
      semantics: same(current.semantics, previous.semantics) ? next.semantics : current.semantics,
      reference_excerpts: (current.reference_excerpts || []).filter(item => a.references.some(r => r.id === item.reference_id)),
    }))
    base.current = next
  }, [a])
  useEffect(() => {
    const receive = (event: Event) => {
      const data = (event as CustomEvent<{ id: number; draft: AnnotationDraft }>).detail
      if (data.id === a.id) setD(data.draft)
    }
    window.addEventListener(draftEvent, receive)
    return () => window.removeEventListener(draftEvent, receive)
  }, [a.id])

  const save = async () => {
    if (saving) return false
    setSaving(true)
    try {
      const result = await update(a.id, {
        label: d.label.trim() || '未命名', color: d.color, concept_ids: d.concept_ids,
        semantics: d.semantics, review_status: 'reviewed',
        reference_excerpts: (d.reference_excerpts || []).filter(item => d.semantics[item.field].includes(item.text)),
      })
      if (result) { setD(initialAnnotationDraft(result)); toast.ok('已保存') }
      return !!result
    } finally { setSaving(false) }
  }
  const video = async () => {
    if (saving || (dirty && !await save())) return
    goToSection('video', { stone: a.stone_id, a: a.asset_id, video_nodes: a.id })
  }
  return <div className="ndetail annotation-form" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
  }}>
    <input className="nd-label" aria-label="名称" placeholder="名称" value={d.label}
      onChange={e => setD(current => ({ ...current, label: e.target.value }))} />
    <div className="nd-row"><span className="nd-k">几何</span><div className="nd-v">
      <Badge outline>{hasGeometry(a) ? ATYPE_LABEL[a.atype] : '无几何'}</Badge>
      {hasGeometry(a) && <Button size="xs" icon={<Crosshair size={12} />} onClick={() => flyTo(a.id)}>定位</Button>}
      {['rect', 'ellipse', 'polygon'].includes(a.atype) && hasGeometry(a) && a.review_status !== 'rejected' && <Button size="xs" icon={<Film size={12} />} disabled={saving} onClick={() => void video()}>{dirty ? '保存并生成视频' : '生成视频'}</Button>}
    </div></div>
    <div className="nd-row annotation-colors"><span className="nd-k">颜色</span><div className="annotation-palette">
      {PALETTE.map(color => <button key={color} type="button" aria-label={`颜色 ${color}`} aria-pressed={d.color === color}
        className={d.color === color ? 'on' : ''} style={{ background: color }} onClick={() => setD(current => ({ ...current, color }))} />)}
    </div></div>
    <div className="nd-row"><span className="nd-k">概念</span><ConceptPicker simple value={d.concept_ids}
      onChange={concept_ids => setD(current => ({ ...current, concept_ids }))} /></div>
    <NodeReferences annotation={a} onExcerpt={item => setD(current => appendExcerpt(current, item))} />
    <Field label="前图像志（直观描述）"><textarea className="textarea nd-ta" aria-label="前图像志（直观描述）" value={d.semantics.pre_iconographic}
      onChange={e => setD(current => ({ ...current, semantics: { ...current.semantics, pre_iconographic: e.target.value } }))} /></Field>
    <Field label="图像志（故事描述）"><textarea className="textarea nd-ta" aria-label="图像志（故事描述）" value={d.semantics.iconographic}
      onChange={e => setD(current => ({ ...current, semantics: { ...current.semantics, iconographic: e.target.value } }))} /></Field>
    <div className="nd-save">
      <span className="hint" role="status">{saving ? '保存中…' : dirty ? '候选 · 未保存' : a.review_status === 'candidate' ? '候选' : '已审 · 已保存'}</span>
      <span style={{ flex: 1 }} />
      {confirmDel ? <><Button size="xs" variant="danger" onClick={() => void remove(a.id)}>确认删除</Button><Button size="xs" variant="ghost" onClick={() => setConfirmDel(false)}>取消</Button></>
        : <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} aria-label="删除标注" onClick={() => setConfirmDel(true)} />}
      <Button size="sm" variant="primary" icon={<Save size={13} />} disabled={saving || (!dirty && a.review_status === 'reviewed')}
        onClick={() => void save()}>保存</Button>
    </div>
  </div>
}
