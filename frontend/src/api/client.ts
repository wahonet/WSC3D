export type DimensionData = {
  width?: number;
  height?: number;
  thickness?: number;
  unit: "cm";
  raw?: string;
  order: "height_width_thickness";
};

export type StoneListItem = {
  id: string;
  name: string;
  displayName: string;
  hasModel: boolean;
  hasMetadata: boolean;
  modelUrl?: string;
  thumbnailUrl?: string;
  metadata?: {
    stone_id: string;
    name: string;
    dimensions: DimensionData;
    dimension_note?: string;
    layerCount: number;
    source_file: string;
  };
};

export type StoneMetadata = {
  stone_id: string;
  name: string;
  dimensions: DimensionData;
  dimension_note?: string;
  layers: Array<{
    layer_index: number;
    title: string;
    source?: string;
    content: string;
    panels: Array<{
      panel_index: number;
      position: string;
      content: string;
      source?: string;
    }>;
  }>;
  source_file: string;
};

export type StoneListResponse = {
  generatedAt: string;
  summary: {
    modelCount: number;
    thumbnailCount: number;
    markdownCount: number;
    referenceImageCount: number;
    unmatchedModels: number;
    unmatchedMetadata: number;
  };
  stones: StoneListItem[];
};

export type IimlPoint = [number, number] | [number, number, number] | [number, number, number, number];

export type IimlGeometry =
  | { type: "Point"; coordinates: IimlPoint }
  | { type: "LineString"; coordinates: IimlPoint[] }
  | { type: "Polygon"; coordinates: IimlPoint[][] }
  | { type: "MultiPolygon"; coordinates: IimlPoint[][][] }
  | { type: "BBox"; coordinates: [number, number, number, number] };

export type IimlStructuralLevel = "whole" | "scene" | "figure" | "component" | "trace" | "inscription" | "damage" | "unknown";
export type IimlReviewStatus = "candidate" | "reviewed" | "approved" | "rejected";

export type IimlTermRef = {
  id: string;
  label: string;
  scheme?: string;
  role?: string;
};

export type IimlAnnotation = {
  id: string;
  type?: "Annotation";
  resourceId: string;
  target: IimlGeometry;
  structuralLevel: IimlStructuralLevel;
  label?: string;
  color?: string;
  visible?: boolean;
  locked?: boolean;
  semantics?: {
    name?: string;
    description?: string;
    iconographicMeaning?: string;
    iconologicalMeaning?: string;
    inscription?: {
      transcription?: string;
      translation?: string;
      readingNote?: string;
    };
    terms?: IimlTermRef[];
    attributes?: Record<string, string | number | boolean | null>;
  };
  contains?: IimlAnnotation[];
  partOf?: string;
  confidence?: number;
  generation?: {
    method: string;
    model?: string;
    modelVersion?: string;
    prompt?: Record<string, unknown>;
    confidence?: number;
    reviewStatus?: IimlReviewStatus;
  };
  reviewStatus?: IimlReviewStatus;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
  notes?: string;
};

export type VocabularyCategory = {
  id: string;
  name: string;
  terms: string[];
};

export type VocabularyTerm = {
  id: string;
  prefLabel: string;
  altLabel: string[];
  scheme: string;
  broader: string[];
};

export type IimlDocument = {
  "@context": string | Record<string, unknown> | Array<string | Record<string, unknown>>;
  "@type": "IIMLDocument";
  documentId: string;
  name: string;
  description?: string;
  version?: string;
  language?: string;
  culturalObject?: Record<string, unknown>;
  resources: Array<Record<string, unknown> & { id: string; type: string; uri: string }>;
  annotations: IimlAnnotation[];
  relations?: Array<Record<string, unknown>>;
  vocabularies?: VocabularyTerm[];
  processingRuns?: Array<Record<string, unknown>>;
  provenance?: Record<string, unknown>;
};

export type ProjectionState = {
  width: number;
  height: number;
  modelBox: {
    min: [number, number, number];
    max: [number, number, number];
  };
};

export type AiDetection = {
  bbox: [number, number, number, number];
  confidence: number;
  label: string;
};

export type AssemblyPlanTransform = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: number;
};

