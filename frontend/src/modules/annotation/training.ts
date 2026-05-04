/**
 * 训练池准入校验：实现 SOP v0.3 §11 `is_training_ready`
 *
 * 给单条 IimlAnnotation 跑 11 项硬约束 + 1 项 warning，返回 errors / warnings。
 * 用于：
 * - 列表 tab 给每条 annotation 显示 ✓ / ⚠️ / ✗ 状态徽标
 * - A2 "导出训练集"按钮（M5 Phase 1 待做）批量过滤
 * - 数据集进度面板统计训练池命中率
 *
 * 设计：
 * - 不依赖 React，纯 TypeScript，方便后端 share 或独立单测
 * - 11 项 errors 任一不过 = 不进训练池
 * - 1 项 warning = 进，但 A2 导出报告里高亮（默认是"故事类缺 motif"）
 * - 几何 / 顶点数校验依赖 IimlGeometry，校验函数定义在本文件内（与 SOP §3.2 对齐）
 */

import type {
  IimlAnnotation,
  IimlDocument,
  IimlGeometry,
  IimlHanStoneCategory
} from "../../api/client";
import { hanStoneCategoryValueSet, narrativeCategoriesNeedMotif } from "./categories";

// SOP §2 结构层级 8 档枚举
const STRUCTURAL_LEVELS_V8 = new Set([
  "whole",
  "scene",
  "figure",
  "component",
  "trace",
  "inscription",
  "damage",
  "unknown"
]);

export type TrainingValidationResult = {
  /** 进训练池 = 所有 errors 为空 */
  ready: boolean;
  /** 11 项硬约束未通过的原因码（机器可读，A2 导出报告会原样输出） */
  errors: string[];
  /** 不阻塞但需关注的告警，如 "missing-motif-for-narrative" */
  warnings: string[];
};

/**
 * 校验单条 annotation 是否满足 SOP §11 训练池准入。
 *
 * @param ann - 待校验的标注
 * @param doc - 所在 IIML 文档（暂未使用，保留用于未来跨条校验如 sources.metadata 引用 doc.layer）
 * @returns errors / warnings；ready 为 errors.length === 0
 */
export function validateAnnotationForTraining(
  ann: IimlAnnotation,
  // 保留参数以便后续做跨条校验（如关系成对存在、frame 与 alignment 状态匹配）
  _doc?: IimlDocument
): TrainingValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. 几何字段非空且无自相交（自相交检查交给 polygon-clipping 兜底）
  const geometryError = validateGeometry(ann.target);
  if (geometryError) errors.push(geometryError);

  // 2. structuralLevel ∈ 8 档
  if (!ann.structuralLevel || !STRUCTURAL_LEVELS_V8.has(ann.structuralLevel)) {
    errors.push("bad-structural-level");
  }

  // 3. category ∈ 13 + unknown（缺字段直接 fail，鼓励显式标 unknown）
  if (!ann.category || !hanStoneCategoryValueSet.has(ann.category)) {
    errors.push("bad-category");
  }

  // 4. motif 长度上限（warn 不在这里，见 §11 第 12 项）
  if (ann.motif && ann.motif.length > 200) {
    errors.push("motif-too-long");
  }

  // 5. terms.length >= 1
  const termCount = ann.semantics?.terms?.length ?? 0;
  if (termCount < 1) {
    errors.push("no-terms");
  }

  // 6. sources >= 1，且 ≥ 1 条 kind ∈ {metadata, reference}
  const sources = ann.sources ?? [];
  if (sources.length < 1) {
    errors.push("no-sources");
  } else if (!sources.some((s) => s.kind === "metadata" || s.kind === "reference")) {
    errors.push("no-evidence-source");
  }

  // 7. preIconographic ≥ 10 字
  const pre = (ann.semantics?.preIconographic ?? "").trim();
  if (pre.length < 10) {
    errors.push("pre-iconographic-too-short");
  }

  // 8. iconographicMeaning ≥ 10 字
  const icono = (ann.semantics?.iconographicMeaning ?? "").trim();
  if (icono.length < 10) {
    errors.push("iconographic-too-short");
  }

  // 9. reviewStatus（SOP v0.3.1 放宽）：reviewed / approved 都进；candidate / rejected 拦截。
  //    手工标注默认 reviewed（geometry.ts），AI 候选 candidate（sam.ts），人审过才升级。
  if (
    ann.reviewStatus &&
    ann.reviewStatus !== "approved" &&
    ann.reviewStatus !== "reviewed"
  ) {
    errors.push(`review-status-${ann.reviewStatus}`);
  }

  // 10. inscription 类必须有 transcription
  if (ann.structuralLevel === "inscription") {
    const transcription = ann.semantics?.inscription?.transcription;
    if (!transcription || !transcription.trim()) {
      errors.push("inscription-no-transcription");
    }
  }

  // 11. 多边形顶点 ∈ [6, 200]，bbox 面积 ≥ 64 px²（前者由 validateGeometry 已做；
  //    bbox 面积按"标注所属图像分辨率 ≥ 1500 px"假设近似为归一化坐标 ≥ 1e-5）
  const sizeError = validateGeometrySize(ann.target);
  if (sizeError) errors.push(sizeError);

  // 12 (warning). 故事类 category 缺 motif
  if (
    ann.category &&
    narrativeCategoriesNeedMotif.has(ann.category as IimlHanStoneCategory) &&
    !(ann.motif && ann.motif.trim())
  ) {
    warnings.push("missing-motif-for-narrative");
  }

  return { ready: errors.length === 0, errors, warnings };
}

