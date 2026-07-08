/**
 * 训练池就绪度 UI（P3 从 AnnotationPanel 抽出，供摘要栏与标注卡片共用）。
 *
 * - `TrainingBadge`：✓ / ⚠ / ✗ 三档图标，hover 列出全部原因码
 * - `TrainingReadinessSection`：展开的 chips + 一键修复（设为已审核 / 设类别 unknown）
 * - `TRAINING_REASON_LABELS`：SOP §11 原因码 → 中文标签
 */

import { AlertTriangle, Check, CircleAlert } from "lucide-react";
import { useMemo } from "react";
import type { IimlAnnotation, IimlDocument } from "../../api/client";
import { validateAnnotationForTraining } from "./training";

export const TRAINING_REASON_LABELS: Record<string, string> = {
  "geometry-missing": "几何为空",
  "geometry-no-type": "几何缺 type",
  "geometry-point-invalid": "Point 几何不合法",
  "geometry-point-nan": "Point 坐标含 NaN",
  "geometry-linestring-too-few-points": "LineString 顶点 < 2",
  "geometry-polygon-no-ring": "Polygon 缺外环",
  "geometry-polygon-too-few-vertices": "Polygon 顶点 < 6（SOP §3.2）",
  "geometry-polygon-too-many-vertices": "Polygon 顶点 > 200（SOP §3.2，建议拆条）",
  "geometry-multipolygon-empty": "MultiPolygon 为空",
  "geometry-bbox-invalid": "BBox 不是 4 元组",
  "geometry-bbox-nan": "BBox 坐标含 NaN",
  "geometry-bbox-zero": "BBox 宽或高 ≤ 0",
  "geometry-bbox-too-small": "BBox 面积 < 64 px²（SOP §11.11）",
  "geometry-polygon-too-small": "Polygon 面积 < 64 px²（SOP §11.11）",
  "geometry-multipolygon-too-small": "MultiPolygon 总面积 < 64 px²",
  "geometry-unknown-type": "几何 type 不在受控集",
  "frame-model-no-alignment": "frame=model 但缺少 4 点对齐或等价正射图",
  "bad-structural-level": "structuralLevel 不在 8 档",
  "bad-category": "category 缺失或不在 13 + unknown（SOP §1）",
  "motif-too-long": "motif 超过 200 字符上限",
  "bad-annotation-quality": "annotationQuality 不在 weak/silver/gold",
  "bad-geometry-intent": "geometryIntent 不在三类边界语义",
  "bad-training-role": "trainingRole 不在 train/validation/holdout",
  "no-terms": "至少 1 个受控术语（terms[]）",
  "no-sources": "未填写证据源；可进训练池，但发布/论文前建议补齐",
  "no-evidence-source": "sources 中缺 metadata / reference；可进训练池，但溯源质量较弱",
  "pre-iconographic-too-short": "preIconographic < 10 字（SOP §4.4）",
  "iconographic-too-short": "iconographicMeaning < 10 字（SOP §4.4）",
  "review-status-candidate": "未审核（reviewStatus=candidate）",
  "review-status-reviewed": "需二次审核才能进训练池",
  "review-status-rejected": "已被拒（reviewStatus=rejected）",
  "inscription-no-transcription": "inscription 类必须有题刻 transcription",
  "missing-motif-for-narrative": "故事类建议填 motif（SOP §11.12 warning）",
  "annotation-quality-weak": "weak 标注：用于覆盖/弱监督，正式 mask 训练需谨慎",
  "geometry-intent-reconstructed": "复原范围：含专家推断，建议单独评估",
  "training-role-validation": "验证/评估子集：训练脚本应默认留出",
  "training-role-holdout": "暂存样本：保留但默认不参与训练"
};

export function describeTrainingReasons(codes: string[]): string {
  return codes.map((code) => `${code}: ${TRAINING_REASON_LABELS[code] ?? code}`).join("\n");
}

