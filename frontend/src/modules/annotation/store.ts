import type { AnnotationAction, AnnotationState, IimlAnnotation, IimlDocument } from "./types";

const maxHistory = 40;

export const annotationPalette = [
  "#f3a712",
  "#2ec4b6",
  "#45d483",
  "#3a86ff",
  "#ff5f57",
  "#c084fc",
  "#facc15",
  "#fb7185",
  "#22d3ee",
  "#a3e635"
];

export const initialAnnotationState: AnnotationState = {
  activeTool: "select",
  undoStack: [],
  redoStack: []
};

export function nextAnnotationColor(annotations: IimlAnnotation[]) {
  return annotationPalette[annotations.length % annotationPalette.length];
}

function ensureAnnotationDefaults(doc: IimlDocument): IimlDocument {
  let assignedIndex = 0;
  const annotations = doc.annotations.map((annotation) => {
    const color = typeof annotation.color === "string" && annotation.color ? annotation.color : annotationPalette[assignedIndex % annotationPalette.length];
    if (!annotation.color) {
      assignedIndex += 1;
    }
    return {
      ...annotation,
      color,
      visible: annotation.visible !== false,
      locked: annotation.locked === true
    };
  });
  // Strip legacy layers field if present so saved docs stop carrying stale data.
  const { layers: _layers, ...rest } = doc as IimlDocument & { layers?: unknown };
  return { ...rest, annotations };
}

export function annotationReducer(state: AnnotationState, action: AnnotationAction): AnnotationState {
  switch (action.type) {
    case "set-doc": {
      return {
        ...state,
        doc: ensureAnnotationDefaults(action.doc),
        selectedAnnotationId: undefined,
        draftAnnotationId: undefined,
        undoStack: [],
        redoStack: []
      };
    }
    case "set-tool":
      return { ...state, activeTool: action.tool };
    case "set-status":
      return { ...state, status: action.status };
    case "select":
      return { ...state, selectedAnnotationId: action.id, draftAnnotationId: action.id ? state.draftAnnotationId : undefined };
    case "set-draft":
      return { ...state, draftAnnotationId: action.id };
    case "add-annotation": {
      const next = updateDoc(
        state,
        (doc) => ({
          ...doc,
          annotations: [...doc.annotations, action.annotation]
        }),
        action.annotation.id
      );
      return action.asDraft ? { ...next, draftAnnotationId: action.annotation.id } : next;
    }
    case "update-annotation":
      return updateDoc(
        state,
        (doc) => ({
          ...doc,
          annotations: doc.annotations.map((annotation) =>
            annotation.id === action.id ? { ...annotation, ...action.patch, updatedAt: new Date().toISOString() } : annotation
          )
        }),
        state.selectedAnnotationId
      );
    case "delete-annotation": {
      const wasSelected = state.selectedAnnotationId === action.id;
      const wasDraft = state.draftAnnotationId === action.id;
      const next = updateDoc(
        state,
        (doc) => ({
          ...doc,
          annotations: doc.annotations.filter((annotation) => annotation.id !== action.id)
        }),
        wasSelected ? undefined : state.selectedAnnotationId
      );
      return wasDraft ? { ...next, draftAnnotationId: undefined } : next;
    }
    case "undo": {
      const previous = state.undoStack.at(-1);
      if (!previous || !state.doc) {
        return state;
      }
      return {
        ...state,
        doc: cloneDoc(previous),
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [cloneDoc(state.doc), ...state.redoStack].slice(0, maxHistory),
        draftAnnotationId: undefined
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
        redoStack: state.redoStack.slice(1),
        draftAnnotationId: undefined
      };
    }
    default:
      return state;
  }
}

function updateDoc(
  state: AnnotationState,
  mutate: (doc: IimlDocument) => IimlDocument,
  selectedAnnotationId: string | undefined
): AnnotationState {
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
