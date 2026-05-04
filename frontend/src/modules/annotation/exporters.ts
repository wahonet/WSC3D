import type { IimlAnnotation, IimlDocument, IimlGeometry, IimlStructuralLevel } from "./types";

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
