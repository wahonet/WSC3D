/**
 * IIML 四层标注数据模型（物理层 / 视觉层 / 图像学层 / 文化层）
 *
 * 依据形相学理论的四层结构（朱青生团队《汉画总录》IIML 系统）：
 * 1. 物理层：文物的物质属性与考古信息（材质、技法、尺寸、出土、断代、保存）
 * 2. 视觉层：视觉形式特征（构图、线条、空间组织、对称、纹理）
 * 3. 图像学层：图像母题识别 + 区域标注 + 空间关系（= 画布上的 annotations/relations）
 * 4. 文化层：宗教意义、社会功能、文化背景、象征系统、现代阐释
 *
 * 四层数据统一存入 IIML 文档的 culturalObject 下：
 *   culturalObject.physicalLayer / visualLayer / iconographyMeta / culturalLayer
 * 图像学层的"区域"即 doc.annotations，"空间关系"即 doc.relations，
 * iconographyMeta 只存主题 / 叙事类型两个文档级字段。
 *
 * 后端 IIML schema 对 culturalObject 是 additionalProperties: true，
 * 直接持久化，无需后端改动。
 */

import type { IimlDocument } from "./types";

// ---------------- 第一层：物理层 ----------------

export type IimlPhysicalLayer = {
  material?: string;
  technique?: string;
  dynasty?: string;
  period?: string;
  datingMethod?: string;
  discoverySite?: string;
  currentCollection?: string;
  positionInTomb?: string;
  preservationCondition?: string;
  damage?: string[];
  restoration?: string;
};

// ---------------- 第二层：视觉层 ----------------

export const compositionTypes = ["中心式构图", "散点式构图", "连环式构图", "对称式构图", "分层式构图"] as const;

export type IimlVisualLayer = {
  compositionType?: string;
  compositionDescription?: string;
  lineTechnique?: string;
  lineQuality?: string;
  spatialLayers?: string[];
  perspective?: string;
  symmetryType?: string;
  symmetryDegree?: number;
  texturePatterns?: string;
};

// ---------------- 第三层：图像学层（文档级元信息） ----------------

export type IimlIconographyMeta = {
  mainTheme?: string;
  narrativeType?: string;
};

export const narrativeTypes = ["神话叙事", "历史叙事", "现实生活", "装饰图案", "混合叙事"] as const;

// ---------------- 第四层：文化层 ----------------

export type IimlSymbolEntry = {
  symbol: string;
  meaning: string;
};

export type IimlCulturalLayer = {
  religiousMeaning?: {
    beliefSystem?: string;
    coreConcept?: string;
    ritualContext?: string;
  };
  socialFunction?: {
    context?: string;
    function?: string;
    audience?: string;
  };
  culturalBackground?: {
    period?: string;
    region?: string;
    intellectual?: string;
  };
  symbolicSystem?: IimlSymbolEntry[];
  comparativeAnalysis?: string;
  modernInterpretation?: string;
};

// ---------------- 读取 helpers ----------------

function nodeOf<T>(doc: IimlDocument | undefined, key: string): T {
  const raw = doc?.culturalObject?.[key];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as T;
  }
  return {} as T;
}

export function getPhysicalLayer(doc?: IimlDocument): IimlPhysicalLayer {
  return nodeOf<IimlPhysicalLayer>(doc, "physicalLayer");
}

export function getVisualLayer(doc?: IimlDocument): IimlVisualLayer {
  return nodeOf<IimlVisualLayer>(doc, "visualLayer");
}

export function getIconographyMeta(doc?: IimlDocument): IimlIconographyMeta {
  return nodeOf<IimlIconographyMeta>(doc, "iconographyMeta");
}

export function getCulturalLayer(doc?: IimlDocument): IimlCulturalLayer {
  return nodeOf<IimlCulturalLayer>(doc, "culturalLayer");
}

// ---------------- 完成度 ----------------

export type LayerKey = "physical" | "visual" | "iconography" | "cultural";

export type LayerProgress = {
  filled: number;
  total: number;
};

function filledCount(values: Array<unknown>): number {
  return values.filter((value) => {
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }).length;
}

export function layerProgress(doc: IimlDocument | undefined): Record<LayerKey, LayerProgress> {
  const physical = getPhysicalLayer(doc);
  const visual = getVisualLayer(doc);
  const iconography = getIconographyMeta(doc);
  const cultural = getCulturalLayer(doc);
  const annotationCount = doc?.annotations.length ?? 0;
  const relationCount = doc?.relations?.length ?? 0;

  return {
    physical: {
      filled: filledCount([
        physical.material,
        physical.technique,
        physical.dynasty,
        physical.discoverySite,
        physical.currentCollection,
        physical.preservationCondition
      ]),
      total: 6
    },
    visual: {
      filled: filledCount([
        visual.compositionType,
        visual.compositionDescription,
        visual.lineTechnique,
        visual.lineQuality,
        visual.perspective,
        visual.spatialLayers
      ]),
      total: 6
    },
    iconography: {
      filled: filledCount([
        iconography.mainTheme,
        iconography.narrativeType,
        annotationCount > 0 ? annotationCount : undefined,
        relationCount > 0 ? relationCount : undefined
      ]),
      total: 4
    },
    cultural: {
      filled: filledCount([
        cultural.religiousMeaning?.coreConcept,
        cultural.socialFunction?.function,
        cultural.culturalBackground?.region,
        cultural.symbolicSystem,
        cultural.modernInterpretation
      ]),
      total: 5
    }
  };
}
