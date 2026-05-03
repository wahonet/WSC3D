import type {
  IimlAnnotation,
  IimlDocument,
  IimlGeometry,
  IimlPoint,
  IimlReviewStatus,
  IimlStructuralLevel,
  VocabularyTerm
} from "../../api/client";

export type AnnotationTool = "select" | "rect" | "ellipse" | "point" | "pen";

export type ProjectionContext = {
  corners: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number }
  ];
  canvasWidth: number;
  canvasHeight: number;
};

export type AnnotationState = {
  doc?: IimlDocument;
  selectedAnnotationId?: string;
  draftAnnotationId?: string;
  activeTool: AnnotationTool;
  status?: string;
  undoStack: IimlDocument[];
  redoStack: IimlDocument[];
};

export type AnnotationAction =
  | { type: "set-doc"; doc: IimlDocument }
  | { type: "set-tool"; tool: AnnotationTool }
  | { type: "set-status"; status?: string }
  | { type: "select"; id?: string }
  | { type: "set-draft"; id?: string }
  | { type: "add-annotation"; annotation: IimlAnnotation; asDraft?: boolean }
  | { type: "update-annotation"; id: string; patch: Partial<IimlAnnotation> }
  | { type: "delete-annotation"; id: string }
  | { type: "undo" }
  | { type: "redo" };

export type {
  IimlAnnotation,
  IimlDocument,
  IimlGeometry,
  IimlPoint,
  IimlReviewStatus,
  IimlStructuralLevel,
  VocabularyTerm
};
