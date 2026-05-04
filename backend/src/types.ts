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

/**
 * Catalog 自动配对结果的健康度报告。
 *
 * 即使没有 override 文件也会生成；前端 / preflight 直接读它判断"哪些 stone
 * 的模型 + metadata 配对靠不靠谱"。
 */
export type CatalogHealth = {
  /** 实际加载的 override 文件路径；undefined 表示没启用 override */
  overrideSourcePath?: string;
  /** override 命中的 forceMatch / drop 规则（用于 UI 展示"哪些是手工固定的"） */
  appliedForceMatches: Array<{ stoneId: string; modelFileName: string | null; note?: string }>;
  appliedDropMetadata: Array<{ sourceFile: string; note?: string }>;
  appliedDropOrphan: Array<{ modelFileName: string; note?: string }>;
  /** override 写了但没命中（拼错文件名 / 文件已删）→ 提醒用户修配置 */
  unrecognizedRules: Array<{ kind: "forceMatch" | "dropMetadata" | "dropOrphan"; rule: unknown }>;
  /** 没找到模型的 metadata（标注无法在 3D 模型上做） */
  unmatchedMetadata: Array<{ stoneId: string; sourceFile: string; displayName: string }>;
  /** 没匹配 metadata 但仍生成了 fallback `asset-XX` 的孤儿模型 */
  orphanModels: Array<{ fallbackId: string; modelFileName: string }>;
  /**
   * stone 与模型 numericKey 冲突表：同一个数字前缀对应多个 stone（典型情况是
   * `asset-32` + `32`，pic 命中时无法区分）。批量标注前用户应通过 forceMatch /
   * dropOrphan 解决。
   */
  numericKeyConflicts: Array<{ key: string; stoneIds: string[] }>;
};

export type Catalog = {
  generatedAt: string;
  summary: ScanSummary;
  stones: StoneRecord[];
  referenceImages: AssetFile[];
  health: CatalogHealth;
};
