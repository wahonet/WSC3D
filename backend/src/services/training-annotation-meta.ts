import type { IimlAnnotation } from "./iiml.js";

export function getAnnotationQuality(ann: IimlAnnotation): string {
  const value = (ann as IimlAnnotation & { annotationQuality?: string }).annotationQuality;
  if (value) return value;
  if (ann.target?.type === "BBox" || ann.target?.type === "Point" || ann.target?.type === "LineString") {
    return "weak";
  }
  return "silver";
}

export function getGeometryIntent(ann: IimlAnnotation): string {
  return (ann as IimlAnnotation & { geometryIntent?: string }).geometryIntent ?? "semantic_extent";
}

export function getTrainingRole(ann: IimlAnnotation): string {
  return (ann as IimlAnnotation & { trainingRole?: string }).trainingRole ?? "train";
}

export function getAnnotationIssues(ann: IimlAnnotation): string[] {
  const issues = (ann as IimlAnnotation & { annotationIssues?: unknown }).annotationIssues;
  return Array.isArray(issues)
    ? (issues as unknown[]).filter((issue): issue is string => typeof issue === "string")
    : [];
}
