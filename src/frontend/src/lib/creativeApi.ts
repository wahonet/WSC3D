import { useWorkspaceAuth } from '../store/useWorkspaceAuth'

export type Palette = 'cinnabar' | 'jade' | 'midnight' | 'white'
export type ProductId = 'wallpaper' | 'postcard' | 'postcard_video' | 'card' | 'emoji' | 'avatar'
export type CustomProduct = 'wallpaper' | 'postcard' | 'card' | 'avatar'
export type Hall = { id: string; name: string; chapter: string; seal: string }
export type StoryRef = { document_id: number; document_title: string; page_no: number; text: string }
export type ProductFile = { name: string; url: string; kind: 'image' | 'video'; thumb_url: string; width?: number; height?: number }
export type Product = { id: ProductId; title: string; use: string; files: ProductFile[]; thumb_url: string; customizable: boolean; printable: boolean }
export type Theme = {
  id: string; title: string; hook: string; story: string; story_refs: StoryRef[]; stone_id: string; stone_name: string; hall: Hall | null; order: number
  greetings: string[]; palette: Palette; line_kind: 'line' | 'rubbing'; color_count: number; has_video: boolean
  art: { original: string | null; line: string | null; colors: string[]; clip: string | null }; cover_url: string | null; products: Product[]; published_at: string | null
}
export type Step = { key: 'project' | 'original' | 'line' | 'color' | 'video' | 'story' | 'products' | 'publish'; title: string; done: boolean; detail: string; optional: boolean }
export type Sticker = { phrase: string; crop: number[]; accent?: boolean }
export type Review = { status?: string; reviewer?: string; at?: string; note?: string; checklist?: Record<string, boolean>; material_id?: string; count?: number }
export type AdminTheme = Theme & {
  status: 'draft' | 'published'; subject: string; annotation_ids: number[]; annotations: { id: number; label: string; status: string }[]
  emoji: Sticker[]; avatar_crop: number[] | null; assets: { original: string | null; line: string | null; colors: string[]; video: string | null }
  approvals: { line?: Review; colors?: Review }; created_at: string; updated_at: string; steps: Step[]; rendered_at: string | null; theme_url: string
}
export type ThemeChanges = Partial<Pick<AdminTheme, 'title' | 'hook' | 'story' | 'subject' | 'story_refs' | 'annotation_ids' | 'order' | 'greetings' | 'emoji' | 'avatar_crop' | 'palette'>> & { hall?: string | null }
export type Venue = {
  idle_seconds: number; print_enabled: boolean; wifi_ssid: string; wifi: string | null; base_url: string; halls: Hall[]
  palettes: Record<Palette, { title: string; bg: string; ink: string; accent: string }>; products: Record<string, { title: string; use: string; width: number; height: number }>
  home_qr: string; wifi_qr: string | null
}
export type Design = { theme: string; product: CustomProduct; palette: Palette; art: 'color' | 'line'; variant: number; greeting: string; signature: string; motion: boolean }
export type Work = { id: string; status: 'queued' | 'rendering' | 'succeeded' | 'failed'; design: Design; theme: string; title: string; created_at: string; width?: number; height?: number; error?: string; files: ProductFile[]; ahead?: number }
export type Handoff = { token: string; url: string; expires_at: string; qr: string }
export type Pickup = { title: string; product: ProductId; product_title: string; theme: { id: string; title: string; stone_id: string; stone_name: string }; files: ProductFile[]; expires_at: string }
export type StampBook = { halls: Hall[]; collected: string[]; complete: boolean; card_url: string | null; hall?: string; fresh?: boolean }
export type PrintTicket = { id: string; title: string; status: 'queued' | 'printed' | 'cancelled'; number: number; created_at: string; image_url?: string }
export type Material = {
  id: string; title: string; kind: 'image' | 'video'; origin: string; tags: string[]; width: number; height: number; published: boolean; created_at: string
  image_url: string; thumb_url: string; video_url: string | null; has_ink: boolean; theme: string | null; role: string | null; style: string | null; review: Review | null
  candidate_for?: 'line' | 'color' | 'video' | null; coverage?: number | null; prompt?: string | null
  source: { stone_id?: string; stone_name?: string; asset_id?: number; annotation_ids?: number[]; references?: StoryRef[] }
}
export type ImageSettings = { model: string; api_base: string; has_key: boolean; price_per_image: number; size: string }
export type ImageJob = { id: string; kind?: string; status: string; theme?: string; role?: 'line' | 'color'; style?: string | null; count?: number; done?: number; results?: string[]; error?: string; created_at: string }
export type AdminVenue = { base_url: string; auto_base_url: boolean; idle_seconds: number; wifi_ssid: string; wifi_password: string; wifi_security: 'WPA' | 'WEP' | 'nopass'; print_enabled: boolean; wifi: string | null; stamps: (Hall & { url: string })[] }
export type Ranked = { key: string; title: string; count: number }
export type Stats = { days: ({ date: string } & Record<string, number | string>)[]; totals: Record<string, number>; views: Ranked[]; downloads: Ranked[]; works: Ranked[]; stamps: Record<string, number> }
export type Approval = { role: 'line' | 'rubbing' | 'color' | 'video'; material_id?: string | null; selected?: boolean; checklist?: Record<string, boolean>; reviewer?: string; note?: string }
export class CreativeApiError extends Error { constructor(message: string, public status: number) { super(message) } }

