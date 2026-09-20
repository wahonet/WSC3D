import { ApiError } from '../api'
import type { Annotation } from '../types'

export interface CandidateEvidence {
  id: string
  document_id: number | null
  document_title: string
  page_id: number | null
  page_no: number | null
  segment_id: number | null
  excerpt: string
  review_status: string
  source_available: boolean
  source_status: 'available' | 'missing' | 'changed' | 'unverified' | 'excluded'
  source_notice?: string
  heading?: string
  matched_name?: string
  method?: string
}

export interface KnowledgeCandidate {
  id: string
  kind: string
  label: string
  aliases?: string[]
  story_id?: string | null
  story_label?: string | null
  concept_id?: number | null
  category_id?: string
  annotation_ids: number[]
  evidence_ids: string[]
  source_count: number
  status: 'candidate'
  source_available: boolean
}

export interface StoneCandidates {
  stone_id: string
  dataset_id: string
  asset_id: number | null
  stories: KnowledgeCandidate[]
  entities: KnowledgeCandidate[]
  evidence: CandidateEvidence[]
  notice: string
  stone_name?: string
  books?: { id: number; title: string; count: number }[]
  passages?: CandidateEvidence[]
  description?: string
}

export interface CandidateBinding {
  node_id: string
  story_id?: string | null
  annotation_id: number
}

export interface MaterializedCandidates {
  created: number
  reused: number
  annotations: Annotation[]
  bindings: CandidateBinding[]
}

export const candidateKey = (candidate: Pick<KnowledgeCandidate, 'id' | 'story_id'>) =>
  JSON.stringify([candidate.id, candidate.story_id ?? null])

async function read<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `候选服务请求失败（${response.status}）`
    try {
      const body = await response.json()
      if (typeof body.detail === 'string') message = body.detail
    } catch { /* Preserve the actionable status when the proxy has no JSON body. */ }
    throw new ApiError(response.status, message)
  }
  return response.json() as Promise<T>
}

export async function getStoneCandidates(stoneId: string, signal?: AbortSignal): Promise<StoneCandidates> {
  return read(await fetch(`/api/knowledge-graph/stones/${encodeURIComponent(stoneId)}/candidates`, { signal }))
}

export async function materializeCandidates(stoneId: string, assetId: number,
  items: { node_id: string; story_id?: string | null }[]): Promise<MaterializedCandidates> {
  return read(await fetch(`/api/knowledge-graph/stones/${encodeURIComponent(stoneId)}/materialize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asset_id: assetId, items }),
  }))
}

export async function attachCandidate(stoneId: string, annotationId: number, node: KnowledgeCandidate, evidenceIds: string[]) {
  return read<{ annotation: Annotation; added_sources: number }>(await fetch(`/api/knowledge-graph/stones/${encodeURIComponent(stoneId)}/attach`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ annotation_id: annotationId, node_id: node.id, story_id: node.story_id, evidence_ids: evidenceIds }),
  }))
}
