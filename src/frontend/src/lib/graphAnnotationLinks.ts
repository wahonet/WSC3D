import type { KnowledgeNode } from './knowledgeGraph'
import type { StoneCandidates } from './knowledgeCandidates'
import type { Annotation, Concept } from '../types'

// A materialized vocabulary term is not an annotation association. Its usage
// must be positive; labels and neighbouring nodes never establish a match.
export function globalAnnotationCounts(nodes: KnowledgeNode[], concepts: Pick<Concept, 'id' | 'usage'>[]): Map<string, number> {
  const usage = new Map(concepts.filter(term => Number.isInteger(term.usage) && term.usage > 0)
    .map(term => [term.id, term.usage]))
  return new Map(nodes.flatMap(node => {
    const count = node.concept_id == null ? 0 : usage.get(node.concept_id) || 0
    return count ? [[node.id, count] as const] : []
  }))
}

// In a stone view, use that stone's actual bindings, not global concept usage.
// Multiple occurrences of an entity may refer to the same annotation.
export function stoneAnnotationCounts(nodes: KnowledgeNode[], stoneId: string, datasetId: string,
  candidates: StoneCandidates | null, annotations: Pick<Annotation, 'id' | 'review_status'>[]): Map<string, number> {
  const counts = new Map<string, number>()
  if (!candidates || candidates.stone_id !== stoneId || candidates.dataset_id !== datasetId) return counts
  const nodeIds = new Set(nodes.map(node => node.id))
  const live = new Set(annotations.filter(item => item.review_status !== 'rejected').map(item => item.id))
  const byNode = new Map<string, Set<number>>()
  const all = new Set<number>()
  for (const item of [...candidates.stories, ...candidates.entities]) {
    if (!nodeIds.has(item.id)) continue
    const ids = byNode.get(item.id) || new Set<number>()
    for (const id of item.annotation_ids) {
      if (!Number.isInteger(id) || id <= 0 || !live.has(id)) continue
      ids.add(id); all.add(id)
    }
    byNode.set(item.id, ids)
  }
  for (const [id, ids] of byNode) if (ids.size) counts.set(id, ids.size)
  for (const node of nodes) if (node.kind === 'stone' && node.stone_id === stoneId && all.size) counts.set(node.id, all.size)
  return counts
}
