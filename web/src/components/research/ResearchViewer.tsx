import { useEffect } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { annotationBounds } from '../../lib/geometry'
import type { Annotation, AssetBrief } from '../../types'
import { Button, Spinner } from '../ui'
import { AnnoShape } from '../viewer/AnnotationShapes'
import { useOsd } from '../viewer/useOsd'

export default function ResearchViewer({ asset, annos, selectedId, onSelect, focus }: {
  asset: AssetBrief
  annos: Annotation[]
  selectedId: number | null
  onSelect: (id: number | null) => void
  /** 变化时把视图定位到选中标注 */
  focus: number
}) {
  const { hostRef, ready, toEl, zoomBy, goHome, fitNorm } = useOsd(asset.id)

  useEffect(() => {
    if (!ready || !focus || selectedId == null) return
    const a = annos.find(x => x.id === selectedId)
    const b = a && annotationBounds(a)
    if (b) fitNorm(b)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, ready])

  return (
    <div className="viewport">
      <div className="osd-host" ref={hostRef} />
      {!ready && <div className="loading-mask"><Spinner />载入预览…</div>}
      <svg className="svg-overlay">
        {ready && annos.map(a => (
          <AnnoShape key={a.id} a={a} toEl={toEl} selected={a.id === selectedId} interactive linkedTint onSelect={onSelect} />
        ))}
      </svg>
      <div className="vp-float tr" style={{ padding: 3, gap: 2 }}>
        <Button variant="ghost" size="sm" icon={<Minus size={14} />} title="缩小" onClick={() => zoomBy(1 / 1.5)} />
        <Button variant="ghost" size="sm" icon={<Plus size={14} />} title="放大" onClick={() => zoomBy(1.5)} />
        <Button variant="ghost" size="sm" icon={<Maximize size={14} />} title="适应窗口" onClick={goHome} />
      </div>
      <div className="vp-float bl">
        <span className="muted">点击图形选中标注 · <b style={{ color: '#e08c1a' }}>橙色</b>为已图文关联</span>
      </div>
    </div>
  )
}
