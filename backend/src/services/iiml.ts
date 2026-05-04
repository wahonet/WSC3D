/**
 * IIML 文档持久化与受控词表服务
 *
 * 后端层 IIML 文档的"门面"，统一处理：
 * - **schema 校验**：用 ajv 2020-12 + JSON-Schema-Draft 加载内嵌 IIML 模式，
 *   保存前一次性把整份 doc 校验，错误带字段路径直接抛 422
 * - **持久化**：读 / 写 `data/iiml/{stoneId}.iiml.json`；JSON 缩进 2 空格 + 末尾
 *   换行，保持 git diff 友好
 * - **从结构化档案 import**：`importMarkdownIntoIiml` 把
 *   `画像石结构化分档/{name}.md` 里的层级 / 面板段落转成层次化 IIML annotations
 *   （结构层级 = `scene` / `figure` / `component`），方便用户在标注模块基础上
 *   编辑而非从零开始
 * - **alignment 状态汇总**：`listAlignments` 一次性回报所有画像石的 4 点对齐
 *   状态（`{ stoneId: hasAlignment }`），供前端下拉显示 ✓ 标记
 *
 * 设计要点：
 * - schema 校验走 ajv 默认严格模式，但允许 additionalProperties（IIML 鼓励
 *   研究者自由扩展）
 * - 保存时自动补 `provenance.{savedAt, savedBy}`，便于审计
 * - 类型定义与 `frontend/src/api/client.ts` 手动同步；任一端字段调整都需要
 *   两端同时修改
 */

import * as Ajv2020Module from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CatalogConfig, getCatalog } from "./catalog.js";

type CatalogLoader = typeof getCatalog;

export type IimlPoint = [number, number] | [number, number, number] | [number, number, number, number];

export type IimlGeometry =
  | { type: "Point"; coordinates: IimlPoint }
  | { type: "LineString"; coordinates: IimlPoint[] }
  | { type: "Polygon"; coordinates: IimlPoint[][] }
  | { type: "MultiPolygon"; coordinates: IimlPoint[][][] }
  | { type: "BBox"; coordinates: [number, number, number, number] };

export type IimlTermRef = {
  id: string;
  label: string;
  scheme?: string;
  role?: string;
};

// 证据源：与前端 IimlSource 保持同构，kind 判别四种来源。
export type IimlSource =
  | { kind: "metadata"; layerIndex: number; panelIndex?: number; note?: string }
  | { kind: "reference"; title?: string; uri?: string; citation?: string }
  | { kind: "resource"; resourceId: string; note?: string }
  | { kind: "other"; text: string };

// 标注所处坐标系；缺省 "model" 兼容历史数据。
export type IimlAnnotationFrame = "image" | "model";

export type IimlAlignmentControlPoint = {
  modelUv: [number, number];
  imageUv: [number, number];
};

export type IimlAlignment = {
  version: 1;
  calibratedAt: string;
  calibratedBy?: string;
  controlPoints: IimlAlignmentControlPoint[];
  imageNaturalSize?: [number, number];
  notes?: string;
};