async function request<T>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/creative/' + path, { method: method || (body === undefined ? 'GET' : 'POST'), cache: 'no-store', signal: signal || AbortSignal.timeout(90000),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  if (response.status === 401) useWorkspaceAuth.setState({ authenticated: false })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    const detail = typeof data.detail === 'string' ? data.detail : Array.isArray(data.detail) ? '填写的内容不符合要求，请检查后重试' : ''
    throw new CreativeApiError(detail || (response.status === 429 ? '操作较频繁，请稍候' : '请求失败，请稍后重试'), response.status)
  }
  return response.json()
}

/** Visitor routes: published themes, local variants, take-away codes and stamps. None of them calls a model. */
export const creativeApi = {
  venue: () => request<Venue>('venue'),
  themes: () => request<Theme[]>('themes'),
  theme: (id: string, view = false) => request<Theme>(`themes/${id}${view ? '?view=1' : ''}`),
  preview: (design: Design, signal: AbortSignal) => request<{ image: string; width: number; height: number }>('preview', design, undefined, signal),
  createWork: (request_id: string, design: Design) => request<Work>('works', { request_id, design }),
  work: (id: string) => request<Work>('works/' + id),
  works: () => request<Work[]>('works'),
  handoff: (target: { work_id?: string; theme?: string; product?: ProductId }) => request<Handoff>('handoff', target),
  pickup: (token: string) => request<Pickup>('take/' + encodeURIComponent(token)),
  reset: () => request<{ ok: boolean }>('session/reset', {}),
  stamps: () => request<StampBook>('stamps'),
  collect: (hall: string, code: string) => request<StampBook>('stamps', { hall, code }),
  print: (target: { work_id?: string; theme?: string; product?: 'postcard' | 'emoji' }) => request<PrintTicket>('prints', target),
}

/** Workbench routes behind the workspace login. */
export const studioApi = {
  themes: () => request<AdminTheme[]>('admin/themes'),
  theme: (id: string) => request<AdminTheme>('admin/themes/' + id),
  create: (body: ThemeChanges & { id: string; title: string; annotation_ids: number[] }) => request<AdminTheme>('admin/themes', body),
  update: (id: string, body: ThemeChanges) => request<AdminTheme>('admin/themes/' + id, body, 'PATCH'),
  remove: (id: string) => request<{ ok: boolean }>('admin/themes/' + id, undefined, 'DELETE'),
  original: (id: string) => request<AdminTheme>(`admin/themes/${id}/original`, {}),
  materials: (id: string) => request<Material[]>(`admin/themes/${id}/materials`),
  candidates: (id: string, body: { request_id: string; role: 'line' | 'color'; style?: string | null; count: number }) => request<ImageJob>(`admin/themes/${id}/candidates`, body),
  adopt: (id: string, material_id: string, role: 'line' | 'color' | 'video') => request<Material>(`admin/themes/${id}/adopt`, { material_id, role }),
  approve: (id: string, body: Approval) => request<AdminTheme>(`admin/themes/${id}/approve`, body),
  render: (id: string) => request<AdminTheme>(`admin/themes/${id}/render`, {}, undefined, AbortSignal.timeout(300000)),
  publish: (id: string, published: boolean) => request<AdminTheme>(`admin/themes/${id}/publish`, { published }, undefined, AbortSignal.timeout(300000)),
  storyDraft: (id: string) => request<{ hook: string; story: string; length: number; model?: string; notice?: string }>(`admin/themes/${id}/story-draft`, {}, undefined, AbortSignal.timeout(180000)),
  library: () => request<Material[]>('admin/materials'),
  importVideo: (jobId: string) => request<Material>('admin/videos/' + jobId, {}),
  imageJobs: () => request<ImageJob[]>('admin/image-jobs'),
  venue: () => request<AdminVenue>('admin/venue'),
  saveVenue: (body: Omit<AdminVenue, 'auto_base_url' | 'wifi' | 'stamps'>) => request<AdminVenue>('admin/venue', body, 'PUT'),
  stats: (days = 30) => request<Stats>('admin/stats?days=' + days),
  prints: () => request<PrintTicket[]>('admin/prints'),
  markPrint: (id: string, status: PrintTicket['status']) => request<PrintTicket>('admin/prints/' + id, { status }),
  imageSettings: () => request<ImageSettings>('admin/image-settings'),
  saveImageSettings: (api_key: string, clear_key: boolean) => request<ImageSettings>('admin/image-settings', { api_key, clear_key }, 'PUT'),
}

export const CHECKLIST: [string, string][] = [
  ['count', '人物、动物数量与原石一致'], ['objects', '器物齐全，没有改成别的器物'], ['orientation', '朝向与姿态一致'],
  ['inscription', '榜题没有臆补文字'], ['nothing_added', '没有新增人物、器物或背景'],
]
export const STYLES: [string, string][] = [['paper', '汉画套色版画'], ['ink', '青绿淡彩'], ['night', '星河汉梦'], ['mineral', '矿物彩']]
export const PALETTE_NAMES: Record<Palette, string> = { cinnabar: '朱砂', jade: '青玉', midnight: '星夜', white: '墨白' }
export const ART_LABEL = { original: '原石拓片 · 依据', line: '线描 · 据原石整理', rubbing: '拓片底稿 · 待线描', color: '彩色演绎 · 艺术演绎', clip: '动态短片 · 艺术演绎' } as const
