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
  let response: Response
  try { response = await fetch('/api/knowledge-graph?limit=3000', { signal }) }
  catch (reason) {
    if ((reason as Error).name === 'AbortError') throw reason
    throw new Error('无法连接平台后端服务，请确认启动窗口仍在运行')
  }
  // 后端异常或代理出错时可能返回 HTML，不能让 JSON 解析错误直接显示给观众
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) throw new Error(typeof data?.detail === 'string' ? data.detail : '知识图谱暂时无法载入，请稍后重试')
  return data
}

/**
 * 图谱约 3000 个节点，形象库、故事库和图谱页都要用。几分钟内复用同一份数据；
 * 页面“重试”或“刷新”传 force。signal 只取消调用方的等待，不中断共享的请求。
 */
const GRAPH_FRESH_MS = 5 * 60_000
let graphCache: { data: KnowledgeGraph; at: number } | null = null
let graphPending: Promise<KnowledgeGraph> | null = null

export function loadKnowledgeGraph(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<KnowledgeGraph> {
  const { force = false, signal } = options
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  if (!force && graphCache && Date.now() - graphCache.at < GRAPH_FRESH_MS) return Promise.resolve(graphCache.data)
  if (!graphPending) {
    graphPending = fetchKnowledgeGraph()
      .then(data => { graphCache = { data, at: Date.now() }; return data })
      .finally(() => { graphPending = null })
  }
  if (!signal) return graphPending
  const shared = graphPending
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