export type IimlAnnotation = {
  id: string;
  type?: "Annotation";
  resourceId: string;
  target: IimlGeometry;
  frame?: IimlAnnotationFrame;
  structuralLevel: "whole" | "scene" | "figure" | "component" | "trace" | "inscription" | "damage" | "unknown";
  label?: string;
  color?: string;
  // 标注填充区域的透明度 0..1；描边不透明。默认 0.15。
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
  semantics?: {
    name?: string;
    description?: string;
    // 前图像志：可见对象纯描述，论文 35 ICON 三层的第一层。
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
    reviewStatus?: "candidate" | "reviewed" | "approved" | "rejected";
  };
  reviewStatus?: "candidate" | "reviewed" | "approved" | "rejected";
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
  notes?: string;
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
  vocabularies?: Array<Record<string, unknown>>;
  processingRuns?: Array<Record<string, unknown>>;
  provenance?: Record<string, unknown>;
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

const iimlContext = {
  iiml: "https://wsc3d.local/ontology/iiml#",
  oa: "http://www.w3.org/ns/oa#",
  dcterms: "http://purl.org/dc/terms/",
  geojson: "https://purl.org/geojson/vocab#"
};

const structuralLevels = new Set(["whole", "scene", "figure", "component", "trace", "inscription", "damage", "unknown"]);

const iimlSchema: AnySchema = {
  type: "object",
  additionalProperties: true,
  required: ["@context", "@type", "documentId", "name", "resources", "annotations"],
  properties: {
    "@context": { anyOf: [{ type: "string" }, { type: "object" }, { type: "array" }] },
    "@type": { type: "string", const: "IIMLDocument" },
    documentId: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    description: { type: "string", nullable: true },
    version: { type: "string", nullable: true },
    language: { type: "string", nullable: true },
    culturalObject: { type: "object", nullable: true, additionalProperties: true },
    resources: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: true,
        required: ["id", "type", "uri"],
        properties: {
          id: { type: "string", minLength: 1 },
          type: { type: "string", minLength: 1 },
          uri: { type: "string", minLength: 1 }
        }
      }
    },
    annotations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["id", "resourceId", "target", "structuralLevel"],
        properties: {
          id: { type: "string", minLength: 1 },
          resourceId: { type: "string", minLength: 1 },
          target: { type: "object", additionalProperties: true, required: ["type", "coordinates"] },
          structuralLevel: { type: "string" }
        }
      }
    },
    relations: { type: "array", nullable: true, items: { type: "object", additionalProperties: true } },
    vocabularies: { type: "array", nullable: true, items: { type: "object", additionalProperties: true } },
    processingRuns: { type: "array", nullable: true, items: { type: "object", additionalProperties: true } },
    provenance: { type: "object", nullable: true, additionalProperties: true }
  }
};

type ValidateFn = ((data: unknown) => boolean) & { errors?: unknown };
const Ajv2020 = (Ajv2020Module as unknown as {
  default: new (options: { allErrors: boolean }) => { compile: (schema: AnySchema) => ValidateFn; errorsText: (errors: unknown) => string };
}).default;
const ajv = new Ajv2020({ allErrors: true });
const validateIiml = ajv.compile(iimlSchema);

export function getIimlContext() {
  return iimlContext;
}

export async function loadIimlDoc(projectRoot: string, catalogConfig: CatalogConfig, getCatalogImpl: CatalogLoader, stoneId: string): Promise<IimlDocument> {
  const id = sanitizeIimlId(stoneId);
  const filePath = iimlFilePath(projectRoot, id);
  try {
    const raw = await readFile(filePath, "utf8");
    const doc = JSON.parse(raw) as IimlDocument;
    validateIimlDoc(doc);
    return doc;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return createDefaultIimlDoc(projectRoot, catalogConfig, getCatalogImpl, id);
  }
}

