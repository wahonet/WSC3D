/**
 * 多边形候选合并：基于 polygon-clipping 的几何并集（union）
 *
 * 候选审核 / 列表 tab 的"合并选中"入口，把多个标注的几何外环并起来生成一个
 * 新的合并候选，让用户在重叠 SAM / YOLO 候选上一键收敛。
 *
 * 业务约束：
 * - 至少 2 个候选（避免误操作）
 * - 必须同 frame（model / image）；跨坐标系合并没有意义
 * - 候选必须含 Polygon / MultiPolygon / BBox 之一；Point/LineString 没有"内部
 *   区域"，跳过
 *
 * 算法：
 * 1. 把每个 annotation 的外环（outer ring）拆出来转成 polygon-clipping 输入
 * 2. `polygonClipping.union(...)` 得到 MultiPolygon（可能包含多块不连通区域）
 * 3. 只保留每块的 outer ring，丢掉 holes —— 满足"只保留最外面的边缘"的需求
 * 4. 单块 → Polygon；多块 → MultiPolygon
 *
 * 失败语义（返回 `{ ok: false, reason }`）：
 * - `not-enough-targets`：候选少于 2
 * - `frame-mismatch`：候选不在同一坐标系
 * - `no-polygon`：所选项目都没有可并的多边形外环
 * - `union-empty`：geometry library 返回空集（极端退化）
 *
 * 设计要点：
 * - 合并候选保留候选状态（reviewStatus = "candidate"），让用户审核后再 approve
 * - 颜色 / frame / resourceId 取第一个候选；标签默认拼成"merge-N"
 */

import polygonClipping, { type Polygon, type Ring } from "polygon-clipping";
import { createAnnotationFromGeometry } from "./geometry";
import type { IimlAnnotation, IimlGeometry, IimlPoint } from "./types";

export type MergeFailure =
  | "not-enough-targets"
  | "frame-mismatch"
  | "no-polygon"
  | "union-empty";

export type MergeResult =
  | { ok: true; annotation: IimlAnnotation }
  | { ok: false; reason: MergeFailure };

/**
 * 把多个候选标注做几何并集（union），返回新的合并候选。
 *
 * 业务约束：
 *   - 至少 2 个候选（避免误操作）
 *   - 必须同 frame（model / image）；跨坐标系合并没有意义
 *   - 候选必须含 Polygon / MultiPolygon / BBox 之一；Point/LineString 没有"内部区域"，跳过
 *
 * 算法：
 *   1. 把每个 annotation 的外环（outer ring）拆出来，转成 polygon-clipping 输入
 *   2. polygonClipping.union(...) 得到 MultiPolygon（可能是多块不连通区域）
 *   3. 只保留每块的 outer ring，丢掉 holes —— 满足"只保留最外面的边缘"的需求
 *   4. 单块 → Polygon；多块 → MultiPolygon
 *
 * 合并候选保留候选状态（reviewStatus = "candidate"），让用户审核后再 approve。
 * 颜色取第一个候选的 color；frame 取第一个候选的 frame；resourceId 同样跟随第一个。
 */
