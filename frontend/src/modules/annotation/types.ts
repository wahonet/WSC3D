import type {
  IimlAlignment,
  IimlAlignmentControlPoint,
  IimlAnnotation,
  IimlAnnotationFrame,
  IimlDocument,
  IimlGeometry,
  IimlPoint,
  IimlProcessingRun,
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

export type IimlResourceEntry = {
  id: string;
  type: string;
  uri: string;
  // G1：可选元数据。description / acquisition / acquiredBy 让多源资源可追溯
  description?: string;
  acquisition?: string;
  acquiredBy?: string;
  acquiredAt?: string;
  // 派生标记：UI 不参与持久化，标识"哪个资源是当前 UI 默认对应的"
  // 真正持久化只看 doc.resources[]；activeResourceId 是 UI state
  [key: string]: unknown;
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
  | { type: "add-processing-run"; run: IimlProcessingRun }
  | { type: "add-resource"; resource: IimlResourceEntry }
  | { type: "update-resource"; id: string; patch: Partial<IimlResourceEntry> }
  | { type: "delete-resource"; id: string }
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
  IimlProcessingRun,
  IimlRelation,
  IimlRelationKind,
  IimlRelationOrigin,
  IimlReviewStatus,
  IimlStructuralLevel,
  VocabularyTerm
};
