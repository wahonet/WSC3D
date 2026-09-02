import type { ReactNode } from 'react'
import { Layers, MousePointer2, PenLine, Ruler, Scissors, Wand2 } from 'lucide-react'
import { COLORS, SHAPE_KEY, SHAPE_LABEL, TOOL_KEY, TOOL_LABEL } from '../../lib/constants'
import { selectIs2d, selectIs3d, useApp } from '../../store/useApp'
import type { AnnotateShape, Tool } from '../../types'
import { Chip, Kbd, Range, Switch } from '../ui'
import SegmentPanel from './SegmentPanel'

const SHAPES: AnnotateShape[] = ['rect', 'polygon', 'point']

export default function ToolPanel() {
  const tool = useApp(s => s.tool)
  const shape = useApp(s => s.shape)
  const asset = useApp(s => s.curAsset)
  const annos = useApp(s => s.annos)
  const overlay = useApp(s => s.overlay)
  const showAnnoLayer = useApp(s => s.showAnnoLayer)
  const showSegLayer = useApp(s => s.showSegLayer)
  const projOn = useApp(s => s.projOn)
  const projItems = useApp(s => s.projItems)
  const projReason = useApp(s => s.projReason)
  const is2d = useApp(selectIs2d)
  const is3d = useApp(selectIs3d)
  const setTool = useApp(s => s.setTool)
  const setShape = useApp(s => s.setShape)
  const setShowAnnoLayer = useApp(s => s.setShowAnnoLayer)
  const setShowSegLayer = useApp(s => s.setShowSegLayer)
  const toggleProj = useApp(s => s.toggleProj)
  const setOverlayOpacity = useApp(s => s.setOverlayOpacity)
  const removeOverlay = useApp(s => s.removeOverlay)

  const segCount = annos.filter(a => a.tool === 'segment').length
  const drawCount = annos.filter(a => a.tool !== 'segment' && a.atype !== 'align').length

  const T = ({ id, icon, hint, disabled }: { id: Tool; icon: ReactNode; hint: string; disabled?: boolean }) => (
    <button className={`tool${tool === id ? ' on' : ''}`} disabled={disabled}
      onClick={() => setTool(tool === id ? 'select' : id)} title={`${TOOL_LABEL[id]}（${TOOL_KEY[id]}）`}>
      <span className="tic">{icon}</span>
      <span className="tlabel">{TOOL_LABEL[id]}</span>
      <span className="thint">{hint}<Kbd>{TOOL_KEY[id]}</Kbd></span>
    </button>
  )

  return (
    <div className="tools">
      <T id="select" icon={<MousePointer2 size={15} />} hint="点击图形或列表" />

      <T id="annotate" icon={<PenLine size={15} />} hint={is3d ? '模型表面放点' : '在图上绘制'} disabled={!asset} />
      {tool === 'annotate' && is2d && (
        <div className="sub">
          <div className="chips">
            {SHAPES.map(s => (
              <Chip key={s} on={shape === s} onClick={() => setShape(s)}>{SHAPE_LABEL[s]} <Kbd>{SHAPE_KEY[s]}</Kbd></Chip>
            ))}
          </div>
          <div className="hint">
            {shape === 'rect' && <>按下并拖拽画出矩形。</>}
            {shape === 'polygon' && <>连续单击加点，<b>双击闭合</b>，<Kbd>Esc</Kbd> 取消。</>}
            {shape === 'point' && <>单击放置一个点。</>}
          </div>
        </div>
      )}
      {tool === 'annotate' && is3d && <div className="sub"><div className="hint">在模型表面单击放置标注点。</div></div>}

      <T id="measure" icon={<Ruler size={15} />} hint="两点距离" disabled={!asset} />
      {tool === 'measure' && (
        <div className="sub">
          <div className="hint">
            依次点击两点。{is2d && <>结果为<b>原图像素距离</b>。</>}
            {is3d && <>结果为<b>模型单位</b>距离（未标定，不得当作厘米）。</>}
          </div>
        </div>
      )}

      <T id="segment" icon={<Wand2 size={15} />} hint="SAM 智能分割" disabled={!is2d} />
      {tool === 'segment' && is2d && <SegmentPanel />}

      <T id="align" icon={<Scissors size={15} />} hint="分屏取点配准" disabled={!is2d} />
      {tool === 'align' && is2d && (
        <div className="sub accent-align">
          <div className="hint">
            左屏当前图（<b style={{ color: COLORS.alignL }}>红</b>）与右屏比对图（<b style={{ color: COLORS.alignR }}>蓝</b>）交替取同名点，
            至少 4 对；左键取点、右键拖图、滚轮缩放。<b>与主图对齐即接入统一坐标系</b>，标注可跨图投影。
          </div>
        </div>
      )}

      {asset && (
        <>
          <div className="layers-title"><Layers size={11} style={{ verticalAlign: -1, marginRight: 5 }} />图层</div>
          {is2d && (
            <div className="layer-row">
              <span className="sw" style={{ background: COLORS.amber }} />
              <span className="lbl">标注与测量</span>
              <span className="cnt">{drawCount}</span>
              <Switch checked={showAnnoLayer} onChange={setShowAnnoLayer} />
            </div>
          )}
          {is2d && (
            <div className="layer-row">
              <span className="sw" style={{ background: COLORS.seg }} />
              <span className="lbl">分割图层（虚线）</span>
              <span className="cnt">{segCount}</span>
              <Switch checked={showSegLayer} onChange={setShowSegLayer} disabled={segCount === 0} />
            </div>
          )}
          {is2d && (
            <>
              <div className="layer-row">
                <span className="sw" style={{ background: COLORS.proj }} />
                <span className="lbl" title="同石其他已入链图上的标注，经主图坐标系投影到本图">跨图投影（点划线）</span>
                {projOn && <span className="cnt">{projItems.length}</span>}
                <Switch checked={projOn} onChange={toggleProj} />
              </div>
              {projReason && <div className="note-box warn" style={{ margin: '0 10px' }}>{projReason}</div>}
            </>
          )}
          {overlay && (
            <div className="sub accent-ok" style={{ marginLeft: 0 }}>
              <div className="row between">
                <span className="hint"><b>对齐叠加</b> 透明度 {(overlay.opacity * 100).toFixed(0)}%</span>
                <button className="btn xs" onClick={removeOverlay}>移除</button>
              </div>
              <Range min={0} max={1} step={0.02} value={overlay.opacity} onChange={e => setOverlayOpacity(Number(e.target.value))} />
            </div>
          )}
          {is3d && <div className="hint" style={{ padding: '0 10px' }}>三维标注以球体标记显示；图层显隐与跨图投影目前仅覆盖 2D。</div>}
        </>
      )}
    </div>
  )
}
