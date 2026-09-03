import type {
  Annotation, Concept, DocFigure, DocSegment, DocumentInfo, ExemplarBox, GeometryIntent, Level, OcrEngine, OcrJob,
  OcrStatus, PageBrief, PageDetail, ParentSuggestion, ProjectedAnnotation, Quality, ReviewStatus, ScanReport,
  SearchHit, SegDetection, SegEngineState, SegPreprocess, SegStatus, SegTiling, SegmentKind, SegmentReview, Semantics,
  SkeletonItem, Stats, StoneInfo, StoneNode, Taxonomy,
} from './types'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response
  try {
    r = await fetch(`/api${path}`, init)
  } catch {
    throw new ApiError(0, '无法连接后端服务（127.0.0.1:8020）')
  }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try {
      const body = await r.json()
      if (typeof body.detail === 'string') msg = body.detail
      else if (Array.isArray(body.detail)) msg = body.detail.map((d: { msg: string }) => d.msg).join('；')
    } catch { /* 非 JSON 响应 */ }
    throw new ApiError(r.status, msg)
  }
  return r.json()
}

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'POST', ...(body !== undefined ? json(body) : {}) }),
  patch: <T>(p: string, body: unknown) => request<T>(p, { method: 'PATCH', ...json(body) }),
  del: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
}

/* ---- 文件 URL ---- */
export const previewUrl = (assetId: number) => `/api/assets/${assetId}/preview`
export const thumbUrl = (assetId: number) => `/api/assets/${assetId}/thumb`
export const modelUrl = (assetId: number, fname: string) =>
  `/api/assets/${assetId}/model/${encodeURIComponent(fname)}`

/* ---- 系统 ---- */
export const getStats = () => api.get<Stats>('/stats')
export const scanAssets = () => api.post<ScanReport>('/scan')

/* ---- 石头 ---- */
export const listStones = () => api.get<StoneNode[]>('/stones')
export const getStone = (id: number) => api.get<StoneInfo>(`/stones/${id}`)
export const stoneAnnotations = (stoneId: number) => api.get<Annotation[]>(`/stones/${stoneId}/annotations`)

export interface StonePatchBody {
  era?: string; material?: string; carving?: string
  dims_text?: string; location?: string; description?: string
}
export const patchStone = (stoneId: number, body: StonePatchBody) =>
  api.patch<StoneInfo>(`/stones/${stoneId}`, body)
export const patchLayer = (stoneId: number, seq: number, summary: string, name?: string) =>
  api.patch<StoneInfo>(`/stones/${stoneId}/layers/${seq}`, { summary, name })
export const setMaster = (stoneId: number, assetId: number) =>
  api.post<{ ok: boolean; message: string; rebased: number }>(`/stones/${stoneId}/master/${assetId}`)

/* ---- 标注 / 结构节点 ---- */
export interface NewAnnotation {
  stone_id: number
  asset_id: number
  tool: string
  atype: Annotation['atype']
  geometry: Record<string, unknown>
  label?: string
  note?: string
  color?: string
  value?: number | null
  unit?: string
  parent_id?: number | null
  level?: Level
  category?: string
  seq?: number | null
  review_status?: ReviewStatus
  concept_ids?: number[]
  /** 未给 parent_id 时按几何包含自动挂到最贴合的容器节点并推断层级 */
  auto_parent?: boolean
}
export interface AnnotationPatchBody {
  label?: string; note?: string; color?: string
  desc_source?: string; desc_start?: number; desc_end?: number; desc_text?: string
  clear_link?: boolean
  parent_id?: number; clear_parent?: boolean
  level?: Level; category?: string; seq?: number; clear_seq?: boolean
  review_status?: ReviewStatus; quality?: Quality; geometry_intent?: GeometryIntent
  semantics?: Semantics
  concept_ids?: number[]
  /** 三者齐全即给节点挂接（替换）几何 */
  asset_id?: number; atype?: Annotation['atype']; geometry?: Record<string, unknown>
}
export interface AnnotationBatchItem {
  id: number
  label?: string; note?: string; color?: string
  parent_id?: number; clear_parent?: boolean
  level?: Level; category?: string; seq?: number; review_status?: ReviewStatus
}

export const listAnnotations = (assetId: number) => api.get<Annotation[]>(`/annotations?asset_id=${assetId}`)
export const createAnnotation = (a: NewAnnotation) => api.post<Annotation>('/annotations', a)
export const createAnnotations = (items: NewAnnotation[]) => api.post<Annotation[]>('/annotations/batch', { items })
export const patchAnnotation = (id: number, body: AnnotationPatchBody) =>
  api.patch<Annotation>(`/annotations/${id}`, body)
export const patchAnnotations = (items: AnnotationBatchItem[]) =>
  api.patch<Annotation[]>('/annotations/batch', { items })
export const deleteAnnotation = (id: number) => api.del<{ ok: boolean; message: string }>(`/annotations/${id}`)
export const deleteAnnotations = (ids: number[]) =>
  api.post<{ ok: boolean; message: string }>('/annotations/batch-delete', { ids })
export const parentSuggestions = (id: number) => api.get<ParentSuggestion[]>(`/annotations/${id}/parent-suggestions`)
export const adoptGeometry = (id: number, sourceId: number) =>
  api.post<Annotation>(`/annotations/${id}/adopt`, { source_id: sourceId })

