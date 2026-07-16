/**
 * 选中区域深编辑器 `RegionEditor`（IimlPanel 图像学层的子组件）
 *
 * 旧 AnnotationCard（5 tab 模态）在 IIML 四层重构中退役后，标注级的深编辑
 * 字段收敛到这里，直接内嵌在图像学层"母题区域"列表下方：
 *
 * - 对象确定：名称 / 类别 / 结构层级 / 审核状态 / 母题（按类别 datalist 建议）/ 标注质量
 * - 训练就绪度：TrainingReadinessSection 实时显示能否进训练池 + 一键修复
 * - 图像志三层文本 + 题刻子面板（structuralLevel = inscription 时出现）
 * - 受控术语 TermPicker（含 D6 共现推荐）
 * - 证据来源 SourcesEditor（档案 / 文献 / 资源 / 其他四种 kind）
 * - 训练细节：几何语义 / 训练角色 / 问题标签（主动学习队列排序用）
 * - 多解释并存 AlternativeInterpretationsView（alternativeInterpretationOf 关系）
 * - 空间关系 RelationsEditor + AI 处理记录 ProcessingRunsList（学术溯源）
 *
 * 所有编辑直接 dispatch update-annotation → reducer undo 栈 + autosave。
 */

import { Check } from "lucide-react";
import { useMemo } from "react";
import type { StoneMetadata, VocabularyCategory, VocabularyTerm } from "../../api/client";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { Field, Select } from "../../ui/Field";
import { AlternativeInterpretationsView } from "./AlternativeInterpretationsView";
import { ColorPopover } from "./ColorPopover";
import { DraftInput, DraftTextarea } from "./DraftFields";
import { ProcessingRunsList } from "./ProcessingRunsList";
import { RelationsEditor, type SpatialRelationCandidate } from "./RelationsEditor";
import { SourcesEditor } from "./SourcesEditor";
import { TermPicker } from "./TermPicker";
import { TrainingReadinessSection } from "./training-ui";
import {
  allMotifSuggestions,
  hanStoneCategoryOptions,
  motifSuggestionsByCategory,
  narrativeCategoriesNeedMotif
} from "./categories";
import { recommendCooccurringTerms } from "./cooccurrence";
import { annotationPalette } from "./store";
import type {
  AnnotationAction,
  IimlAnnotation,
  IimlAnnotationIssue,
  IimlAnnotationQualityTier,
  IimlDocument,
  IimlGeometryIntent,
  IimlHanStoneCategory,
  IimlProcessingRun,
  IimlRelation,
  IimlReviewStatus,
  IimlStructuralLevel,
  IimlTrainingRole
} from "./types";

const structuralLevelOptions: Array<{ value: IimlStructuralLevel; label: string }> = [
  { value: "whole", label: "整体" },
  { value: "scene", label: "场景" },
  { value: "figure", label: "形象" },
  { value: "component", label: "构件" },
  { value: "trace", label: "痕迹" },
  { value: "inscription", label: "题刻" },
  { value: "damage", label: "病害" },
  { value: "unknown", label: "未定" }
];

const reviewStatusOptions: Array<{ value: IimlReviewStatus; label: string }> = [
  { value: "candidate", label: "候选（AI 未审）" },
  { value: "reviewed", label: "已审核" },
  { value: "approved", label: "已通过" },
  { value: "rejected", label: "已拒绝" }
];

const annotationQualityOptions: Array<{ value: IimlAnnotationQualityTier; label: string; title: string }> = [
  { value: "weak", label: "weak · 粗略", title: "框、点、涂鸦、局部线索；用于覆盖和弱监督" },
  { value: "silver", label: "silver · 可用", title: "AI 或人工快速修正的 polygon/mask；可训练但需统计噪声" },
  { value: "gold", label: "gold · 精确", title: "专家精修；用于验证集、测试集或论文评估" }
];

