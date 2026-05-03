import type {
  IimlAnnotation,
  IimlGeometry,
  IimlPoint,
  IimlReviewStatus,
  IimlStructuralLevel,
  ProjectionContext
} from "./types";

export type UV = { u: number; v: number };

export function createAnnotationFromGeometry({
  geometry,
  resourceId,
  color,
  label,
  structuralLevel = "unknown",
  reviewStatus = "reviewed",
  generation
}: {
  geometry: IimlGeometry;
  resourceId: string;
  color?: string;
  label?: string;
  structuralLevel?: IimlStructuralLevel;
  reviewStatus?: IimlReviewStatus;
  generation?: IimlAnnotation["generation"];
}): IimlAnnotation {
  const now = new Date().toISOString();
  const id = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    type: "Annotation",
    resourceId,
    target: geometry,
    structuralLevel,
    label: label ?? defaultLabel(geometry.type),
    color,
    visible: true,
    locked: false,
    reviewStatus,
    generation: generation ?? { method: "manual", reviewStatus },
    createdBy: "local-user",
    createdAt: now,
    updatedAt: now
  };
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function bboxFromUV(a: UV, b: UV): IimlGeometry {
  const minU = Math.min(a.u, b.u);
  const minV = Math.min(a.v, b.v);
  const maxU = Math.max(a.u, b.u);
  const maxV = Math.max(a.v, b.v);
  return {
    type: "BBox",
    coordinates: [clamp01(minU), clamp01(minV), clamp01(maxU), clamp01(maxV)]
  };
}

export function pointFromUV(uv: UV): IimlGeometry {
  return { type: "Point", coordinates: [clamp01(uv.u), clamp01(uv.v), 0] };
}

export function polygonFromUVs(points: UV[]): IimlGeometry {
  const ring: IimlPoint[] = points.map((point) => [clamp01(point.u), clamp01(point.v), 0] as IimlPoint);
  if (ring.length > 0) {
    ring.push([...ring[0]] as IimlPoint);
  }
  return { type: "Polygon", coordinates: [ring] };
}

export function ellipsePolygonFromUV(a: UV, b: UV, samples = 48): IimlGeometry {
  const centerU = (a.u + b.u) / 2;
  const centerV = (a.v + b.v) / 2;
  const radiusU = Math.abs(b.u - a.u) / 2;
  const radiusV = Math.abs(b.v - a.v) / 2;
  const ring: IimlPoint[] = [];
  for (let index = 0; index <= samples; index += 1) {
    const angle = (index / samples) * Math.PI * 2;
    ring.push([clamp01(centerU + Math.cos(angle) * radiusU), clamp01(centerV + Math.sin(angle) * radiusV), 0] as IimlPoint);
  }
  return { type: "Polygon", coordinates: [ring] };
}

export function bboxToUV(geometry: IimlGeometry): { min: UV; max: UV } | undefined {
  if (geometry.type !== "BBox") {
    return undefined;
  }
  const [minU, minV, maxU, maxV] = geometry.coordinates;
  return { min: { u: minU, v: minV }, max: { u: maxU, v: maxV } };
}

export function ellipseBoundsToUV(geometry: IimlGeometry): { min: UV; max: UV } | undefined {
  if (geometry.type !== "Polygon") {
    return undefined;
  }
  const ring = geometry.coordinates[0];
  if (!ring || ring.length === 0) {
    return undefined;
  }
  let minU = 1;
  let minV = 1;
  let maxU = 0;
  let maxV = 0;
  for (const point of ring) {
    const u = Number(point[0] ?? 0);
    const v = Number(point[1] ?? 0);
    if (u < minU) minU = u;
    if (v < minV) minV = v;
    if (u > maxU) maxU = u;
    if (v > maxV) maxV = v;
  }
  return { min: { u: minU, v: minV }, max: { u: maxU, v: maxV } };
}

export function flattenUVs(geometry: IimlGeometry): UV[] {
  if (geometry.type === "Point") {
    const [u, v] = geometry.coordinates;
    return [{ u: Number(u ?? 0), v: Number(v ?? 0) }];
  }
  if (geometry.type === "LineString") {
    return geometry.coordinates.map((point) => ({ u: Number(point[0] ?? 0), v: Number(point[1] ?? 0) }));
  }
  if (geometry.type === "Polygon") {
    return geometry.coordinates.flat().map((point) => ({ u: Number(point[0] ?? 0), v: Number(point[1] ?? 0) }));
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.flat(2).map((point) => ({ u: Number(point[0] ?? 0), v: Number(point[1] ?? 0) }));
  }
  const [minU, minV, maxU, maxV] = geometry.coordinates;
  return [
    { u: minU, v: minV },
    { u: maxU, v: minV },
    { u: maxU, v: maxV },
    { u: minU, v: maxV }
  ];
}

export function geometryCenter(geometry: IimlGeometry): UV {
  if (geometry.type === "BBox") {
    const [minU, minV, maxU, maxV] = geometry.coordinates;
    return { u: (minU + maxU) / 2, v: (minV + maxV) / 2 };
  }
  if (geometry.type === "Point") {
    return { u: Number(geometry.coordinates[0] ?? 0), v: Number(geometry.coordinates[1] ?? 0) };
  }
  const points = flattenUVs(geometry);
  if (points.length === 0) {
    return { u: 0.5, v: 0.5 };
  }
  const sum = points.reduce((acc, point) => ({ u: acc.u + point.u, v: acc.v + point.v }), { u: 0, v: 0 });
  return { u: sum.u / points.length, v: sum.v / points.length };
}

