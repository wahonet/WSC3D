/**
 * 前端共用 API 客户端 + 数据模型类型定义
 *
 * 一份文件同时承担两件事：
 * 1. **类型契约**：定义 IIML 文档结构、AI 服务响应、拼接方案等跨模块共享的
 *    TypeScript 类型，前后端字段保持同名（必要时与 `backend/src/services/iiml.ts`
 *    手动对齐）
 * 2. **HTTP 封装**：统一拼接 `/api/*`（Express，:3100）和 `/ai/*`（FastAPI，:8000）
 *    端点，处理 JSON 序列化、URL 编码、错误转译等公共逻辑
 *
 * 命名约定：
 * - `Iiml*` 前缀的类型与 IIML 标注文档强相关
 * - `Ai*` / `Sam*` / `Yolo*` 前缀对应 AI 服务的请求 / 响应
 * - `AssemblyPlan*` 前缀对应拼接模块的持久化结构
 *
 * 设计要点：
 * - 所有请求都 `fetch()` 直发，不引入 axios / SWR；走 Vite 的 `server.proxy`
 *   让 dev 与生产环境同享相对路径
 * - 响应 4xx / 5xx 时统一抛 `Error("xxx 失败：状态码")`，调用方用 try/catch 处理
 * - 请求体里的字段名遵循 camelCase，落盘 IIML 同样 camelCase（与论文 / IIML schema 对齐）
 */

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

// 汉画像石领域类别（13 类 + unknown）；与 structuralLevel 正交。
// 详见 docs/han-stone-annotation-SOP.md §1。category 用于 YOLO/SAM 训练，
// motif 用于具体故事 / 视觉格套（见 SOP §1.6 + 附录 A）。
// 历史标注无该字段时视为 undefined，A2 训练池准入会跳过（categories 不全 → bad-category）。
export type IimlHanStoneCategory =
  | "figure-deity"
  | "figure-immortal"
  | "figure-mythic-ruler"
  | "figure-loyal-assassin"
  | "figure-filial-son"
  | "figure-virtuous-woman"
  | "figure-music-dance"
  | "chariot-procession"
  | "mythic-creature"
  | "celestial"
  | "daily-life-scene"
  | "architecture"
  | "inscription"
  | "pattern-border"
  | "unknown";

// 标注所处坐标系：3D 模型 modelBox UV 或高清图自身归一化坐标。
// 历史标注无该字段时默认按 "model" 处理（向后兼容）。
export type IimlAnnotationFrame = "image" | "model";

// 标注间关系：基于 IIML schema 的 relations[]。
// kind 是受控词表，覆盖叙事关系（holds / rides / attacks 等）+ 层级关系
// （partOf / contains）+ 解释并存（alternativeInterpretationOf）+ 空间关系
// （above / below / leftOf / rightOf / overlaps / nextTo）。
// 空间关系一般来自 origin="spatial-auto" 的运行时推导；用户在 UI 上"采纳"才
// 升级为 origin="manual"，否则不写入 IIML 文档。
export type IimlRelationKind =
  | "holds"
  | "rides"
  | "attacks"
  | "faces"
  | "partOf"
  | "contains"
  | "nextTo"
  | "above"
  | "below"
  | "leftOf"
  | "rightOf"
  | "overlaps"
  | "alternativeInterpretationOf"
  | "manual";

export type IimlRelationOrigin = "manual" | "spatial-auto" | "ai-suggest";

export type IimlRelation = {
  id: string;
  kind: IimlRelationKind;
  // 来源 / 目标都是 annotation.id
  source: string;
  target: string;
  // 自由文本描述（可选）
  note?: string;
  // 来源：人工创建 / 几何自动推导 / AI 推荐
  origin: IimlRelationOrigin;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
};

