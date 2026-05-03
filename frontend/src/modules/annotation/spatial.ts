import { ellipseBoundsToUV, flattenUVs } from "./geometry";
import type { SpatialRelationCandidate } from "./RelationsEditor";
import type { IimlAnnotation, IimlGeometry, IimlRelationKind } from "./types";

// 空间关系自动推导（B2）：纯运行时计算，**不写入 IIML**。
// 只对一对标注生成至多一条最显著的空间关系，避免推导出 5-6 条噪声关系
// 把 RelationsEditor 候选区淹没。
//
// 算法：
//   1. 把每个 annotation 算出"外接矩形" (uMin, uMax, vMin, vMax) 与中心 (uC, vC)
//   2. 对每对（i, j）按以下优先级判定：
//        a. 矩形相交且面积重叠率 > 0.15 → "overlaps"
//        b. 矩形不相交但中心距 < 平均尺寸 * 0.5 → "nextTo"
//        c. 否则取主导方向：
//           - dy = j.vC - i.vC, dx = j.uC - i.uC
//           - |dy| > |dx| 时纵向：j 在 i 的下方/上方 → "below" / "above"
//             （前提是垂直距离 > 平均高 * 0.6，避免平排标注误判）
//           - 否则横向：j 在 i 的左/右 → "leftOf" / "rightOf"
//   3. 同 frame 才比对（model 与 image 的 UV 不可直接比）
//
// 性能：对 N 个标注做 O(N²/2) 比对；目前候选 + 正式合计一般 < 50，几毫秒级。
// 真到 200+ 时可以加按 frame 分桶 + 空间索引，当前不需要。

export type SpatialDeriveOptions = {
  // 重叠率阈值（默认 0.15）：重合面积 / 较小矩形面积
  overlapRatio: number;
  // 相邻判定阈值倍数（默认 0.5）：中心距 / (平均宽 + 平均高) * 0.5
  nextToFactor: number;
  // 主导方向阈值（默认 0.6）：dy / 平均高 才算"上下"，否则当作"左右"
  verticalDominanceFactor: number;
};

const defaultOptions: SpatialDeriveOptions = {
  overlapRatio: 0.15,
  nextToFactor: 0.5,
  verticalDominanceFactor: 0.6
};

export function deriveSpatialRelations(
  annotations: IimlAnnotation[],
  options: Partial<SpatialDeriveOptions> = {}
): SpatialRelationCandidate[] {
  const config: SpatialDeriveOptions = { ...defaultOptions, ...options };
  const visible = annotations.filter((annotation) => annotation.visible !== false);
  const records = visible
    .map((annotation) => {
      const bounds = boundsOf(annotation.target);
      if (!bounds) {
        return undefined;
      }
      return { annotation, bounds };
    })
    .filter((entry): entry is { annotation: IimlAnnotation; bounds: AnnotationBounds } =>
      Boolean(entry)
    );

  const candidates: SpatialRelationCandidate[] = [];
  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      const a = records[i];
      const b = records[j];
      // 跨 frame 不比对：model 与 image 是不同坐标系，几何上没有可比性
      const aFrame = a.annotation.frame ?? "model";
      const bFrame = b.annotation.frame ?? "model";
      if (aFrame !== bFrame) {
        continue;
      }
      const kind = classifyPair(a.bounds, b.bounds, config);
      if (!kind) {
        continue;
      }
      // classifyPair 已经按 "a 是 source, b 是 target" 视角生成 kind：
      // - "above"  ⇔ A 在 B 上 ⇔ source=a, target=b
      // - "leftOf" ⇔ A 在 B 左 ⇔ source=a, target=b
      // - "overlaps" / "nextTo"：对称，source / target 任意（取 a/b）
      candidates.push({
        id: `spatial-${a.annotation.id}-${b.annotation.id}-${kind}`,
        kind,
        source: a.annotation.id,
        target: b.annotation.id,
        origin: "spatial-auto"
      });
    }
  }
  return candidates;
}

type AnnotationBounds = {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  uCenter: number;
  vCenter: number;
  width: number;
  height: number;
};

function boundsOf(geometry: IimlGeometry): AnnotationBounds | undefined {
  if (geometry.type === "BBox") {
    const [u1, v1, u2, v2] = geometry.coordinates;
    return makeBounds(Math.min(u1, u2), Math.min(v1, v2), Math.max(u1, u2), Math.max(v1, v2));
  }
  if (geometry.type === "Polygon") {
    const ellipse = ellipseBoundsToUV(geometry);
    if (ellipse) {
      return makeBounds(ellipse.min.u, ellipse.min.v, ellipse.max.u, ellipse.max.v);
    }
  }
  // Polygon / MultiPolygon / LineString / Point：扁平化所有顶点取外接矩形
  const points = flattenUVs(geometry);
  if (points.length === 0) {
    return undefined;
  }
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const point of points) {
    if (point.u < uMin) uMin = point.u;
    if (point.u > uMax) uMax = point.u;
    if (point.v < vMin) vMin = point.v;
    if (point.v > vMax) vMax = point.v;
  }
  if (!Number.isFinite(uMin) || !Number.isFinite(vMin)) {
    return undefined;
  }
  return makeBounds(uMin, vMin, uMax, vMax);
}

function makeBounds(uMin: number, vMin: number, uMax: number, vMax: number): AnnotationBounds {
  return {
    uMin,
    uMax,
    vMin,
    vMax,
    uCenter: (uMin + uMax) / 2,
    vCenter: (vMin + vMax) / 2,
    width: Math.max(0, uMax - uMin),
    height: Math.max(0, vMax - vMin)
  };
}

function classifyPair(
  a: AnnotationBounds,
  b: AnnotationBounds,
  options: SpatialDeriveOptions
): IimlRelationKind | undefined {
  // 1. 重叠
  const interW = Math.max(0, Math.min(a.uMax, b.uMax) - Math.max(a.uMin, b.uMin));
  const interH = Math.max(0, Math.min(a.vMax, b.vMax) - Math.max(a.vMin, b.vMin));
  const interArea = interW * interH;
  if (interArea > 0) {
    const minArea = Math.min(a.width * a.height, b.width * b.height);
    if (minArea > 0 && interArea / minArea >= options.overlapRatio) {
      return "overlaps";
    }
  }

  // 2. 相邻：中心距 < (平均宽 + 平均高) / 2 * factor
  const dx = b.uCenter - a.uCenter;
  const dy = b.vCenter - a.vCenter;
  const dist = Math.hypot(dx, dy);
  const meanSize = ((a.width + b.width) / 2 + (a.height + b.height) / 2) / 2;
  if (meanSize > 0 && dist < meanSize * options.nextToFactor) {
    return "nextTo";
  }

  // 3. 主导方向（v 向下：dy > 0 表示 b 在 a 下方，即 a "above" b）
  const meanHeight = (a.height + b.height) / 2;
  if (Math.abs(dy) > Math.abs(dx) && meanHeight > 0 && Math.abs(dy) > meanHeight * options.verticalDominanceFactor) {
    return dy > 0 ? "above" /* a 在 b 上方 */ : "below";
  }
  return dx > 0 ? "leftOf" /* a 在 b 左侧 */ : "rightOf";
}
