import type { AnnotationAction, AnnotationState, IimlDocument } from "./types";

const maxHistory = 40;

export const initialAnnotationState: AnnotationState = {
  activeTool: "select",
  activeTab: "object",
  filter: "all",
  undoStack: [],
  redoStack: []
};

export function annotationReducer(state: AnnotationState, action: AnnotationAction): AnnotationState {
  switch (action.type) {
    case "set-doc":
      return {
        ...state,
        doc: action.doc,
        selectedAnnotationId: undefined,
        undoStack: [],
        redoStack: []
      };
    case "set-tool":
      return { ...state, activeTool: action.tool };
    case "set-tab":
      return { ...state, activeTab: action.tab };
    case "set-filter":
      return { ...state, filter: action.filter };
    case "set-status":
      return { ...state, status: action.status };
    case "set-ai-busy":
      return { ...state, aiBusy: action.aiBusy };
    case "select":
      return { ...state, selectedAnnotationId: action.id };
    case "add-annotation":
      return updateDoc(state, (doc) => ({
        ...doc,
        annotations: [...doc.annotations, action.annotation]
      }), action.annotation.id);
    case "add-annotations":
      return updateDoc(state, (doc) => ({
        ...doc,
        annotations: [...doc.annotations, ...action.annotations]
      }), action.annotations.at(-1)?.id);
    case "update-annotation":
      return updateDoc(state, (doc) => ({
        ...doc,
        annotations: doc.annotations.map((annotation) => (annotation.id === action.id ? { ...annotation, ...action.patch, updatedAt: new Date().toISOString() } : annotation))
      }), action.id);
    case "delete-annotation":
      return updateDoc(state, (doc) => ({
        ...doc,
        annotations: doc.annotations.filter((annotation) => annotation.id !== action.id)
      }), undefined);
    case "add-resource":
      return updateDoc(state, (doc) => ({
        ...doc,
        resources: [...doc.resources.filter((resource) => resource.id !== action.resource.id), action.resource],
        processingRuns: action.processingRun ? [...(doc.processingRuns ?? []), action.processingRun] : (doc.processingRuns ?? [])
      }), state.selectedAnnotationId);
    case "undo": {
      const previous = state.undoStack.at(-1);
      if (!previous || !state.doc) {
        return state;
      }
      return {
        ...state,
        doc: cloneDoc(previous),
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [cloneDoc(state.doc), ...state.redoStack].slice(0, maxHistory)
      };
    }
    case "redo": {
      const next = state.redoStack[0];
      if (!next || !state.doc) {
        return state;
      }
      return {
        ...state,
        doc: cloneDoc(next),
        undoStack: [...state.undoStack, cloneDoc(state.doc)].slice(-maxHistory),
        redoStack: state.redoStack.slice(1)
      };
    }
    default:
      return state;
  }
}

function updateDoc(state: AnnotationState, mutate: (doc: IimlDocument) => IimlDocument, selectedAnnotationId: string | undefined): AnnotationState {
  if (!state.doc) {
    return state;
  }
  const next = mutate(cloneDoc(state.doc));
  return {
    ...state,
    doc: next,
    selectedAnnotationId,
    undoStack: [...state.undoStack, cloneDoc(state.doc)].slice(-maxHistory),
    redoStack: []
  };
}

export function cloneDoc(doc: IimlDocument): IimlDocument {
  return JSON.parse(JSON.stringify(doc)) as IimlDocument;
}
