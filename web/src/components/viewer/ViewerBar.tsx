import { Crosshair, Maximize, Minus, Plus, Star, X } from 'lucide-react'
import { fmtBytes } from '../../lib/format'
import { ENGINE_SHORT, SHAPE_LABEL, TOOL_LABEL } from '../../lib/constants'
import { selectIs3d, useApp } from '../../store/useApp'
import { Badge, Button } from '../ui'

export default function ViewerBar() {
  const asset = useApp(s => s.curAsset)
  const tool = useApp(s => s.tool)
  const shape = useApp(s => s.shape)
  const engine = useApp(s => s.seg.engine)
  const is3d = useApp(selectIs3d)
  const makeMaster = useApp(s => s.makeMaster)
  const sendViewerCmd = useApp(s => s.sendViewerCmd)
  const closeAsset = useApp(s => s.closeAsset)

  if (!asset) {
    return (
      <div className="vp-bar">
        <span className="muted">从左侧列表打开照片、拓片或三维模型</span>
      </div>
    )
  }

  return (
    <div className="vp-bar">
      <span className="name" title={asset.filename}>{asset.filename}</span>
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
      {!is3d && !asset.is_master && (
        <Button size="xs" icon={<Star size={12} />} onClick={makeMaster} title="设为该石头的坐标系原点（主图）">
          设为主图
        </Button>
      )}
      <span className="spacer" />
      <span className="tool-state">
        <Crosshair size={13} className="muted" />
        {TOOL_LABEL[tool]}
        {tool === 'annotate' && !is3d && <span className="muted">· {SHAPE_LABEL[shape]}</span>}
        {tool === 'segment' && <span className="muted">· {ENGINE_SHORT[engine]}</span>}
      </span>
      {tool === 'align' ? null : (
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
