/**
 * training-validation 单元测试
 *
 * 锁住 SOP §11 的 11 项准入硬约束 + warning。这是训练池导出的门面逻辑，
 * 任何字段默认值 / 阈值 / frame 反投影规则改动都应被这里拦截。
 *
 * 覆盖：
 * - baseline（frame=image，全字段合法）→ ready
 * - 12 个 error 码逐个触发
 * - frame=model 的三条路径（alignment / 等价正射 / 都没有）
 * - 关键 warning（no-sources / missing-motif-for-narrative / quality-weak）
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IimlAnnotation, IimlDocument } from "../services/iiml.js";
import { validateAnnotationForTraining } from "../services/training-validation.js";

type AnnOverrides = Record<string, unknown>;

/** 合法基线 annotation（frame=image，所有字段满足准入）。每次返回新拷贝。 */
function baseAnn(overrides: AnnOverrides = {}): IimlAnnotation {
  return {
    id: "a1",
    resourceId: "01:original",
    // 6 点闭合环（≥6 顶点门槛），面积 ~0.09 ≫ 1e-5
    target: {
      type: "Polygon",
      coordinates: [
        [
          [0.1, 0.1],
          [0.3, 0.1],
          [0.4, 0.2],
          [0.4, 0.4],
          [0.1, 0.4],
          [0.1, 0.1]
        ]
      ]
    },
    frame: "image",
    structuralLevel: "figure",
    category: "figure-deity",
    semantics: {
      preIconographic: "a carved standing human figure",
      iconographicMeaning: "depicts a deity figure",
      terms: [{ id: "t1", label: "deity" }]
    },
    reviewStatus: "reviewed",
    sources: [{ kind: "metadata", layerIndex: 0 }],
    ...overrides
  } as IimlAnnotation;
}

/** 最小 doc（culturalObject 可被覆写以挂 alignment / 等价正射 resource）。 */
function baseDoc(overrides: Partial<IimlDocument> & Record<string, unknown> = {}): IimlDocument {
  return {
    "@context": "/api/iiml/context",
    "@type": "IIMLDocument",
    documentId: "01:iiml",
    name: "test",
    resources: [{ id: "01:original", type: "OriginalImage", uri: "/x.png" }],
    annotations: [],
    ...overrides
  } as IimlDocument;
}

describe("validateAnnotationForTraining — baseline", () => {
  it("frame=image 全字段合法 → ready，无 error", () => {
    const r = validateAnnotationForTraining(baseAnn(), baseDoc());
    assert.equal(r.ready, true);
    assert.deepEqual(r.errors, []);
  });
});

describe("validateAnnotationForTraining — 几何规则", () => {
  it("Polygon 环 <6 顶点 → geometry-polygon-too-few-vertices", () => {
    const ann = baseAnn({
      target: { type: "Polygon", coordinates: [[[0.1, 0.1], [0.4, 0.1], [0.1, 0.4], [0.1, 0.1]]] }
    });
    const r = validateAnnotationForTraining(ann, baseDoc());
    assert.equal(r.ready, false);
    assert.ok(r.errors.includes("geometry-polygon-too-few-vertices"));
  });

  it("Polygon 面积过小 → geometry-polygon-too-small", () => {
    const tiny = [
      [0.5, 0.5],
      [0.5001, 0.5],
      [0.5001, 0.5001],
      [0.5, 0.5001],
      [0.5, 0.5]
    ];
    const ann = baseAnn({ target: { type: "Polygon", coordinates: [tiny] } });
    const r = validateAnnotationForTraining(ann, baseDoc());
    assert.ok(r.errors.includes("geometry-polygon-too-small"));
  });

  it("BBox 视作对角点 UV，w/h 接近 0 → geometry-bbox-too-small（防 u2/v2 被当 w/h 的老 bug）", () => {
    const ann = baseAnn({ target: { type: "BBox", coordinates: [0.2, 0.2, 0.6, 0.4] } });
    const r = validateAnnotationForTraining(ann, baseDoc());
    assert.equal(r.ready, true, "合法 BBox 对角点应通过");
  });

  it("BBox 零面积 → geometry-bbox-zero", () => {
    const ann = baseAnn({ target: { type: "BBox", coordinates: [0.3, 0.3, 0.3, 0.3] } });
    const r = validateAnnotationForTraining(ann, baseDoc());
    assert.ok(r.errors.includes("geometry-bbox-zero"));
  });
});

