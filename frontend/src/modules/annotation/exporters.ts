/**
 * 学术导出器：COCO / IIIF / .hpsml / CSV / IIML 五种格式
 *
 * 标注模块的"学术互操作层"。同一份 IIML 文档根据下游用户的需要导出成不同
 * 格式，覆盖 AI 训练、数字人文研究、跨机器协作等场景：
 *
 * - **IIML**（原生）：完整保真，研究内部循环
 * - **CSV**：表格化标注，方便 Excel / pandas 二次分析
 * - **COCO**（D7）：喂 YOLOv8 / Detectron2 等开源检测分割训练
 * - **IIIF Web Annotation**（D8）：International Image Interoperability Framework
 *   规范，与 Mirador / Annona 等阅读器互通
 * - **.hpsml**（G2）：项目自定义"研究包"，IIML + 拼接方案 + 词表 + 关系
 *   网络快照打包，跨机器迁移 / 论文附件用
 *
 * 通用工具：
 * - `downloadJson` / `downloadText`：浏览器侧下载触发器，自动按时间戳命名
 *
 * 设计要点：
 * - 所有导出器都是纯函数：给定 IIML doc + context，返回字符串（或 JSON 对象）
 *   → 业务层决定下载或预览
 * - 跨 frame 处理：默认导出当前 frame；options.frame 强制覆盖
 * - 不破坏 IIML 数据：导出过程都是只读，不写回 doc
 */

// =============================================================================
// D7 COCO JSON 导出
// =============================================================================
//
// 把 IIML 标注导出为 COCO 目标检测 / 实例分割数据集格式（JSON），用于喂
// YOLOv8 / Detectron2 等开源检测分割训练。
//
// 设计：
//   - images：每个 IIML 文档当作 "1 张图"（id=1），width/height 从
//     options.imageSize 提供（image frame）或默认 1000（model frame）
//   - annotations：每条 IimlAnnotation 转一条 COCO annotation
//     * BBox 直接用 bbox=[x, y, w, h]（pixel 坐标）
//     * Polygon 转 segmentation=[[x1,y1,x2,y2,...]]，bbox 取外接矩形
//     * Point / LineString 跳过（COCO 不支持这两种 shape）
//   - categories：取所有 structuralLevel 去重，加 1 个 fallback "unknown"
//   - 跨 frame 处理：默认只导出当前 frame；options.frame 控制
//
// 当前简化点：只支持单图（一个 stoneId），不做多图 batch；坐标系按
// imageSize 把 UV 换算成像素。

import type {
  IimlAnnotation,
  IimlDocument,
  IimlGeometry,
  IimlRelation,
  IimlStructuralLevel
} from "./types";
import type {
  AssemblyPlanRecord,
  StoneListItem,
  StoneMetadata,
  VocabularyCategory,
  VocabularyTerm
} from "../../api/client";

export type CocoExportOptions = {
  // 当前画像石的图像尺寸；缺省时按 1000x1000 单位（前端 UI 提示一下）
  imageSize: { width: number; height: number };
  // 只导出指定 frame 的标注；默认全部
  frame?: "image" | "model";
  // 用于 image.file_name；缺省 "stone.png"
  imageFileName?: string;
};

type CocoCategory = {
  id: number;
  name: string;
  supercategory?: string;
};

type CocoImage = {
  id: number;
  width: number;
  height: number;
  file_name: string;
};

type CocoAnnotation = {
  id: number;
  image_id: number;
  category_id: number;
  bbox: [number, number, number, number]; // [x, y, w, h] 像素
  area: number;
  iscrowd: 0 | 1;
  segmentation?: number[][];
  // 扩展字段：保留 IIML 标注 id 供回溯
  iiml_id?: string;
  iiml_label?: string;
};

type CocoDataset = {
  info: {
    description: string;
    version: string;
    year: number;
    contributor: string;
    date_created: string;
  };
  images: CocoImage[];
  annotations: CocoAnnotation[];
  categories: CocoCategory[];
};

const structuralLevels: IimlStructuralLevel[] = [
  "whole",
  "scene",
  "figure",
  "component",
  "trace",
  "inscription",
  "damage",
  "unknown"
];

