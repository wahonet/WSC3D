import { useApp } from '../store/useApp'
import type { AnnotationReference } from '../types'

export function openReferenceLibrary() {
  const q = new URLSearchParams(location.hash.replace(/^#/, ''))
  q.set('lib', 'books')
  q.delete('seg'); q.delete('fig'); q.delete('src'); q.delete('off')
  history.replaceState(null, '', `#${q.toString()}`)
  useApp.getState().setPage('library')
  window.dispatchEvent(new CustomEvent('stonelab:open-reference', { detail: {} }))
}

export function openAnnotationReference(r: AnnotationReference) {
  const q = new URLSearchParams(location.hash.replace(/^#/, ''))
  q.delete('seg'); q.delete('fig'); q.delete('q'); q.delete('src'); q.delete('off')
  if (r.kind === 'description') {
    q.set('lib', 'link')
    q.set('src', r.desc_source || 'description'); q.set('off', String(r.desc_start ?? 0))
    history.replaceState(null, '', `#${q.toString()}`)
    useApp.getState().select(r.annotation_id)
    useApp.getState().setPage('library')
    // The library mode can mount the article in response to this event.
    window.dispatchEvent(new CustomEvent('stonelab:open-description', { detail: r }))
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('stonelab:locate-description', { detail: r })))
    return
  }
  if (r.document_id == null || r.page_id == null || r.page_no == null) return
  q.set('lib', 'books'); q.set('doc', String(r.document_id)); q.set('pg', String(r.page_no))
  if (r.segment_id != null) q.set('seg', String(r.segment_id))
  if (r.figure_id != null) q.set('fig', String(r.figure_id))
  history.replaceState(null, '', `#${q.toString()}`)
  useApp.getState().setPage('library')
  window.dispatchEvent(new CustomEvent('stonelab:open-reference', { detail: {
    documentId: r.document_id, pageId: r.page_id, pageNo: r.page_no,
    segmentId: r.segment_id ?? undefined, figureId: r.figure_id ?? undefined,
  } }))
}