export async function saveIimlDoc(projectRoot: string, stoneId: string, doc: IimlDocument): Promise<IimlDocument> {
  const id = sanitizeIimlId(stoneId);
  const normalized = normalizeIimlDoc(id, doc);
  validateIimlDoc(normalized);
  await mkdir(path.dirname(iimlFilePath(projectRoot, id)), { recursive: true });
  await writeFile(iimlFilePath(projectRoot, id), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export async function importMarkdownIntoIiml(
  projectRoot: string,
  catalogConfig: CatalogConfig,
  getCatalogImpl: CatalogLoader,
  stoneId: string
): Promise<IimlDocument> {
  const id = sanitizeIimlId(stoneId);
  const catalog = await getCatalogImpl(catalogConfig);
  const stone = catalog.stones.find((item) => item.id === id);
  if (!stone?.metadata) {
    throw new Error("metadata_not_found");
  }

  const baseDoc = await loadIimlDoc(projectRoot, catalogConfig, getCatalogImpl, id);
  const now = new Date().toISOString();
  const resourceId = baseDoc.resources[0]?.id ?? `${id}:model`;
  const imported = stone.metadata.layers.flatMap((layer) => {
    const panels = layer.panels.length > 0 ? layer.panels : [{ panel_index: 0, position: layer.title, content: layer.content, source: layer.source }];
    return panels.map((panel) => ({
      id: `${id}:md:l${layer.layer_index}:p${panel.panel_index || 0}`,
      type: "Annotation" as const,
      resourceId,
      target: { type: "BBox" as const, coordinates: [0, 0, 1, 1] as [number, number, number, number] },
      structuralLevel: "scene" as const,
      label: panel.position || layer.title,
      semantics: {
        name: panel.position || layer.title,
        description: panel.content,
        iconographicMeaning: panel.content
      },
      reviewStatus: "reviewed" as const,
      generation: { method: "imported", model: "markdown-parser", reviewStatus: "reviewed" as const },
      createdBy: "markdown-import",
      createdAt: now,
      updatedAt: now,
      notes: panel.source ? `${panel.content}\n\n来源：${panel.source}` : panel.content
    }));
  });

  const importedIds = new Set(imported.map((annotation) => annotation.id));
  const doc: IimlDocument = {
    ...baseDoc,
    annotations: [...baseDoc.annotations.filter((annotation) => !importedIds.has(annotation.id)), ...imported],
    provenance: {
      ...baseDoc.provenance,
      updatedAt: now,
      updatedBy: "markdown-import"
    }
  };
  return saveIimlDoc(projectRoot, id, doc);
}

/**
 * 扫描 data/iiml/*.iiml.json，对每条返回 stoneId → 是否含 culturalObject.alignment。
 * 仅做最小校验（controlPoints 是数组且 ≥ 4），与前端 store.getAlignment 一致。
 *
 * 性能：一次读 N 个文件（当前 < 20）；JSON.parse 后只读 culturalObject 节就丢，
 * 不全文校验。前端可以在切画像石时，决定是否提示用户"该石头还没做对齐校准"。
 */
export async function listAlignments(projectRoot: string): Promise<Record<string, boolean>> {
  const dir = path.join(projectRoot, "data", "iiml");
  let entries: string[];
  try {
    entries = await import("node:fs/promises").then((fs) => fs.readdir(dir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  const result: Record<string, boolean> = {};
  await Promise.all(
    entries
      .filter((name) => name.endsWith(".iiml.json"))
      .map(async (name) => {
        const stoneId = name.replace(/\.iiml\.json$/u, "");
        try {
          const raw = await readFile(path.join(dir, name), "utf8");
          const doc = JSON.parse(raw) as { culturalObject?: { alignment?: { controlPoints?: unknown } } };
          const alignment = doc.culturalObject?.alignment;
          const points = alignment && Array.isArray(alignment.controlPoints) ? alignment.controlPoints : [];
          result[stoneId] = points.length >= 4;
        } catch {
          // 单文件解析失败不影响其它文件；记为未校准
          result[stoneId] = false;
        }
      })
  );
  return result;
}

export async function loadVocabulary(projectRoot: string): Promise<{ categories: VocabularyCategory[]; terms: VocabularyTerm[] }> {
  const raw = await readFile(path.join(projectRoot, "data", "terms.json"), "utf8");
  const source = JSON.parse(raw) as { categories?: VocabularyCategory[] };
  const categories = source.categories ?? [];
  const terms = categories.flatMap((category) =>
    category.terms.map((label) => ({
      id: `${category.id}:${slugify(label)}`,
      prefLabel: label,
      altLabel: [],
      scheme: "WSC3D",
      broader: [category.id]
    }))
  );
  return { categories, terms };
}

function validateIimlDoc(doc: IimlDocument) {
  if (!validateIiml(doc)) {
    throw new Error(`invalid_iiml_document: ${ajv.errorsText(validateIiml.errors)}`);
  }
  for (const annotation of doc.annotations) {
    if (!structuralLevels.has(annotation.structuralLevel)) {
      throw new Error(`invalid_structural_level: ${annotation.structuralLevel}`);
    }
    validateGeometry(annotation.target);
  }
}

function validateGeometry(geometry: IimlGeometry) {
  if (!geometry || typeof geometry.type !== "string") {
    throw new Error("invalid_geometry");
  }
  const coords = (geometry as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coords)) {
    throw new Error("invalid_geometry_coordinates");
  }
}

async function createDefaultIimlDoc(
  projectRoot: string,
  catalogConfig: CatalogConfig,
  getCatalogImpl: CatalogLoader,
  stoneId: string
): Promise<IimlDocument> {
  const catalog = await getCatalogImpl(catalogConfig);
  const stone = catalog.stones.find((item) => item.id === stoneId);
  if (!stone) {
    throw new Error("stone_not_found");
  }
  const now = new Date().toISOString();
  return {
    "@context": "/api/iiml/context",
    "@type": "IIMLDocument",
    documentId: `${stoneId}:iiml`,
    name: `${stone.displayName} 标注`,
    version: "0.1.0",
    language: "zh-CN",
    culturalObject: {
      objectId: stone.id,
      name: stone.displayName,
      objectType: "stone_relief",
      dimensions: stone.metadata?.dimensions
        ? {
            width: stone.metadata.dimensions.width,
            height: stone.metadata.dimensions.height,
            depth: stone.metadata.dimensions.thickness,
            unit: stone.metadata.dimensions.unit
          }
        : undefined
    },
    resources: [
      {
        id: `${stoneId}:model`,
        type: "Mesh3D",
        uri: stone.modelUrl ?? `/api/stones/${encodeURIComponent(stoneId)}/model`,
        name: stone.displayName,
        format: stone.model?.extension === ".glb" ? "model/gltf-binary" : "model/gltf+json",
        coordinateSystem: { type: "world3d", origin: "model-center", unit: "model" }
      }
    ],
    annotations: [],
    relations: [],
    vocabularies: (await loadVocabulary(projectRoot)).terms,
    processingRuns: [],
    provenance: {
      createdBy: "wsc3d",
      createdAt: now,
      updatedBy: "wsc3d",
      updatedAt: now
    }
  };
}

function normalizeIimlDoc(stoneId: string, doc: IimlDocument): IimlDocument {
  const now = new Date().toISOString();
  return {
    ...doc,
    "@context": doc["@context"] || "/api/iiml/context",
    "@type": "IIMLDocument",
    documentId: doc.documentId || `${stoneId}:iiml`,
    name: doc.name || `${stoneId} 标注`,
    version: doc.version ?? "0.1.0",
    language: doc.language ?? "zh-CN",
    resources: Array.isArray(doc.resources) && doc.resources.length > 0 ? doc.resources : [{ id: `${stoneId}:model`, type: "Mesh3D", uri: `/api/stones/${stoneId}/model` }],
    annotations: Array.isArray(doc.annotations) ? doc.annotations : [],
    relations: Array.isArray(doc.relations) ? doc.relations : [],
    vocabularies: Array.isArray(doc.vocabularies) ? doc.vocabularies : [],
    processingRuns: Array.isArray(doc.processingRuns) ? doc.processingRuns : [],
    provenance: {
      ...(doc.provenance ?? {}),
      updatedAt: now
    }
  };
}

function iimlFilePath(projectRoot: string, stoneId: string) {
  return path.join(projectRoot, "data", "iiml", `${stoneId}.iiml.json`);
}

function sanitizeIimlId(id: string) {
  const trimmed = id.trim();
  if (!/^[\p{Letter}\p{Number}._:-]+$/u.test(trimmed)) {
    throw new Error("invalid_iiml_id");
  }
  return trimmed;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{Letter}\p{Number}-]+/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}