describe("validateAnnotationForTraining — 字段规则", () => {
  it("缺 category → bad-category", () => {
    const r = validateAnnotationForTraining(baseAnn({ category: undefined }), baseDoc());
    assert.ok(r.errors.includes("bad-category"));
  });

  it("category 不在枚举 → bad-category", () => {
    const r = validateAnnotationForTraining(baseAnn({ category: "random-thing" }), baseDoc());
    assert.ok(r.errors.includes("bad-category"));
  });

  it("motif >200 字 → motif-too-long", () => {
    const r = validateAnnotationForTraining(baseAnn({ motif: "x".repeat(201) }), baseDoc());
    assert.ok(r.errors.includes("motif-too-long"));
  });

  it("structuralLevel 非法 → bad-structural-level", () => {
    const r = validateAnnotationForTraining(baseAnn({ structuralLevel: "blob" }), baseDoc());
    assert.ok(r.errors.includes("bad-structural-level"));
  });

  it("无 terms → no-terms", () => {
    const ann = baseAnn({ semantics: { preIconographic: "valid description", iconographicMeaning: "valid meaning", terms: [] } });
    const r = validateAnnotationForTraining(ann, baseDoc());
    assert.ok(r.errors.includes("no-terms"));
  });

  it("preIconographic <10 字 → pre-iconographic-too-short", () => {
    const ann = baseAnn({ semantics: { preIconographic: "short", iconographicMeaning: "valid meaning", terms: [{ id: "t", label: "x" }] } });
    const r = validateAnnotationForTraining(ann, baseDoc());
    assert.ok(r.errors.includes("pre-iconographic-too-short"));
  });

  it("iconographicMeaning <10 字 → iconographic-too-short", () => {
    const ann = baseAnn({ semantics: { preIconographic: "valid description", iconographicMeaning: "short", terms: [{ id: "t", label: "x" }] } });
    const r = validateAnnotationForTraining(ann, baseDoc());
    assert.ok(r.errors.includes("iconographic-too-short"));
  });

  it("reviewStatus=candidate → review-status-candidate", () => {
    const r = validateAnnotationForTraining(baseAnn({ reviewStatus: "candidate" }), baseDoc());
    assert.ok(r.errors.some((e) => e.startsWith("review-status-")));
  });

  it("reviewStatus=rejected → 拦截", () => {
    const r = validateAnnotationForTraining(baseAnn({ reviewStatus: "rejected" }), baseDoc());
    assert.ok(r.errors.some((e) => e.startsWith("review-status-")));
  });

  it("reviewStatus=approved → 放行", () => {
    const r = validateAnnotationForTraining(baseAnn({ reviewStatus: "approved" }), baseDoc());
    assert.equal(r.ready, true);
  });

  it("inscription 缺 transcription → inscription-no-transcription", () => {
    const ann = baseAnn({
      structuralLevel: "inscription",
      semantics: { preIconographic: "an inscription carved here", iconographicMeaning: "commemorative text", terms: [{ id: "t", label: "x" }] }
    });
    const r = validateAnnotationForTraining(ann, baseDoc());
    assert.ok(r.errors.includes("inscription-no-transcription"));
  });
});

