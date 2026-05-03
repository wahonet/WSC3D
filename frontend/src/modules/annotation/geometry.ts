import type { IimlAnnotation, IimlGeometry, IimlPoint, IimlReviewStatus, IimlStructuralLevel } from "./types";

export function createAnnotationFromGeometry({
  geometry,
  resourceId,
  label,
  structuralLevel = "unknown",
  reviewStatus = "reviewed",
  generation
}: {
  geometry: IimlGeometry;
  resourceId: string;
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
    semantics: {
      name: label ?? defaultLabel(geometry.type),
      terms: []
    },
    reviewStatus,
    generation: generation ?? { method: "manual", reviewStatus },
    createdBy: "local-user",
    createdAt: now,
    updatedAt: now
  };
}

export function normalizePoint(x: number, y: number, width: number, height: number): IimlPoint {
  return [clamp(x / Math.max(width, 1), 0, 1), clamp(y / Math.max(height, 1), 0, 1), 0];
}

export function denormalizePoint(point: IimlPoint, width: number, height: number) {
  return {
    x: Number(point[0] ?? 0) * width,
    y: Number(point[1] ?? 0) * height
  };
}

export function bboxGeometry(start: { x: number; y: number }, end: { x: number; y: number }, width: number, height: number): IimlGeometry {
  const minX = Math.min(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxX = Math.max(start.x, end.x);
  const maxY = Math.max(start.y, end.y);
  return {
    type: "BBox",
    coordinates: [minX / width, minY / height, maxX / width, maxY / height].map((value) => clamp(value, 0, 1)) as [number, number, number, number]
  };
}

export function ellipsePolygon(start: { x: number; y: number }, end: { x: number; y: number }, width: number, height: number): IimlGeometry {
  const centerX = (start.x + end.x) / 2;
  const centerY = (start.y + end.y) / 2;
  const radiusX = Math.abs(end.x - start.x) / 2;
  const radiusY = Math.abs(end.y - start.y) / 2;
  const ring: IimlPoint[] = [];
  for (let index = 0; index <= 32; index += 1) {
    const angle = (index / 32) * Math.PI * 2;
    ring.push(normalizePoint(centerX + Math.cos(angle) * radiusX, centerY + Math.sin(angle) * radiusY, width, height));
  }
  return { type: "Polygon", coordinates: [ring] };
}

export function lineStringGeometry(points: Array<{ x: number; y: number }>, width: number, height: number): IimlGeometry {
  return { type: "LineString", coordinates: points.map((point) => normalizePoint(point.x, point.y, width, height)) };
}

export function polygonGeometry(points: Array<{ x: number; y: number }>, width: number, height: number): IimlGeometry {
  const ring = points.map((point) => normalizePoint(point.x, point.y, width, height));
  if (ring.length > 0) {
    ring.push([...ring[0]] as IimlPoint);
  }
  return { type: "Polygon", coordinates: [ring] };
}

export function pointGeometry(point: { x: number; y: number }, width: number, height: number): IimlGeometry {
  return { type: "Point", coordinates: normalizePoint(point.x, point.y, width, height) };
}

export function geometryCenter(geometry: IimlGeometry, width: number, height: number) {
  if (geometry.type === "BBox") {
    const [minX, minY, maxX, maxY] = geometry.coordinates;
    return { x: ((minX + maxX) / 2) * width, y: ((minY + maxY) / 2) * height };
  }
  if (geometry.type === "Point") {
    return denormalizePoint(geometry.coordinates, width, height);
  }
  const points = flattenPoints(geometry);
  if (points.length === 0) {
    return { x: width / 2, y: height / 2 };
  }
  const total = points.reduce((acc, point) => ({ x: acc.x + Number(point[0] ?? 0) * width, y: acc.y + Number(point[1] ?? 0) * height }), { x: 0, y: 0 });
  return { x: total.x / points.length, y: total.y / points.length };
}

export function flattenPoints(geometry: IimlGeometry): IimlPoint[] {
  if (geometry.type === "Point") {
    return [geometry.coordinates];
  }
  if (geometry.type === "LineString") {
    return geometry.coordinates;
  }
  if (geometry.type === "Polygon") {
    return geometry.coordinates.flat();
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.flat(2);
  }
  const [minX, minY, maxX, maxY] = geometry.coordinates;
  return [
    [minX, minY, 0],
    [maxX, minY, 0],
    [maxX, maxY, 0],
    [minX, maxY, 0]
  ];
}

export function screenPoints(geometry: IimlGeometry, width: number, height: number) {
  return flattenPoints(geometry).map((point) => denormalizePoint(point, width, height));
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
