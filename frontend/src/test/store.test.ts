/**
 * annotationReducer 测试 — frame 默认补全 + 撤销/重做
 *
 * 锁住 `ensureAnnotationDefaults`：历史 IIML 文档（v0.3.0 前无 frame 字段）
 * 加载时统一补 `frame: "model"` + color + visible + locked，并剥掉 legacy
 * `layers` 字段。这是 runtime 兜底，与 backend migrate-iiml-frame 脚本双保险。
 *
 * 通过公共 reducer API（set-doc action）验证，不直接测私有函数。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { annotationReducer, initialAnnotationState } from "../modules/annotation/store";
import type { IimlDocument } from "../api/client";

function docWith(annotations: unknown[], extra: Record<string, unknown> = {}): IimlDocument {
  return {
    "@context": "/api/iiml/context",
    "@type": "IIMLDocument",
    documentId: "01:iiml",
    name: "t",
    resources: [{ id: "01:original", type: "OriginalImage", uri: "/x.png" }],
    annotations: annotations as IimlDocument["annotations"],
    ...extra
  } as IimlDocument;
}

describe("annotationReducer set-doc — 默认值补全", () => {
  it("历史 annotation 缺 frame → 补 'model'", () => {
    const ann = { id: "a1", resourceId: "r", target: { type: "Polygon", coordinates: [] }, structuralLevel: "figure" };
    const next = annotationReducer(initialAnnotationState, { type: "set-doc", doc: docWith([ann]) });
    assert.equal(next.doc?.annotations[0].frame, "model");
  });

  it("保留已显式声明的 frame=image", () => {
    const ann = { id: "a1", resourceId: "r", target: { type: "Polygon", coordinates: [] }, structuralLevel: "figure", frame: "image" };
    const next = annotationReducer(initialAnnotationState, { type: "set-doc", doc: docWith([ann]) });
    assert.equal(next.doc?.annotations[0].frame, "image");
  });

  it("缺 color → 补调色板色；visible 默认 true；locked 默认 false", () => {
    const ann = { id: "a1", resourceId: "r", target: { type: "Point", coordinates: [0, 0] }, structuralLevel: "figure" };
    const next = annotationReducer(initialAnnotationState, { type: "set-doc", doc: docWith([ann]) });
    const a = next.doc?.annotations[0];
    assert.ok(typeof a?.color === "string" && a.color.length > 0);
    assert.equal(a?.visible, true);
    assert.equal(a?.locked, false);
  });

  it("剥掉 legacy doc.layers 字段（防止 stale 数据写回）", () => {
    const ann = { id: "a1", resourceId: "r", target: { type: "Point", coordinates: [0, 0] }, structuralLevel: "figure" };
    const doc = docWith([ann], { layers: [{ stale: true }] });
    const next = annotationReducer(initialAnnotationState, { type: "set-doc", doc });
    assert.equal((next.doc as Record<string, unknown>).layers, undefined);
  });

  it("set-doc 清空 undo/redo 栈与选中态", () => {
    const doc1 = docWith([{ id: "a1", resourceId: "r", target: { type: "Point", coordinates: [0, 0] }, structuralLevel: "figure" }]);
    let state = annotationReducer(initialAnnotationState, { type: "set-doc", doc: doc1 });
    state = annotationReducer(state, { type: "select", id: "a1" });
    state = annotationReducer(state, {
      type: "update-annotation",
      id: "a1",
      patch: { label: "x" }
    });
    assert.ok(state.undoStack.length > 0);
    state = annotationReducer(state, { type: "set-doc", doc: doc1 });
    assert.equal(state.undoStack.length, 0);
    assert.equal(state.redoStack.length, 0);
    assert.equal(state.selectedAnnotationId, undefined);
  });
});

describe("annotationReducer — 撤销/重做", () => {
  it("update → undo 回到原状 → redo 恢复", () => {
    const doc = docWith([{ id: "a1", resourceId: "r", target: { type: "Point", coordinates: [0, 0] }, structuralLevel: "figure" }]);
    let state = annotationReducer(initialAnnotationState, { type: "set-doc", doc });
    const originalLabel = state.doc?.annotations[0].label;
    state = annotationReducer(state, { type: "update-annotation", id: "a1", patch: { label: "new-label" } });
    assert.equal(state.doc?.annotations[0].label, "new-label");
    state = annotationReducer(state, { type: "undo" });
    assert.equal(state.doc?.annotations[0].label, originalLabel);
    state = annotationReducer(state, { type: "redo" });
    assert.equal(state.doc?.annotations[0].label, "new-label");
  });

  it("delete-annotation 同时清掉悬空关系", () => {
    const doc = docWith([
      { id: "a1", resourceId: "r", target: { type: "Point", coordinates: [0, 0] }, structuralLevel: "figure" },
      { id: "a2", resourceId: "r", target: { type: "Point", coordinates: [0, 0] }, structuralLevel: "figure" }
    ]);
    let state = annotationReducer(initialAnnotationState, { type: "set-doc", doc });
    state = annotationReducer(state, {
      type: "add-relation",
      relation: { id: "rel1", kind: "narrative-precedes", source: "a1", target: "a2", origin: "manual" } as never
    });
    assert.equal((state.doc?.relations ?? []).length, 1);
    state = annotationReducer(state, { type: "delete-annotation", id: "a1" });
    assert.equal((state.doc?.relations ?? []).length, 0, "删 a1 后引用 a1 的关系应被清掉");
    assert.equal(state.doc?.annotations.length, 1);
  });
});
