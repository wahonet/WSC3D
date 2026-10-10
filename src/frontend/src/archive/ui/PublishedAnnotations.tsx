import { useState } from 'react'
import { BookOpen } from 'lucide-react'
import { useApp } from '../../store/useApp'
import { annotationLabel, hasGeometry, isStructural } from '../../lib/tree'
import { previewDocument } from '../../lib/navigation'
import { AnnotationCrop } from '../../components/library/PageAnnotations'
import type { Annotation, AssetBrief } from '../../types'

/**
 * One collapsed entry. The cropped preview is drawn only once the entry is opened:
 * a stone can hold hundreds of entries, and drawing every segmentation outline up front
 * made the first visit to the archive freeze for seconds. Text and citations stay in
 * the page so the browser's find-in-page still reaches them.
 */
function PublishedAnnotation({ annotation, asset, stoneName }: { annotation: Annotation; asset?: AssetBrief; stoneName: string }) {
  const [opened, setOpened] = useState(false)
  return <details data-public-annotation={annotation.id} onToggle={event => { if (event.currentTarget.open) setOpened(true) }}>
    <summary>{annotationLabel(annotation)}</summary>
    {opened && asset && <AnnotationCrop row={{ annotation, stone_name: stoneName, asset_width: asset.width || 1,
      asset_height: asset.height || 1, references: annotation.references }} />}
    {annotation.semantics.pre_iconographic && <p>{annotation.semantics.pre_iconographic}</p>}
    {annotation.semantics.iconographic && <p>{annotation.semantics.iconographic}</p>}
    {annotation.references.filter(reference => !reference.source_missing && reference.document_id && reference.page_no).map(reference =>
      <button key={reference.id} onClick={() => previewDocument({ collection: 'core', documentId: reference.document_id!, pageNo: reference.page_no!, segmentId: reference.segment_id })}>
        <BookOpen size={12} /><span>{reference.document_title} · 第{reference.page_no}页</span>
      </button>)}
  </details>
}

export default function PublishedAnnotations({ stoneId }: { stoneId: string }) {
  const annotations = useApp(s => s.stoneAnnos)
  const stone = useApp(s => s.stones.find(item => item.id === stoneId))
  const rows = annotations.filter(annotation => annotation.stone_id === stoneId && isStructural(annotation)
    && ['reviewed', 'approved'].includes(annotation.review_status) && hasGeometry(annotation))
  if (!stone || !rows.length) return null
  const assets = new Map(stone.groups.flatMap(group => group.assets).map(asset => [asset.id, asset]))
  return <section className="arch-sec published-annotations"><div className="arch-hd">图像解读<span className="arch-n">{rows.length}</span></div>
    {rows.map(annotation => <PublishedAnnotation key={annotation.id} annotation={annotation} asset={assets.get(annotation.asset_id)} stoneName={stone.name} />)}
  </section>
}
