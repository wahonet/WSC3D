import type { AiDetection, IimlAnnotation, IimlDocument, IimlGeometry, IimlPoint, IimlReviewStatus, IimlStructuralLevel, VocabularyTerm } from "../../api/client";

export type AnnotationTool = "select" | "rect" | "ellipse" | "pen" | "polyline" | "point" | "eraser" | "sam" | "yolo";
export type AnnotationTab = "object" | "terms" | "annotations" | "graph" | "history";
export type AnnotationFilter = "all" | "candidate" | "approved";

export type DraftShape =
  | { type: "BBox"; start: { x: number; y: number }; end: { x: number; y: number } }
  | { type: "LineString"; points: Array<{ x: number; y: number }> }
  | { type: "Polygon"; points: Array<{ x: number; y: number }> }
  | { type: "Point"; point: { x: number; y: number } };

export type AnnotationState = {
  doc?: IimlDocument;
  selectedAnnotationId?: string;
  activeTool: AnnotationTool;
  activeTab: AnnotationTab;
  filter: AnnotationFilter;
  status?: string;
  aiBusy?: "sam" | "yolo" | "canny";
  undoStack: IimlDocument[];
  redoStack: IimlDocument[];
};

export type AnnotationAction =
  | { type: "set-doc"; doc: IimlDocument }
  | { type: "set-tool"; tool: AnnotationTool }
  | { type: "set-tab"; tab: AnnotationTab }
  | { type: "set-filter"; filter: AnnotationFilter }
  | { type: "set-status"; status?: string }
  | { type: "set-ai-busy"; aiBusy?: "sam" | "yolo" | "canny" }
  | { type: "select"; id?: string }
  | { type: "add-annotation"; annotation: IimlAnnotation }
  | { type: "add-annotations"; annotations: IimlAnnotation[] }
  | { type: "update-annotation"; id: string; patch: Partial<IimlAnnotation> }
  | { type: "delete-annotation"; id: string }
  | { type: "add-resource"; resource: IimlDocument["resources"][number]; processingRun?: Record<string, unknown> }
  | { type: "undo" }
  | { type: "redo" };

export type ProjectionState = {
  width: number;
  height: number;
  modelBox: {
    min: [number, number, number];
    max: [number, number, number];
  };
};

export type { AiDetection, IimlAnnotation, IimlDocument, IimlGeometry, IimlPoint, IimlReviewStatus, IimlStructuralLevel, VocabularyTerm };
