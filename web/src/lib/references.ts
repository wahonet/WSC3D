import type { Annotation, AnnotationReference } from '../types'

/** The legacy fields remain readable while an older server is being upgraded. */
export function annotationReferences(a: Annotation): AnnotationReference[] {
  if (a.references) return a.references
  if (!a.desc_text || a.desc_start == null || a.desc_end == null) return []
  return [{
    id: -a.id, annotation_id: a.id, kind: 'description',
    desc_source: a.desc_source, desc_start: a.desc_start, desc_end: a.desc_end, text: a.desc_text,
    document_id: null, document_title: null, document_code: null, page_id: null, page_no: null,
    segment_id: null, figure_id: null, figure_label: '', image_url: null, source_missing: false,
  }]
}

export const hasReferences = (a: Annotation) => annotationReferences(a).length > 0

export function referenceSource(r: AnnotationReference): string {
  if (r.kind === 'description') return r.desc_source?.startsWith('layer:')
    ? `第 ${r.desc_source.split(':')[1]} 层释文` : '总述'
  return [r.document_code, r.document_title, r.page_no != null ? `物理页 ${r.page_no}` : ''].filter(Boolean).join(' · ')
}