// 处理运行记录：每次 AI 调用（SAM / YOLO / Canny / 未来其它）追加一条，
// 写入 IimlDocument.processingRuns[]，便于研究溯源（论文 24/25/26/34 都强调
// 候选必须可追溯到具体模型 + 参数 + 时间）。
export type IimlProcessingRun = {
  id: string;
  method: "sam" | "yolo" | "canny" | "sam-merge" | string;
  model: string;
  modelVersion?: string;
  // 处理输入（prompt 摘要）；不同 method 字段不同，用 Record 兜底
  input?: Record<string, unknown>;
  // 输出汇总（生成了几个 annotation 等）
  output?: Record<string, unknown>;
  // 整体置信度 / 平均置信度（每条 annotation 自己也有）
  confidence?: number;
  // 该 run 直接产出的 annotation id 列表（合并 / 后续编辑后可能不全部存在）
  resultAnnotationIds?: string[];
  // 关联的画像石（resourceId 形如 "asset-29:model"）
  resourceId?: string;
  // 该 run 跑的坐标系（image / model）
  frame?: IimlAnnotationFrame;
  startedAt: string;
  endedAt?: string;
  // 失败时记 error / warning
  warning?: string;
  error?: string;
};

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
  // 汉画像石领域类别（13 类 + unknown）。SOP v0.3 §1 引入；与 structuralLevel 正交。
  // 历史标注可能无此字段，前端 dropdown 显示空值，A2 导出时跳过该 annotation。
  category?: IimlHanStoneCategory;
  // 二层母题：具体故事 / 视觉格套（SOP §1.6 + 附录 A 受控词表 130+ 项）。
  // 自由字符串以容纳学界新格套；建议从 categories.ts motifSuggestionsByCategory 选。
  motif?: string;
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
  relations?: IimlRelation[];
  vocabularies?: VocabularyTerm[];
  processingRuns?: IimlProcessingRun[];
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

export type YoloDetectionDebug = {
  // 模型实际输出的检测条数（按 conf >= 0.01 的 lower-bound 拉，未做 class 过滤前）
  rawDetections: number;
  // 模型识别出的 label → 数量；用来排查"为什么没检测到我想要的类"
  classDistribution: Record<string, number>;
  filteredByClass: number;
  filteredByConf: number;
  appliedConfThreshold: number;
  appliedClassFilter: string[] | null;
  // 1 = 只用原图扫；2 = 同时用原图 + CLAHE 增强图扫并合并去重（汉画像石走这一路）
  enhancedPasses: number;
};

export type YoloDetectionResponse = {
  detections: AiDetection[];
  model: string;
  imageSize?: [number, number];
  coordinateSystem?: "image-normalized";
  sourceMode?: "screenshot" | "source";
  sourceImage?: string;
  error?: string;
  // 后端诊断信息：用于前端 status / dialog 给用户更准确的提示
  debug?: YoloDetectionDebug;
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

// 一次性返回所有画像石的 4 点对齐状态：{ stoneId: hasAlignment }
// 头部画像石下拉用它在 option 文本前加 ✓ 标识。
export async function fetchAlignmentStatuses(): Promise<Record<string, boolean>> {
  try {
    const response = await fetch("/api/iiml/alignments");
    if (!response.ok) {
      return {};
    }
    return (await response.json()) as Record<string, boolean>;
  } catch {
    return {};
  }
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

// M5 Phase 1 A2 主动学习闭环：训练池导出。
// 后端扫 data/iiml/*.iiml.json → 跑 SOP §11 准入校验 → 按 stoneId 70/15/15
// 划分 → 写 data/datasets/wsc-han-stone-v0/。返回汇总统计。
export type TrainingExportSummary = {
  exportedAt: string;
  /** 相对项目根的目录路径，比如 "data/datasets/wsc-han-stone-v0" */
  datasetDir: string;
  totalAnnotations: number;
  acceptedAnnotations: number;
  skippedAnnotations: number;
  totalStones: number;
  acceptedStones: number;
  splits: { train: number; val: number; test: number };
  categoryDistribution: Record<string, number>;
  motifDistribution: Record<string, number>;
  warningCounts: Record<string, number>;
  reportFileName: string;
};

export async function exportTrainingDataset(): Promise<TrainingExportSummary> {
  const response = await fetch("/api/training/export", { method: "POST" });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`训练池导出失败 ${response.status}：${text || response.statusText}`);
  }
  return response.json();
}

// ----- D 阶段：标注上线前预检 -----

