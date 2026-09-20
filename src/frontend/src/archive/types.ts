/** 档案简要(列表项, GET /api/stones) */
export interface StoneBrief {
  id: string;
  name: string;
  location: string;
  size_cm: [number, number, number] | null;
  size_source: 'measured' | 'registry' | 'estimated' | null;
  condition: string;
  note: string;
  photo_count: number;
  has_model: boolean;
  size_display?: string;
  has_rubbing: boolean;
  has_intro: boolean;
  legacy_id: string;
  catalogue_no: string;
  classification_no: string;
  /** 策展／专题组合，与历史组属分别记录。 */
  collections?: string[];
  display_order: number;
  aliases: string[];
  grading: Grading | null;
  is_graded: boolean;
  media_keywords: string;
}

export interface Grading {
  level: string;
  confirmed: boolean;
  basis: string;
  authority?: string;
  document_no?: string;
  appraisal_date?: string;
  issued_date?: string;
  report?: string;
  report_name?: string;
  report_identifier?: string;
  report_row?: string;
  pdf_page?: number;
  printed_page?: number;
  set_name?: string;
  set_count?: number;
}

export interface MediaItem {
  id: string;
  label: string;
  url: string;
  thumbnail_url: string;
  original_url: string;
  original_name?: string;
  image_size?: number[];
  bytes?: number;
}

export interface MediaVersion {
  id: string;
  label: string;
  kind: 'photo' | 'rubbing';
  items: MediaItem[];
}

/** 照片批次(photos/<批次名>/ 子文件夹, batch='' 为未分批散图) */
export interface PhotoBatch {
  batch: string;
  photos: string[];        // 文件URL
}

/** 书籍著录条目(石刻 -> 书籍反查) */
export interface BookRef {
  book: string;            // 书籍档案夹ID
  title: string;
  year: string;
  loc: string;             // 页码/图版
  note: string;
}

/** 档案详情(GET /api/stones/:id) */
export interface StoneDetail extends StoneBrief {
  era: string;
  category: string;
  group: string;
  surveyed: string;
  intro: string;
  photos: string[];        // 全部照片URL(按批次顺序平铺)
  photo_batches: PhotoBatch[];
  book_refs: BookRef[];
  model: string | null;    // gltf URL
  model_info?: { label: string; description: string; view?: [number, number, number] };
  rubbing: string | null;  // 拓片URL
  media_versions: MediaVersion[];
  technique: string;
  material: string;
  position_code: string;
  research: string;
  catalogue: { name?: string; size?: string; era?: string; source?: string; file?: string; sheet?: string; row?: number };
}

/** 书籍/文献(GET /api/books) */
export interface Book {
  quality?: { readable: boolean; indexed_pages: number; pages?: number; sha256: string; duplicate_core: number | null };
  id: string;
  title: string;
  author: string;
  publisher: string;
  year: string;
  category: string;        // 武氏祠/武梁祠/汉画像石/外文与综合('' = 手工登记)
  kind: string;            // 专著/期刊论文/学位论文/图录…
  theme: string;
  source: string;          // 来源平台
  url: string;             // 落地页
  pages: string;
  pdf: string | null;      // 全文PDF URL(文献库内)
  note: string;
  cover: string | null;
  refs: { stone: string; loc?: string; note?: string; stone_name?: string }[];
  ref_count: number;
  completeness?: string;
  import_batch?: string;
  original_pdf?: string | null;
  text_index?: { total_pages: number; text_pages: number; ocr_pages: number; indexed_pages: number; ocr_checked_pages?: number; note?: string };
}

export interface Stats {
  total: number;
  by_location: Record<string, number>;
  by_area: Record<string, number>;
  measured: number;
  with_model: number;
  with_photos: number;
  books: number;
}

export type ViewKey = 'pan' | 'gate' | 'que' | 'xcl' | 'hall' | 'bl' | 'center' | 'site';

/** 工作台模块 */
export type ModuleKey = 'ledger' | 'scene' | 'books' | 'search';

/* ---------- RAG 检索 ---------- */
export interface RagStatus {
  ready: boolean;
  building: boolean;
  error: string;
  chunks: number;
  built_at: string;
  llm: boolean;          // 已配置大模型
  model: string;
  model_mode: 'online_first' | 'local_only';
  online_configured: boolean;
  model_provider: string;
  local_model: string;
  dense_configured: boolean;   // 已配置embedding模型
  dense_ready: boolean;        // 语义向量已就绪(混合检索生效)
  dense_building: boolean;
  dense_model: string;
  dense_done: number;          // 向量化进度
  dense_n: number;
  dense_error: string;
}

/** 知识库片段(向量检索命中) */
export interface RagChunk {
  id: number;
  kind: 'stone' | 'book' | 'base' | 'doc' | 'text';
  ref: string;           // stone id / book id / 07文档相对路径
  title: string;
  page: number;          // 权威底本PDF页(kind=base)
  score: number;
  snippet: string;
  text: string;
}

/** 结构化事实命中 */
export interface CatalogueAggregate {
  kind: 'catalogue';
  complete: boolean;
  count: number;
  unit: string;
  scope: string;
  scanned_archives: number;
  by_area: { name: string; count: number }[];
  by_location: { name: string; count: number }[];
  items: { id: string; catalogue_no: string; name: string; location: string; group: string; category: string }[];
}

export interface SearchFacts {
  objects: StoneSearchResult[];
  object_count: number;
  object_notice?: string;
  aggregate?: CatalogueAggregate;
  stones: { id: string; name: string; location: string; exact: boolean; catalogue_no?: string; is_graded?: boolean }[];
  books: { id: string; title: string; year: string; author: string; exact: boolean }[];
  facts: { stone: string; book: string; book_title: string; year: string; loc: string; note: string }[];
  images?: { id: string; stone: string; stone_name: string; catalogue_no: string; label: string; version: string; url: string; thumbnail_url: string; related?: boolean; location?: string }[];
  related_objects?: { id: string; name: string; catalogue_no: string; location: string; note: string }[];
  image_count?: number;
}

export interface SearchResult extends SearchFacts {
  chunks: RagChunk[];
  rag: RagStatus;
}

export interface AskResult {
  question: string;
  answer: string | null;
  model: string;
  notice: string;
  provider: string;
  route: 'online' | 'local' | 'unavailable' | 'catalogue' | 'verified';
  facts: SearchFacts;
  sources: RagChunk[];
  rag: RagStatus;
}

export interface StoneSearchResult {
  id: string;
  name: string;
  catalogue_no: string;
  location: string;
  thumbnail_url: string | null;
  href: string;
  match_reason: string;
  match_kind: 'catalogue' | 'identity' | 'text' | 'related_text' | 'literature';
}

export interface LlmProfile {
  label: string; api_base: string; model: string; models: string[]; has_key: boolean; help_url: string;
  api_key?: string; clear_key?: boolean;
}
export interface LlmSettings {
  mode: 'online_first' | 'local_only';
  provider: string;
  profiles: Record<string, LlmProfile>;
  local: { model: string; api_base: string; models: string[]; available: boolean | null };
}

/** 台账预览页签 */
export type TabKey = 'model' | 'photos' | 'rubbing';
