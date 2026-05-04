/**
 * 后端共享类型定义
 *
 * 后端层（catalog / parser / server）共用的数据结构。前端有一份语义对应的
 * 类型在 `frontend/src/api/client.ts`，两端字段保持手动同步。
 *
 * - `DimensionData` / `LayerData` / `PanelData` / `StoneMetadata`：来自
 *   `画像石结构化分档/*.md` 的解析结果
 * - `AssetFile`：文件系统中的资源文件（模型 / 缩略图 / 参考图）
 * - `StoneRecord`：catalog 里的一条画像石记录，关联 metadata + 模型 + 缩略图
 * - `ScanSummary` / `Catalog`：整份目录扫描快照
 */

export type DimensionData = {
  width?: number;
  height?: number;
  thickness?: number;
  unit: "cm";
  raw?: string;
  order: "height_width_thickness";
};

export type PanelData = {
  panel_index: number;
  position: string;
  content: string;
  source?: string;
};

export type LayerData = {
  layer_index: number;
  title: string;
  source?: string;
  content: string;
  panels: PanelData[];
};

export type StoneMetadata = {
  stone_id: string;
  name: string;
  dimensions: DimensionData;
  dimension_note?: string;
  layers: LayerData[];
  source_file: string;
};

export type AssetFile = {
  fileName: string;
  path: string;
  size: number;
  extension: string;
};

export type StoneRecord = {
  id: string;
  name: string;
  displayName: string;
  model?: AssetFile;
  thumbnail?: AssetFile;
  metadata?: StoneMetadata;
  hasModel: boolean;
  hasMetadata: boolean;
  modelUrl?: string;
  thumbnailUrl?: string;
};

export type ScanSummary = {
  modelDir: string;
  metadataDir: string;
  referenceDir: string;
  modelCount: number;
  thumbnailCount: number;
  markdownCount: number;
  referenceImageCount: number;
  modelExtensions: Record<string, number>;
  unmatchedModels: number;
  unmatchedMetadata: number;
};

export type Catalog = {
  generatedAt: string;
  summary: ScanSummary;
  stones: StoneRecord[];
  referenceImages: AssetFile[];
};