const geometryIntentOptions: Array<{ value: IimlGeometryIntent; label: string; title: string }> = [
  { value: "visible_trace", label: "可见刻痕", title: "只标图像上可见的雕刻/痕迹区域" },
  { value: "semantic_extent", label: "语义范围", title: "标专家判定该对象在画面中的整体范围" },
  { value: "reconstructed_extent", label: "复原范围", title: "包含磨损、遮挡后的专家推断完整形态" }
];

const trainingRoleOptions: Array<{ value: IimlTrainingRole; label: string; title: string }> = [
  { value: "train", label: "训练", title: "常规训练候选" },
  { value: "validation", label: "验证/评估", title: "gold 子集，优先留作验证或论文评估" },
  { value: "holdout", label: "暂存", title: "保留在 IIML 中，但导出报告会单独标记" }
];

const annotationIssueOptions: Array<{ value: IimlAnnotationIssue; label: string }> = [
  { value: "low_contrast", label: "低对比" },
  { value: "texture_confusion", label: "纹理混淆" },
  { value: "ambiguous_boundary", label: "边界歧义" },
  { value: "occluded_or_worn", label: "遮挡/风化" },
  { value: "oversegmented", label: "过分割" },
  { value: "undersegmented", label: "欠分割" },
  { value: "class_uncertain", label: "类别不确定" },
  { value: "needs_expert_review", label: "需专家复核" }
];

const MOTIF_DATALIST_ID = "wsc-motif-suggestions";

export type RegionEditorProps = {
  annotation: IimlAnnotation;
  isDraft: boolean;
  doc?: IimlDocument;
  metadata?: StoneMetadata;
  annotations: IimlAnnotation[];
  relations: IimlRelation[];
  spatialCandidates: SpatialRelationCandidate[];
  processingRuns: IimlProcessingRun[];
  vocabularyCategories: VocabularyCategory[];
  vocabularyTerms: VocabularyTerm[];
  dispatch: (a: AnnotationAction) => void;
};