export function TrainingBadge({ result }: { result?: ReturnType<typeof validateAnnotationForTraining> }) {
  if (!result) {
    return <span className="training-badge training-badge--unknown" title="未计算" aria-hidden>·</span>;
  }
  if (!result.ready) {
    const tooltip = `不进训练池（${result.errors.length} 项未通过）：\n${describeTrainingReasons(result.errors)}`;
    return (
      <span className="training-badge training-badge--blocked" title={tooltip} aria-label="不进训练池">
        <CircleAlert size={13} />
      </span>
    );
  }
  if (result.warnings.length > 0) {
    const tooltip = `进训练池但有警告：\n${describeTrainingReasons(result.warnings)}`;
    return (
      <span className="training-badge training-badge--warn" title={tooltip} aria-label="进训练池（有警告）">
        <AlertTriangle size={13} />
      </span>
    );
  }
  return (
    <span className="training-badge training-badge--ready" title="进训练池（SOP §11 全部通过）" aria-label="进训练池">
      <Check size={13} />
    </span>
  );
}

/**
 * P1 训练就绪度面板：顶部实时显示"能否进训练池 + 卡在哪 + 一键修"。
 * 校验复用 training.ts，无后端 round-trip。
 */
export function TrainingReadinessSection({
  annotation,
  doc,
  onUpdateAnnotation
}: {
  annotation: IimlAnnotation;
  doc?: IimlDocument;
  onUpdateAnnotation: (id: string, patch: Partial<IimlAnnotation>) => void;
}) {
  const result = useMemo(() => validateAnnotationForTraining(annotation, doc), [annotation, doc]);
  const hasReviewIssue = result.errors.some((code) => code.startsWith("review-status-"));
  const hasCategoryIssue = result.errors.includes("bad-category");

  return (
    <section className="training-readiness" aria-label="训练池就绪度">
      <header className="training-readiness-head">
        <TrainingBadge result={result} />
        {result.ready ? (
          result.warnings.length > 0 ? (
            <span className="training-readiness-title training-readiness-title--warn">
              进训练池 · {result.warnings.length} 项警告
            </span>
          ) : (
            <span className="training-readiness-title training-readiness-title--ready">已就绪 · 进训练池</span>
          )
        ) : (
          <span className="training-readiness-title training-readiness-title--blocked">
            不进训练池 · {result.errors.length} 项未通过
          </span>
        )}
      </header>
      {result.errors.length > 0 ? (
        <div className="training-reason-chips">
          {result.errors.map((code) => (
            <span
              key={code}
              className="training-reason-chip training-reason-chip--error"
              title={`${code}: ${TRAINING_REASON_LABELS[code] ?? code}`}
            >
              {TRAINING_REASON_LABELS[code] ?? code}
            </span>
          ))}
        </div>
      ) : null}
      {result.warnings.length > 0 ? (
        <div className="training-reason-chips">
          {result.warnings.map((code) => (
            <span
              key={code}
              className="training-reason-chip training-reason-chip--warn"
              title={`${code}: ${TRAINING_REASON_LABELS[code] ?? code}`}
            >
              {TRAINING_REASON_LABELS[code] ?? code}
            </span>
          ))}
        </div>
      ) : null}
      {hasReviewIssue || hasCategoryIssue ? (
        <div className="training-readiness-quickfixes">
          {hasReviewIssue ? (
            <button
              type="button"
              className="secondary-action small"
              onClick={() => onUpdateAnnotation(annotation.id, { reviewStatus: "reviewed" })}
              title="把 reviewStatus 设为 reviewed（人工已审），最常见的 SAM3 候选升级动作"
            >
              设为已审核
            </button>
          ) : null}
          {hasCategoryIssue ? (
            <button
              type="button"
              className="secondary-action small"
              onClick={() => onUpdateAnnotation(annotation.id, { category: "unknown" })}
              title="category 缺失时先标 unknown 占位，进训练池后再细化分类"
            >
              设类别 unknown
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
