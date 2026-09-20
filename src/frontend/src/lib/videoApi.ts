import { useWorkspaceAuth } from '../store/useWorkspaceAuth'

export type VideoMode = 'multimodal' | 'fast'
export type VideoStyle = 'paper' | 'flat' | 'ink' | 'custom'
export type VideoOptions = { annotation_ids: number[]; mode: VideoMode; duration: 4 | 5; style: VideoStyle }
export type VideoDraft = VideoOptions & { stone_id: string; asset_id: number }
export type VideoSubmission = { request_id: string; source_id: string; prompt?: string }
export type VideoSource = { stone_id: string; stone_name: string; asset_id: number; annotation_ids: number[] }
export type VideoPrepared = {
  id: string; title: string; prompt: string; options: VideoOptions; image_url: string; width: number; height: number
  source: VideoSource & { filename: string; annotations: { id: number; label: string; selected: boolean }[]; references: { id: number; source_missing: boolean }[] }
}
export type VideoCatalogue = { id: string; name: string; assets: { id: number; filename: string; annotations: { id: number; label: string; parent_id: number | null; atype: string; review_status: string }[] }[] }[]
export type SourceGroups = { id: string; name: string; assets: { id: number; filename: string; count: number }[] }[]
export type SourceAnnotation = { id: number; label: string; parent_id: number | null; atype: string; review_status: string; updated_at: string; stone_id: string; stone_name: string; asset_id: number; filename: string }
export type SourcePage = { items: SourceAnnotation[]; total: number; offset: number; limit: number }
export type SourceQuery = { q?: string; stone_id?: string; asset_id?: number; offset?: number; limit?: number; ids?: number[] }
export type VideoJob = {
  title: string; prompt: string; duration: number; ratio: string; style: VideoStyle; mode: VideoMode; mode_label: string; source: VideoSource | null
  id: string; status: string; created_at: string; error: string; actual_duration: number | null
  model: string; resolution: string; estimated_cny: number; video_url: string | null; poster_url: string | null
}
export type VideoPolicy = { configured: boolean; error: string; default_mode: VideoMode; max_duration: number; modes: { id: VideoMode; label: string; model: string; resolution: string; durations: (4 | 5)[]; price_per_second: number }[] }
export class VideoApiError extends Error { constructor(message: string, public status: number) { super(message) } }

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/videos/' + path, {
    method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: signal || AbortSignal.timeout(30000),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (response.status === 401) useWorkspaceAuth.setState({ authenticated: false })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new VideoApiError(typeof data.detail === 'string' ? data.detail : '请求失败，请检查输入或稍后重试', response.status)
  }
  return response.json()
}
export const videoApi = {
  settings: () => request<VideoPolicy>('settings'),
  jobs: () => request<VideoJob[]>('jobs'),
  sources: () => request<VideoCatalogue>('sources'),
  sourceGroups: (signal?: AbortSignal) => request<SourceGroups>('source-groups', undefined, signal),
  annotations: (query: SourceQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams()
    Object.entries(query).forEach(([key, value]) => {
      if (Array.isArray(value)) value.forEach(id => params.append(key, String(id)))
      else if (value !== undefined && value !== '') params.set(key, String(value))
    })
    return request<SourcePage>('source-annotations?' + params, undefined, signal)
  },
  prepare: (body: VideoOptions) => request<VideoPrepared>('prepare', body),
  create: (body: VideoSubmission) => request<VideoJob>('jobs', body),
  refresh: (id: string) => request<VideoJob>(`jobs/${id}/refresh`, {}),
}
