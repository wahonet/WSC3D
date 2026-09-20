import { useState } from 'react'
import { Crosshair, MousePointer2, Ruler, Trash2 } from 'lucide-react'
import { fmtValue } from '../lib/format'
import { selectIs2d, selectIs3d, useApp } from '../store/useApp'
import { Button, Kbd } from './ui'

/** 首页左下：选中 / 测量 两个工具 + 当前图上的测量记录 */
export default function MeasureTools() {
  const asset = useApp(s => s.curAsset)
  const tool = useApp(s => s.tool)
  const annos = useApp(s => s.annos)
  const selectedId = useApp(s => s.selectedId)
  const is2d = useApp(selectIs2d)
  const is3d = useApp(selectIs3d)
  const setTool = useApp(s => s.setTool)
  const select = useApp(s => s.select)
  const flyTo = useApp(s => s.flyToAnnotation)
  const remove = useApp(s => s.removeAnnotation)
  const [confirmDel, setConfirmDel] = useState<number | null>(null)

  const measures = annos.filter(a => a.tool === 'measure')

  return (
    <div className="tools">
      <button className={`tool${tool === 'select' ? ' on' : ''}`} onClick={() => setTool('select')} title="选中（V）">
        <span className="tic"><MousePointer2 size={15} /></span>
        <span className="tlabel">选中</span>
        <span className="thint">点击图形查看信息<Kbd>V</Kbd></span>
      </button>
      <button className={`tool${tool === 'measure' ? ' on' : ''}`} disabled={!asset}
        onClick={() => setTool(tool === 'measure' ? 'select' : 'measure')} title="测量（M）">
        <span className="tic"><Ruler size={15} /></span>
        <span className="tlabel">测量</span>
        <span className="thint">两点距离<Kbd>M</Kbd></span>
      </button>
      {tool === 'measure' && (
        <div className="sub">
          <div className="hint">
            依次点击两点。{is2d && <>结果为<b>原图像素距离</b>（尚无比例尺标定）。</>}
            {is3d && <>结果为<b>模型单位</b>距离（未标定，不得当作厘米）。</>}
          </div>
        </div>
      )}
      {asset && measures.length > 0 && (
        <div className="measure-list">
          <div className="layers-title">测量记录 · {measures.length}</div>
          {measures.map(m => (
            <div key={m.id} className={`measure-row${selectedId === m.id ? ' on' : ''}`} onClick={() => select(m.id)}>
              <span className="sw" style={{ background: m.color }} />
              <span className="val">{fmtValue(m.value, m.unit, m.atype)}</span>
              <span style={{ flex: 1 }} />
              {m.atype === 'line' && <Button size="xs" variant="ghost" icon={<Crosshair size={11} />} onClick={e => { e.stopPropagation(); flyTo(m.id) }} title="定位" />}
              {confirmDel === m.id ? (
                <>
                  <Button size="xs" variant="danger" onClick={e => { e.stopPropagation(); remove(m.id); setConfirmDel(null) }}>确认</Button>
                  <Button size="xs" variant="ghost" onClick={e => { e.stopPropagation(); setConfirmDel(null) }}>取消</Button>
                </>
              ) : <Button size="xs" variant="ghost" icon={<Trash2 size={11} />} onClick={e => { e.stopPropagation(); setConfirmDel(m.id) }} title="删除" />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
