import type { AnnotationAction, AnnotationState, IimlAlignment, IimlAnnotation, IimlDocument, IimlProcessingRun, IimlRelation } from "./types";

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
    // 历史 IIML 文档没有 frame 字段（v0.3.0 之前所有标注都在 modelBox 坐标系），
    // 这里在 load 时统一补 "model"，下次 autosave 就把字段写进磁盘，
    // 与 backend/src/scripts/migrate-iiml-frame.ts 形成"一次性脚本 + 长期 runtime 兜底"。
    const frame = annotation.frame ?? "model";
    return {
      ...annotation,
      color,
      frame,
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
          annotations: doc.annotations.filter((annotation) => annotation.id !== action.id),
          // 删标注同时清掉它涉及的关系，避免 doc.relations 里出现悬空 source/target
          relations: (doc.relations ?? []).filter(
            (relation) => relation.source !== action.id && relation.target !== action.id
          )
        }),
        wasSelected ? undefined : state.selectedAnnotationId
      );
      return wasDraft ? { ...next, draftAnnotationId: undefined } : next;
    }
    case "add-relation": {
      return updateDoc(
        state,
        (doc) => ({
          ...doc,
          relations: [...(doc.relations ?? []), action.relation]
        }),
        state.selectedAnnotationId
      );
    }
    case "update-relation": {
      return updateDoc(
        state,
        (doc) => ({
          ...doc,
          relations: (doc.relations ?? []).map((relation) =>
            relation.id === action.id
              ? { ...relation, ...action.patch, updatedAt: new Date().toISOString() }
              : relation
          )
        }),
        state.selectedAnnotationId
      );
    }
    case "delete-relation": {
      return updateDoc(
        state,
        (doc) => ({
          ...doc,
          relations: (doc.relations ?? []).filter((relation) => relation.id !== action.id)
        }),
        state.selectedAnnotationId
      );
    }
    case "add-processing-run": {
      // 处理记录追加；不进 undo 栈避免污染（用 set-doc 风格直接设值）
      // 但走 updateDoc 仍会进 undo 栈。这里保持一致以便后续也能通过撤销移除一条
      // 误触的 SAM 调用记录——不影响功能。
      return updateDoc(
        state,
        (doc) => ({
          ...doc,
          processingRuns: [...(doc.processingRuns ?? []), action.run]
        }),
        state.selectedAnnotationId
      );
    }
    case "set-alignment": {
      // alignment 落在 culturalObject 下；undefined 表示清除已有标定。
      return updateDoc(
        state,
        (doc) => {
          const culturalObject = { ...(doc.culturalObject ?? {}) } as Record<string, unknown>;
          if (action.alignment) {
            culturalObject.alignment = action.alignment;
          } else {
            delete culturalObject.alignment;
          }
          return { ...doc, culturalObject };
        },
        state.selectedAnnotationId
      );
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

/**
 * 从 IIML 文档中取处理运行记录；缺失返回空数组。
 * processingRuns 字段在 v0.5.0 之前是 Record<string, unknown>[]，这里做最小
 * 校验把缺关键字段的条目滤掉。
 */
export function getProcessingRuns(doc: IimlDocument | undefined): IimlProcessingRun[] {
  const raw = doc?.processingRuns;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((run): run is IimlProcessingRun => {
    if (!run || typeof run !== "object") return false;
    const candidate = run as Partial<IimlProcessingRun>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.method === "string" &&
      typeof candidate.model === "string" &&
      typeof candidate.startedAt === "string"
    );
  });
}

/**
 * 从 IIML 文档中取关系列表；缺失返回空数组。relations 字段在 v0.5.0 之前可能
 * 没有（旧 schema 是 Record<string, unknown>），这里做最小校验保证类型安全。
 */
export function getRelations(doc: IimlDocument | undefined): IimlRelation[] {
  const raw = doc?.relations;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((relation): relation is IimlRelation => {
    if (!relation || typeof relation !== "object") return false;
    const candidate = relation as Partial<IimlRelation>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.kind === "string" &&
      typeof candidate.source === "string" &&
      typeof candidate.target === "string"
    );
  });
}

/**
 * 从 IIML 文档中取出 alignment，校验最小字段后返回；缺失或字段不完整时返回 undefined。
 * 渲染层和标定流程都通过该函数取数据，避免到处写防御代码。
 */
export function getAlignment(doc: IimlDocument | undefined): IimlAlignment | undefined {
  const raw = doc?.culturalObject && (doc.culturalObject as Record<string, unknown>).alignment;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const candidate = raw as Partial<IimlAlignment>;
  if (!Array.isArray(candidate.controlPoints) || candidate.controlPoints.length < 4) {
    return undefined;
  }
  for (const point of candidate.controlPoints) {
    if (
      !Array.isArray(point.modelUv) || point.modelUv.length !== 2 ||
      !Array.isArray(point.imageUv) || point.imageUv.length !== 2
    ) {
      return undefined;
    }
  }
  return candidate as IimlAlignment;
}
