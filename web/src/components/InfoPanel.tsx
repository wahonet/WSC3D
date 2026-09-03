import { useEffect, useMemo, useState } from 'react'
import { Landmark, Save } from 'lucide-react'
import { patchLayer, patchStone } from '../api'
import { useApp } from '../store/useApp'
import { toast } from '../store/useToast'
import TextCard, { buildSources, type PendingSel } from './research/TextCard'
import { Button, Empty, Field } from './ui'

type Fields = { dims_text: string; era: string; material: string; carving: string; location: string }
const FIELD_LABELS: [keyof Fields, string][] = [
  ['dims_text', '尺寸'], ['era', '年代'], ['material', '材质'], ['carving', '刻法'], ['location', '收藏'],
]

/**
 * 文献模块右栏：石头元数据（可编辑）+ 总述 / 分层释文。
 * 释文可直接拖选文字关联到当前选中的结构节点（已关联文字按节点颜色高亮并锁定）。
 * 释文即当前的"文献"：来自著录原书，后续文献库模块会把 PDF / OCR 的文段也接进来。
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
  const saveText = async (sourceKey: string, text: string) => {
    try {
      if (sourceKey === 'description') await patchStone(info.id, { description: text })
      else await patchLayer(info.id, Number(sourceKey.split(':')[1]), text)
      await refreshStoneInfo()
      await refreshAnnos()
      toast.ok('已保存')
      return true
    } catch (e) { toast.error(e); return false }
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

  return (
    <div className="info">
      <div className="info-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>{info.name}</h2>
          <div className="code">{info.code} · {info.asset_count} 件素材 · {info.annotation_count} 条标注</div>
        </div>
      </div>

      <div className="rfields">
        {FIELD_LABELS.map(([k, lb]) => (
          <Field key={k} label={lb}>
            <input className="input sm" value={fields[k]} onChange={e => setF(k, e.target.value)} />
          </Field>
        ))}
      </div>
      {fieldsDirty && (
        <div className="rrow" style={{ marginTop: 0 }}>
          <Button size="sm" variant="primary" icon={<Save size={13} />} onClick={saveFields}>保存信息</Button>
          <Button size="sm" variant="ghost" onClick={() => refreshStoneInfo()}>放弃修改</Button>
        </div>
      )}

      <TextCard sources={sources} links={links} selectedId={selectedId} selectedLabel={selected?.label ?? null}
        pending={pending} onPending={setPending} onSelectAnno={id => { select(id); flyTo(id) }}
        onSave={saveText} onLink={doLink} onError={toast.warn} />
    </div>
  )
}
