import { useMemo } from 'react'
import { Layers } from 'lucide-react'
import { COLORS, LEVELS, LEVEL_LABEL } from '../lib/constants'
import { isStructural } from '../lib/tree'
import { selectIs2d, selectIs3d, useApp } from '../store/useApp'
import type { Level } from '../types'
import { Chip, Range, Switch } from './ui'

/**
 * 图层面板：结构节点（按层级开关）/ 机器候选 / 节点名称 / 跨图投影 / 同石其他图的叠加。
 * 首页与各模块共用；显隐状态在 store 里，切换模块不丢。
 */
export default function LayerPanel() {
  const asset = useApp(s => s.curAsset)
  const stone = useApp(s => s.curStone)
  const annos = useApp(s => s.annos)
  const stoneAnnos = useApp(s => s.stoneAnnos)
  const overlay = useApp(s => s.overlay)
  const showAnnoLayer = useApp(s => s.showAnnoLayer)
  const showCandidates = useApp(s => s.showCandidates)
  const showLabels = useApp(s => s.showLabels)
  const hiddenLevels = useApp(s => s.hiddenLevels)
  const projOn = useApp(s => s.projOn)
  const projItems = useApp(s => s.projItems)
  const projReason = useApp(s => s.projReason)
  const is2d = useApp(selectIs2d)
  const is3d = useApp(selectIs3d)
  const setShowAnnoLayer = useApp(s => s.setShowAnnoLayer)
  const setShowCandidates = useApp(s => s.setShowCandidates)
  const setShowLabels = useApp(s => s.setShowLabels)
  const toggleLevel = useApp(s => s.toggleLevel)
  const toggleProj = useApp(s => s.toggleProj)
  const setOverlayAsset = useApp(s => s.setOverlayAsset)
  const setOverlayOpacity = useApp(s => s.setOverlayOpacity)

  const levelCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const a of stoneAnnos) if (isStructural(a) && a.review_status !== 'candidate') c[a.level] = (c[a.level] ?? 0) + 1
    return c
  }, [stoneAnnos])
  const candCount = annos.filter(a => a.review_status === 'candidate').length
    + projItems.filter(p => p.review_status === 'candidate').length
  const overlayChoices = useMemo(() => {
    if (!stone || !asset || !(asset.is_master || asset.in_frame)) return []
    return stone.groups.filter(g => g.key !== 'model').flatMap(g => g.assets)
      .filter(a => a.id !== asset.id && (a.is_master || a.in_frame))
  }, [stone, asset])

  if (!asset) return <div className="hint" style={{ padding: '10px 12px' }}>打开一件素材后，这里控制各图层的显隐。</div>
  if (is3d) return <div className="hint" style={{ padding: '10px 12px' }}>三维标注以球体标记显示；图层显隐与跨图投影目前仅覆盖 2D。</div>

  return (
    <div className="layers">
      <div className="layers-title"><Layers size={11} style={{ verticalAlign: -1, marginRight: 5 }} />图层</div>
      <div className="layer-row">
        <span className="sw" style={{ background: COLORS.amber }} />
        <span className="lbl">结构节点与测量</span>
        <Switch checked={showAnnoLayer} onChange={setShowAnnoLayer} />
      </div>
      {showAnnoLayer && (
        <div className="layer-levels">
          {LEVELS.filter(l => levelCounts[l.id]).map(l => (
            <Chip key={l.id} size="sm" on={!hiddenLevels.includes(l.id as Level)} onClick={() => toggleLevel(l.id as Level)}
              title={`${LEVEL_LABEL[l.id]} ${levelCounts[l.id]} 个`}>{l.label} {levelCounts[l.id]}</Chip>
          ))}
          {levelCounts[''] ? (
            <Chip size="sm" on={!hiddenLevels.includes('')} onClick={() => toggleLevel('')} title="尚未定层级的节点">未定 {levelCounts['']}</Chip>
          ) : null}
          {Object.keys(levelCounts).length === 0 && <span className="hint">（还没有结构节点）</span>}
        </div>
      )}
      <div className="layer-row">
        <span className="sw" style={{ background: COLORS.seg }} />
        <span className="lbl" title="SAM 等机器产生、尚未人工命名转正的候选（虚线）">机器候选（虚线）</span>
        <span className="cnt">{candCount}</span>
        <Switch checked={showCandidates} onChange={setShowCandidates} disabled={candCount === 0} />
      </div>
      <div className="layer-row">
        <span className="sw" style={{ background: 'var(--text-2)' }} />
        <span className="lbl" title="在图形左上角显示节点名称（图形在屏幕上太小时自动隐藏）">节点名称</span>
        <Switch checked={showLabels} onChange={setShowLabels} />
      </div>
      {is2d && (
        <>
          <div className="layer-row">
            <span className="sw" style={{ background: COLORS.proj }} />
            <span className="lbl" title="同石其他已入链图上的节点，经主图坐标系投影到本图（点划线，沿用各节点颜色）">跨图投影（点划线）</span>
            {projOn && projItems.length > 0 && <span className="cnt">{projItems.length}</span>}
            <Switch checked={projOn} onChange={toggleProj} />
          </div>
          {projOn && projReason && <div className="hint" style={{ padding: '0 10px 4px' }}>{projReason}</div>}
          <div className="layer-row" style={{ alignItems: 'flex-start' }}>
            <span className="sw" style={{ background: COLORS.align, marginTop: 8 }} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="lbl" title="把同石另一张已入链的图按坐标链叠到本图上，拖透明度做拓片 / 照片比对">图像叠加</span>
              <select className="select sm" value={overlay?.assetId ?? ''} onChange={e => setOverlayAsset(e.target.value ? Number(e.target.value) : null)}
                disabled={overlayChoices.length === 0}>
                <option value="">{overlayChoices.length ? '不叠加' : (asset.is_master || asset.in_frame ? '（没有其他已入链的图）' : '（本图未入链）')}</option>
                {overlayChoices.map(a => <option key={a.id} value={a.id}>{a.kind_label} · {a.filename}</option>)}
              </select>
              {overlay && (
                <>
                  <Range min={0} max={1} step={0.02} value={overlay.opacity} onChange={e => setOverlayOpacity(Number(e.target.value))} />
                  <span className="hint">透明度 {(overlay.opacity * 100).toFixed(0)}%</span>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
