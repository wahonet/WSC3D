import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, RotateCw, Search, X } from 'lucide-react'
import { videoApi, type SourceAnnotation, type SourceGroups, type SourcePage } from '../lib/videoApi'
import './AnnotationSourcePicker.css'

export type AnnotationSelection = { stone_id: string; asset_id: number; annotation_ids: number[] }
export const emptySelection: AnnotationSelection = { stone_id: '', asset_id: 0, annotation_ids: [] }
const shapes: Record<string, string> = { rect: '框选', ellipse: '椭圆', polygon: '分割' }
const pageSize = 24

export default function AnnotationSourcePicker({ value, onChange, disabled = false, onRefresh }: {
  value: AnnotationSelection; onChange: (next: AnnotationSelection) => void; disabled?: boolean; onRefresh?: () => void
}) {
  const [groups, setGroups] = useState<SourceGroups>([])
  const [query, setQuery] = useState(''), [stoneId, setStoneId] = useState(value.stone_id), [assetId, setAssetId] = useState(value.asset_id)
  const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0)
  const [page, setPage] = useState<SourcePage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [selected, setSelected] = useState<SourceAnnotation[]>([])
  const list = useRef<HTMLDivElement>(null), changeRef = useRef(onChange), refreshRef = useRef(onRefresh)
  changeRef.current = onChange; refreshRef.current = onRefresh
  const idsKey = [...value.annotation_ids].sort((a, b) => a - b).join(',')
  const refresh = () => { setRevision(v => v + 1); refreshRef.current?.() }
  useEffect(() => {
    const focus = () => { if (!disabled) refresh() }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [disabled])
  useEffect(() => {
    const controller = new AbortController()
    videoApi.sourceGroups(controller.signal).then(setGroups).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [revision])
  useEffect(() => {
    if (!idsKey) { setSelected([]); return }
    const controller = new AbortController()
    videoApi.annotations({ ids: idsKey.split(',').map(Number), limit: 20 }, controller.signal).then(result => {
      setSelected(result.items)
      const first = result.items[0]
      const ids = result.items.filter(n => n.asset_id === first?.asset_id).map(n => n.id)
      if (ids.length !== idsKey.split(',').length) changeRef.current(first ? { stone_id: first.stone_id, asset_id: first.asset_id, annotation_ids: ids } : emptySelection)
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [idsKey, revision])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    const timer = window.setTimeout(() => {
      videoApi.annotations({ q: query, stone_id: stoneId, asset_id: assetId || undefined, offset, limit: pageSize }, controller.signal)
        .then(result => {
          if (controller.signal.aborted) return
          if (offset && !result.items.length && result.total <= offset) { setOffset(Math.max(0, Math.ceil(result.total / pageSize) - 1) * pageSize); return }
          setPage(result); list.current?.scrollTo({ top: 0 })
        }).catch(reason => { if (!controller.signal.aborted) { setPage(null); setError(reason.message) } })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 220)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [query, stoneId, assetId, offset, revision])
  const choose = (node: SourceAnnotation) => {
    const ids = value.annotation_ids.includes(node.id) ? value.annotation_ids.filter(id => id !== node.id)
      : [...(value.asset_id === node.asset_id ? value.annotation_ids : []), node.id]
    setSelected(previous => ids.map(id => id === node.id ? node : previous.find(n => n.id === id)).filter((n): n is SourceAnnotation => !!n))
    onChange({ stone_id: node.stone_id, asset_id: node.asset_id, annotation_ids: ids })
  }
  const assets = groups.find(stone => stone.id === stoneId)?.assets || []
  return <div className="annotation-source-picker">
    <div className="source-picker-heading"><span>选择标注</span><button type="button" disabled={disabled || loading} onClick={refresh} title="刷新标注" aria-label="刷新标注"><RotateCw size={14} /></button></div>
    <div className="source-picker-search"><Search size={15} /><input aria-label="搜索标注" placeholder="搜索标注、概念或画像石" value={query} maxLength={120} disabled={disabled} onChange={event => { setQuery(event.target.value); setOffset(0) }} />{query && <button type="button" aria-label="清除搜索" disabled={disabled} onClick={() => { setQuery(''); setOffset(0) }}><X size={14} /></button>}</div>
    <div className="source-picker-filters">
      <select aria-label="画像石" value={stoneId} disabled={disabled} onChange={event => { setStoneId(event.target.value); setAssetId(0); setOffset(0) }}><option value="">全部画像石</option>{groups.map(stone => <option key={stone.id} value={stone.id}>{stone.id} · {stone.name}</option>)}</select>
      <select aria-label="底图" value={assetId} disabled={disabled || !stoneId} onChange={event => { setAssetId(Number(event.target.value)); setOffset(0) }}><option value={0}>全部底图</option>{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.filename}</option>)}</select>
    </div>
    {!!value.annotation_ids.length && <div className="source-picker-selected"><div><span>已选 {value.annotation_ids.length} / 20</span><button type="button" disabled={disabled} onClick={() => onChange(emptySelection)}>清空</button></div><div>{value.annotation_ids.map(id => <button type="button" key={id} disabled={disabled} title="移除选择" onClick={() => onChange({ ...value, annotation_ids: value.annotation_ids.filter(n => n !== id) })}>{selected.find(n => n.id === id)?.label || `#${id}`}<X size={11} /></button>)}</div></div>}
    <div ref={list} className="source-picker-list" role="group" aria-label="标注列表" aria-busy={loading}>
      {!loading && page?.items.map(node => <label key={node.id} className={'source-picker-row' + (value.annotation_ids.includes(node.id) ? ' selected' : '')}>
        <input type="checkbox" checked={value.annotation_ids.includes(node.id)} disabled={disabled || (!value.annotation_ids.includes(node.id) && value.asset_id === node.asset_id && value.annotation_ids.length >= 20)} onChange={() => choose(node)} />
        <span><strong>{node.label}</strong><small title={node.filename}>{node.stone_id} · {node.stone_name}</small><small>#{node.id} · {shapes[node.atype]} · {node.review_status === 'candidate' ? '候选' : '已审'}</small></span>
      </label>)}
      {(loading || !page?.items.length) && <div className="source-picker-empty" role="status">{loading ? '读取标注…' : error || '未找到标注'}</div>}
    </div>
    <div className="source-picker-pagination"><span>{page?.total ? `${page.offset + 1}–${Math.min(page.offset + page.limit, page.total)} / ${page.total}` : '0 条'}</span><div><button type="button" aria-label="上一页标注" disabled={disabled || loading || !offset} onClick={() => setOffset(offset - pageSize)}><ChevronLeft size={15} /></button><button type="button" aria-label="下一页标注" disabled={disabled || loading || !page || offset + pageSize >= page.total} onClick={() => setOffset(offset + pageSize)}><ChevronRight size={15} /></button></div></div>
  </div>
}
