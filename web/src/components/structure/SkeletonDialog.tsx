import { useEffect, useMemo, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { skeletonCreate, skeletonPreview } from '../../api'
import { LEVEL_SHORT } from '../../lib/constants'
import { useApp } from '../../store/useApp'
import { toast } from '../../store/useToast'
import type { SkeletonItem } from '../../types'
import { Badge, Button, Spinner } from '../ui'

/**
 * 从释文生成骨架：后端解析出 整石 / 花纹带 / 层 / 场景 / 人物 / 榜题 清单，
 * 这里预览、勾选、改名后创建（节点先无几何，之后在图上绘制或并入候选）。
 */
export default function SkeletonDialog({ stoneId, onClose }: { stoneId: number; onClose: () => void }) {
  const refreshAnnos = useApp(s => s.refreshAnnos)
  const [items, setItems] = useState<SkeletonItem[] | null>(null)
  const [assetId, setAssetId] = useState<number | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    skeletonPreview(stoneId).then(r => {
      setItems(r.items)
      setAssetId(r.asset_id)
      setChecked(new Set(r.items.filter(i => !i.exists).map(i => i.key)))
    }).catch(e => { toast.error(e); onClose() })
  }, [stoneId, onClose])

  const depthOf = useMemo(() => {
    const m = new Map((items ?? []).map(i => [i.key, i]))
    return (it: SkeletonItem) => {
      let d = 0
      let k = it.parent_key
      while (k && m.has(k)) { d++; k = m.get(k)!.parent_key }
      return d
    }
  }, [items])

  const toggle = (key: string) => setChecked(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n })
  /** 勾选 / 取消一个节点连同它的子树 */
  const toggleSubtree = (root: SkeletonItem, on: boolean) => {
    if (!items) return
    const kids = new Map<string, string[]>()
    for (const it of items) if (it.parent_key) (kids.get(it.parent_key) ?? kids.set(it.parent_key, []).get(it.parent_key)!).push(it.key)
    const keys: string[] = []
    const stack = [root.key]
    while (stack.length) { const k = stack.pop()!; keys.push(k); stack.push(...(kids.get(k) ?? [])) }
    setChecked(prev => { const n = new Set(prev); for (const k of keys) { if (on) n.add(k); else n.delete(k) } return n })
  }
  const setAll = (mode: 'all' | 'none' | 'new' | 'containers') => {
    if (!items) return
    if (mode === 'all') setChecked(new Set(items.map(i => i.key)))
    else if (mode === 'none') setChecked(new Set())
    else if (mode === 'new') setChecked(new Set(items.filter(i => !i.exists).map(i => i.key)))
    else setChecked(new Set(items.filter(i => !i.exists && ['whole', 'band', 'layer', 'scene'].includes(i.level)).map(i => i.key)))
  }

  const create = async () => {
    if (!items) return
    const pick = items.filter(i => checked.has(i.key)).map(i => ({ ...i, label: (labels[i.key] ?? i.label).trim() || i.label }))
    if (pick.length === 0) return
    setBusy(true)
    try {
      const r = await skeletonCreate(stoneId, pick, assetId)
      await refreshAnnos()
      toast.ok(`已创建 ${r.created} 个节点，其中 ${r.linked} 个已关联释文${r.skipped_links.length ? `；${r.skipped_links.length} 处关联因重叠跳过` : ''}`)
      onClose()
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const it of items ?? []) if (checked.has(it.key)) c[it.level] = (c[it.level] ?? 0) + 1
    return c
  }, [items, checked])

  return (
    <div className="modal-mask" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal skeleton">
        <div className="modal-h">
          <Sparkles size={15} />
          <b>从释文生成骨架</b>
          <span className="hint" style={{ marginLeft: 8 }}>
            按"一则 / 二则"识别场景，"首刻 / 次一人"识别人物，"数词 + 名词"枚举物象，引号内为榜题录文。
            节点先没有几何：创建后选中节点、在图上绘制即挂接，或把 SAM 候选拖到节点上"并入几何"。
          </span>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={onClose} />
        </div>
        {!items ? <div className="modal-b" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Spinner />解析释文…</div> : (
          <>
            <div className="modal-tools">
              <span className="hint">勾选：</span>
              <Button size="xs" variant="ghost" onClick={() => setAll('new')}>全部新节点</Button>
              <Button size="xs" variant="ghost" onClick={() => setAll('containers')}>只要整石 / 层 / 场景</Button>
              <Button size="xs" variant="ghost" onClick={() => setAll('all')}>全选</Button>
              <Button size="xs" variant="ghost" onClick={() => setAll('none')}>全不选</Button>
              <span style={{ flex: 1 }} />
              <span className="hint">
                {Object.entries(counts).map(([lv, n]) => <span key={lv} style={{ marginLeft: 8 }}>{LEVEL_SHORT[lv] ?? lv} <b>{n}</b></span>)}
              </span>
            </div>
            <div className="modal-b skeleton-list">
              {items.map(it => {
                const d = depthOf(it)
                const on = checked.has(it.key)
                return (
                  <div key={it.key} className={`sk-row${on ? '' : ' off'}${it.exists ? ' exists' : ''}`} style={{ paddingLeft: 8 + d * 16 }}>
                    <input type="checkbox" checked={on} onChange={() => toggle(it.key)}
                      onDoubleClick={e => { e.preventDefault(); toggleSubtree(it, !on) }}
                      title="双击 = 连同子树一起勾选 / 取消" />
                    <span className={`lv${it.level ? '' : ' none'}`}>{LEVEL_SHORT[it.level] ?? '?'}</span>
                    <input className="sk-label" value={labels[it.key] ?? it.label}
                      onChange={e => setLabels(l => ({ ...l, [it.key]: e.target.value }))} />
                    {it.exists && <Badge tone="amber" title="石头上已有同名节点，默认不再创建">已存在</Badge>}
                    {it.desc_start != null && <Badge tone="green" title="创建后自动关联到这段释文">释文</Badge>}
                    {it.transcription && <Badge mono outline title={it.transcription}>录文</Badge>}
                    {it.concept_names.length > 0 && <span className="hint mono" title="将尝试匹配概念">{it.concept_names.slice(0, 2).join(' · ')}</span>}
                    <span className="sk-ex" title={it.excerpt}>{it.excerpt}</span>
                  </div>
                )
              })}
            </div>
            <div className="modal-f">
              <span className="hint">共 {items.length} 项，已勾选 {checked.size} 项 · 名称可直接改；创建后仍可在结构树中改名、移动、删除</span>
              <span style={{ flex: 1 }} />
              <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
              <Button size="sm" variant="primary" disabled={busy || checked.size === 0} onClick={create}>
                {busy ? <Spinner /> : `创建 ${checked.size} 个节点`}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