export type PreflightReport = {
  generatedAt: string;
  catalog: {
    overrideSourcePath?: string;
    totalStones: number;
    stonesWithModel: number;
    stonesWithMetadata: number;
    orphanModelCount: number;
    unmatchedMetadataCount: number;
    numericKeyConflictCount: number;
    unrecognizedRuleCount: number;
    numericKeyConflicts: Array<{ key: string; stoneIds: string[] }>;
    orphanModels: Array<{ fallbackId: string; modelFileName: string }>;
    unmatchedMetadata: Array<{ stoneId: string; sourceFile: string; displayName: string }>;
  };
  pic: {
    picDir: string;
    exists: boolean;
    totalFiles: number;
    matchedCount: number;
    matched: Array<{ stoneId: string; fileName: string }>;
    unmatchedStones: string[];
    duplicateKeys: Array<{ key: string; fileNames: string[] }>;
    unrecognizedFiles: string[];
  };
  iiml: {
    totalDocs: number;
    annotationsTotal: number;
    missingCategoryCount: number;
    missingMotifInNarrativeCount: number;
    frameModelNoAlignmentCount: number;
    reviewStatusBreakdown: Record<string, number>;
  };
  trainingReadiness: {
    estimatedAccepted: number;
    estimatedSkipped: number;
    skipReasonTop: Array<{ reason: string; count: number }>;
    categoryDistribution: Record<string, number>;
    underrepresentedCategories: string[];
  };
};

export async function fetchPreflight(): Promise<PreflightReport> {
  const response = await fetch("/api/preflight");
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`预检失败 ${response.status}：${text || response.statusText}`);
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

// G-new：画像石生成 / 上传的资源（正射 / 拓片 / 法线图等）
export type StoneResourceEntry = {
  fileName: string;
  type: string;
  uri: string;
  size?: number;
  createdAt?: string;
};

export async function listStoneResources(stoneId: string): Promise<StoneResourceEntry[]> {
  const response = await fetch(`/api/stones/${encodeURIComponent(stoneId)}/resources`);
  if (!response.ok) {
    return [];
  }
  const data = (await response.json()) as { resources?: StoneResourceEntry[] };
  return data.resources ?? [];
}

/**
 * 上传一张 PNG 给后端做该画像石的资源。body 可以直接传 Blob（前端生成正射）
 * 或传 base64 字符串（比如剪贴板粘贴）。后端会把文件存到 data/stone-resources/
 * {stoneId}/{type}-{ts}.png 并返回前端可加到 IIML resources 的元信息。
 */
// I3 v0.8.0：.hpsml 研究包解包 / 导入
export type HpsmlImportSummary = {
  stoneId: string;
  imported: {
    iiml: boolean;
    annotations: number;
    relations: number;
    processingRuns: number;
    resources: number;
    assemblyPlans: number;
  };
  skipped: {
    iiml: boolean;
    assemblyPlans: number;
  };
  warnings: string[];
};

