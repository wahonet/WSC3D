import { useWorkspaceAuth } from '../store/useWorkspaceAuth'

export type Material = { id: string; title: string; kind: 'image' | 'video'; origin: 'annotation' | 'seedream' | 'video'; tags: string[]; story: string; width: number; height: number; published: boolean; created_at: string; image_url: string; thumb_url: string; video_url: string | null; has_ink: boolean; source: { stone_id?: string; stone_name?: string; asset_id?: number; annotation_ids?: number[]; references?: { document_id: number; document_title: string; page_no: number; text: string }[] } }
export type Layer = { material_id: string; x: number; y: number; scale: number; tint: boolean }
export type Design = { template: 'postcard' | 'wallpaper' | 'card' | 'sticker'; palette: 'cinnabar' | 'jade' | 'midnight' | 'white'; title: string; greeting: string; signature: string; stamp: string; layers: Layer[] }
export type Template = { id: Design['template']; title: string; category: string; width: number; height: number; video: boolean; published: boolean; cover_url: string | null; design?: Design }
export type Catalogue = { materials: Material[]; templates: Template[]; palettes: Record<string, { title: string; bg: string; ink: string; accent: string }> }
export type Preview = { artwork: { x: number; y: number; width: number; height: number }; image: string; width: number; height: number; video: { url: string; x: number; y: number; width: number; height: number } | null }
export type Work = { id: string; status: string; design: Design; created_at: string; sources: Material[]; image_url: string; cover_url: string; video_url: string | null; share?: string | null; error?: string; width?: number; height?: number }
export type ImageSettings = { model: string; api_base: string; has_key: boolean; price_per_image: number; size: string }
export type ImageJob = { id: string; status: string; result_id?: string; material_id?: string; error?: string; created_at: string }
export type ImagePrepared = { id: string; title: string; style: string; prompt: string; image_url: string; width: number; height: number; source: Material['source'] }
export type ImageSubmission = { request_id: string; material_id: string | null; source_id?: string; style: string }
export class CreativeApiError extends Error { constructor(message: string, public status: number) { super(message) } }

async function request<T>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/creative/' + path, { method: method || (body === undefined ? 'GET' : 'POST'), cache: 'no-store', signal: signal || AbortSignal.timeout(40000),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  if (response.status === 401) useWorkspaceAuth.setState({ authenticated: false })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new CreativeApiError(typeof data.detail === 'string' ? data.detail : '请求失败，请检查输入后重试', response.status)
  }
  return response.json()
}
export const creativeApi = {
  catalogue: () => request<Catalogue>('catalogue'),
  preview: (design: Design, signal: AbortSignal) => request<Preview>('preview', design, undefined, signal),
  create: (id: string, design: Design) => request<Work>('works', { request_id: id, design }),
  work: (id: string) => request<Work>('works/' + id),
  works: () => request<Work[]>('works'),
  share: (id: string, enabled = true) => request<Work>(`works/${id}/share`, { enabled }),
  shared: (token: string) => request<Work>('share/' + encodeURIComponent(token)),
  materials: () => request<Material[]>('admin/materials'),
  importAnnotations: (ids: number[]) => request<Material>('admin/annotations', { annotation_ids: ids }),
  importVideo: (id: string) => request<Material>('admin/videos/' + id, {}),
  publish: (id: string, published: boolean, title?: string, tags?: string[]) => request<Material>(`admin/materials/${id}`, { published, title, tags }, 'PATCH'),
  templates: () => request<Template[]>('admin/templates'),
  saveTemplate: (id: string, published: boolean, design?: Design) => request<Template>(`admin/templates/${id}`, { published, design }, 'PATCH'),
  imageSettings: () => request<ImageSettings>('admin/image-settings'),
  saveImageSettings: (api_key: string, clear_key: boolean) => request<ImageSettings>('admin/image-settings', { api_key, clear_key }, 'PUT'),
  prepareImage: (annotation_ids: number[], style: string) => request<ImagePrepared>('admin/image-prepare', { annotation_ids, style }),
  generate: (body: ImageSubmission) => request<ImageJob>('admin/image-jobs', body),
  imageJobs: () => request<ImageJob[]>('admin/image-jobs'),
}

export function newDesign(template: Template, material: Material): Design {
  return { template: template.id, palette: 'cinnabar', title: material.title.split(' · ')[0].slice(0, 18), greeting: template.id === 'wallpaper' ? '循石迹 见汉风' : '把这一刻，寄给远方的你', signature: '', stamp: '汉风', layers: [{ material_id: material.id, x: 50, y: 50, scale: 1, tint: template.id === 'sticker' }] }
}
