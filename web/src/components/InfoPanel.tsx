import { useEffect, useMemo, useState } from 'react'
import { Landmark, Link2, Pencil, Save, X } from 'lucide-react'
import { patchLayer, patchStone } from '../api'
import { useApp } from '../store/useApp'
import { toast } from '../store/useToast'
import TextArticle, { buildSources, joinArticle, splitArticle, type PendingSel } from './library/TextArticle'
import { Badge, Button, Empty, Field } from './ui'

type Fields = { dims_text: string; era: string; material: string; carving: string; location: string }
const FIELD_LABELS: [keyof Fields, string][] = [
  ['dims_text', '尺寸'], ['era', '年代'], ['material', '材质'], ['carving', '刻法'], ['location', '收藏'],
]

/**
 * 文献模块右栏：顶部固定的关联操作栏 + 可滚动正文（石头信息折叠块、释文全文）。
 * 释文是目前唯一的"文献"，来自著录原书人工录入；总述与各层连成一篇阅读，整篇一个文本框编辑。
 * 选中节点后在正文里拖选一段文字 → 顶部「关联到本节点」；已关联文字按节点颜色高亮并锁定。
 */
export default function InfoPanel() {
  const info = useApp(s => s.stoneInfo)
  const stoneAnnos = useApp(s => s.stoneAnnos)
  const selectedId = useApp(s => s.selectedId)
  const select = useApp(s => s.select)
  const flyTo = useApp(s => s.flyToAnnotation)
  const update = useApp(s => s.updateAnnotation)
  const refreshStoneInfo = useApp(s => s.refreshStoneInfo)
  const refreshAnnos = useApp(s => s.refreshAnnos)

  const [pending, setPending] = useState<PendingSel | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [fields, setFields] = useState<Fields>({ dims_text: '', era: '', material: '', carving: '', location: '' })
  const [fieldsDirty, setFieldsDirty] = useState(false)

  useEffect(() => {
    if (!info) return
    setFields({ dims_text: info.dims_text, era: info.era, material: info.material, carving: info.carving, location: info.location })
    setFieldsDirty(false)
  }, [info])

  const sources = useMemo(() => (info ? buildSources(info) : []), [info])
  const links = useMemo(() => stoneAnnos.filter(a => a.desc_text && a.desc_start != null), [stoneAnnos])
  const selected = selectedId != null ? stoneAnnos.find(a => a.id === selectedId) ?? null : null

  if (!info) return <Empty icon={<Landmark size={22} />} title="未选择画像石">先在首页选择一块画像石</Empty>

  const setF = (k: keyof Fields, v: string) => { setFields(f => ({ ...f, [k]: v })); setFieldsDirty(true) }
  const saveFields = async () => {
    try {
      await patchStone(info.id, fields)
      await refreshStoneInfo()
      toast.ok('石头信息已保存')
    } catch (e) { toast.error(e) }
  }

  const startEdit = () => { setDraft(joinArticle(sources)); setEditing(true); setPending(null); window.getSelection()?.removeAllRanges() }
  const cancelEdit = () => setEditing(false)
  const saveArticle = async () => {
    const r = splitArticle(draft, sources)
    if (!r.ok) { toast.warn(r.error); return }
    setSaving(true)
    try {
      for (const p of r.parts) {
        const src = sources.find(s => s.key === p.key)
        if (!src) continue
        const nameChanged = p.name != null && p.name !== src.name
        if (p.text === src.text && !nameChanged) continue
        if (p.key === 'description') await patchStone(info.id, { description: p.text })
        else await patchLayer(info.id, Number(p.key.split(':')[1]), p.text, nameChanged ? p.name : undefined)
      }
      await refreshStoneInfo()
      await refreshAnnos()
      setEditing(false)
      toast.ok('释文已保存')
    } catch (e) { toast.error(e) } finally { setSaving(false) }
  }

  const doLink = async () => {
    if (!selected || !pending) return
    const r = await update(selected.id, { desc_source: pending.source, desc_start: pending.start, desc_end: pending.end, desc_text: pending.text })
    if (r) {
      setPending(null)
      window.getSelection()?.removeAllRanges()
      toast.ok(`已把这段释文关联到「${selected.label}」`)
    }
  }
  const dropPending = () => { setPending(null); window.getSelection()?.removeAllRanges() }
  const excerpt = (t: string) => (t.length > 22 ? t.slice(0, 22) + '…' : t)

  return (
    <div className="libpane">
      {/* ---------- 顶部固定：关联操作 + 全文编辑 ---------- */}
      <div className="lib-top">
        <div className="lib-link">
          {editing ? (
            <span className="hint">正在编辑全文；保存后再做关联</span>
          ) : pending ? (
            <>
              <Link2 size={13} className="muted" />
              <span className="lib-sel">已选 <b>{pending.text.length}</b> 字：<q>{excerpt(pending.text)}</q></span>
              {selected
                ? <Button size="sm" variant="primary" onClick={doLink}>关联到「{excerpt(selected.label)}」</Button>
                : <span className="hint">（先在左侧树或图上选中一个节点）</span>}
              <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={dropPending} title="放弃选区" />
            </>
          ) : selected ? (
            <>
              <span className="sw" style={{ background: selected.color }} />
              <span className="lib-sel">节点「<b>{excerpt(selected.label)}</b>」</span>
              {selected.desc_text
                ? <Badge tone="amber">已关联 {selected.desc_text.length} 字</Badge>
                : <span className="hint">在下方释文里拖选一段文字，这里会出现「关联」按钮</span>}
              {selected.desc_text && (
                <Button size="xs" variant="ghost" onClick={() => update(selected.id, { clear_link: true })} title="解除关联，文字恢复可编辑">解除</Button>
              )}
            </>
          ) : (
            <span className="hint">先在左侧结构树或图上选中一个节点，再在下方释文里拖选文字关联</span>
          )}
        </div>
        <span style={{ flex: 1 }} />
        {editing ? (
          <>
            <Button size="sm" variant="primary" icon={<Save size={13} />} onClick={saveArticle} disabled={saving}>{saving ? '保存中…' : '保存全文'}</Button>
            <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>取消</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" icon={<Pencil size={12} />} onClick={startEdit} title="整篇编辑总述与各层释文">编辑全文</Button>
        )}
      </div>

      {/* ---------- 正文（滚动） ---------- */}
      <div className="lib-body">
        <details className="lib-meta">
          <summary>
            <b>{info.name}</b>
            <span className="mono muted">{info.code}</span>
            <span className="muted truncate">{[info.era, info.dims_text].filter(Boolean).join(' · ') || '（尺寸 / 年代未填）'}</span>
          </summary>
          <div className="rfields" style={{ marginTop: 8 }}>
            {FIELD_LABELS.map(([k, lb]) => (
              <Field key={k} label={lb}>
                <input className="input sm" value={fields[k]} onChange={e => setF(k, e.target.value)} />
              </Field>
            ))}
          </div>
          {fieldsDirty && (
            <div className="rrow" style={{ marginTop: 8 }}>
              <Button size="sm" variant="primary" icon={<Save size={13} />} onClick={saveFields}>保存信息</Button>
              <Button size="sm" variant="ghost" onClick={() => refreshStoneInfo()}>放弃修改</Button>
            </div>
          )}
        </details>

        <TextArticle sources={sources} links={links} selectedId={selectedId}
          onPending={setPending} onSelectAnno={id => { select(id); flyTo(id) }} onError={toast.warn}
          editing={editing} draft={draft} onDraft={setDraft} />
      </div>
    </div>
  )
}