export function exportToCoco(doc: IimlDocument, options: CocoExportOptions): CocoDataset {
  const { imageSize, frame, imageFileName = "stone.png" } = options;
  const W = Math.max(1, Math.round(imageSize.width));
  const H = Math.max(1, Math.round(imageSize.height));

  const image: CocoImage = {
    id: 1,
    width: W,
    height: H,
    file_name: imageFileName
  };

  const categories: CocoCategory[] = structuralLevels.map((level, index) => ({
    id: index + 1,
    name: level
  }));
  const categoryIdByLevel = new Map(categories.map((category) => [category.name, category.id]));

  const annotations: CocoAnnotation[] = [];
  let nextId = 1;
  for (const annotation of doc.annotations) {
    if (frame && (annotation.frame ?? "model") !== frame) continue;
    const cocoAnn = convertAnnotation(annotation, nextId, image.id, W, H, categoryIdByLevel);
    if (cocoAnn) {
      annotations.push(cocoAnn);
      nextId += 1;
    }
  }

  return {
    info: {
      description: `WSC3D IIML export — ${doc.name ?? doc.documentId}`,
      version: doc.version ?? "0.1.0",
      year: new Date().getFullYear(),
      contributor: "WSC3D",
      date_created: new Date().toISOString()
    },
    images: [image],
    annotations,
    categories
  };
}

