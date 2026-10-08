export type ReconstructionPart = {
  id: string; name: string; historicalName: string; color: string; kind: 'wall' | 'roof';
  sourceFile: string; sourceSha256: string; triangles: number; vertices: number;
  registrySizeCm: number[]; workingExtentsCm?: number[]; scaleMetersPerRawUnit?: number;
  translationResearchMeters?: number[]; explodeGltf: [number, number, number];
  rawExtents?: number[]; workingExtentsU?: number[]; publishedSizeCm?: (number | null)[];
  group?: string; previewTriangles?: number;
  note: string; evidence: string[];
}
export type ReconstructionSummary = { id: string; title: string; version: string; date: string; status: string; description: string; sortOrder?: number }
export type ReconstructionVariant = {
  id: string; group: string; title: string; method: string; status: string; description: string;
  changes: string[]; conflicts: string[]; missing: string[]; partIds: string[];
  matricesGltf: Record<string, number[]>; sceneFile: string; fullSceneFile: string; sceneBytes: number;
  previewFile: string; downloadSceneFile?: string; views: { path: string; label: string }[];
  metrics: { label: string; value: string; unit: string }[];
  parameters: { frontPitchDegrees?: number; rearPitchDegrees?: number };
}
export type ReconstructionDimension = {
  id: string; name: string; historicalName?: string; status: string; physicalSizeCm: number[] | null;
  rawExtents?: number[]; heightToWidth?: number; thicknessToWidth?: number; registrySizeCm?: number[];
  publishedSizeCm?: (number | null)[]; publishedNote?: string;
}
export type ReconstructionCase = ReconstructionSummary & {
  schemaVersion: number; sceneFile: string; sceneSha256: string; sceneBytes: number; blendFile: string;
  worklogFile: string; previewFile: string; directory: string; scaleNote: string; coordinateNote: string;
  parts: ReconstructionPart[];
  sources: { id: string; title: string; locator: string; claim: string; url: string; image: string }[];
  findings: { level: string; title: string; text: string }[];
  parameters: { frontPitchDegrees?: number; rearPitchDegrees?: number; ridgeUndersideReferenceMeters?: number };
  unitLabel?: string; variants?: ReconstructionVariant[]; dimensionFile?: string; dimensionCsv?: string; calibrationFile?: string;
  coverage?: { requested: number; models: number; front: number; left: number; unassigned: number; missing: { id: string; name: string; reason: string }[] };
}
export function reconstructionFile(caseId: string, path: string, download = false) {
  return `/api/reconstruction/${encodeURIComponent(caseId)}/files/${path.split('/').map(encodeURIComponent).join('/')}${download ? '?download=true' : ''}`
}
