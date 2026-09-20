import { BookOpen } from 'lucide-react'
import { useApp } from '../../store/useApp'
import { annotationLabel, hasGeometry, isStructural } from '../../lib/tree'
import { previewDocument } from '../../lib/navigation'
import { AnnotationCrop } from '../../components/library/PageAnnotations'

export default function PublishedAnnotations({ stoneId }: { stoneId: string }) {
  const annotations = useApp(s => s.stoneAnnos)
  const stone = useApp(s => s.stones.find(item => item.id === stoneId))
  const rows = annotations.filter(annotation => annotation.stone_id === stoneId && isStructural(annotation)
    && ['reviewed', 'approved'].includes(annotation.review_status) && hasGeometry(annotation))
  if (!stone || !rows.length) return null
  return <section className="arch-sec published-annotations"><div className="arch-hd">图像解读<span className="arch-n">{rows.length}</span></div>
    {rows.map(annotation => {
      const asset = stone.groups.flatMap(group => group.assets).find(item => item.id === annotation.asset_id)
      return <details key={annotation.id} data-public-annotation={annotation.id}>
        <summary>{annotationLabel(annotation)}</summary>
        {asset && <AnnotationCrop row={{ annotation, stone_name: stone.name, asset_width: asset.width || 1,
          asset_height: asset.height || 1, references: annotation.references }} />}
        {annotation.semantics.pre_iconographic && <p>{annotation.semantics.pre_iconographic}</p>}
        {annotation.semantics.iconographic && <p>{annotation.semantics.iconographic}</p>}
        {annotation.references.filter(reference => !reference.source_missing && reference.document_id && reference.page_no).map(reference =>
          <button key={reference.id} onClick={() => previewDocument({ collection: 'core', documentId: reference.document_id!, pageNo: reference.page_no!, segmentId: reference.segment_id })}>
            <BookOpen size={12} /><span>{reference.document_title} · 第{reference.page_no}页</span>
          </button>)}
      </details>
    })}
  </section>
}
