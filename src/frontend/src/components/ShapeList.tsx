import { useMemo, useState } from 'react'
import { ArrowRight, Crosshair, Shapes, Trash2 } from 'lucide-react'
import { ATYPE_LABEL, LEVEL_SHORT } from '../lib/constants'
import { fmtTime } from '../lib/format'
import { annotationLabel, isStructural } from '../lib/tree'
import { imageBadge } from '../lib/imageBadge'
import { useApp } from '../store/useApp'
import { Badge, Button, Chip, Empty, onEnterSpace } from './ui'

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
  const remove = useApp(s => s.removeAnnotation)
  const removeMany = useApp(s => s.removeAnnotations)
  const setPage = useApp(s => s.setPage)
  const [filter, setFilter] = useState<Filter>('all')
  const [confirmDel, setConfirmDel] = useState<number | 'cands' | null>(null)
  // 与结构标注、查看与测量共用的「其他影像」开关：默认只列本图实体，切换影像时自动恢复
  const stone = useApp(s => s.curStone)
  const stoneAnnos = useApp(s => s.stoneAnnos)
  const projOn = useApp(s => s.projOn)
  const projItems = useApp(s => s.projItems)
  const projReason = useApp(s => s.projReason)
  const toggleProj = useApp(s => s.toggleProj)

  const shapes = useMemo(() => annos.filter(a => isStructural(a) && a.atype !== 'none').sort((x, y) => y.id - x.id), [annos])
  const cands = shapes.filter(a => a.review_status === 'candidate')
  const shown = filter === 'all' ? shapes : filter === 'candidate' ? cands : shapes.filter(a => a.review_status !== 'candidate')
  const selected = shapes.find(a => a.id === selectedId)
  const otherCount = useMemo(() => asset ? stoneAnnos.filter(a => isStructural(a) && a.asset_id !== asset.id && a.atype !== 'none').length : 0, [stoneAnnos, asset])
  const assets = useMemo(() => new Map((stone?.groups ?? []).flatMap(g => g.assets).map(a => [a.id, a])), [stone])
  const others = projOn ? projItems.filter(p => filter === 'all' || (filter === 'candidate') === (p.review_status === 'candidate')) : []

  if (!asset) return <Empty icon={<Shapes size={22} />} title="暂无对象">打开一张照片或拓片后，这里列出它上面切出的实体</Empty>
  if (shapes.length === 0 && !otherCount) return <Empty icon={<Shapes size={22} />} title="这张图上还没有实体">用左侧的 矩形 / 圆形 / 多边形 / 点 绘制，或用 SAM 分割后保存候选</Empty>

  return (
    <div className="shapes">
      <div className="anno-filters">
        <Chip size="sm" on={filter === 'all'} onClick={() => setFilter('all')}>全部 {shapes.length}</Chip>
        {cands.length > 0 && <Chip size="sm" on={filter === 'candidate'} onClick={() => setFilter('candidate')}>候选 {cands.length}</Chip>}
        <Chip size="sm" on={filter === 'manual'} onClick={() => setFilter('manual')}>已审 {shapes.length - cands.length}</Chip>
        {otherCount > 0 && <Chip size="sm" on={projOn} onClick={() => void toggleProj(!projOn)}
          title={projOn ? '只看本图实体' : '同时列出本石其他照片、拓片上的实体，并在图上以点划线投影显示'}>其他影像 {otherCount}</Chip>}
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
            <div key={a.id} className={`anno${on ? ' on' : ''}`} tabIndex={0} aria-current={on || undefined}
              onClick={() => select(on ? null : a.id)} onKeyDown={onEnterSpace(() => select(on ? null : a.id))}>
              <div className="head">
                <span className="sw" style={{ background: a.color }} />
                <span className={`lv${a.level ? '' : ' none'}`} title="层级">{LEVEL_SHORT[a.level] ?? '?'}</span>
                <span className="label">{annotationLabel(a)}</span>
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
        {shapes.length === 0 && !projOn && <div className="hint" style={{ padding: '8px 10px' }}>这张图上还没有实体；打开「其他影像」可查看本石其他照片、拓片上的实体。</div>}
        {projOn && <>
          <div className="anno-section">其他影像 · 投影到本图 {others.length}</div>
          {projReason && <div className="hint" style={{ padding: '4px 10px' }}>{projReason}</div>}
          {!projReason && projItems.length === 0 && <div className="hint" style={{ padding: '4px 10px' }}>正在读取其他影像的标注…</div>}
          {projItems.length > 0 && otherCount > projItems.length && <div className="hint" style={{ padding: '4px 10px' }}>
            另有 {otherCount - projItems.length} 条所在影像未接入主图坐标链（或几何无效），无法投影到本图，可在「结构标注」树中查看。</div>}
          {others.map(p => {
            const on = selectedId === p.id
            return (
              <div key={`p${p.id}`} className={`anno other-image${on ? ' on' : ''}`} tabIndex={0} aria-current={on || undefined}
                title={`${p.source_filename}：在该影像上编辑或删除`}
                onClick={() => select(on ? null : p.id)} onKeyDown={onEnterSpace(() => select(on ? null : p.id))}>
                <div className="head">
                  <span className="sw" style={{ background: p.color }} />
                  <span className={`lv${p.level ? '' : ' none'}`} title="层级">{LEVEL_SHORT[p.level] ?? '?'}</span>
                  <span className="label">{annotationLabel(p)}</span>
                  {p.review_status === 'candidate' && <Badge tone="cyan">候选</Badge>}
                  <span className="img-badge">{imageBadge(assets.get(p.source_asset_id)) }</span>
                </div>
              </div>
            )
          })}
        </>}
      </div>
      <div className="shapes-foot">
        <Button size="sm" variant="primary" icon={<ArrowRight size={13} />} onClick={() => setPage('annotate')} block>
          {selected ? `去标注「${annotationLabel(selected)}」` : '去标注模块'}
        </Button>
      </div>
    </div>
  )
}
