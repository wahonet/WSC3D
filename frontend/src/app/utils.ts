import type { IimlDocument, IimlSource } from "../api/client";

export function formatExportTimestamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export function docBelongsToStone(doc: IimlDocument, stoneId: string): boolean {
  if (doc.documentId === `${stoneId}:iiml` || doc.documentId === stoneId) return true;
  const objectId = (doc.culturalObject as { objectId?: unknown } | undefined)?.objectId;
  return objectId === stoneId;
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function buildAnnotationCsv(doc: IimlDocument): string {
  const header = [
    "id",
    "structuralLevel",
    "label",
    "preIconographic",
    "iconographicMeaning",
    "iconologicalMeaning",
    "terms",
    "inscriptionTranscription",
    "inscriptionTranslation",
    "inscriptionReadingNote",
    "sources",
    "notes"
  ];
  const rows = doc.annotations.map((annotation) => [
    annotation.id,
    annotation.structuralLevel,
    annotation.label ?? "",
    annotation.semantics?.preIconographic ?? "",
    annotation.semantics?.iconographicMeaning ?? "",
    annotation.semantics?.iconologicalMeaning ?? "",
    (annotation.semantics?.terms ?? []).map((term) => term.label).join(" | "),
    annotation.semantics?.inscription?.transcription ?? "",
    annotation.semantics?.inscription?.translation ?? "",
    annotation.semantics?.inscription?.readingNote ?? "",
    (annotation.sources ?? []).map(stringifyCsvSource).join(" | "),
    annotation.notes ?? ""
  ]);
  const escape = (value: string) => (/[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value);
  const lines = [header.join(","), ...rows.map((row) => row.map(escape).join(","))];
  return `\ufeff${lines.join("\r\n")}`;
}

function stringifyCsvSource(source: IimlSource): string {
  switch (source.kind) {
    case "metadata":
      return source.panelIndex !== undefined
        ? `档案 L${source.layerIndex}·P${source.panelIndex + 1}`
        : `档案 L${source.layerIndex}`;
    case "reference":
      return source.title || source.citation || source.uri || "文献";
    case "resource":
      return `资源 ${source.resourceId || ""}`.trim();
    case "other":
      return source.text || "其他";
    default:
      return "";
  }
}

export function formatDimensions(dimensions?: { width?: number; height?: number; thickness?: number; raw?: string; unit?: string }) {
  if (!dimensions) return "待补充";
  if (dimensions.height && dimensions.width && dimensions.thickness) {
    return `${dimensions.width} × ${dimensions.height} × ${dimensions.thickness} ${dimensions.unit ?? "cm"}`;
  }
  return dimensions.raw ?? "待补充";
}

export const viewerModeLabels = { "3d": "3D", "2d": "2D", ortho: "正射" } as const;

export const backgroundLabels = { black: "黑", gray: "灰", white: "白" } as const;

export function panelRect(right: number, top: number, width: number, height: number) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1400;
  return { x: vw - right - width, y: top, width, height };
}

export function panelRectLeft(left: number, top: number, width: number, height: number) {
  return { x: left, y: top, width, height };
}
