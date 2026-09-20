import { useApp } from '../store/useApp'
import { goToSection, openDocument } from './navigation'
import type { AnnotationReference } from '../types'

export function openReferenceLibrary() {
  useApp.getState().setPage('library')
  goToSection('library', { scope: 'core', lib: 'books', seg: null, fig: null, src: null, off: null, manage: null })
  window.dispatchEvent(new CustomEvent('stonelab:open-reference', { detail: {} }))
}

export function openAnnotationReference(r: AnnotationReference) {
  if (r.kind === 'description') {
    useApp.getState().setPage('library')
    useApp.getState().select(r.annotation_id)
    goToSection('research', { p: 'library', lib: 'link', node: r.annotation_id,
      src: r.desc_source || 'description', off: r.desc_start ?? 0,
      doc: null, pg: null, seg: null, fig: null, q: null, book: null, epg: null, manage: null })
    // The library mode can mount the article in response to this event.
    window.dispatchEvent(new CustomEvent('stonelab:open-description', { detail: r }))
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('stonelab:locate-description', { detail: r })))
    return
  }
  if (r.document_id == null || r.page_id == null || r.page_no == null) return
  useApp.getState().setTool('select')
  openDocument({ collection: 'core', documentId: r.document_id, pageNo: r.page_no, pageId: r.page_id,
    segmentId: r.segment_id, figureId: r.figure_id })
}
