import { useEffect } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { previewUrl } from '../../api'
import { annotationBounds } from '../../lib/geometry'
import type { Annotation, AssetBrief, ProjectedAnnotation } from '../../types'
import { Button, Spinner } from '../ui'
import { AnnoShape, ProjectedShape } from '../viewer/AnnotationShapes'
import { useOsd } from '../viewer/useOsd'

export default function ResearchViewer({ asset, annos, projected, linkedIds, selectedId, onSelect, focus }: {
  asset: AssetBrief
  /** 本图层自身的标注 */
  annos: Annotation[]
  /** 同石其他已入链图层（通常是主图）投影到本图层的标注 */
  projected: ProjectedAnnotation[]
  /** 已图文关联的标注 id（投影标注据此着橙色） */
  linkedIds: Set<number>
  selectedId: number | null
  onSelect: (id: number | null) => void
  /** 变化时把视图定位到选中标注 */
  focus: number
}) {
  const { hostRef, ready, toEl, zoomBy, goHome, fitNorm } = useOsd(previewUrl(asset.id))

  useEffect(() => {
    if (!ready || !focus || selectedId == null) return
    const own = annos.find(x => x.id === selectedId)
    const pj = projected.find(x => x.id === selectedId)
    const b = own ? annotationBounds(own) : pj ? annotationBounds({ atype: pj.atype, geometry: pj.geometry }) : null
    if (b) fitNorm(b)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, ready])

  return (
    <div className="viewport">
      <div className="osd-host" ref={hostRef} />
      {!ready && <div className="loading-mask"><Spinner />载入预览…</div>}
      <svg className="svg-overlay">
        {ready && projected.map(p => (
          <ProjectedShape key={`pj${p.id}`} p={p} toEl={toEl} selected={p.id === selectedId} interactive onSelect={onSelect} />
        ))}
        {ready && annos.map(a => (
          <AnnoShape key={a.id} a={a} toEl={toEl} selected={a.id === selectedId} interactive onSelect={onSelect} />
        ))}
      </svg>
      <div className="vp-float tr" style={{ padding: 3, gap: 2 }}>
        <Button variant="ghost" size="sm" icon={<Minus size={14} />} title="缩小" onClick={() => zoomBy(1 / 1.5)} />
        <Button variant="ghost" size="sm" icon={<Plus size={14} />} title="放大" onClick={() => zoomBy(1.5)} />
        <Button variant="ghost" size="sm" icon={<Maximize size={14} />} title="适应窗口" onClick={goHome} />
      </div>
      <div className="vp-float bl">
        <span className="muted">
          点击图形选中标注 · 图形、列表色块与右侧关联文字同色{linkedIds.size > 0 && <>（已关联 {linkedIds.size} 条）</>}
          {projected.length > 0 && <> · <b>点划线</b>为主图等图层的投影（{projected.length} 条）</>}
        </span>
      </div>
    </div>
  )
}
