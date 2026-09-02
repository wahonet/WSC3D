import type {
  Annotation, ProjectedAnnotation, ScanReport, SegDetection, SegEngineState, SegStatus, Stats,
  StoneInfo, StoneNode,
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
export const patchLayer = (stoneId: number, seq: number, summary: string) =>
  api.patch<StoneInfo>(`/stones/${stoneId}/layers/${seq}`, { summary })
export const setMaster = (stoneId: number, assetId: number) =>
  api.post<{ ok: boolean; message: string; rebased: number }>(`/stones/${stoneId}/master/${assetId}`)

/* ---- 标注 ---- */
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
}
export interface AnnotationPatchBody {
  label?: string; note?: string; color?: string
  desc_source?: string; desc_start?: number; desc_end?: number; desc_text?: string
  clear_link?: boolean
}

export const listAnnotations = (assetId: number) => api.get<Annotation[]>(`/annotations?asset_id=${assetId}`)
export const createAnnotation = (a: NewAnnotation) => api.post<Annotation>('/annotations', a)
export const createAnnotations = (items: NewAnnotation[]) => api.post<Annotation[]>('/annotations/batch', { items })
export const patchAnnotation = (id: number, body: AnnotationPatchBody) =>
  api.patch<Annotation>(`/annotations/${id}`, body)
export const deleteAnnotation = (id: number) => api.del<{ ok: boolean }>(`/annotations/${id}`)

/* ---- 分割 ---- */
type EnginesOut = { ok: boolean; error?: string | null; engines: Record<string, SegEngineState> }
export const segStatus = () => api.get<SegStatus>('/tools/segment/status')
export const segLoad = (engine: string) => api.post<EnginesOut>(`/tools/segment/load/${engine}`)
export const segUnload = (engine: string) => api.post<EnginesOut>(`/tools/segment/unload/${engine}`)
export const segPoint = (body: { asset_id: number; points: [number, number][]; labels: number[] }) =>
  api.post<{ ok: boolean; error?: string | null; polygons?: [number, number][][]; score?: number }>(
    '/tools/segment/point', body)
export const segText = (body: { asset_id: number; prompt: string; engine: string; threshold: number; max_results: number }) =>
  api.post<{ ok: boolean; error?: string | null; detections?: SegDetection[] }>('/tools/segment/text', body)

/* ---- 对齐 / 投影 ---- */
export const alignCommit = (body: {
  stone_id: number; left_asset_id: number; right_asset_id: number; geometry: Record<string, unknown>
}) => api.post<{ annotation: Annotation; chain_updates: string[]; warning: string }>('/align/commit', body)

export const getProjected = (assetId: number) =>
  api.get<{ ok: boolean; reason: string; items: ProjectedAnnotation[]; skipped_unaligned: number }>(
    `/assets/${assetId}/projected`)
