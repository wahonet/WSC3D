/**
 * P4 空间锚点（anchor）派生服务。
 *
 * 项目坐标原则：**所有标注只写入"正射基准"坐标系**——
 *   - `frame="model"` 的 modelBox UV 与正面等价正射图 UV 数学上 1:1，视作
 *     canonical orthophoto frame；
 *   - `frame="image"` 且底图是 equivalentToModel 正射图 → 同上；
 *   - 其余 image 资源（拓片 / 历史照片）是 "image-local"，必须经 4 点校准
 *     才能迁移到正射基准。
 *
 * 每条标注保存时自动派生 `anchor`：
 *   - canonicalFrame：orthophoto / image-local
 *   - bboxUv / centroidUv：几何的归一化外接矩形与质心
 *   - imageSizePx：mask 栅格尺寸（annotation.appearance）或等价正射资源 pixelSize
 *   - physical：以石头结构化档案的实测尺寸（cm）换算的物理位置 / 大小 /
 *     像素-厘米比例——"同一块石头不同分辨率正射图可复用标注"的比例关系凭证
 *
 * 纯函数、幂等：同一输入永远派生同一 anchor（无时间戳），重复保存零 diff。
 */

export type AnchorPhysical = {
  unit: "cm";
  origin: "orthophoto-top-left";
  x: number;
  y: number;
  width: number;
  height: number;
  pxPerCmX?: number;
  pxPerCmY?: number;
};

export type AnnotationAnchor = {
  canonicalFrame: "orthophoto" | "image-local";
  bboxUv: [number, number, number, number];
  centroidUv: [number, number];
  imageSizePx?: { width: number; height: number };
  physical?: AnchorPhysical;
};

type GeometryLike = { type?: unknown; coordinates?: unknown };
type AnnotationLike = {
  frame?: unknown;
  resourceId?: unknown;
  target?: GeometryLike;
  appearance?: { imageSizePx?: { width?: unknown; height?: unknown } };
  anchor?: unknown;
  [key: string]: unknown;
};
type ResourceLike = { id?: unknown; transform?: Record<string, unknown>; [key: string]: unknown };
type DocLike = { annotations?: AnnotationLike[]; resources?: ResourceLike[]; [key: string]: unknown };

export type StoneDimensionsCm = { width?: number; height?: number };

const round = (value: number, digits = 6) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** 把 IIML 几何拍平成 UV 点列表（Point/LineString/Polygon/MultiPolygon/BBox）。 */
function flattenGeometryUVs(geometry: GeometryLike | undefined): Array<[number, number]> {
  if (!geometry || typeof geometry.type !== "string") return [];
  const coords = geometry.coordinates;
  const points: Array<[number, number]> = [];
  const pushPoint = (point: unknown) => {
    if (Array.isArray(point) && point.length >= 2) {
      const u = Number(point[0]);
      const v = Number(point[1]);
      if (Number.isFinite(u) && Number.isFinite(v)) {
        points.push([u, v]);
      }
    }
  };
  switch (geometry.type) {
    case "Point":
      pushPoint(coords);
      break;
    case "LineString":
      if (Array.isArray(coords)) coords.forEach(pushPoint);
      break;
    case "Polygon":
      if (Array.isArray(coords)) {
        for (const ring of coords) {
          if (Array.isArray(ring)) ring.forEach(pushPoint);
        }
      }
      break;
    case "MultiPolygon":
      if (Array.isArray(coords)) {
        for (const polygon of coords) {
          if (!Array.isArray(polygon)) continue;
          for (const ring of polygon) {
            if (Array.isArray(ring)) ring.forEach(pushPoint);
          }
        }
      }
      break;
    case "BBox":
      if (Array.isArray(coords) && coords.length === 4) {
        const [u1, v1, u2, v2] = coords.map(Number);
        if ([u1, v1, u2, v2].every(Number.isFinite)) {
          points.push([u1, v1], [u2, v2]);
        }
      }
      break;
    default:
      break;
  }
  return points;
}

