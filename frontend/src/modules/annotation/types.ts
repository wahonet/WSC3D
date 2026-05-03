import type {
  IimlAlignment,
  IimlAlignmentControlPoint,
  IimlAnnotation,
  IimlAnnotationFrame,
  IimlDocument,
  IimlGeometry,
  IimlPoint,
  IimlRelation,
  IimlRelationKind,
  IimlRelationOrigin,
  IimlReviewStatus,
  IimlStructuralLevel,
  VocabularyTerm
} from "../../api/client";

export type AnnotationTool = "select" | "rect" | "ellipse" | "point" | "pen" | "sam" | "calibrate";

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
  | { type: "set-alignment"; alignment: IimlAlignment | undefined }
  | { type: "add-relation"; relation: IimlRelation }
  | { type: "update-relation"; id: string; patch: Partial<IimlRelation> }
  | { type: "delete-relation"; id: string }
  | { type: "undo" }
  | { type: "redo" };

export type {
  IimlAlignment,
  IimlAlignmentControlPoint,
  IimlAnnotation,
  IimlAnnotationFrame,
  IimlDocument,
  IimlGeometry,
  IimlPoint,
  IimlRelation,
  IimlRelationKind,
  IimlRelationOrigin,
  IimlReviewStatus,
  IimlStructuralLevel,
  VocabularyTerm
};