/**
 * 几何字段基本完整性校验。返回错误码或 null。
 * SOP §3.2 顶点数门槛：多边形顶点 ∈ [6, 200]
 */
function validateGeometry(geometry: IimlGeometry | undefined): string | null {
  if (!geometry) return "geometry-missing";
  if (!geometry.type) return "geometry-no-type";

  switch (geometry.type) {
    case "Point": {
      const coords = geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return "geometry-point-invalid";
      if (!coords.every((n) => Number.isFinite(n))) return "geometry-point-nan";
      return null;
    }
    case "LineString": {
      const coords = geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return "geometry-linestring-too-few-points";
      return null;
    }
    case "Polygon": {
      const rings = geometry.coordinates;
      if (!Array.isArray(rings) || rings.length < 1) return "geometry-polygon-no-ring";
      const outer = rings[0];
      if (!Array.isArray(outer) || outer.length < 6) return "geometry-polygon-too-few-vertices";
      if (outer.length > 200) return "geometry-polygon-too-many-vertices";
      return null;
    }
    case "MultiPolygon": {
      const polygons = geometry.coordinates;
      if (!Array.isArray(polygons) || polygons.length < 1) return "geometry-multipolygon-empty";
      for (const rings of polygons) {
        const outer = rings?.[0];
        if (!Array.isArray(outer) || outer.length < 6) return "geometry-polygon-too-few-vertices";
        if (outer.length > 200) return "geometry-polygon-too-many-vertices";
      }
      return null;
    }
    case "BBox": {
      const coords = geometry.coordinates;
      if (!Array.isArray(coords) || coords.length !== 4) return "geometry-bbox-invalid";
      if (!coords.every((n) => Number.isFinite(n))) return "geometry-bbox-nan";
      return null;
    }
    default:
      return "geometry-unknown-type";
  }
}

/**
 * 面积 / 长度门槛校验。
 * 坐标系约定：归一化 [0,1]² UV。SOP §3.5 假设最小图像长边 ≥ 1500 px，
 * 64 px² → (8/1500)² ≈ 2.84e-5。我们用 1e-5 作为下限稍宽松一点。
 */
function validateGeometrySize(geometry: IimlGeometry | undefined): string | null {
  if (!geometry) return null; // 已在 validateGeometry 报过
  const MIN_AREA = 1e-5;

  if (geometry.type === "BBox") {
    // IIML BBox = [u1, v1, u2, v2] 两个对角点 UV，**不是** [x, y, w, h]。
    // 与 backend training-validation.ts 保持算法一致。
    const [u1, v1, u2, v2] = geometry.coordinates;
    const w = Math.abs(u2 - u1);
    const h = Math.abs(v2 - v1);
    if (w <= 0 || h <= 0) return "geometry-bbox-zero";
    if (w * h < MIN_AREA) return "geometry-bbox-too-small";
    return null;
  }
  if (geometry.type === "Polygon") {
    const outer = geometry.coordinates[0];
    if (!outer) return null;
    const area = polygonAreaAbs(outer);
    if (area < MIN_AREA) return "geometry-polygon-too-small";
    return null;
  }
  if (geometry.type === "MultiPolygon") {
    let total = 0;
    for (const rings of geometry.coordinates) {
      const outer = rings?.[0];
      if (!outer) continue;
      total += polygonAreaAbs(outer);
    }
    if (total < MIN_AREA) return "geometry-multipolygon-too-small";
    return null;
  }
  return null;
}

/** Shoelace 公式取绝对值。坐标点是 [x, y]。 */
function polygonAreaAbs(ring: ReadonlyArray<readonly [number, number] | number[]>): number {
  if (ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const cur = ring[i];
    const next = ring[(i + 1) % ring.length];
    if (!cur || !next || cur.length < 2 || next.length < 2) continue;
    sum += cur[0] * next[1] - next[0] * cur[1];
  }
  return Math.abs(sum) / 2;
}

/**
 * 批量校验：返回 ready 的标注 + 失败明细。
 * A2 导出按钮直接调这个函数。
 */
export function bulkValidateForTraining(
  doc: IimlDocument
): {
  ready: IimlAnnotation[];
  skipped: Array<{ annotation: IimlAnnotation; errors: string[] }>;
  warningsCount: Record<string, number>;
} {
  const ready: IimlAnnotation[] = [];
  const skipped: Array<{ annotation: IimlAnnotation; errors: string[] }> = [];
  const warningsCount: Record<string, number> = {};

  for (const annotation of doc.annotations) {
    const result = validateAnnotationForTraining(annotation, doc);
    if (result.ready) {
      ready.push(annotation);
    } else {
      skipped.push({ annotation, errors: result.errors });
    }
    for (const w of result.warnings) {
      warningsCount[w] = (warningsCount[w] ?? 0) + 1;
    }
  }

  return { ready, skipped, warningsCount };
}