/** 该 image 资源的 UV 是否与 modelBox UV 等价（正面等价正射图）。 */
function isEquivalentOrthoResource(resource: ResourceLike | undefined): boolean {
  const transform = resource?.transform;
  if (!transform || transform.kind !== "orthographic-from-model") return false;
  if (transform.equivalentToModel === true) return true;
  const frustumScale = typeof transform.frustumScale === "number" ? transform.frustumScale : Number.NaN;
  return transform.view === "front" && Number.isFinite(frustumScale) && Math.abs(frustumScale - 1.0) < 1e-3;
}

function resourcePixelSize(resource: ResourceLike | undefined): { width: number; height: number } | undefined {
  const pixelSize = resource?.transform?.pixelSize as { width?: unknown; height?: unknown } | undefined;
  const width = Number(pixelSize?.width);
  const height = Number(pixelSize?.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height };
  }
  return undefined;
}

export function computeAnnotationAnchor(
  annotation: AnnotationLike,
  doc: DocLike,
  dimensions?: StoneDimensionsCm
): AnnotationAnchor | undefined {
  const uvs = flattenGeometryUVs(annotation.target);
  if (uvs.length === 0) return undefined;

  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  let sumU = 0;
  let sumV = 0;
  for (const [u, v] of uvs) {
    if (u < minU) minU = u;
    if (v < minV) minV = v;
    if (u > maxU) maxU = u;
    if (v > maxV) maxV = v;
    sumU += u;
    sumV += v;
  }

  const frame = annotation.frame === "image" ? "image" : "model";
  const resource = (doc.resources ?? []).find((r) => r.id === annotation.resourceId);
  const equivalentOrtho = frame === "image" && isEquivalentOrthoResource(resource);
  const canonicalFrame: AnnotationAnchor["canonicalFrame"] =
    frame === "model" || equivalentOrtho ? "orthophoto" : "image-local";

  // 像素网格：mask 生成时记录的栅格尺寸优先；等价正射资源的 pixelSize 次之。
  const appearanceSize = annotation.appearance?.imageSizePx;
  const appearanceWidth = Number(appearanceSize?.width);
  const appearanceHeight = Number(appearanceSize?.height);
  const imageSizePx =
    Number.isFinite(appearanceWidth) && Number.isFinite(appearanceHeight) && appearanceWidth > 0 && appearanceHeight > 0
      ? { width: appearanceWidth, height: appearanceHeight }
      : resourcePixelSize(resource);

  const anchor: AnnotationAnchor = {
    canonicalFrame,
    bboxUv: [round(minU), round(minV), round(maxU), round(maxV)],
    centroidUv: [round(sumU / uvs.length), round(sumV / uvs.length)]
  };
  if (imageSizePx) {
    anchor.imageSizePx = imageSizePx;
  }

  // 物理位置：仅正射基准可换算（modelBox UV ↔ 石头实测宽高 cm）。
  const widthCm = Number(dimensions?.width);
  const heightCm = Number(dimensions?.height);
  if (canonicalFrame === "orthophoto" && Number.isFinite(widthCm) && Number.isFinite(heightCm) && widthCm > 0 && heightCm > 0) {
    const physical: AnchorPhysical = {
      unit: "cm",
      origin: "orthophoto-top-left",
      x: round(minU * widthCm, 2),
      y: round(minV * heightCm, 2),
      width: round((maxU - minU) * widthCm, 2),
      height: round((maxV - minV) * heightCm, 2)
    };
    if (imageSizePx) {
      physical.pxPerCmX = round(imageSizePx.width / widthCm, 3);
      physical.pxPerCmY = round(imageSizePx.height / heightCm, 3);
    }
    anchor.physical = physical;
  }

  return anchor;
}

/**
 * 给整份 IIML 文档的所有 annotation 派生 / 刷新 anchor。
 * 返回是否有任何 anchor 发生变化（供迁移脚本判断是否写盘）。
 */
export function enrichDocAnchors(doc: DocLike, dimensions?: StoneDimensionsCm): boolean {
  const annotations = Array.isArray(doc.annotations) ? doc.annotations : [];
  let changed = false;
  for (const annotation of annotations) {
    const next = computeAnnotationAnchor(annotation, doc, dimensions);
    if (!next) continue;
    const previous = annotation.anchor;
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      annotation.anchor = next;
      changed = true;
    }
  }
  return changed;
}
