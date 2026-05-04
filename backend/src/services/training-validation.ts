/**
 * 训练池准入校验（后端版）
 *
 * 与 `frontend/src/modules/annotation/training.ts` 算法严格对齐 ——
 * SOP v0.3 §11 `is_training_ready` 11 项硬约束 + 1 项 warning。
 *
 * 重复实现而非共享代码的原因：
 * - 前端 / 后端类型定义历史上是手动同步（client.ts ↔ services/iiml.ts）
 * - 后端校验在 A2 数据集导出时跑一次（写盘前），不依赖网络
 * - 前端校验给 ListTab 实时徽标提示（每条 annotation rerender）
 *
 * 当 SOP §11 升级为 v0.4 时，**两个文件必须一起改**。
 */

import type { IimlAlignment, IimlAnnotation, IimlDocument, IimlGeometry } from "./iiml.js";

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

// SOP v0.3 §1.1 类别表 13 + unknown
const HAN_STONE_CATEGORIES = new Set([
  "figure-deity",
  "figure-immortal",
  "figure-mythic-ruler",
  "figure-loyal-assassin",
  "figure-filial-son",
  "figure-virtuous-woman",
  "figure-music-dance",
  "chariot-procession",
  "mythic-creature",
  "celestial",
  "daily-life-scene",
  "architecture",
  "inscription",
  "pattern-border",
  "unknown"
]);

const NARRATIVE_CATEGORIES_NEED_MOTIF = new Set([
  "figure-loyal-assassin",
  "figure-filial-son",
  "figure-virtuous-woman"
]);

export type TrainingValidationResult = {
  ready: boolean;
  errors: string[];
  warnings: string[];
};

export function validateAnnotationForTraining(
  ann: IimlAnnotation,
  doc?: IimlDocument
): TrainingValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 0. SOP §3.4 frame 准入：训练池只接受 frame=image 的 annotation；
  //    frame=model 必须满足下述任一条件才能由 training-export 反投影到 image：
  //      a. resourceId 指向"等价正射图"（view=front + frustumScale≈1.0）→ 坐标系等价
  //      b. doc.culturalObject.alignment 已校准（4 对控制点）→ 走单应性反投影
  //    都不满足 → "frame-model-no-alignment" 错误，整条 annotation 跳过。
  const frame = ann.frame ?? "model";
  if (frame === "model") {
    const isEquivalentOrtho = isEquivalentOrthophotoResource(ann.resourceId, doc);
    const alignment = getAlignmentFromDoc(doc);
    if (!isEquivalentOrtho && !alignment) {
      errors.push("frame-model-no-alignment");
    }
  }

  // 1. 几何
  const geometryError = validateGeometryForTraining(ann.target);
  if (geometryError) errors.push(geometryError);

  // 2. structuralLevel
  if (!ann.structuralLevel || !STRUCTURAL_LEVELS_V8.has(ann.structuralLevel)) {
    errors.push("bad-structural-level");
  }

  // 3. category
  const category = (ann as IimlAnnotation & { category?: string }).category;
  if (!category || !HAN_STONE_CATEGORIES.has(category)) {
    errors.push("bad-category");
  }

  // 4. motif 长度上限
  const motif = (ann as IimlAnnotation & { motif?: string }).motif;
  if (motif && motif.length > 200) {
    errors.push("motif-too-long");
  }

  // 5. terms >= 1
  const termCount = ann.semantics?.terms?.length ?? 0;
  if (termCount < 1) {
    errors.push("no-terms");
  }

  // 6. sources >= 1，且 ≥ 1 条 metadata 或 reference
  const sources = ann.sources ?? [];
  if (sources.length < 1) {
    errors.push("no-sources");
  } else if (!sources.some((s) => s.kind === "metadata" || s.kind === "reference")) {
    errors.push("no-evidence-source");
  }

  // 7. preIconographic ≥ 10
  const pre = (ann.semantics?.preIconographic ?? "").trim();
  if (pre.length < 10) {
    errors.push("pre-iconographic-too-short");
  }

  // 8. iconographicMeaning ≥ 10
  const icono = (ann.semantics?.iconographicMeaning ?? "").trim();
  if (icono.length < 10) {
    errors.push("iconographic-too-short");
  }

  // 9. reviewStatus（SOP §11 v0.3.1 调整）
  //    放宽：reviewed / approved 都进训练池；candidate / rejected 拦截。
  //    geometry.ts 默认创建 reviewStatus="reviewed"，sam.ts 创建 "candidate"，
  //    使老约定（必须 approved）会让所有手工标注被拦下，不符合实务流。
  //    工作流：标员手工创建 → reviewed（默认进池）；AI 候选 → candidate（人审过
  //    → reviewed/approved 才进池）；rejected 永不进池。
  if (ann.reviewStatus && ann.reviewStatus !== "approved" && ann.reviewStatus !== "reviewed") {
    errors.push(`review-status-${ann.reviewStatus}`);
  }

  // 10. inscription transcription
  if (ann.structuralLevel === "inscription") {
    const transcription = ann.semantics?.inscription?.transcription;
    if (!transcription || !transcription.trim()) {
      errors.push("inscription-no-transcription");
    }
  }

  // 11. 几何尺寸
  const sizeError = validateGeometrySize(ann.target);
  if (sizeError) errors.push(sizeError);

  // 12 (warning). 故事类缺 motif
  if (
    category &&
    NARRATIVE_CATEGORIES_NEED_MOTIF.has(category) &&
    !(motif && motif.trim())
  ) {
    warnings.push("missing-motif-for-narrative");
  }

  return { ready: errors.length === 0, errors, warnings };
}

