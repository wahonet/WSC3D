export type KnowledgeKind = 'stone' | 'story' | 'person' | 'object'
export interface KnowledgeNode {
  id: string; kind: KnowledgeKind; label: string; aliases: string[]; description: string;
  stone_id?: string; category_id?: string; concept_id: number | null; status: string;
  evidence_ids: string[]; source_count: number; source_available: boolean;
}
export interface KnowledgeEdge {
  id: string; source: string; target: string; relation: string; label: string; status: string;
  evidence_ids: string[]; note: string; source_available: boolean;
}
export interface KnowledgeEvidence {
  id: string; document_id: number; document_title: string; page_id: number; page_no: number;
  segment_id: number | null; excerpt: string; review_status: string;
  source_available: boolean; source_status: string; source_notice: string;
}
export interface KnowledgeDocument {
  document_id: number; title: string; total_pages: number; readable_pages: number; evidence_count?: number;
}
export interface KnowledgeGraph {
  meta: { dataset_id: string; schema_version: number; status: string; notice: string;
    total_nodes: number; total_edges: number; returned_nodes: number; returned_edges: number;
    truncated: boolean; counts: Record<KnowledgeKind, number>; evidence_available: number;
    evidence_total: number; core_documents: number };
  nodes: KnowledgeNode[]; edges: KnowledgeEdge[]; evidence: KnowledgeEvidence[]; documents: KnowledgeDocument[];
}
export async function fetchKnowledgeGraph(signal?: AbortSignal): Promise<KnowledgeGraph> {
  const response = await fetch('/api/knowledge-graph?limit=3000', { signal })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '知识图谱暂时无法载入')
  return data
}
