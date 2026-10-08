import type { Annotation, AnnotationReference, StoneNode } from '../types'
import { collectMotifs, motifProvenance, motifReferenceScope, renderMotifCutout, renderMotifPreview, validOutline, type Motif, type Point } from './motifCutouts'
import { displayImageVersions, imageVersion } from './imageVersions'

export interface StoryCutout extends Motif {
  descendants: Annotation[]
  motifs: Motif[]
  extraction: 'annotated_scene_crop' | 'saved_scene_outline'
}
export type StoryView = 'scene' | 'composition'
const accepted = (a: Annotation) => ['reviewed', 'approved', 'candidate'].includes(a.review_status) &&
  (a.review_status !== 'candidate' || Boolean(a.note.trim()))

export function sceneOutline(a: Annotation): Point[] | null {
  if (a.geometry_intent === 'reconstructed_extent') return null
  if (a.atype === 'polygon') return validOutline(a.geometry.points)
  if (a.atype !== 'rect') return null
  const { x, y, w, h } = a.geometry
  if (![x, y, w, h].every(v => typeof v === 'number' && Number.isFinite(v))) return null
  const [left, top, width, height] = [x, y, w, h] as number[]
  if (left < 0 || top < 0 || width <= 0 || height <= 0 || left + width > 1.00000001 || top + height > 1.00000001) return null
  const right = Math.min(1, left + width), bottom = Math.min(1, top + height)
  return [[left, top], [right, top], [right, bottom], [left, bottom]]
}

/** Membership comes only from saved parent IDs in the same stone and image. */
export function collectStories(stone: StoneNode, annotations: Annotation[]): StoryCutout[] {
  const local = annotations.filter(a => a.stone_id === stone.id)
  const nodes = new Map(local.map(a => [a.id, a]))
  const assets = new Map(stone.groups.flatMap(group => group.assets).map(a => [a.id, a]))
  const motifs = collectMotifs(stone, local)
  const preferredMotifs = new Set(displayImageVersions(motifs).map(m => m.annotation.id))
  return local.flatMap(a => {
    if (a.level !== 'scene' || !accepted(a) || !a.label.trim() ||
      !a.references.some(r => r.kind === 'segment' && !r.source_missing)) return []
    const asset = assets.get(a.asset_id), points = sceneOutline(a)
    if (!asset || !['photo', 'photo_part', 'rubbing'].includes(asset.kind) || !points) return []
    const ancestors: Annotation[] = [], seen = new Set([a.id])
    let parent = nodes.get(a.parent_id ?? -1)
    if (a.parent_id != null && !parent) return []
    while (parent) {
      if (seen.has(parent.id) || parent.asset_id !== a.asset_id || !accepted(parent)) return []
      ancestors.push(parent); seen.add(parent.id); parent = nodes.get(parent.parent_id ?? -1)
    }
    const sourceSceneIds = new Set([a.id])
    const version = imageVersion({ annotation: a, stone, asset, points, ancestors })
    const original = version && nodes.get(version.canonical_annotation_id)
    // A replacement on the original image retains that scene's saved members.
    if (original && !original.geometry.image_version && original.level === 'scene' &&
      original.asset_id === a.asset_id && accepted(original)) sourceSceneIds.add(original.id)
    const descendants = local.filter(child => {
      if (child.id === a.id || child.asset_id !== a.asset_id || !accepted(child)) return false
      let current = child
      const path = new Set([child.id])
      while (current.parent_id != null) {
        const next = nodes.get(current.parent_id)
        if (!next || next.asset_id !== a.asset_id || !accepted(next) || path.has(next.id)) return false
        if (sourceSceneIds.has(next.id)) return true
        path.add(next.id); current = next
      }
      return false
    })
    const ids = new Set(descendants.map(child => child.id))
    return [{ annotation: a, stone, asset, points, ancestors, descendants, canonicalAnnotation: original || undefined,
      motifs: motifs.filter(m => ids.has(m.annotation.id) && preferredMotifs.has(m.annotation.id) && m.annotation.geometry_intent !== 'reconstructed_extent'),
      extraction: a.atype === 'rect' ? 'annotated_scene_crop' as const : 'saved_scene_outline' as const }]
  })
}

export function storyReferences(story: StoryCutout): AnnotationReference[] {
  const unique = new Map<string, AnnotationReference>()
  for (const node of [story.annotation, ...story.descendants]) for (const ref of node.references) {
    if (!['segment', 'figure'].includes(ref.kind)) continue
    const key = ref.kind + ':' + (ref.segment_id ?? ref.figure_id ?? ref.id)
    const previous = unique.get(key)
    if (!previous || (previous.source_missing && !ref.source_missing)) unique.set(key, ref)
  }
  return [...unique.values()]
}

export function storyConceptIds(story: StoryCutout): Set<number> {
  return new Set([story.annotation, ...story.descendants].flatMap(a => a.concept_ids))
}

export function renderStoryCutout(story: StoryCutout, view: StoryView, maxSide = 1800, includeCandidates = false): Promise<Blob> {
  const members = story.motifs.filter(m => includeCandidates || m.annotation.review_status !== 'candidate')
  if (view === 'composition' && !members.length) return Promise.reject(new Error('当前场景尚无可组合的分割轮廓'))
  return renderMotifCutout(story, maxSide, view === 'composition' ? members.map(m => m.points) : undefined,
    view === 'composition' ? members : undefined)
}

export function renderStoryPreview(story: StoryCutout, view: StoryView, maxSide = 650, includeCandidates = false): Promise<Blob> {
  const members = story.motifs.filter(m => includeCandidates || m.annotation.review_status !== 'candidate')
  if (view === 'composition' && !members.length) return Promise.reject(new Error('当前场景尚无可组合的分割轮廓'))
  return renderMotifPreview(story, maxSide, view === 'composition' ? members.map(m => m.points) : undefined,
    view === 'composition' ? members : undefined)
}

export function storyProvenance(story: StoryCutout, view: StoryView, includeCandidates = false) {
  const members = story.motifs.filter(m => includeCandidates || m.annotation.review_status !== 'candidate')
  return { ...motifProvenance(story, view === 'composition' ? members : undefined), format: 'wsc-story-cutout-1', view,
    extraction: view === 'composition' ? 'saved_outline_composition' : story.extraction,
    preserves_source_positions: true, include_candidates: includeCandidates,
    scene_reference_scope: motifReferenceScope(story),
    concept_ids: [...storyConceptIds(story)],
    descendants: story.descendants.map(a => ({ annotation_id: a.id, parent_id: a.parent_id,
      label: a.label, level: a.level, review_status: a.review_status, references: a.references, concept_ids: a.concept_ids })),
    motifs: story.motifs.filter(m => includeCandidates || m.annotation.review_status !== 'candidate').map(m => motifProvenance(m)),
  }
}
