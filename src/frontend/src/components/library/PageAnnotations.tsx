import { useEffect, useState } from 'react'
import { previewUrl } from '../../api'
import { annotationBounds } from '../../lib/geometry'
import { annotationLabel } from '../../lib/tree'
import { goToSection } from '../../lib/navigation'
import { useApp } from '../../store/useApp'
import type { Annotation, AnnotationReference } from '../../types'
import { AnnoShape } from '../viewer/AnnotationShapes'

export interface PageAnnotation {
  annotation: Annotation
  stone_name: string
  asset_width: number
  asset_height: number
  references: AnnotationReference[]
}

export function usePageAnnotations(pageId: number | null) {
  const [rows, setRows] = useState<PageAnnotation[]>([])
  const [error, setError] = useState('')
  const annotations = useApp(s => s.stoneAnnos)
  useEffect(() => {
    let active = true
    setRows([]); setError('')
    if (pageId == null) return
    fetch(`/api/library/pages/${pageId}/annotations`).then(async response => {
      if (!response.ok) throw new Error('关联图像读取失败')
      return response.json() as Promise<PageAnnotation[]>
    }).then(value => { if (active) setRows(value) }).catch(reason => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [pageId, annotations])
  return { rows, error }
}

export function AnnotationCrop({ row }: { row: PageAnnotation }) {
  const annotation = row.annotation
  const bounds = annotationBounds(annotation)
  if (!bounds || bounds.some(value => !Number.isFinite(value))) return null
  const [x, y, width, height] = bounds
  const sx = 1000, sy = 1000 * row.asset_height / row.asset_width
  const margin = Math.max(width, height) * .08
  const left = Math.max(0, x - margin), top = Math.max(0, y - margin)
  const w = Math.max(.005, Math.min(1, x + width + margin) - left)
  const h = Math.max(.005, Math.min(1, y + height + margin) - top)
  return <svg className="page-annotation-crop" viewBox={`${left * sx} ${top * sy} ${w * sx} ${h * sy}`} aria-label={`${annotationLabel(annotation)}标注区域`}>
    <image href={previewUrl(annotation.asset_id)} width={sx} height={sy} preserveAspectRatio="none" />
    <AnnoShape a={annotation} toEl={point => [point[0] * sx, point[1] * sy]} selected={false} interactive={false} />
  </svg>
}

export default function PageAnnotations({ rows, error }: { rows: PageAnnotation[]; error: string }) {
  if (error) return <div className="hint page-annotations-error">{error}</div>
  if (!rows.length) return null
  const open = (annotation: Annotation) => {
    const state = useApp.getState()
    if (state.hiddenAnnotations.includes(annotation.id)) state.toggleAnnotationVisibility(annotation.id)
    goToSection('research', { p: 'annotate', stone: annotation.stone_id, a: annotation.asset_id, node: annotation.id })
  }
  return <details className="page-annotations" open>
    <summary>关联图像 <span>{rows.length}</span></summary>
    <div className="page-annotation-grid">{rows.map(row => <button key={row.annotation.id} className="page-annotation-card"
      data-reference-annotation={row.annotation.id} onClick={() => open(row.annotation)} title={row.references.flatMap(ref => ref.excerpts?.map(item => item.text) || []).join('\n')}>
      <AnnotationCrop row={row} />
      <span><b>{annotationLabel(row.annotation)}</b><small>{row.stone_name}</small></span>
    </button>)}</div>
  </details>
}