function validateGeometryForTraining(geometry: IimlGeometry | undefined): string | null {
  if (!geometry) return "geometry-missing";
  if (!geometry.type) return "geometry-no-type";

  switch (geometry.type) {
    case "Point": {
      const coords = geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return "geometry-point-invalid";
      if (!coords.every((n: unknown) => Number.isFinite(n as number))) return "geometry-point-nan";
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
      if (!coords.every((n: unknown) => Number.isFinite(n as number))) return "geometry-bbox-nan";
      return null;
    }
    default:
      return "geometry-unknown-type";
  }
}

function validateGeometrySize(geometry: IimlGeometry | undefined): string | null {
  if (!geometry) return null;
  const MIN_AREA = 1e-5;

  if (geometry.type === "BBox") {
    // IIML BBox = [u1, v1, u2, v2] 两个对角点 UV，**不是** [x, y, w, h]。
    // 早期版本错把 u2/v2 当 w/h，导致面积过滤完全失效（u2≈0.6、v2≈0.4 永远 > 1e-5）。
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

/**
 * 判断给定 resourceId 所指资源是否"与 3D 模型 UV 等价的正射图"。
 * 等价条件（与 frontend `activeResourceEquivalentToModel` 对齐）：
 *   - transform.kind === "orthographic-from-model"
 *   - 显式 transform.equivalentToModel === true，或
 *   - view==="front" 且 |frustumScale - 1.0| < 1e-3（老数据兜底）
 */
export function isEquivalentOrthophotoResource(
  resourceId: string | undefined,
  doc: IimlDocument | undefined
): boolean {
  if (!resourceId || !doc?.resources) return false;
  const raw = doc.resources.find((r) => (r as Record<string, unknown>).id === resourceId) as
    | Record<string, unknown>
    | undefined;
  if (!raw) return false;
  const transform = raw.transform as Record<string, unknown> | undefined;
  if (!transform) return false;
  if (transform.kind !== "orthographic-from-model") return false;
  if (transform.equivalentToModel === true) return true;
  const view = transform.view;
  const frustumScale = typeof transform.frustumScale === "number" ? transform.frustumScale : 1.05;
  return view === "front" && Math.abs(frustumScale - 1.0) < 1e-3;
}

/**
 * 从 doc.culturalObject.alignment 取出已完成的 4 点对齐；字段不完整返回 undefined。
 * 与 frontend `getAlignment` 对齐，单独做一份是为了不让校验依赖前端 store。
 */
export function getAlignmentFromDoc(doc: IimlDocument | undefined): IimlAlignment | undefined {
  const raw = doc?.culturalObject && (doc.culturalObject as Record<string, unknown>).alignment;
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Partial<IimlAlignment>;
  if (!Array.isArray(candidate.controlPoints) || candidate.controlPoints.length < 4) {
    return undefined;
  }
  for (const point of candidate.controlPoints) {
    if (
      !Array.isArray(point.modelUv) || point.modelUv.length !== 2 ||
      !Array.isArray(point.imageUv) || point.imageUv.length !== 2
    ) {
      return undefined;
    }
  }
  return candidate as IimlAlignment;
}

function polygonAreaAbs(ring: ReadonlyArray<readonly number[]>): number {
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