export type AssemblyPlanDimensions = {
  width: number;
  length: number;
  thickness: number;
  longEdge: number;
  unit: "cm" | "model";
  source: "metadata" | "model";
};

export type AssemblyPlanItem = {
  instanceId: string;
  stoneId: string;
  displayName: string;
  locked: boolean;
  transform: AssemblyPlanTransform;
  baseDimensions?: AssemblyPlanDimensions;
};

export type AssemblyPlanPayload = {
  id?: string;
  name: string;
  items: AssemblyPlanItem[];
};

export type AssemblyPlanRecord = AssemblyPlanPayload & {
  id: string;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
};

export async function fetchStones(): Promise<StoneListResponse> {
  const response = await fetch("/api/stones");
  if (!response.ok) {
    throw new Error(`获取画像石列表失败：${response.status}`);
  }
  return response.json();
}

export async function fetchStoneMetadata(id: string): Promise<StoneMetadata> {
  const response = await fetch(`/api/stones/${encodeURIComponent(id)}/metadata`);
  if (!response.ok) {
    throw new Error(`获取画像石元数据失败：${response.status}`);
  }
  return response.json();
}

export async function fetchIimlDocument(stoneId: string): Promise<IimlDocument> {
  const response = await fetch(`/api/iiml/${encodeURIComponent(stoneId)}`);
  if (!response.ok) {
    throw new Error(`读取标注文档失败：${response.status}`);
  }
  return response.json();
}

export async function saveIimlDocument(stoneId: string, document: IimlDocument): Promise<IimlDocument> {
  const response = await fetch(`/api/iiml/${encodeURIComponent(stoneId)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(document)
  });
  if (!response.ok) {
    throw new Error(`保存标注文档失败：${response.status}`);
  }
  return response.json();
}

export async function importMarkdownAnnotations(stoneId: string): Promise<IimlDocument> {
  const response = await fetch(`/api/iiml/${encodeURIComponent(stoneId)}/import-md`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`导入结构化档案失败：${response.status}`);
  }
  return response.json();
}

export async function fetchTerms(): Promise<{ categories: VocabularyCategory[]; terms: VocabularyTerm[] }> {
  const response = await fetch("/api/terms");
  if (!response.ok) {
    throw new Error(`读取术语库失败：${response.status}`);
  }
  return response.json();
}

export async function fetchAiHealth(): Promise<{ ok: boolean; service?: string }> {
  const response = await fetch("/ai/health");
  if (!response.ok) {
    throw new Error("ai_service_unavailable");
  }
  return response.json();
}

export async function runSamSegmentation(payload: {
  imageBase64: string;
  prompts: Array<{ type: "point"; x: number; y: number; label: 0 | 1 } | { type: "box"; bbox: [number, number, number, number] }>;
}): Promise<{ polygons: Array<IimlPoint[]>; confidence: number; model: string }> {
  const response = await fetch("/ai/sam", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`SAM 标注失败：${response.status}`);
  }
  return response.json();
}

export async function runYoloDetection(payload: { imageBase64: string; classFilter?: string[] }): Promise<{ detections: AiDetection[]; model: string }> {
  const response = await fetch("/ai/yolo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`YOLO 检测失败：${response.status}`);
  }
  return response.json();
}

export async function runCannyLine(payload: { imageBase64: string; low: number; high: number }): Promise<{ imageBase64: string; resourceId: string; model: string }> {
  const response = await fetch("/ai/canny", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`线图生成失败：${response.status}`);
  }
  return response.json();
}

export async function fetchAssemblyPlans(): Promise<AssemblyPlanRecord[]> {
  const response = await fetch("/api/assembly-plans");
  if (!response.ok) {
    throw new Error(`获取拼接方案失败：${response.status}`);
  }
  return response.json();
}

export async function fetchAssemblyPlan(id: string): Promise<AssemblyPlanRecord> {
  const response = await fetch(`/api/assembly-plans/${encodeURIComponent(id)}`);
  if (!response.ok) {
    throw new Error(`读取拼接方案失败：${response.status}`);
  }
  return response.json();
}

export async function saveAssemblyPlan(payload: AssemblyPlanPayload): Promise<AssemblyPlanRecord> {
  const response = await fetch("/api/assembly-plans", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`保存拼接方案失败：${response.status}`);
  }
  return response.json();
}