/* ---- 结构：自动归类 / 骨架 ---- */
export const autoParent = (stoneId: number, body: { ids?: number[]; only_orphans?: boolean; min_ratio?: number; include_candidates?: boolean }) =>
  api.post<{ assigned: number; skipped: number; details: string[] }>(`/stones/${stoneId}/structure/auto-parent`, body)
export const skeletonPreview = (stoneId: number) =>
  api.get<{ items: SkeletonItem[]; asset_id: number | null }>(`/stones/${stoneId}/structure/skeleton`)
export const skeletonCreate = (stoneId: number, items: SkeletonItem[], assetId: number | null) =>
  api.post<{ created: number; linked: number; skipped_links: string[]; annotations: Annotation[] }>(
    `/stones/${stoneId}/structure/skeleton`, { items, asset_id: assetId })

/* ---- 文献库 / OCR ---- */
export const libraryScan = () => api.post<{ documents: number; added: number; updated: number; removed: number }>('/library/scan')
export const listDocuments = () => api.get<DocumentInfo[]>('/library/documents')
export const patchDocument = (id: number, body: Partial<Pick<DocumentInfo, 'title' | 'authors' | 'year' | 'publisher' | 'kind' | 'script' | 'notes'>>) =>
  api.patch<DocumentInfo>(`/library/documents/${id}`, body)
export const listDocPages = (docId: number, offset = 0, limit = 500) =>
  api.get<PageBrief[]>(`/library/documents/${docId}/pages?offset=${offset}&limit=${limit}`)
export const getPageDetail = (pageId: number) => api.get<PageDetail>(`/library/pages/${pageId}`)
export const pageImageUrl = (pageId: number, dpi = 0) => `/api/library/pages/${pageId}/image${dpi ? `?dpi=${dpi}` : ''}`
export const figureImageUrl = (figureId: number) => `/api/library/figures/${figureId}/image`
export const docFileUrl = (docId: number) => `/api/library/documents/${docId}/file`
export const ocrStatus = () => api.get<OcrStatus>('/library/ocr/status')
export const startOcr = (docId: number, body: { engine?: OcrEngine | null; pages?: number[] | null; redo?: boolean; backend?: string }) =>
  api.post<OcrJob>(`/library/documents/${docId}/ocr`, body)
export const cancelOcr = () => api.post<OcrJob>('/library/ocr/cancel')
export const patchSegment = (id: number, body: { text_edit?: string; kind?: SegmentKind; review_status?: SegmentReview; note?: string; base_revision?: number }) =>
  api.patch<DocSegment>(`/library/segments/${id}`, body)
export const patchFigure = (id: number, body: { caption?: string; label?: string; review_status?: SegmentReview; note?: string }) =>
  api.patch<DocFigure>(`/library/figures/${id}`, body)
export const searchLibrary = (q: string, documentId?: number | null, limit = 50) =>
  api.get<SearchHit[]>(`/library/search?q=${encodeURIComponent(q)}${documentId ? `&document_id=${documentId}` : ''}&limit=${limit}`)

/* ---- 概念 ---- */
export const getTaxonomy = () => api.get<Taxonomy>('/concepts/taxonomy')
export const listConcepts = () => api.get<Concept[]>('/concepts')
export const createConcept = (body: { name: string; category_id: string; aliases?: string[]; description?: string }) =>
  api.post<Concept>('/concepts', body)
export const patchConcept = (id: number, body: { name?: string; category_id?: string; aliases?: string[]; description?: string }) =>
  api.patch<Concept>(`/concepts/${id}`, body)
export const deleteConcept = (id: number) => api.del<{ ok: boolean; message: string }>(`/concepts/${id}`)

/* ---- 分割 ---- */
type EnginesOut = { ok: boolean; error?: string | null; engines: Record<string, SegEngineState> }
export const segStatus = () => api.get<SegStatus>('/tools/segment/status')
export const segLoad = (engine: string) => api.post<EnginesOut>(`/tools/segment/load/${engine}`)
export const segUnload = (engine: string) => api.post<EnginesOut>(`/tools/segment/unload/${engine}`)
export const segPoint = (body: { asset_id: number; points: [number, number][]; labels: number[] }) =>
  api.post<{ ok: boolean; error?: string | null; polygons?: [number, number][][]; score?: number }>(
    '/tools/segment/point', body)
export interface SegTextBody {
  asset_id: number
  prompt: string
  engine: string
  threshold: number
  max_results: number
  boxes?: ExemplarBox[]
  preprocess?: SegPreprocess
  invert?: boolean
  tiling?: SegTiling
}
export const segText = (body: SegTextBody) =>
  api.post<{
    ok: boolean; error?: string | null; detections?: SegDetection[]
    tiles?: number | null; exemplars?: number | null; preprocess?: string | null
  }>('/tools/segment/text', body)

/** 分割预处理效果图（与预览同尺寸，可直接替换查看器图源） */
export const preprocessedUrl = (assetId: number, mode: SegPreprocess, invert: boolean) =>
  `/api/assets/${assetId}/preprocessed?mode=${mode}&invert=${invert ? 'true' : 'false'}`

/* ---- 对齐 / 投影 ---- */
export const alignCommit = (body: {
  stone_id: number; left_asset_id: number; right_asset_id: number; geometry: Record<string, unknown>
}) => api.post<{ annotation: Annotation; chain_updates: string[]; warning: string }>('/align/commit', body)

export const getProjected = (assetId: number) =>
  api.get<{ ok: boolean; reason: string; items: ProjectedAnnotation[]; skipped_unaligned: number }>(
    `/assets/${assetId}/projected`)