export async function importHpsmlPackage(
  payload: unknown,
  options: { stoneId?: string; conflict?: "overwrite" | "skip" } = {}
): Promise<HpsmlImportSummary> {
  const params = new URLSearchParams();
  if (options.stoneId) params.set("stoneId", options.stoneId);
  if (options.conflict) params.set("conflict", options.conflict);
  const url = `/api/hpsml/import${params.toString() ? `?${params.toString()}` : ""}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "unknown");
    throw new Error(`hpsml_import_failed: ${response.status} ${message}`);
  }
  return (await response.json()) as HpsmlImportSummary;
}

// 删除一份已落盘的画像石资源（仅支持正射图，后端会拒绝其它类型）。
// 通过 fileName（不是 URI）定位文件，与列表接口返回的 fileName 一致。
export async function deleteStoneResource(stoneId: string, fileName: string): Promise<void> {
  const url = `/api/stones/${encodeURIComponent(stoneId)}/resources/${encodeURIComponent(fileName)}`;
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) {
    const message = await response.text().catch(() => "unknown");
    throw new Error(`delete_failed: ${response.status} ${message}`);
  }
}

export async function uploadStoneResource(
  stoneId: string,
  payload: Blob | { type?: string; imageBase64: string },
  options: { type?: string } = {}
): Promise<StoneResourceEntry> {
  const type = options.type ?? (payload instanceof Blob ? "ortho" : payload.type ?? "ortho");
  let init: RequestInit;
  if (payload instanceof Blob) {
    const url = `/api/stones/${encodeURIComponent(stoneId)}/resources?type=${encodeURIComponent(type)}`;
    init = {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: payload
    };
    const response = await fetch(url, init);
    if (!response.ok) {
      const message = await response.text().catch(() => "unknown");
      throw new Error(`upload_failed: ${response.status} ${message}`);
    }
    return (await response.json()) as StoneResourceEntry;
  }

  init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, imageBase64: payload.imageBase64 })
  };
  const response = await fetch(
    `/api/stones/${encodeURIComponent(stoneId)}/resources`,
    init
  );
  if (!response.ok) {
    const message = await response.text().catch(() => "unknown");
    throw new Error(`upload_failed: ${response.status} ${message}`);
  }
  return (await response.json()) as StoneResourceEntry;
}

// AI 线图 PNG 端点：基于 source-image 的转码缓存，做边缘检测后落盘。
// 输出是 RGBA（白线 + alpha 软渐变），可直接半透明叠加在高清图上。
// 不同 method / 阈值组合各自缓存，浏览器并发请求互不影响。
//
// method 支持：
//   - canny：经典双阈值；最快
//   - sobel：Sobel 梯度阈值化；对软边缘敏感
//   - scharr：Scharr 改进核；细节多的浮雕更精细
//   - morph：自适应阈值 + 形态学；残损 / 风化更稳（low 当 blockSize 用）
//   - canny-plus：Canny + 形态学闭运算填补断边；**汉画像石推荐**
export type LineartMethod = "canny" | "sobel" | "scharr" | "morph" | "canny-plus";

export const lineartMethodOptions: Array<{ id: LineartMethod; label: string; hint: string }> = [
  { id: "canny", label: "Canny", hint: "经典双阈值边缘检测，最快" },
  { id: "canny-plus", label: "Canny+", hint: "Canny + 形态学闭运算填补断边，汉画像石残损浮雕推荐" },
  { id: "sobel", label: "Sobel", hint: "Sobel 梯度幅值阈值化，对灰度软边缘敏感" },
  { id: "scharr", label: "Scharr", hint: "Scharr 改进核，细节多的浮雕更精细" },
  { id: "morph", label: "形态学", hint: "自适应阈值 + 形态学，残损 / 风化表面更稳；low 当 blockSize 用（11~31 推荐）" }
];

export function getLineartUrl(
  stoneId: string,
  options: { method?: LineartMethod; low?: number; high?: number; maxEdge?: number } = {}
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

// SAM 高清图路径：
//   优先 imageUri（任意资源 URI，正射图 / 拓片 / 法线图 …，v0.8.0 J 加入），
//   否则 stoneId（pic/ 原图）。prompt 点 / 响应 polygon 都用图像 UV（v 向下），
//   前端直接当画布 UV 渲染；当底图是 equivalentToModel 的正射图时，图像 UV
//   与 modelBox UV 数值上相等，可直接作为 model frame 标注。
export async function runSamSegmentationBySource(payload: {
  stoneId?: string;
  imageUri?: string;
  prompts: Array<
    | { type: "point_uv"; u: number; v: number; label: 0 | 1 }
    | { type: "box_uv"; bbox_uv: [number, number, number, number] }
  >;
}): Promise<SamSegmentationResponse> {
  if (!payload.stoneId && !payload.imageUri) {
    throw new Error("runSamSegmentationBySource 需要 stoneId 或 imageUri");
  }
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

// 通用 YOLO 检测：优先 imageUri > stoneId (pic/ 高清图) > imageBase64 (截图)。
// 后端会按 confThreshold 与 maxDetections 过滤；class_filter 仅保留你关心的标签。
export async function runYoloDetection(payload: {
  stoneId?: string;
  imageUri?: string;
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
