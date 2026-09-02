/* 与后端 schemas.py 一一对应的接口类型。 */

export type AssetKind = 'photo' | 'photo_part' | 'rubbing' | 'model_high' | 'model_mid' | 'model_low'
export type GroupKey = 'model' | 'photo' | 'photo_part' | 'rubbing'

export interface AlignChain {
  s: number
  theta_deg: number
  tx: number
  ty: number
  master_asset_id: number
  via: string
  rmse_px?: number | null
}

export interface AssetBrief {
  id: number
  kind: AssetKind
  kind_label: string
  filename: string
  bytes: number
  width: number
  height: number
  fmt: string
  extra: {
    mtl?: string | null
    textures?: string[]
    is_master?: boolean
    align_to_master?: AlignChain | null
  }
  is_master: boolean
  in_frame: boolean
  has_preview: boolean
  annotation_count: number
}

export interface AssetGroup {
  key: GroupKey
  label: string
  assets: AssetBrief[]
}

export interface StoneNode {
  id: number
  code: string
  name: string
  asset_count: number
  annotation_count: number
  master_asset_id: number | null
  groups: AssetGroup[]
}

export interface LayerInfo { seq: number; name: string; summary: string }

export interface StoneInfo {
  id: number
  code: string
  name: string
  dirname: string
  era: string
  material: string
  carving: string
  dims_text: string
  location: string
  description: string
  layers: LayerInfo[]
  annotation_count: number
  asset_count: number
  updated_at: string | null
}

export interface Stats {
  stones: number
  assets: number
  assets_2d: number
  assets_3d: number
  annotations: number
  linked_annotations: number
  previews_cached: number
  preview_cache_bytes: number
  db_bytes: number
  version: string
}

export type AType = 'rect' | 'polygon' | 'point' | 'line' | 'point3d' | 'line3d' | 'align'

export interface Annotation {
  id: number
  stone_id: number
  asset_id: number
  tool: string
  atype: AType
  geometry: Record<string, unknown>
  label: string
  note: string
  color: string
  value: number | null
  unit: string
  desc_source: string
  desc_start: number | null
  desc_end: number | null
  desc_text: string
  created_at: string
  updated_at: string | null
}

export interface ProjectedAnnotation {
  id: number
  label: string
  color: string
  tool: string
  atype: 'polygon' | 'point' | 'line'
  geometry: Record<string, unknown>
  source_asset_id: number
  source_filename: string
  value: number | null
  unit: string
}

export type Tool = 'select' | 'annotate' | 'measure' | 'segment' | 'align'
export type AnnotateShape = 'rect' | 'polygon' | 'point'

/* ---------------- 分割 ---------------- */
export type SegEngine = 'mobilesam' | 'sam3' | 'sam3.1'

export interface SegEngineState { status: 'idle' | 'loading' | 'ready' | 'error' | string; detail: string }

export interface SegStatus {
  worker: {
    python: string | null
    available: boolean
    alive: boolean
    gpu: string | null
    cuda: boolean | null
    torch: string | null
    vram_used_mb: number | null
    log: string
  }
  weights: Record<string, { file: string | null; exists: boolean; bytes: number }>
  engines: Record<string, SegEngineState>
}

export interface SegPoint { p: [number, number]; label: 0 | 1 }
export interface SegDetection {
  polygon: [number, number][]
  score: number
  box?: [number, number, number, number] | null   // 归一化 x0,y0,x1,y1
}

/** SAM3 示例框：归一化中心 + 宽高；label 1 正例 / 0 负例 */
export interface ExemplarBox { cx: number; cy: number; w: number; h: number; label: 0 | 1 }
export type SegPreprocess = 'none' | 'enhance' | 'rubbing'
export type SegTiling = 'none' | 'preview' | 'hires'
export type SegPromptMode = 'text' | 'box'

/* ---------------- 对齐 ---------------- */
export interface AlignGeometry {
  target_asset_id: number
  pairs: { a: [number, number]; b: [number, number] }[]
  s: number
  theta_deg: number
  tx: number
  ty: number
  rmse_px: number
  wl: number; hl: number; wr: number; hr: number
}

export interface OverlayTransform { xVp: number; yVp: number; wVp: number; deg: number }

export interface OverlaySpec {
  assetId: number
  opacity: number
  transform: OverlayTransform | null
}

export interface ScanReport {
  stones: number
  assets_added: number
  assets_updated: number
  assets_kept: number
  assets_removed: number
  previews_invalidated: number
  masters_assigned: { stone: string; asset_id: number; filename: string }[]
  previews_warming: number
  duration_ms: number
}
