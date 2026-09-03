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

/** ellipse = 圆 / 椭圆 {cx,cy,rx,ry}；none = 尚无几何的骨架节点（先由释文生成，之后绘制或并入候选几何） */
export type AType = 'rect' | 'ellipse' | 'polygon' | 'point' | 'line' | 'point3d' | 'line3d' | 'align' | 'none'

/* ---------------- 结构树（沿用 WSC3D 标注 SOP） ---------------- */
export type Level = '' | 'whole' | 'band' | 'layer' | 'scene' | 'figure' | 'component' | 'inscription' | 'trace' | 'damage'
export type ReviewStatus = 'candidate' | 'reviewed' | 'approved' | 'rejected'
export type Quality = '' | 'weak' | 'silver' | 'gold'
export type GeometryIntent = '' | 'visible_trace' | 'semantic_extent' | 'reconstructed_extent'

export interface InscriptionSem { transcription: string; translation: string; notes: string }
/** 图像志三层文本（Panofsky）+ 榜题 */
export interface Semantics {
  pre_iconographic: string
  iconographic: string
  iconological: string
  inscription: InscriptionSem
}
export const EMPTY_SEMANTICS: Semantics = {
  pre_iconographic: '', iconographic: '', iconological: '',
  inscription: { transcription: '', translation: '', notes: '' },
}

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
  parent_id: number | null
  level: Level
  category: string
  seq: number | null
  review_status: ReviewStatus
  quality: Quality
  geometry_intent: GeometryIntent
  semantics: Semantics
  concept_ids: number[]
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
  level: Level
  review_status: ReviewStatus
}

export interface ParentSuggestion { id: number; label: string; level: Level; ratio: number; area_ratio: number }

export interface SkeletonItem {
  key: string
  parent_key: string | null
  parent_label: string
  level: Level
  label: string
  seq: number | null
  category: string
  desc_source: string | null
  desc_start: number | null
  desc_end: number | null
  transcription: string
  concept_names: string[]
  exists: boolean
  excerpt: string
}

/* ---------------- 文献库 / OCR ---------------- */
export type OcrEngine = 'mineru' | 'ndl'
export type SegmentKind = 'text' | 'title' | 'caption' | 'footnote' | 'header' | 'page_number' | 'table' | 'equation' | 'list' | 'line' | 'other'
export type SegmentReview = 'machine' | 'reviewed' | 'rejected'

export interface DocumentInfo {
  id: number
  code: string
  title: string
  authors: string
  year: string
  publisher: string
  kind: 'book' | 'article' | 'catalog' | 'other'
  script: 'modern' | 'classical'
  relpath: string
  filename: string
  bytes: number
  page_count: number
  has_text_layer: boolean
  notes: string
  pages_done: number
  pages_error: number
  segments: number
  figures: number
  updated_at: string | null
}

export interface PageBrief {
  id: number
  page_no: number
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped'
  engine: string
  width: number
  height: number
  segments: number
  figures: number
  snippet: string
  error: string
}

export interface DocSegment {
  id: number
  document_id: number
  page_id: number
  page_no: number
  seq: number
  kind: SegmentKind | string
  text: string
  text_edit: string
  bbox: [number, number, number, number]
  confidence: number | null
  review_status: SegmentReview
  revision: number
  note: string
}

export interface DocFigure {
  id: number
  document_id: number
  page_id: number
  page_no: number
  seq: number
  bbox: [number, number, number, number]
  caption: string
  label: string
  review_status: SegmentReview
  note: string
  has_image: boolean
}

export interface PageDetail {
  id: number
  document_id: number
  document_code: string
  document_title: string
  page_no: number
  page_count: number
  status: string
  engine: string
  width: number
  height: number
  text: string
  error: string
  stats: Record<string, unknown>
  segments: DocSegment[]
  figures: DocFigure[]
}

export interface OcrJob {
  running: boolean
  document_id: number | null
  engine: string
  total: number
  done: number
  errors: number
  current_page: number | null
  started_at: string | null
  finished_at: string | null
  message: string
  cancel_requested: boolean
}

export interface OcrStatus {
  workers: { engine: string; python: string | null; available: boolean; alive: boolean; detail: string }[]
  job: OcrJob
  log: string
}

export interface SearchHit {
  segment_id: number
  document_id: number
  document_code: string
  document_title: string
  page_id: number
  page_no: number
  kind: string
  /** 命中片段，命中词用 [[ ]] 包住 */
  snippet: string
  text: string
}

export interface SearchFacet {
  document_id: number
  document_code: string
  document_title: string
  count: number
}

export interface SearchOut {
  q: string
  total: number
  offset: number
  hits: SearchHit[]
  /** 各书命中数（不受 document_id 过滤） */
  facets: SearchFacet[]
}

/* ---------------- 概念 ---------------- */
export interface ConceptCategory { id: string; name: string; parent_id: string | null }
export interface Concept {
  id: number
  name: string
  category_id: string
  aliases: string[]
  description: string
  usage: number
}
export interface Taxonomy {
  categories: ConceptCategory[]
  levels: Record<string, string>
  sop_categories: Record<string, string>
  review_statuses: Record<string, string>
  qualities: Record<string, string>
  geometry_intents: Record<string, string>
}

export type Tool = 'select' | 'annotate' | 'measure' | 'segment'
export type AnnotateShape = 'rect' | 'ellipse' | 'polygon' | 'point'

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