export function uvToScreen(uv: UV, projection: ProjectionContext): { x: number; y: number } {
  const left = projection.corners[3].x;
  const top = projection.corners[3].y;
  const right = projection.corners[2].x;
  const bottom = projection.corners[0].y;
  return {
    x: left + uv.u * (right - left),
    y: top + uv.v * (bottom - top)
  };
}

export function screenToUV(point: { x: number; y: number }, projection: ProjectionContext): UV {
  const left = projection.corners[3].x;
  const top = projection.corners[3].y;
  const right = projection.corners[2].x;
  const bottom = projection.corners[0].y;
  const widthSpan = right - left || 1;
  const heightSpan = bottom - top || 1;
  return {
    u: (point.x - left) / widthSpan,
    v: (point.y - top) / heightSpan
  };
}

export function projectGeometryToScreen(geometry: IimlGeometry, projection: ProjectionContext) {
  return flattenUVs(geometry).map((uv) => uvToScreen(uv, projection));
}

export function translateGeometry(geometry: IimlGeometry, du: number, dv: number): IimlGeometry {
  const move = (point: number[]) => [clamp01((point[0] ?? 0) + du), clamp01((point[1] ?? 0) + dv), point[2] ?? 0] as IimlPoint;
  if (geometry.type === "BBox") {
    const [minU, minV, maxU, maxV] = geometry.coordinates;
    return { type: "BBox", coordinates: [clamp01(minU + du), clamp01(minV + dv), clamp01(maxU + du), clamp01(maxV + dv)] };
  }
  if (geometry.type === "Point") {
    return { type: "Point", coordinates: move(geometry.coordinates) };
  }
  if (geometry.type === "LineString") {
    return { type: "LineString", coordinates: geometry.coordinates.map(move) };
  }
  if (geometry.type === "Polygon") {
    return { type: "Polygon", coordinates: geometry.coordinates.map((ring) => ring.map(move)) };
  }
  return { type: "MultiPolygon", coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(move))) };
}

export function resizeBBoxByCorner(geometry: IimlGeometry, cornerIndex: 0 | 1 | 2 | 3, target: UV): IimlGeometry {
  if (geometry.type !== "BBox") {
    return geometry;
  }
  const [minU, minV, maxU, maxV] = geometry.coordinates;
  const corners: Array<{ u: number; v: number }> = [
    { u: minU, v: maxV },
    { u: maxU, v: maxV },
    { u: maxU, v: minV },
    { u: minU, v: minV }
  ];
  corners[cornerIndex] = target;
  const opposite = corners[(cornerIndex + 2) % 4];
  return bboxFromUV(opposite, target);
}

export function resizeEllipseByCorner(geometry: IimlGeometry, cornerIndex: 0 | 1 | 2 | 3, target: UV): IimlGeometry | undefined {
  const bounds = ellipseBoundsToUV(geometry);
  if (!bounds) {
    return undefined;
  }
  const corners: Array<{ u: number; v: number }> = [
    { u: bounds.min.u, v: bounds.max.v },
    { u: bounds.max.u, v: bounds.max.v },
    { u: bounds.max.u, v: bounds.min.v },
    { u: bounds.min.u, v: bounds.min.v }
  ];
  corners[cornerIndex] = target;
  const opposite = corners[(cornerIndex + 2) % 4];
  return ellipsePolygonFromUV(opposite, target);
}

export function bboxCornersOnScreen(geometry: IimlGeometry, projection: ProjectionContext) {
  if (geometry.type !== "BBox") {
    const bounds = ellipseBoundsToUV(geometry);
    if (!bounds) {
      return [];
    }
    return computeBoundsCorners(bounds, projection);
  }
  const [minU, minV, maxU, maxV] = geometry.coordinates;
  return computeBoundsCorners({ min: { u: minU, v: minV }, max: { u: maxU, v: maxV } }, projection);
}

function computeBoundsCorners(bounds: { min: UV; max: UV }, projection: ProjectionContext) {
  const order: Array<{ uv: UV; index: 0 | 1 | 2 | 3 }> = [
    { uv: { u: bounds.min.u, v: bounds.max.v }, index: 0 },
    { uv: { u: bounds.max.u, v: bounds.max.v }, index: 1 },
    { uv: { u: bounds.max.u, v: bounds.min.v }, index: 2 },
    { uv: { u: bounds.min.u, v: bounds.min.v }, index: 3 }
  ];
  return order.map(({ uv, index }) => ({ ...uvToScreen(uv, projection), index }));
}

function defaultLabel(type: IimlGeometry["type"]) {
  const labels: Record<IimlGeometry["type"], string> = {
    BBox: "矩形标注",
    LineString: "折线标注",
    MultiPolygon: "复合区域",
    Point: "点标注",
    Polygon: "区域标注"
  };
  return labels[type];
}