function convertAnnotation(
  annotation: IimlAnnotation,
  id: number,
  imageId: number,
  W: number,
  H: number,
  categoryIdByLevel: Map<string, number>
): CocoAnnotation | undefined {
  const target = annotation.target;
  const categoryId = categoryIdByLevel.get(annotation.structuralLevel) ?? categoryIdByLevel.get("unknown") ?? 1;
  const base = {
    id,
    image_id: imageId,
    category_id: categoryId,
    iscrowd: 0 as const,
    iiml_id: annotation.id,
    iiml_label: annotation.label
  };

  if (target.type === "BBox") {
    const [u1, v1, u2, v2] = target.coordinates;
    const x = Math.min(u1, u2) * W;
    const y = Math.min(v1, v2) * H;
    const w = Math.abs(u2 - u1) * W;
    const h = Math.abs(v2 - v1) * H;
    return {
      ...base,
      bbox: [x, y, w, h],
      area: w * h
    };
  }

  if (target.type === "Polygon" || target.type === "MultiPolygon") {
    const polygons = target.type === "Polygon" ? [target.coordinates] : target.coordinates;
    const segmentation: number[][] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let totalArea = 0;
    for (const polygon of polygons) {
      const ring = polygon[0];
      if (!ring || ring.length < 3) continue;
      const flat: number[] = [];
      for (const point of ring) {
        const x = Number(point[0] ?? 0) * W;
        const y = Number(point[1] ?? 0) * H;
        flat.push(x, y);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      segmentation.push(flat);
      totalArea += polygonArea(flat);
    }
    if (segmentation.length === 0 || !Number.isFinite(minX)) return undefined;
    return {
      ...base,
      bbox: [minX, minY, maxX - minX, maxY - minY],
      area: Math.abs(totalArea),
      segmentation
    };
  }

  // Point / LineString：COCO 不直接支持作为目标检测；跳过
  return undefined;
}

function polygonArea(flat: number[]): number {
  // shoelace 公式：flat = [x0, y0, x1, y1, ...]
  let area = 0;
  const n = flat.length / 2;
  for (let i = 0; i < n; i += 1) {
    const x1 = flat[i * 2];
    const y1 = flat[i * 2 + 1];
    const x2 = flat[((i + 1) % n) * 2];
    const y2 = flat[((i + 1) % n) * 2 + 1];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

// =============================================================================
// D8 IIIF Web Annotation 导出
// =============================================================================
//
// 把 IIML 标注导出为 W3C Web Annotation Data Model（IIIF Presentation API
// v3 兼容），用于与外部文物 / 博物馆平台互操作。
//
// 设计：
//   - 输出 AnnotationPage（iiif/annotation/page）含 N 个 Annotation
//   - 每个 Annotation:
//     * id：派生自 IIML annotation id
//     * type: "Annotation"
//     * motivation: "tagging" 默认；inscription level 用 "transcribing"
//     * body：IIML 的 label / semantics 拼成 list
//     * target：FragmentSelector / SvgSelector，URL 用 options.canvasId
//   - BBox → FragmentSelector#xywh=...
//   - Polygon → SvgSelector + svg path

export type IiifExportOptions = {
  imageSize: { width: number; height: number };
  frame?: "image" | "model";
  // IIIF Canvas URL（必填，外部互操作锚点）
  canvasId: string;
  // Annotation Page id；默认根据 doc.documentId 派生
  pageId?: string;
};

type IiifAnnotation = {
  "@context": string | string[];
  id: string;
  type: "Annotation";
  motivation: string | string[];
  body: Array<Record<string, unknown>>;
  target: Record<string, unknown>;
  generator?: Record<string, unknown>;
  created?: string;
  modified?: string;
};

type IiifAnnotationPage = {
  "@context": string | string[];
  id: string;
  type: "AnnotationPage";
  items: IiifAnnotation[];
};

export function exportToIiifAnnotationPage(doc: IimlDocument, options: IiifExportOptions): IiifAnnotationPage {
  const { imageSize, frame, canvasId, pageId } = options;
  const W = Math.max(1, Math.round(imageSize.width));
  const H = Math.max(1, Math.round(imageSize.height));
  const generated = new Date().toISOString();
  const pageIdFinal = pageId ?? `urn:wsc3d:${doc.documentId}:page`;

  const items: IiifAnnotation[] = [];
  for (const annotation of doc.annotations) {
    if (frame && (annotation.frame ?? "model") !== frame) continue;
    const item = convertToIiif(annotation, canvasId, W, H, generated);
    if (item) items.push(item);
  }

  return {
    "@context": "http://www.w3.org/ns/anno.jsonld",
    id: pageIdFinal,
    type: "AnnotationPage",
    items
  };
}

function convertToIiif(
  annotation: IimlAnnotation,
  canvasId: string,
  W: number,
  H: number,
  generated: string
): IiifAnnotation | undefined {
  const target = annotation.target;
  const motivation = annotation.structuralLevel === "inscription" ? "transcribing" : "tagging";
  const body: Array<Record<string, unknown>> = [];

  if (annotation.label) {
    body.push({ type: "TextualBody", value: annotation.label, language: "zh", purpose: "tagging" });
  }
  const sem = annotation.semantics;
  if (sem?.preIconographic) {
    body.push({ type: "TextualBody", value: sem.preIconographic, language: "zh", purpose: "describing" });
  }
  if (sem?.iconographicMeaning) {
    body.push({ type: "TextualBody", value: sem.iconographicMeaning, language: "zh", purpose: "identifying" });
  }
  if (sem?.iconologicalMeaning) {
    body.push({ type: "TextualBody", value: sem.iconologicalMeaning, language: "zh", purpose: "classifying" });
  }
  if (sem?.terms) {
    for (const term of sem.terms) {
      body.push({
        type: "SpecificResource",
        source: term.id,
        purpose: "tagging",
        label: term.label,
        scheme: term.scheme
      });
    }
  }
  if (sem?.inscription?.transcription) {
    body.push({ type: "TextualBody", value: sem.inscription.transcription, language: "zh", purpose: "transcribing" });
  }

  let targetSelector: Record<string, unknown> | undefined;
  if (target.type === "BBox") {
    const [u1, v1, u2, v2] = target.coordinates;
    const x = Math.round(Math.min(u1, u2) * W);
    const y = Math.round(Math.min(v1, v2) * H);
    const w = Math.round(Math.abs(u2 - u1) * W);
    const h = Math.round(Math.abs(v2 - v1) * H);
    targetSelector = {
      type: "FragmentSelector",
      conformsTo: "http://www.w3.org/TR/media-frags/",
      value: `xywh=${x},${y},${w},${h}`
    };
  } else if (target.type === "Polygon" || target.type === "MultiPolygon") {
    const polygons = target.type === "Polygon" ? [target.coordinates] : target.coordinates;
    const paths: string[] = [];
    for (const polygon of polygons) {
      const ring = polygon[0];
      if (!ring || ring.length < 3) continue;
      const segments = ring.map((point, index) => {
        const x = Math.round(Number(point[0] ?? 0) * W);
        const y = Math.round(Number(point[1] ?? 0) * H);
        return `${index === 0 ? "M" : "L"}${x},${y}`;
      });
      paths.push(`${segments.join(" ")}Z`);
    }
    if (paths.length === 0) return undefined;
    targetSelector = {
      type: "SvgSelector",
      value: `<svg xmlns="http://www.w3.org/2000/svg"><path d="${paths.join(" ")}"/></svg>`
    };
  } else if (target.type === "Point") {
    const [u, v] = target.coordinates;
    const x = Math.round(Number(u ?? 0) * W);
    const y = Math.round(Number(v ?? 0) * H);
    targetSelector = {
      type: "FragmentSelector",
      conformsTo: "http://www.w3.org/TR/media-frags/",
      value: `xywh=${x - 4},${y - 4},8,8`
    };
  } else {
    return undefined;
  }

  return {
    "@context": "http://www.w3.org/ns/anno.jsonld",
    id: `urn:wsc3d:${annotation.id}`,
    type: "Annotation",
    motivation,
    body,
    target: {
      source: canvasId,
      selector: targetSelector
    },
    generator: {
      id: "https://github.com/wahonet/WSC3D",
      type: "Software",
      name: "WSC3D",
      method: annotation.generation?.method,
      model: annotation.generation?.model
    },
    created: annotation.createdAt ?? generated,
    modified: annotation.updatedAt ?? generated
  };
}

// =============================================================================
// 通用：geometry 端点是 image 的标注会用 imageSize 直接转，end of file 工具
// 用 stone.metadata.dimensions（cm）+ 模型 longEdge 做 fallback 的逻辑由
// AnnotationPanel 的"下载"按钮负责；此处只接受 imageSize。
// =============================================================================

export function downloadJson(payload: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// 给 Geometry 类型推导一个 type-only 引用，避免未使用 import 警告
export type _GeometryRef = IimlGeometry;

// =============================================================================
// G2 .hpsml — Han Pictorial Stone Markup Language 自定义研究包导出
// =============================================================================
//
// .hpsml 是项目自有的"研究档案完整包"格式，扩展 IIML 文档加入：
//   - 元数据（stone.metadata，包含尺寸 / 层级 / 出处）快照
//   - 拼接方案（assembly plans）涉及该 stoneId 的全部条目
//   - 词表快照（vocabularyCategories + vocabularyTerms 当前版本）
//   - 关系网络（relations + 自动空间推导结果，由前端负责传入）
//   - AI 处理记录（processingRuns 全量）
//   - 导出元信息（exportedAt / exporter / version）
//
// 落盘是单个 JSON（建议扩展名 .hpsml.json，便于编辑器识别）。
// 解包 / 校验由后端 backend/src/services/hpsml.ts 负责（待实现）。
//
// 与 IIML 的关系：.hpsml 包含 IIML 全文 + 周边研究档案，是 IIML 的超集。
// 解包时拆出 iiml 字段就是标准 IIML 文档，可独立使用。

export type HpsmlExportOptions = {
  // 当前画像石的 stone metadata；用于在包外存一份方便协作时不依赖原始 catalog
  stone?: StoneListItem;
  metadata?: StoneMetadata;
  // 与该 stoneId 相关的拼接方案（前端从 fetchAssemblyPlans 拉到后过滤传入）
  relatedAssemblyPlans?: AssemblyPlanRecord[];
  // 词表快照（导出时刻）
  vocabularyCategories?: VocabularyCategory[];
  vocabularyTerms?: VocabularyTerm[];
  // 谁导的（缺省 "local-user"）
  exporter?: string;
  // 导出说明（可选，用户写一段研究上下文供日后查阅）
  notes?: string;
};

export type HpsmlPackage = {
  // 文件格式签名 + 版本，便于后续解包校验
  format: "hpsml";
  formatVersion: "0.1.0";
  // 导出元信息
  package: {
    exportedAt: string;
    exporter: string;
    notes?: string;
    // 实际生成机器的简短 ID（uuid 截断），便于多机协作时区分来源
    generatorRunId: string;
  };
  // IIML 主体（标注 / 关系 / processingRuns 全部在里面）
  iiml: IimlDocument;
  // 周边研究档案
  context: {
    stone?: StoneListItem;
    metadata?: StoneMetadata;
    relatedAssemblyPlans: AssemblyPlanRecord[];
    vocabulary: {
      categories: VocabularyCategory[];
      terms: VocabularyTerm[];
    };
    // 关系网络分析结果：节点度数 / 连通分量数 / 关系总数（计算开销可控的 quick stats）
    networkStats: {
      annotationCount: number;
      relationCount: number;
      processingRunCount: number;
      relationKindBreakdown: Record<string, number>;
    };
  };
};

export function exportToHpsml(
  doc: IimlDocument,
  relations: IimlRelation[],
  options: HpsmlExportOptions = {}
): HpsmlPackage {
  const exportedAt = new Date().toISOString();
  const generatorRunId = `wsc3d-${Math.random().toString(36).slice(2, 10)}`;

  // 关系类别分布
  const relationKindBreakdown: Record<string, number> = {};
  for (const relation of relations) {
    const key = relation.kind || "unknown";
    relationKindBreakdown[key] = (relationKindBreakdown[key] ?? 0) + 1;
  }

  return {
    format: "hpsml",
    formatVersion: "0.1.0",
    package: {
      exportedAt,
      exporter: options.exporter ?? "local-user",
      notes: options.notes,
      generatorRunId
    },
    // 把 relations 也带回 iiml.relations，确保 IIML 单独解包时也完整
    iiml: {
      ...doc,
      relations: relations as unknown as IimlDocument["relations"]
    },
    context: {
      stone: options.stone,
      metadata: options.metadata,
      relatedAssemblyPlans: options.relatedAssemblyPlans ?? [],
      vocabulary: {
        categories: options.vocabularyCategories ?? [],
        terms: options.vocabularyTerms ?? []
      },
      networkStats: {
        annotationCount: doc.annotations.length,
        relationCount: relations.length,
        processingRunCount: Array.isArray(doc.processingRuns) ? doc.processingRuns.length : 0,
        relationKindBreakdown
      }
    }
  };
}
