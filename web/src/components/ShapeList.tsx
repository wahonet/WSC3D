import { useMemo, useState } from 'react'
import { ArrowRight, Check, Crosshair, Shapes, Trash2 } from 'lucide-react'
import { ATYPE_LABEL, LEVEL_SHORT } from '../lib/constants'
import { fmtTime } from '../lib/format'
import { isStructural } from '../lib/tree'
import { useApp } from '../store/useApp'
import { Badge, Button, Chip, Empty } from './ui'

type Filter = 'all' | 'candidate' | 'manual'

/**
 * 分割模块右栏：当前图上已切出的实体（形状），按新旧排列。
 * 这里只管"有没有 / 要不要"，命名与语义到「标注」模块填写。
 */
export default function ShapeList() {
  const asset = useApp(s => s.curAsset)
  const annos = useApp(s => s.annos)
  const selectedId = useApp(s => s.selectedId)
  const select = useApp(s => s.select)
  const flyTo = useApp(s => s.flyToAnnotation)
  const update = useApp(s => s.updateAnnotation)
  const remove = useApp(s => s.removeAnnotation)
  const removeMany = useApp(s => s.removeAnnotations)
  const setPage = useApp(s => s.setPage)
  const [filter, setFilter] = useState<Filter>('all')
  const [confirmDel, setConfirmDel] = useState<number | 'cands' | null>(null)

  const shapes = useMemo(() => annos.filter(a => isStructural(a) && a.atype !== 'none').sort((x, y) => y.id - x.id), [annos])
  const cands = shapes.filter(a => a.review_status === 'candidate')
  const shown = filter === 'all' ? shapes : filter === 'candidate' ? cands : shapes.filter(a => a.review_status !== 'candidate')
  const selected = shapes.find(a => a.id === selectedId)

  if (!asset) return <Empty icon={<Shapes size={22} />} title="暂无对象">打开一张照片或拓片后，这里列出它上面切出的实体</Empty>
  if (shapes.length === 0) return <Empty icon={<Shapes size={22} />} title="这张图上还没有实体">用左侧的 矩形 / 圆形 / 多边形 / 点 绘制，或用 SAM 分割后保存候选</Empty>

  return (
    <div className="shapes">
      <div className="anno-filters">
        <Chip size="sm" on={filter === 'all'} onClick={() => setFilter('all')}>全部 {shapes.length}</Chip>
        {cands.length > 0 && <Chip size="sm" on={filter === 'candidate'} onClick={() => setFilter('candidate')}>候选 {cands.length}</Chip>}
        <Chip size="sm" on={filter === 'manual'} onClick={() => setFilter('manual')}>已确认 {shapes.length - cands.length}</Chip>
        <span style={{ flex: 1 }} />
        {cands.length > 0 && (confirmDel === 'cands' ? (
          <>
            <Button size="xs" variant="danger" onClick={() => { removeMany(cands.map(c => c.id)); setConfirmDel(null) }}>确认删 {cands.length} 条</Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmDel(null)}>取消</Button>
          </>
        ) : <Button size="xs" variant="ghost" icon={<Trash2 size={11} />} onClick={() => setConfirmDel('cands')} title="删除本图全部机器候选">清空候选</Button>)}
      </div>
      <div className="anno-list">
        {shown.map(a => {
          const on = selectedId === a.id
          const isCand = a.review_status === 'candidate'
          return (
            <div key={a.id} className={`anno${on ? ' on' : ''}`} onClick={() => select(on ? null : a.id)}>
              <div className="head">
                <span className="sw" style={{ background: a.color }} />
                <span className={`lv${a.level ? '' : ' none'}`} title="层级">{LEVEL_SHORT[a.level] ?? '?'}</span>
                <span className="label">{a.label}</span>
                {isCand && <Badge tone="cyan">候选</Badge>}
                <Badge mono outline>{ATYPE_LABEL[a.atype] ?? a.atype}</Badge>
              </div>
              <div className="meta">
                <span>{a.tool === 'segment' ? 'SAM' : '手绘'}</span>
                {a.parent_id != null && <span>已归类</span>}
                <span>{fmtTime(a.created_at)}</span>
              </div>
              {on && (
                <div className="ops" onClick={e => e.stopPropagation()}>
                  <Button size="xs" icon={<Crosshair size={12} />} onClick={() => flyTo(a.id)}>定位</Button>
                  {isCand && <Button size="xs" variant="primary" icon={<Check size={12} />} onClick={() => update(a.id, { review_status: 'reviewed' })} title="确认为实体（R）">确认</Button>}
                  <span style={{ flex: 1 }} />
                  {confirmDel === a.id ? (
                    <>
                      <Button size="xs" variant="danger" onClick={() => { remove(a.id); setConfirmDel(null) }}>确认删除</Button>
                      <Button size="xs" variant="ghost" onClick={() => setConfirmDel(null)}>取消</Button>
                    </>
                  ) : <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} onClick={() => setConfirmDel(a.id)}>删除</Button>}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="shapes-foot">
        <Button size="sm" variant="primary" icon={<ArrowRight size={13} />} onClick={() => setPage('annotate')} block>
          {selected ? `去标注「${selected.label}」` : '去标注模块'}
        </Button>
      </div>
    </div>
  )
}