describe("validateAnnotationForTraining — frame=model 三路径", () => {
  it("frame=model 且无 alignment 且非等价正射 → frame-model-no-alignment", () => {
    const ann = baseAnn({ frame: "model" });
    const r = validateAnnotationForTraining(ann, baseDoc());
    assert.ok(r.errors.includes("frame-model-no-alignment"));
  });

  it("frame=model + doc 有 4 点 alignment → 放行", () => {
    const ann = baseAnn({ frame: "model" });
    const doc = baseDoc({
      culturalObject: {
        alignment: {
          version: 1,
          calibratedAt: "2026-01-01T00:00:00Z",
          controlPoints: [
            { modelUv: [0, 0], imageUv: [0, 0] },
            { modelUv: [1, 0], imageUv: [1, 0] },
            { modelUv: [1, 1], imageUv: [1, 1] },
            { modelUv: [0, 1], imageUv: [0, 1] }
          ]
        }
      }
    });
    const r = validateAnnotationForTraining(ann, doc);
    assert.equal(r.ready, true, "有 alignment 的 model 标注应放行");
  });

  it("frame=model + resourceId 命中等价正射图（front + frustumScale≈1）→ 放行", () => {
    const ann = baseAnn({ frame: "model", resourceId: "01:ortho" });
    const doc = baseDoc({
      resources: [
        { id: "01:ortho", type: "Orthophoto", uri: "/o.png", transform: { kind: "orthographic-from-model", view: "front", frustumScale: 1.0, modelAABB: { width: 1, height: 1, depth: 1 }, pixelSize: { width: 1024, height: 1024 } } }
      ]
    });
    const r = validateAnnotationForTraining(ann, doc);
    assert.equal(r.ready, true, "等价正射图上的 model 标注应放行");
  });

  it("frame=model + 非正面正射图（view=back）→ frame-model-no-alignment", () => {
    const ann = baseAnn({ frame: "model", resourceId: "01:ortho" });
    const doc = baseDoc({
      resources: [
        { id: "01:ortho", type: "Orthophoto", uri: "/o.png", transform: { kind: "orthographic-from-model", view: "back", frustumScale: 1.0, modelAABB: { width: 1, height: 1, depth: 1 }, pixelSize: { width: 1024, height: 1024 } } }
      ]
    });
    const r = validateAnnotationForTraining(ann, doc);
    assert.ok(r.errors.includes("frame-model-no-alignment"));
  });
});

describe("validateAnnotationForTraining — warning", () => {
  it("无 sources → no-sources warning（不阻断）", () => {
    const ann = baseAnn({ sources: [] });
    const r = validateAnnotationForTraining(ann, baseDoc());
    assert.equal(r.ready, true);
    assert.ok(r.warnings.includes("no-sources"));
  });

  it("sources 只有 other → no-evidence-source warning", () => {
    const ann = baseAnn({ sources: [{ kind: "other", text: "guess" }] });
    const r = validateAnnotationForTraining(ann, baseDoc());
    assert.ok(r.warnings.includes("no-evidence-source"));
  });

  it("叙事类缺 motif → missing-motif-for-narrative", () => {
    const ann = baseAnn({ category: "figure-loyal-assassin", motif: undefined });
    const r = validateAnnotationForTraining(ann, baseDoc());
    assert.ok(r.warnings.includes("missing-motif-for-narrative"));
  });
});

describe("validateAnnotationForTraining — 默认值推导", () => {
  it("BBox 默认 annotationQuality=weak → quality warning + 不报 bad-quality", () => {
    const ann = baseAnn({ target: { type: "BBox", coordinates: [0.2, 0.2, 0.6, 0.5] } });
    const r = validateAnnotationForTraining(ann, baseDoc());
    assert.equal(r.ready, true);
    assert.ok(r.warnings.includes("annotation-quality-weak"));
    assert.ok(!r.errors.includes("bad-annotation-quality"));
  });

  it("显式 annotationQuality=gold + Polygon → 不报 weak warning", () => {
    const ann = baseAnn({ annotationQuality: "gold" as IimlAnnotation["annotationQuality"] });
    const r = validateAnnotationForTraining(ann, baseDoc());
    assert.ok(!r.warnings.includes("annotation-quality-weak"));
  });
});
