import { useMemo } from 'react'
import { Crosshair, Maximize, Minus, Plus, X } from 'lucide-react'
import { fmtBytes } from '../../lib/format'
import { ENGINE_SHORT, SHAPE_LABEL, TOOL_LABEL } from '../../lib/constants'
import { selectIs3d, useApp } from '../../store/useApp'
import { Badge, Button } from '../ui'

/** 查看器顶栏：当前图信息 + 同石切图（所有模块共用，因此在没有石头列表的模块里也能换图） */
export default function ViewerBar() {
  const stone = useApp(s => s.curStone)
  const asset = useApp(s => s.curAsset)
  const page = useApp(s => s.page)
  const tool = useApp(s => s.tool)
  const shape = useApp(s => s.shape)
  const engine = useApp(s => s.seg.engine)
  const is3d = useApp(selectIs3d)
  const openAsset = useApp(s => s.openAsset)
  const sendViewerCmd = useApp(s => s.sendViewerCmd)
  const closeAsset = useApp(s => s.closeAsset)

  const choices = useMemo(() => {
    if (!stone) return []
    const all = stone.groups.flatMap(g => g.assets)
    // 首页允许切三维；其他模块只处理 2D
    return page === 'home' ? all : all.filter(a => !a.kind.startsWith('model'))
  }, [stone, page])

  if (!asset || !stone) {
    return (
      <div className="vp-bar">
        <span className="muted">{stone ? '在左侧打开一张照片或拓片' : '先在首页左侧选择一块画像石'}</span>
      </div>
    )
  }

  return (
    <div className="vp-bar">
      <select className="select sm vp-switch" value={asset.id} title="切换同一块石头的其他图"
        onChange={e => { const a = choices.find(x => x.id === Number(e.target.value)); if (a) openAsset(stone, a) }}>
        {choices.map(a => (
          <option key={a.id} value={a.id}>
            {a.is_master ? '[主图] ' : a.in_frame ? '[链] ' : ''}{a.kind_label} · {a.filename}
          </option>
        ))}
      </select>
      <Badge tone={is3d ? 'green' : asset.kind === 'rubbing' ? 'violet' : asset.kind === 'photo_part' ? 'amber' : 'blue'}>
        {asset.kind_label}
      </Badge>
      {asset.is_master && <Badge tone="accent" title="坐标系原点">主图</Badge>}
      {!asset.is_master && asset.in_frame && <Badge tone="green" title="已接入主图坐标链">链</Badge>}
      <span className="meta">
        {asset.width > 0 && <span>{asset.width} x {asset.height}</span>}
        <span>{fmtBytes(asset.bytes)}</span>
        {asset.fmt && <span>{asset.fmt}</span>}
      </span>
      <span className="spacer" />
      {page !== 'align' && (
        <span className="tool-state">
          <Crosshair size={13} className="muted" />
          {TOOL_LABEL[tool]}
          {tool === 'annotate' && !is3d && <span className="muted">· {SHAPE_LABEL[shape]}</span>}
          {tool === 'segment' && <span className="muted">· {ENGINE_SHORT[engine]}</span>}
        </span>
      )}
      {page !== 'align' && (
        <span className="group">
          <Button variant="ghost" size="sm" icon={<Minus size={14} />} title="缩小" onClick={() => sendViewerCmd('zoomOut')} />
          <Button variant="ghost" size="sm" icon={<Plus size={14} />} title="放大" onClick={() => sendViewerCmd('zoomIn')} />
          <Button variant="ghost" size="sm" icon={<Maximize size={14} />} title="适应窗口 (F)" onClick={() => sendViewerCmd('fit')} />
        </span>
      )}
      <Button variant="ghost" size="sm" icon={<X size={14} />} title="关闭" onClick={closeAsset} />
    </div>
  )
}