export function mergePolygonAnnotations(annotations: IimlAnnotation[]): MergeResult {
  if (annotations.length < 2) {
    return { ok: false, reason: "not-enough-targets" };
  }
  const baseFrame = annotations[0].frame ?? "model";
  if (annotations.some((annotation) => (annotation.frame ?? "model") !== baseFrame)) {
    return { ok: false, reason: "frame-mismatch" };
  }

  const polygons: Polygon[] = [];
  for (const annotation of annotations) {
    const extracted = extractOuterRings(annotation.target);
    for (const ring of extracted) {
      polygons.push([ring]);
    }
  }
  if (polygons.length < 2) {
    return { ok: false, reason: "no-polygon" };
  }

  // polygonClipping.union 第一个参数是 Geom（多边形或 multipolygon），后面是同类型的 rest。
  // 我们的每个 polygon 只是一个 outer ring，没有 holes，组成 single-polygon Geom。
  const result = polygonClipping.union(polygons[0], ...polygons.slice(1));
  if (!result || result.length === 0) {
    return { ok: false, reason: "union-empty" };
  }

  // result: MultiPolygon = Polygon[]；polygon = Ring[]，第 0 个是 outer ring，余下是 holes。
  // 我们丢 holes，只取 outer。
  const cleanRings: IimlPoint[][] = result
    .map((polygon) => polygon[0])
    .filter((ring): ring is Ring => Array.isArray(ring) && ring.length >= 3)
    .map((ring) => ring.map((point) => [point[0], point[1], 0] as IimlPoint));

  if (cleanRings.length === 0) {
    return { ok: false, reason: "union-empty" };
  }

  // 闭合每个 ring：polygon-clipping 内部不一定吐回闭合 ring，IIML Polygon 约定首尾点相同。
  for (const ring of cleanRings) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1], 0] as IimlPoint);
    }
  }

  let geometry: IimlGeometry;
  if (cleanRings.length === 1) {
    geometry = { type: "Polygon", coordinates: [cleanRings[0]] };
  } else {
    geometry = {
      type: "MultiPolygon",
      coordinates: cleanRings.map((ring) => [ring])
    };
  }

  const first = annotations[0];
  // 合并后的审核状态："最保守"原则——任一源是候选则结果是候选（继续审），
  // 否则跟随第一个源的状态。这样：
  //   候选 + 候选 → 候选（让用户审合并质量）
  //   approved + approved → approved（避免已审过的标注被打回重审）
  const hasCandidate = annotations.some((annotation) => annotation.reviewStatus === "candidate");
  const reviewStatus = hasCandidate ? "candidate" : first.reviewStatus ?? "reviewed";
  const label = hasCandidate ? "SAM 合并候选" : "合并标注";

  const merged = createAnnotationFromGeometry({
    geometry,
    resourceId: first.resourceId,
    color: first.color,
    frame: baseFrame,
    label,
    structuralLevel: first.structuralLevel === "unknown" ? "figure" : first.structuralLevel,
    reviewStatus,
    generation: {
      method: "sam-merge",
      model: "polygon-union",
      confidence: averageConfidence(annotations),
      prompt: {
        sourceIds: annotations.map((annotation) => annotation.id),
        sourceCount: annotations.length
      }
    }
  });
  return { ok: true, annotation: merged };
}

/**
 * 从 IIML geometry 中拿出"区域型"的 outer ring 列表。
 *   - Polygon: 取 coordinates[0]
 *   - MultiPolygon: 取每个 polygon 的 coordinates[0]
 *   - BBox: 转换为 4 点矩形 ring（合并时把矩形候选也接住）
 *   - Point / LineString: 没有面积，返回空
 */
function extractOuterRings(geometry: IimlGeometry): Ring[] {
  if (geometry.type === "Polygon") {
    const ring = geometry.coordinates[0];
    if (!ring || ring.length < 3) return [];
    return [ringToPairs(ring)];
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates
      .map((polygon) => polygon[0])
      .filter((ring) => Array.isArray(ring) && ring.length >= 3)
      .map((ring) => ringToPairs(ring));
  }
  if (geometry.type === "BBox") {
    const [u1, v1, u2, v2] = geometry.coordinates;
    return [
      [
        [u1, v1],
        [u2, v1],
        [u2, v2],
        [u1, v2],
        [u1, v1]
      ]
    ];
  }
  return [];
}

function ringToPairs(ring: IimlPoint[]): Ring {
  return ring.map((point) => [Number(point[0] ?? 0), Number(point[1] ?? 0)]);
}

function averageConfidence(annotations: IimlAnnotation[]): number {
  const values = annotations
    .map((annotation) => annotation.generation?.confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) {
    return 1;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 把失败原因翻成人话给用户看；放在工具里方便跨调用方复用。
 */
export function describeMergeFailure(reason: MergeFailure): string {
  switch (reason) {
    case "not-enough-targets":
      return "至少选 2 个候选才能合并";
    case "frame-mismatch":
      return "无法合并：所选候选位于不同坐标系（3D 模型 / 高清图）";
    case "no-polygon":
      return "无法合并：所选候选缺少有效的多边形区域";
    case "union-empty":
    default:
      return "无法合并：候选几何无法求并集，请检查重叠或形状";
  }
}
