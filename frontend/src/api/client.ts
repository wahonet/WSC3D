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

// 标注所处坐标系：3D 模型 modelBox UV 或高清图自身归一化坐标。
// 历史标注无该字段时默认按 "model" 处理（向后兼容）。
export type IimlAnnotationFrame = "image" | "model";

// 3D 模型 / 高清图坐标系之间的 4 点单应性标定。
// controlPoints 至少 4 对，按用户采集顺序存储，渲染时用 4 个点解 3×3 矩阵。
export type IimlAlignmentControlPoint = {
  modelUv: [number, number];
  imageUv: [number, number];
};

export type IimlAlignment = {
  version: 1;
  calibratedAt: string;
  calibratedBy?: string;
  controlPoints: IimlAlignmentControlPoint[];
  // 标定时高清图的原始尺寸；若以后高清图被重新缩放/裁剪，可作为校验依据。
  imageNaturalSize?: [number, number];
  notes?: string;
};

export type IimlTermRef = {
  id: string;
  label: string;
  scheme?: string;
  role?: string;
};

// 证据源：用 kind 区分 metadata / reference / resource / other 四种；
// M2 只启用 metadata（结构化档案层/帧）和 reference（文献），
// resource 留给 M3 一对象多资源，other 兜底自由文本。
export type IimlSource =
  | { kind: "metadata"; layerIndex: number; panelIndex?: number; note?: string }
  | { kind: "reference"; title?: string; uri?: string; citation?: string }
  | { kind: "resource"; resourceId: string; note?: string }
  | { kind: "other"; text: string };

export type IimlAnnotation = {
  id: string;
  type?: "Annotation";
  resourceId: string;
  target: IimlGeometry;
  // 标注几何坐标所在的参考系。缺省视作 "model"，与历史数据兼容。
  frame?: IimlAnnotationFrame;
  structuralLevel: IimlStructuralLevel;
  label?: string;
  color?: string;
  // 标注填充区域的透明度 0..1；描边始终用 color 不透明。默认 0.15。
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
  semantics?: {
    name?: string;
    description?: string;
    // 前图像志：可见对象纯描述，论文 35 ICON 三层中的第一层。
    preIconographic?: string;
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
  sources?: IimlSource[];
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
  // 图像归一化坐标（0..1，v 向下；与 SAM polygon 同约定，前端可以直接当 BBox UV 使用）
  bbox_uv?: [number, number, number, number];
  confidence: number;
  label: string;
};

export type YoloDetectionResponse = {
  detections: AiDetection[];
  model: string;
  imageSize?: [number, number];
  coordinateSystem?: "image-normalized";
  sourceMode?: "screenshot" | "source";
  sourceImage?: string;
  error?: string;
};

// COCO 类别中"通常对汉画像石可用"的子集，UI 默认勾选这一组以减少噪声候选。
// 真要做精确识别需要专门微调，这是 v0.4.0 的取舍。
export const yoloCocoUsefulClasses = [
  "person",
  "bird",
  "cat",
  "dog",
  "horse",
  "sheep",
  "cow",
  "elephant",
  "bear",
  "zebra",
  "giraffe",
  "umbrella",
  "knife",
  "fork",
  "spoon",
  "cup",
  "bottle",
  "vase",
  "chair",
  "couch",
  "bed",
  "dining table",
  "kite",
  "bicycle",
  "car",
  "motorcycle",
  "bus",
  "truck",
  "boat",
  "potted plant"
];

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

export type SamStatus = {
  ready: boolean;
  // pending | downloading | loading | ready | error
  status: "pending" | "downloading" | "loading" | "ready" | "error";
  model: string;
  detail: string;
};

export type AiHealthResponse = {
  ok: boolean;
  service?: string;
  features?: string[];
  sam?: SamStatus;
};

export async function fetchAiHealth(): Promise<AiHealthResponse> {
  const response = await fetch("/ai/health");
  if (!response.ok) {
    throw new Error("ai_service_unavailable");
  }
  return response.json();
}

// 高清图 PNG 端点：后端会把 pic/ 下的 tif 解码并缩放到指定长边后落盘缓存，
// 浏览器直接 <img src=...> 即可。HEAD 请求可用来探测某块画像石是否配了高清图。
export function getSourceImageUrl(stoneId: string, maxEdge = 4096): string {
  return `/ai/source-image/${encodeURIComponent(stoneId)}?max_edge=${maxEdge}`;
}

export async function probeSourceImage(stoneId: string): Promise<boolean> {
  try {
    const response = await fetch(getSourceImageUrl(stoneId), { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

// AI 线图 PNG 端点：基于 source-image 的转码缓存，做 OpenCV Canny 后落盘。
// 输出是 RGBA（白线 + alpha 软渐变），可直接半透明叠加在高清图上。
// 不同阈值组合各自缓存，浏览器并发请求互不影响。
export function getLineartUrl(
  stoneId: string,
  options: { method?: "canny"; low?: number; high?: number; maxEdge?: number } = {}
): string {
  const method = options.method ?? "canny";
  const low = options.low ?? 60;
  const high = options.high ?? 140;
  const maxEdge = options.maxEdge ?? 4096;
  return `/ai/lineart/${encodeURIComponent(stoneId)}?method=${method}&low=${low}&high=${high}&max_edge=${maxEdge}`;
}

export type SamSegmentationResponse = {
  polygons: Array<IimlPoint[]>;
  confidence: number;
  model: string;
  // 响应坐标系：旧截图路径返回图像归一化（y 向下），需要前端再做 screenToUV；
  // 高清图路径返回 modelBox-uv（v 向下，与屏幕/图像坐标一致），前端可以直接当 UV 用。
  coordinateSystem?: "image-normalized" | "modelbox-uv";
  sourceMode?: "screenshot" | "source";
  sourceImage?: string;
  sourceSize?: [number, number];
  error?: string;
  warning?: string;
};

export async function runSamSegmentation(payload: {
  imageBase64: string;
  prompts: Array<{ type: "point"; x: number; y: number; label: 0 | 1 } | { type: "box"; bbox: [number, number, number, number] }>;
}): Promise<SamSegmentationResponse> {
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

// 高清图路径：让后端根据 stoneId 去 pic/ 目录找对应原图。
// prompt 点 / 响应 polygon 都用 modelBox UV（v 向下，与屏幕坐标一致），
// 后端不再做 y 翻转，前端直接把 polygon 当 UV 渲染。
export async function runSamSegmentationBySource(payload: {
  stoneId: string;
  prompts: Array<
    | { type: "point_uv"; u: number; v: number; label: 0 | 1 }
    | { type: "box_uv"; bbox_uv: [number, number, number, number] }
  >;
}): Promise<SamSegmentationResponse> {
  const response = await fetch("/ai/sam", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`SAM 高清图标注失败：${response.status}`);
  }
  return response.json();
}

// 通用 YOLO 检测：stoneId 优先（高清图路径），否则 imageBase64（截图）。
// 后端会按 confThreshold 与 maxDetections 过滤；class_filter 仅保留你关心的标签。
export async function runYoloDetection(payload: {
  stoneId?: string;
  imageBase64?: string;
  classFilter?: string[];
  confThreshold?: number;
  maxDetections?: number;
}): Promise<YoloDetectionResponse> {
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
