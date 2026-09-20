import type { Annotation, AnnotationExcerptPatch, Semantics } from '../types'
import { EMPTY_SEMANTICS } from '../types'

export interface AnnotationDraft {
  label: string
  color: string
  concept_ids: number[]
  semantics: Semantics
  reference_excerpts: AnnotationExcerptPatch[]
}
export const draftEvent = 'wsc:annotation-excerpt'
export const draftKey = (id: number) => 'wsc-unified.draft.node.' + id
export const initialAnnotationDraft = (a: Annotation): AnnotationDraft => ({
  label: /^sam\d?(?:\.\d+)?:/i.test(a.label) || a.label === '未命名' ? '' : a.label,
  color: a.color,
  concept_ids: [...a.concept_ids].sort((x, y) => x - y),
  semantics: { ...EMPTY_SEMANTICS, ...a.semantics, inscription: { ...EMPTY_SEMANTICS.inscription, ...a.semantics?.inscription } },
  reference_excerpts: [],
})

export function appendExcerpt(draft: AnnotationDraft, excerpt: AnnotationExcerptPatch): AnnotationDraft {
  const current = draft.semantics[excerpt.field] || ''
  const pending = draft.reference_excerpts || []
  return {
    ...draft,
    semantics: { ...draft.semantics, [excerpt.field]: current.includes(excerpt.text) ? current : [current.trim(), excerpt.text].filter(Boolean).join('\n') },
    reference_excerpts: pending.some(item => JSON.stringify(item) === JSON.stringify(excerpt)) ? pending : [...pending, excerpt],
  }
}

/** 文献中心也可填入描述；未保存的内容随同一标注草稿回到工作台。 */
export function stageReferenceExcerpt(annotation: Annotation, excerpt: AnnotationExcerptPatch) {
  let base = initialAnnotationDraft(annotation)
  try { base = JSON.parse(localStorage.getItem(draftKey(annotation.id)) || 'null') || base } catch { /* fresh draft */ }
  const draft = appendExcerpt(base, excerpt)
  localStorage.setItem(draftKey(annotation.id), JSON.stringify(draft))
  window.dispatchEvent(new CustomEvent(draftEvent, { detail: { id: annotation.id, draft } }))
}