export function RegionEditor({
  annotation,
  isDraft,
  doc,
  metadata,
  annotations,
  relations,
  spatialCandidates,
  processingRuns,
  vocabularyCategories,
  vocabularyTerms,
  dispatch
}: RegionEditorProps) {
  const patch = (p: Partial<IimlAnnotation>) => dispatch({ type: "update-annotation", id: annotation.id, patch: p });
  const patchSemantics = (p: Record<string, string>) =>
    patch({ semantics: { ...annotation.semantics, ...p } });
  const patchInscription = (key: "transcription" | "translation" | "readingNote", value: string) =>
    patch({
      semantics: {
        ...annotation.semantics,
        inscription: { ...annotation.semantics?.inscription, [key]: value }
      }
    });

  const category = annotation.category;
  const motifSuggestions = (category && motifSuggestionsByCategory[category]?.length
    ? motifSuggestionsByCategory[category]
    : allMotifSuggestions);
  const showInscription = (annotation.structuralLevel ?? "unknown") === "inscription";
  const issues = annotation.annotationIssues ?? [];

  const toggleIssue = (issue: IimlAnnotationIssue) => {
    const next = new Set(issues);
    if (next.has(issue)) next.delete(issue);
    else next.add(issue);
    patch({ annotationIssues: next.size > 0 ? [...next] : undefined });
  };

  // D6 共现推荐：基于全文档其他标注的术语共现频次给建议（数据稀疏时为空）
  const suggestedTerms = useMemo(
    () =>
      recommendCooccurringTerms(
        annotations,
        (annotation.semantics?.terms ?? []).map((term) => term.id),
        vocabularyTerms
      ),
    [annotations, annotation.semantics?.terms, vocabularyTerms]
  );

  const relationCount = relations.filter(
    (r) => r.source === annotation.id || r.target === annotation.id
  ).length;

  return (
    <section className="iiml-region-editor">
      <header className="iiml-subheader">
        <ColorPopover
          color={annotation.color ?? annotationPalette[0]}
          size={14}
          title="更改标注颜色"
          onChange={(color) => patch({ color })}
        />
        <strong>{annotation.label || "选中区域"}</strong>
        <span className="iiml-region__meta">
          {annotation.target.type} · {annotation.frame ?? "model"}
        </span>
        {isDraft ? (
          <span className="iiml-subheader__actions">
            <Button compact variant="primary" onClick={() => dispatch({ type: "set-draft", id: undefined })}>
              <Check size={13} /> 确认标注
            </Button>
            <Button compact variant="danger" onClick={() => dispatch({ type: "delete-annotation", id: annotation.id })}>
              取消
            </Button>
          </span>
        ) : null}
      </header>

      <TrainingReadinessSection
        annotation={annotation}
        doc={doc}
        onUpdateAnnotation={(id, p) => dispatch({ type: "update-annotation", id, patch: p })}
      />

      <div className="iiml-grid-2">
        <Field label="名称（母题主体）">
          <DraftInput value={annotation.label ?? ""} placeholder="如：西王母" onCommit={(v) => patch({ label: v })} />
        </Field>
        <Field label="类别">
          <Select
            value={annotation.category ?? ""}
            onChange={(e) => patch({ category: (e.target.value || undefined) as IimlHanStoneCategory | undefined })}
          >
            <option value="">（未分类）</option>
            {hanStoneCategoryOptions.map((o) => (
              <option key={o.value} value={o.value} title={o.description}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="结构层级">
          <Select
            value={annotation.structuralLevel ?? "unknown"}
            onChange={(e) => patch({ structuralLevel: e.target.value as IimlStructuralLevel })}
          >
            {structuralLevelOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="审核状态">
          <Select
            value={annotation.reviewStatus ?? "reviewed"}
            onChange={(e) => patch({ reviewStatus: e.target.value as IimlReviewStatus })}
          >
            {reviewStatusOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="母题 / 格套">
          <DraftInput
            value={annotation.motif ?? ""}
            placeholder="如：荆轲刺秦王 / 车马出行"
            datalistId={MOTIF_DATALIST_ID}
            onCommit={(v) => patch({ motif: v })}
          />
        </Field>
        <Field label="标注质量">
          <Select
            value={annotation.annotationQuality ?? ""}
            onChange={(e) =>
              patch({ annotationQuality: (e.target.value || undefined) as IimlAnnotationQualityTier | undefined })
            }
          >
            <option value="">（默认）</option>
            {annotationQualityOptions.map((o) => (
              <option key={o.value} value={o.value} title={o.title}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <datalist id={MOTIF_DATALIST_ID}>
        {motifSuggestions.map((motif) => (
          <option key={motif} value={motif} />
        ))}
      </datalist>
      {category && narrativeCategoriesNeedMotif.has(category) && !annotation.motif?.trim() ? (
        <p className="ui-muted">故事类（忠臣 / 孝子 / 烈女）建议填写具体母题，训练导出会给出 warning。</p>
      ) : null}

      <Field label="前图像志描述（可见对象的纯描述）">
        <DraftTextarea
          value={annotation.semantics?.preIconographic ?? ""}
          placeholder="如：一位戴胜端坐的女性形象，两侧有玉兔与九尾狐"
          onCommit={(v) => patchSemantics({ preIconographic: v })}
        />
      </Field>
      <Field label="图像志含义（母题识别与文献关联）">
        <DraftTextarea
          value={annotation.semantics?.iconographicMeaning ?? ""}
          placeholder="如：西王母，见《山海经·西山经》「其状如人，豹尾虎齿」"
          onCommit={(v) => patchSemantics({ iconographicMeaning: v })}
        />
      </Field>
      <Field label="图像学阐释（文化意义）">
        <DraftTextarea
          value={annotation.semantics?.iconologicalMeaning ?? ""}
          placeholder="如：汉代升仙信仰的核心神祇，墓葬语境中引导墓主灵魂升仙"
          onCommit={(v) => patchSemantics({ iconologicalMeaning: v })}
        />
      </Field>

      {showInscription ? (
        <details className="iiml-collapse" open>
          <summary>题刻释读（训练准入要求有释文）</summary>
          <div className="iiml-form">
            <Field label="释文 transcription">
              <DraftTextarea
                value={annotation.semantics?.inscription?.transcription ?? ""}
                placeholder="原文释文，保留缺字符号如 □"
                rows={2}
                onCommit={(v) => patchInscription("transcription", v)}
              />
            </Field>
            <Field label="今译">
              <DraftTextarea
                value={annotation.semantics?.inscription?.translation ?? ""}
                placeholder="现代汉语翻译"
                rows={2}
                onCommit={(v) => patchInscription("translation", v)}
              />
            </Field>
            <Field label="释读注">
              <DraftTextarea
                value={annotation.semantics?.inscription?.readingNote ?? ""}
                placeholder="异体字、缺损、争议读法等说明"
                rows={2}
                onCommit={(v) => patchInscription("readingNote", v)}
              />
            </Field>
          </div>
        </details>
      ) : null}

      <strong className="iiml-group-title">受控术语</strong>
      <TermPicker
        value={annotation.semantics?.terms}
        categories={vocabularyCategories}
        terms={vocabularyTerms}
        suggestedTerms={suggestedTerms}
        onChange={(terms) => patch({ semantics: { ...annotation.semantics, terms } })}
      />

      <details className="iiml-collapse">
        <summary>证据来源（{annotation.sources?.length ?? 0}）</summary>
        <SourcesEditor value={annotation.sources} metadata={metadata} onChange={(sources) => patch({ sources })} />
      </details>

      <details className="iiml-collapse">
        <summary>训练细节（几何语义 / 训练角色 / 问题标签）</summary>
        <div className="iiml-form">
          <div className="iiml-grid-2">
            <Field label="几何语义">
              <Select
                value={annotation.geometryIntent ?? "visible_trace"}
                onChange={(e) => patch({ geometryIntent: e.target.value as IimlGeometryIntent })}
              >
                {geometryIntentOptions.map((o) => (
                  <option key={o.value} value={o.value} title={o.title}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="训练角色">
              <Select
                value={annotation.trainingRole ?? "train"}
                onChange={(e) => patch({ trainingRole: e.target.value as IimlTrainingRole })}
              >
                {trainingRoleOptions.map((o) => (
                  <option key={o.value} value={o.value} title={o.title}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="iiml-issue-chips" role="group" aria-label="问题标签">
            {annotationIssueOptions.map((o) => (
              <Chip key={o.value} active={issues.includes(o.value)} onClick={() => toggleIssue(o.value)}>
                {o.label}
              </Chip>
            ))}
          </div>
          <Field label="研究备注">
            <DraftTextarea
              value={annotation.notes ?? ""}
              placeholder="研究思路、参考、待查证…"
              rows={2}
              onCommit={(v) => patch({ notes: v })}
            />
          </Field>
        </div>
      </details>

      <AlternativeInterpretationsView
        annotation={annotation}
        annotations={annotations}
        relations={relations}
        onSelectAnnotation={(id) => dispatch({ type: "select", id })}
      />

      <details className="iiml-collapse" open>
        <summary>空间关系（{relationCount}）</summary>
        <RelationsEditor
          annotation={annotation}
          relations={relations}
          annotations={annotations}
          spatialCandidates={spatialCandidates}
          onAddRelation={(relation) => dispatch({ type: "add-relation", relation })}
          onUpdateRelation={(id, p) => dispatch({ type: "update-relation", id, patch: p })}
          onDeleteRelation={(id) => dispatch({ type: "delete-relation", id })}
          onSelectAnnotation={(id) => dispatch({ type: "select", id })}
        />
      </details>

      <ProcessingRunsList
        annotation={annotation}
        runs={processingRuns}
        onSelectAnnotation={(id) => dispatch({ type: "select", id })}
      />
    </section>
  );
}
