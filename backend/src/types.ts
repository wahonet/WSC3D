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
