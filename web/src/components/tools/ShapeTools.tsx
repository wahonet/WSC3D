import { Circle, Dot, MousePointer2, Pentagon, Square, Wand2 } from 'lucide-react'
import { SHAPES, SHAPE_KEY, SHAPE_LABEL } from '../../lib/constants'
import { selectIs2d, useApp } from '../../store/useApp'
import type { AnnotateShape } from '../../types'
import { Kbd } from '../ui'
import SegmentPanel from './SegmentPanel'

const ICON: Record<AnnotateShape, React.ReactNode> = {
  rect: <Square size={14} />, ellipse: <Circle size={14} />, polygon: <Pentagon size={14} />, point: <Dot size={16} />,
}

/** 分割模块左下：手绘形状（矩形 / 圆形 / 多边形 / 点）与 SAM 分割 */
export default function ShapeTools() {
  const asset = useApp(s => s.curAsset)
  const tool = useApp(s => s.tool)
  const shape = useApp(s => s.shape)
  const is2d = useApp(selectIs2d)
  const setTool = useApp(s => s.setTool)
  const setShape = useApp(s => s.setShape)

  if (!asset || !is2d) return <div className="hint" style={{ padding: '10px 12px' }}>在上方打开一张照片或拓片，然后用形状工具或 SAM 把画面切成实体。</div>

  return (
    <div className="tools">
      <button className={`tool${tool === 'select' ? ' on' : ''}`} onClick={() => setTool('select')} title="拖动图像 / 选中图形（V）；Esc 退出绘制">
        <span className="tic"><MousePointer2 size={15} /></span>
        <span className="tlabel">选中</span>
        <span className="thint">拖动图像 / 点击图形<Kbd>V</Kbd></span>
      </button>
      <div className="shape-grid">
        {SHAPES.map(s => (
          <button key={s} className={`tool shape${tool === 'annotate' && shape === s ? ' on' : ''}`} onClick={() => setShape(s)}
            title={`${SHAPE_LABEL[s]}（${SHAPE_KEY[s]}）`}>
            <span className="tic">{ICON[s]}</span>
            <span className="tlabel">{SHAPE_LABEL[s]}</span>
            <Kbd>{SHAPE_KEY[s]}</Kbd>
          </button>
        ))}
      </div>
      {tool === 'annotate' && (
        <div className="sub">
          <div className="hint">
            {shape === 'rect' && <>按下并拖拽画出矩形。</>}
            {shape === 'ellipse' && <>按下并拖拽，得到内切于拖拽框的圆 / 椭圆。</>}
            {shape === 'polygon' && <>连续单击加点，<b>双击闭合</b>，<Kbd>Esc</Kbd> 取消。</>}
            {shape === 'point' && <>单击放置一个点。</>}
            {' '}新图形会按位置自动归入所在的层 / 场景；选中「无框」节点时绘制即挂接到它。
          </div>
        </div>
      )}
      <button className={`tool${tool === 'segment' ? ' on' : ''}`} onClick={() => setTool(tool === 'segment' ? 'select' : 'segment')} title="SAM 分割（S）">
        <span className="tic"><Wand2 size={15} /></span>
        <span className="tlabel">SAM 分割</span>
        <span className="thint">点选 / 文字 / 示例框<Kbd>S</Kbd></span>
      </button>
      {tool === 'segment' && <SegmentPanel />}
    </div>
  )
}
