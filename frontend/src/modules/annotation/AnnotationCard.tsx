/**
 * 宽标注卡片 `AnnotationCard`（P3）
 *
 * IIML 不是"标签表"，而是"图像证据 + 形象学解释 + 关系网络 + 文化语义"的
 * 结构化档案。右侧窄栏只放摘要；完整的 IIML 字段在这张宽卡片里分 5 个页签：
 *
 *   A 对象确定   —— 名称 / 类别 / 母题 / 审核状态 / 边界质量 / 训练角色
 *   B 位置与形态 —— 系统自动生成：frame / 几何统计 / bbox / mask / cutout / 编辑历史
 *   C 视觉层     —— 前图像志描述 / 问题标签 / 几何语义 / 备注
 *   D 图像志层   —— 图像志含义 / 图像学解释 / 受控术语 / 证据源 / 题刻
 *   E 关系网络   —— 标注间关系 / 多解释对比 / AI 处理记录
 *
 * 设计要点：
 * - 初次标注只要求最少字段（A 页签），深入解释后置（C/D/E 慢慢补）
 * - 所有编辑直接走 onUpdateAnnotation → reducer autosave，与旧编辑面板一致
 * - 卡片是模态浮层（Esc / 点遮罩关闭），不打断画布上的标注选择
 */

import { Check, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  IimlAnnotation,
  IimlAnnotationIssue,
  IimlAnnotationQualityTier,
  IimlDocument,
  IimlGeometryIntent,
  IimlHanStoneCategory,
  IimlReviewStatus,
  IimlSource,
  IimlStructuralLevel,
  IimlTermRef,
  IimlTrainingRole,
  StoneMetadata,
  VocabularyCategory,
  VocabularyTerm
} from "../../api/client";
import { AlternativeInterpretationsView } from "./AlternativeInterpretationsView";
import { ColorPopover } from "./ColorPopover";
import { ProcessingRunsList } from "./ProcessingRunsList";
import { RelationsEditor } from "./RelationsEditor";
import { SourcesEditor } from "./SourcesEditor";
import { TermPicker } from "./TermPicker";
import { annotationPalette } from "./store";
import { flattenUVs, geometryCenter } from "./geometry";
import {
  allMotifSuggestions,
  hanStoneCategoryOptions,
  motifSuggestionsByCategory,
  narrativeCategoriesNeedMotif
} from "./categories";
import { TrainingReadinessSection } from "./training-ui";

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

type CardTab = "object" | "shape" | "visual" | "iconography" | "network";

const cardTabs: Array<{ id: CardTab; label: string; hint: string }> = [
  { id: "object", label: "对象", hint: "对象确定：名称 / 类别 / 状态（初次标注只填这页）" },
  { id: "shape", label: "位置与形态", hint: "系统自动生成：几何统计 / mask / cutout / 编辑历史" },
  { id: "visual", label: "视觉层", hint: "线条 / 构图 / 保存状况等可见特征描述" },
  { id: "iconography", label: "图像志", hint: "母题识别与文化解释（研究价值最高）" },
  { id: "network", label: "关系网络", hint: "标注间关系 / 多解释对比 / AI 处理记录" }
];

const DEFAULT_OPACITY = 0.15;

type AnnotationCardProps = {
  annotation: IimlAnnotation;
  doc?: IimlDocument;
  metadata?: StoneMetadata;
  vocabularyCategories: VocabularyCategory[];
  vocabularyTerms: VocabularyTerm[];
  relations: import("./types").IimlRelation[];
  spatialCandidates?: import("./RelationsEditor").SpatialRelationCandidate[];
  processingRuns?: import("./types").IimlProcessingRun[];
  suggestedTerms?: VocabularyTerm[];
  onUpdateAnnotation: (id: string, patch: Partial<IimlAnnotation>) => void;
  onDeleteAnnotation: (id: string) => void;
  onSelectAnnotation: (id?: string) => void;
  onAddRelation: (relation: import("./types").IimlRelation) => void;
  onUpdateRelation: (id: string, patch: Partial<import("./types").IimlRelation>) => void;
  onDeleteRelation: (id: string) => void;
  onClose: () => void;
};

export function AnnotationCard({
  annotation,
  doc,
  metadata,
  vocabularyCategories,
  vocabularyTerms,
  relations,
  spatialCandidates,
  processingRuns = [],
  suggestedTerms = [],
  onUpdateAnnotation,
  onDeleteAnnotation,
  onSelectAnnotation,
  onAddRelation,
  onUpdateRelation,
  onDeleteRelation,
  onClose
}: AnnotationCardProps) {
  const [tab, setTab] = useState<CardTab>("object");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="annotation-card-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="annotation-card" role="dialog" aria-label="标注详情卡片">
        <header className="annotation-card-head">
          <span
            className="annotation-color-dot annotation-color-dot--static"
            style={{ background: annotation.color ?? annotationPalette[0] }}
            aria-hidden
          />
          <strong className="annotation-card-title">{annotation.label || "未命名标注"}</strong>
          <span className="annotation-card-subtitle">
            {annotation.target.type} · {annotation.frame ?? "model"} frame
          </span>
          <button className="annotation-card-close" type="button" onClick={onClose} title="关闭（Esc）">
            <X size={16} />
          </button>
        </header>
        <nav className="annotation-card-tabs" role="tablist">
          {cardTabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={tab === entry.id ? "annotation-card-tab is-active" : "annotation-card-tab"}
              title={entry.hint}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <div className="annotation-card-body">
          {tab === "object" ? (
            <ObjectTab annotation={annotation} doc={doc} onUpdateAnnotation={onUpdateAnnotation} />
          ) : tab === "shape" ? (
            <ShapeTab annotation={annotation} metadata={metadata} />
          ) : tab === "visual" ? (
            <VisualTab annotation={annotation} onUpdateAnnotation={onUpdateAnnotation} />
          ) : tab === "iconography" ? (
            <IconographyTab
              annotation={annotation}
              metadata={metadata}
              vocabularyCategories={vocabularyCategories}
              vocabularyTerms={vocabularyTerms}
              suggestedTerms={suggestedTerms}
              onUpdateAnnotation={onUpdateAnnotation}
            />
          ) : (
            <NetworkTab
              annotation={annotation}
              doc={doc}
              relations={relations}
              spatialCandidates={spatialCandidates}
              processingRuns={processingRuns}
              onAddRelation={onAddRelation}
              onUpdateRelation={onUpdateRelation}
              onDeleteRelation={onDeleteRelation}
              onSelectAnnotation={onSelectAnnotation}
            />
          )}
        </div>
        <footer className="annotation-card-foot">
          <button
            type="button"
            className="secondary-action danger"
            onClick={() => {
              onDeleteAnnotation(annotation.id);
              onClose();
            }}
          >
            <Trash2 size={14} /> 删除标注
          </button>
          <span className="annotation-card-foot-hint muted-text">改动实时自动保存</span>
          <button type="button" className="primary-action" onClick={onClose}>
            <Check size={14} /> 完成
          </button>
        </footer>
      </div>
    </div>
  );
}

function CardField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="card-field" title={hint}>
      <label className="card-field-label">{label}</label>
      <div className="card-field-body">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A 对象确定
// ---------------------------------------------------------------------------

function ObjectTab({
  annotation,
  doc,
  onUpdateAnnotation
}: {
  annotation: IimlAnnotation;
  doc?: IimlDocument;
  onUpdateAnnotation: (id: string, patch: Partial<IimlAnnotation>) => void;
}) {
  const [labelDraft, setLabelDraft] = useState(annotation.label ?? "");
  const [motifDraft, setMotifDraft] = useState(annotation.motif ?? "");
  useEffect(() => {
    setLabelDraft(annotation.label ?? "");
    setMotifDraft(annotation.motif ?? "");
  }, [annotation.id, annotation.label, annotation.motif]);

  const motifSuggestions = annotation.category
    ? motifSuggestionsByCategory[annotation.category]
    : allMotifSuggestions;
  const motifMissingWarning =
    annotation.category && narrativeCategoriesNeedMotif.has(annotation.category) && motifDraft.trim() === "";
  const opacityValue = annotation.opacity ?? DEFAULT_OPACITY;

  return (
    <div className="card-tab-grid">
      <TrainingReadinessSection annotation={annotation} doc={doc} onUpdateAnnotation={onUpdateAnnotation} />
      <div className="card-row">
        <CardField label="对象名称">
          <input
            type="text"
            value={labelDraft}
            placeholder="例如：执笏人物 / 青龙"
            onChange={(event) => setLabelDraft(event.target.value)}
            onBlur={() => {
              if (labelDraft !== (annotation.label ?? "")) {
                onUpdateAnnotation(annotation.id, { label: labelDraft });
              }
            }}
          />
        </CardField>
        <CardField label="颜色 / 透明度">
          <div className="card-inline-row">
            <ColorPopover
              color={annotation.color ?? annotationPalette[0]}
              onChange={(color) => onUpdateAnnotation(annotation.id, { color })}
              title="更改颜色"
              size={22}
            />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={opacityValue}
              onChange={(event) => onUpdateAnnotation(annotation.id, { opacity: Number(event.target.value) })}
            />
            <span className="muted-text">{Math.round(opacityValue * 100)}%</span>
          </div>
        </CardField>
      </div>
      <div className="card-row">
        <CardField label="结构层级">
          <select
            value={annotation.structuralLevel ?? "unknown"}
            onChange={(event) =>
              onUpdateAnnotation(annotation.id, { structuralLevel: event.target.value as IimlStructuralLevel })
            }
          >
            {structuralLevelOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </CardField>
        <CardField label="领域类别" hint="汉画像石领域类别（SOP §1，13 类 + 未识别）">
          <select
            value={annotation.category ?? ""}
            onChange={(event) =>
              onUpdateAnnotation(annotation.id, {
                category: event.target.value === "" ? undefined : (event.target.value as IimlHanStoneCategory)
              })
            }
          >
            <option value="">— 未填 —</option>
            {hanStoneCategoryOptions.map((option) => (
              <option key={option.value} value={option.value} title={option.description}>
                {option.label}
              </option>
            ))}
          </select>
        </CardField>
        <CardField label="审核状态">
          <select
            value={annotation.reviewStatus ?? "reviewed"}
            onChange={(event) =>
              onUpdateAnnotation(annotation.id, { reviewStatus: event.target.value as IimlReviewStatus })
            }
          >
            {reviewStatusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </CardField>
      </div>
      <CardField label="母题 / 格套">
        <input
          type="text"
          list={`card-motif-${annotation.id}`}
          value={motifDraft}
          placeholder={annotation.category ? `${motifSuggestions.length} 项建议，可自由填写` : "先选类别可获得受控建议"}
          onChange={(event) => setMotifDraft(event.target.value)}
          onBlur={() => {
            const trimmed = motifDraft.trim();
            if (trimmed !== (annotation.motif ?? "")) {
              onUpdateAnnotation(annotation.id, { motif: trimmed });
            }
          }}
        />
        <datalist id={`card-motif-${annotation.id}`}>
          {motifSuggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
        {motifMissingWarning ? (
          <p className="edit-hint edit-hint--warn">故事类标注建议填具体母题（SOP 附录 A）；空值不阻塞但导出会标记。</p>
        ) : null}
      </CardField>
      <div className="card-row">
        <CardField label="边界质量" hint="weak=粗略 / silver=可用 / gold=精确">
          <select
            value={annotation.annotationQuality ?? inferQuality(annotation)}
            onChange={(event) =>
              onUpdateAnnotation(annotation.id, { annotationQuality: event.target.value as IimlAnnotationQualityTier })
            }
          >
            {annotationQualityOptions.map((option) => (
              <option key={option.value} value={option.value} title={option.title}>
                {option.label}
              </option>
            ))}
          </select>
        </CardField>
        <CardField label="训练角色" hint="是否作为训练样本 / 验证集 / 暂存">
          <select
            value={annotation.trainingRole ?? "train"}
            onChange={(event) =>
              onUpdateAnnotation(annotation.id, { trainingRole: event.target.value as IimlTrainingRole })
            }
          >
            {trainingRoleOptions.map((option) => (
              <option key={option.value} value={option.value} title={option.title}>
                {option.label}
              </option>
            ))}
          </select>
        </CardField>
      </div>
    </div>
  );
}

function inferQuality(annotation: IimlAnnotation): IimlAnnotationQualityTier {
  if (annotation.target.type === "BBox" || annotation.target.type === "Point" || annotation.target.type === "LineString") {
    return "weak";
  }
  return "silver";
}

// ---------------------------------------------------------------------------
// B 位置与形态（自动生成）
// ---------------------------------------------------------------------------

function ShapeTab({ annotation, metadata }: { annotation: IimlAnnotation; metadata?: StoneMetadata }) {
  const stats = useMemo(() => {
    const uvs = flattenUVs(annotation.target);
    if (uvs.length === 0) {
      return undefined;
    }
    let minU = 1;
    let minV = 1;
    let maxU = 0;
    let maxV = 0;
    for (const uv of uvs) {
      if (uv.u < minU) minU = uv.u;
      if (uv.v < minV) minV = uv.v;
      if (uv.u > maxU) maxU = uv.u;
      if (uv.v > maxV) maxV = uv.v;
    }
    const center = geometryCenter(annotation.target);
    return { minU, minV, maxU, maxV, center, vertexCount: uvs.length };
  }, [annotation.target]);

  const appearance = annotation.appearance;
  const imageSize = appearance?.imageSizePx ?? annotation.anchor?.imageSizePx;
  const anchorBboxPx = stats && imageSize
    ? {
        x: Math.round(stats.minU * imageSize.width),
        y: Math.round(stats.minV * imageSize.height),
        w: Math.round((stats.maxU - stats.minU) * imageSize.width),
        h: Math.round((stats.maxV - stats.minV) * imageSize.height)
      }
    : undefined;
  const operations = annotation.editOperations ?? [];

  // P4：物理位置。优先后端派生的 anchor.physical；未保存过时按石头实测尺寸
  // 现算（仅正射基准 frame=model 有意义）。
  const canonicalFrame =
    annotation.anchor?.canonicalFrame ?? ((annotation.frame ?? "model") === "model" ? "orthophoto" : "image-local");
  const physical = useMemo(() => {
    if (annotation.anchor?.physical) {
      return annotation.anchor.physical;
    }
    const dims = metadata?.dimensions;
    if (canonicalFrame !== "orthophoto" || !stats || !dims?.width || !dims.height) {
      return undefined;
    }
    return {
      unit: "cm" as const,
      x: Number((stats.minU * dims.width).toFixed(2)),
      y: Number((stats.minV * dims.height).toFixed(2)),
      width: Number(((stats.maxU - stats.minU) * dims.width).toFixed(2)),
      height: Number(((stats.maxV - stats.minV) * dims.height).toFixed(2))
    };
  }, [annotation.anchor?.physical, canonicalFrame, metadata?.dimensions, stats]);

  return (
    <div className="card-tab-grid">
      <div className="card-row">
        <CardField
          label="空间基准"
          hint="orthophoto = 正射基准（modelBox UV / 等价正射图，跨分辨率可复用）；image-local = 本地图像坐标（需 4 点校准后迁移）"
        >
          <code>{canonicalFrame === "orthophoto" ? "orthophoto · 正射基准" : "image-local · 待校准"}</code>
        </CardField>
        <CardField label="坐标系 frame">
          <code>{annotation.frame ?? "model"}</code>
        </CardField>
        <CardField label="资源 resourceId">
          <code className="card-code-wrap">{annotation.resourceId}</code>
        </CardField>
        <CardField label="几何类型">
          <code>
            {annotation.target.type}
            {stats ? ` · ${stats.vertexCount} 顶点` : ""}
          </code>
        </CardField>
      </div>
      {stats ? (
        <div className="card-row">
          <CardField label="bboxUv" hint="归一化外接矩形 [minU, minV, maxU, maxV]">
            <code>
              [{stats.minU.toFixed(4)}, {stats.minV.toFixed(4)}, {stats.maxU.toFixed(4)}, {stats.maxV.toFixed(4)}]
            </code>
          </CardField>
          <CardField label="centroidUv">
            <code>
              [{stats.center.u.toFixed(4)}, {stats.center.v.toFixed(4)}]
            </code>
          </CardField>
        </div>
      ) : null}
      <div className="card-row">
        <CardField label="像素网格" hint="mask 生成时的底图栅格尺寸">
          <code>{imageSize ? `${imageSize.width} × ${imageSize.height} px` : "—（尚未生成 mask）"}</code>
        </CardField>
        <CardField label="面积">
          <code>{appearance?.areaPx ? `${appearance.areaPx.toLocaleString()} px²` : "—"}</code>
        </CardField>
        <CardField label="bboxPx">
          <code>{anchorBboxPx ? `x${anchorBboxPx.x} y${anchorBboxPx.y} · ${anchorBboxPx.w}×${anchorBboxPx.h}` : "—"}</code>
        </CardField>
      </div>
      <div className="card-row">
        <CardField label="物理位置" hint="以石头结构化档案实测尺寸换算（原点 = 正射图左上角）">
          <code>
            {physical
              ? `x ${physical.x} cm · y ${physical.y} cm`
              : canonicalFrame === "orthophoto"
                ? "—（档案缺实测尺寸）"
                : "—（本地图像坐标，先做 4 点校准）"}
          </code>
        </CardField>
        <CardField label="物理大小">
          <code>{physical ? `${physical.width} × ${physical.height} cm` : "—"}</code>
        </CardField>
        <CardField label="像素密度" hint="像素-厘米比例；跨分辨率正射图复用标注的换算凭证">
          <code>
            {annotation.anchor?.physical?.pxPerCmX
              ? `${annotation.anchor.physical.pxPerCmX} px/cm`
              : "—"}
          </code>
        </CardField>
      </div>
      <CardField label="外观资产" hint="mask 与底图整图对齐；cutout 是透明背景抠图，可直接用于图录 / 对比研究">
        {appearance?.cutoutUri || appearance?.maskUri ? (
          <div className="card-asset-row">
            {appearance.cutoutUri ? (
              <a href={appearance.cutoutUri} target="_blank" rel="noreferrer" className="card-asset" title="打开 cutout 原图">
                <img src={appearance.thumbnailUri ?? appearance.cutoutUri} alt="cutout" />
                <span>cutout</span>
              </a>
            ) : null}
            {appearance.maskUri ? (
              <a href={appearance.maskUri} target="_blank" rel="noreferrer" className="card-asset" title="打开 mask 原图">
                <img src={appearance.maskUri} alt="mask" />
                <span>mask</span>
              </a>
            ) : null}
          </div>
        ) : (
          <p className="muted-text">
            尚未生成。在高清图底图上选中此标注，用工具栏"补笔 / 擦除"做一次 mask 修正即可自动生成 mask + cutout。
          </p>
        )}
      </CardField>
      <CardField label="编辑历史" hint="mask 级编辑操作记录（学术溯源）">
        {operations.length === 0 ? (
          <p className="muted-text">暂无 mask 级编辑记录。</p>
        ) : (
          <ul className="card-oplist">
            {operations.map((operation, index) => (
              <li key={`${operation.type}-${index}`}>
                <code>{operation.type}</code>
                {operation.strokeCount !== undefined ? ` · ${operation.strokeCount} 笔` : ""}
                {operation.strokeWidthPx !== undefined ? ` · 笔宽 ${operation.strokeWidthPx}px` : ""}
                {operation.at ? <span className="muted-text"> · {new Date(operation.at).toLocaleString("zh-CN")}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </CardField>
    </div>
  );
}

// ---------------------------------------------------------------------------
// C 视觉层
// ---------------------------------------------------------------------------

function VisualTab({
  annotation,
  onUpdateAnnotation
}: {
  annotation: IimlAnnotation;
  onUpdateAnnotation: (id: string, patch: Partial<IimlAnnotation>) => void;
}) {
  const [preIconographicDraft, setPreIconographicDraft] = useState(annotation.semantics?.preIconographic ?? "");
  const [notesDraft, setNotesDraft] = useState(annotation.notes ?? "");
  useEffect(() => {
    setPreIconographicDraft(annotation.semantics?.preIconographic ?? "");
    setNotesDraft(annotation.notes ?? "");
  }, [annotation.id, annotation.semantics?.preIconographic, annotation.notes]);

  const toggleIssue = (issue: IimlAnnotationIssue) => {
    const current = new Set(annotation.annotationIssues ?? []);
    if (current.has(issue)) {
      current.delete(issue);
    } else {
      current.add(issue);
    }
    onUpdateAnnotation(annotation.id, { annotationIssues: Array.from(current) });
  };

  return (
    <div className="card-tab-grid">
      <CardField label="前图像志（可见特征）" hint="纯描述看得见的对象：线条类型、姿态方向、构图位置、保存状况…">
        <textarea
          rows={4}
          value={preIconographicDraft}
          placeholder="例如：阴线刻画的左向立姿人物，位于中栏，双手持笏，衣纹清晰，头部轻微磨损…"
          onChange={(event) => setPreIconographicDraft(event.target.value)}
          onBlur={() => {
            if (preIconographicDraft !== (annotation.semantics?.preIconographic ?? "")) {
              onUpdateAnnotation(annotation.id, {
                semantics: { ...(annotation.semantics ?? {}), preIconographic: preIconographicDraft }
              });
            }
          }}
        />
        <p className="edit-hint">建议覆盖：线条类型（阴线/阳线/浅浮雕/深刻）、姿态方向、构图位置（上/中/下栏）、保存状况。</p>
      </CardField>
      <CardField label="几何语义" hint="区分可见刻痕、语义对象范围与专家复原范围">
        <select
          value={annotation.geometryIntent ?? "semantic_extent"}
          onChange={(event) =>
            onUpdateAnnotation(annotation.id, { geometryIntent: event.target.value as IimlGeometryIntent })
          }
        >
          {geometryIntentOptions.map((option) => (
            <option key={option.value} value={option.value} title={option.title}>
              {option.label}
            </option>
          ))}
        </select>
      </CardField>
      <CardField label="问题标签" hint="记录 SAM3 失败原因，并进入主动学习队列排序">
        <div className="issue-chip-list">
          {annotationIssueOptions.map((option) => {
            const checked = (annotation.annotationIssues ?? []).includes(option.value);
            return (
              <label key={option.value} className={checked ? "issue-chip is-on" : "issue-chip"}>
                <input type="checkbox" checked={checked} onChange={() => toggleIssue(option.value)} />
                {option.label}
              </label>
            );
          })}
        </div>
      </CardField>
      <CardField label="形态备注">
        <textarea
          rows={3}
          value={notesDraft}
          placeholder="研究思路、参考、待查…"
          onChange={(event) => setNotesDraft(event.target.value)}
          onBlur={() => {
            if (notesDraft !== (annotation.notes ?? "")) {
              onUpdateAnnotation(annotation.id, { notes: notesDraft });
            }
          }}
        />
      </CardField>
    </div>
  );
}

// ---------------------------------------------------------------------------
// D 图像志 / 形象学层
// ---------------------------------------------------------------------------

function IconographyTab({
  annotation,
  metadata,
  vocabularyCategories,
  vocabularyTerms,
  suggestedTerms,
  onUpdateAnnotation
}: {
  annotation: IimlAnnotation;
  metadata?: StoneMetadata;
  vocabularyCategories: VocabularyCategory[];
  vocabularyTerms: VocabularyTerm[];
  suggestedTerms: VocabularyTerm[];
  onUpdateAnnotation: (id: string, patch: Partial<IimlAnnotation>) => void;
}) {
  const [iconographicDraft, setIconographicDraft] = useState(annotation.semantics?.iconographicMeaning ?? "");
  const [iconologicalDraft, setIconologicalDraft] = useState(annotation.semantics?.iconologicalMeaning ?? "");
  const [transcriptionDraft, setTranscriptionDraft] = useState(annotation.semantics?.inscription?.transcription ?? "");
  const [translationDraft, setTranslationDraft] = useState(annotation.semantics?.inscription?.translation ?? "");
  const [readingNoteDraft, setReadingNoteDraft] = useState(annotation.semantics?.inscription?.readingNote ?? "");
  useEffect(() => {
    setIconographicDraft(annotation.semantics?.iconographicMeaning ?? "");
    setIconologicalDraft(annotation.semantics?.iconologicalMeaning ?? "");
    setTranscriptionDraft(annotation.semantics?.inscription?.transcription ?? "");
    setTranslationDraft(annotation.semantics?.inscription?.translation ?? "");
    setReadingNoteDraft(annotation.semantics?.inscription?.readingNote ?? "");
  }, [annotation.id, annotation.semantics]);

  const showInscription = (annotation.structuralLevel ?? "unknown") === "inscription";

  const patchSemantics = (key: "iconographicMeaning" | "iconologicalMeaning", nextValue: string, previous: string) => {
    if (nextValue === previous) return;
    onUpdateAnnotation(annotation.id, {
      semantics: { ...(annotation.semantics ?? {}), [key]: nextValue }
    });
  };

  const patchInscription = (key: "transcription" | "translation" | "readingNote", nextValue: string, previous: string) => {
    if (nextValue === previous) return;
    const inscription = { ...(annotation.semantics?.inscription ?? {}) };
    inscription[key] = nextValue;
    onUpdateAnnotation(annotation.id, {
      semantics: { ...(annotation.semantics ?? {}), inscription }
    });
  };

  return (
    <div className="card-tab-grid">
      <CardField label="图像志（主题识别）" hint="这是什么母题：车马 / 侍从 / 神兽 / 西王母 / 门阙 / 云气纹…">
        <textarea
          rows={3}
          value={iconographicDraft}
          placeholder="例如：青龙，四象之一，见于东壁上栏…"
          onChange={(event) => setIconographicDraft(event.target.value)}
          onBlur={() => patchSemantics("iconographicMeaning", iconographicDraft, annotation.semantics?.iconographicMeaning ?? "")}
        />
      </CardField>
      <CardField label="图像学（文化解释）" hint="宗教意义 / 社会功能 / 墓葬语境 / 象征系统 / 比较研究">
        <textarea
          rows={3}
          value={iconologicalDraft}
          placeholder="例如：象征东方与春，与升仙语境相关…"
          onChange={(event) => setIconologicalDraft(event.target.value)}
          onBlur={() => patchSemantics("iconologicalMeaning", iconologicalDraft, annotation.semantics?.iconologicalMeaning ?? "")}
        />
      </CardField>
      <CardField label="受控术语" hint="从 data/terms.json 检索多选；系统会基于术语共现推荐">
        <TermPicker
          value={annotation.semantics?.terms}
          categories={vocabularyCategories}
          terms={vocabularyTerms}
          suggestedTerms={suggestedTerms}
          onChange={(nextTerms: IimlTermRef[]) =>
            onUpdateAnnotation(annotation.id, {
              semantics: { ...(annotation.semantics ?? {}), terms: nextTerms }
            })
          }
        />
      </CardField>
      <CardField label="证据源" hint="档案 / 文献 / 资源 / 其它——让每条判断可追溯">
        <SourcesEditor
          value={annotation.sources}
          metadata={metadata}
          onChange={(nextSources: IimlSource[]) => onUpdateAnnotation(annotation.id, { sources: nextSources })}
        />
      </CardField>
      {showInscription ? (
        <>
          <CardField label="题刻释文">
            <textarea
              rows={2}
              value={transcriptionDraft}
              placeholder="原文释读…"
              onChange={(event) => setTranscriptionDraft(event.target.value)}
              onBlur={() => patchInscription("transcription", transcriptionDraft, annotation.semantics?.inscription?.transcription ?? "")}
            />
          </CardField>
          <div className="card-row">
            <CardField label="题刻翻译">
              <textarea
                rows={2}
                value={translationDraft}
                placeholder="今译 / 外文翻译…"
                onChange={(event) => setTranslationDraft(event.target.value)}
                onBlur={() => patchInscription("translation", translationDraft, annotation.semantics?.inscription?.translation ?? "")}
              />
            </CardField>
            <CardField label="释读注">
              <textarea
                rows={2}
                value={readingNoteDraft}
                placeholder="释读难点、异体字、残损…"
                onChange={(event) => setReadingNoteDraft(event.target.value)}
                onBlur={() => patchInscription("readingNote", readingNoteDraft, annotation.semantics?.inscription?.readingNote ?? "")}
              />
            </CardField>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// E 关系网络与文化解释
// ---------------------------------------------------------------------------

function NetworkTab({
  annotation,
  doc,
  relations,
  spatialCandidates,
  processingRuns,
  onAddRelation,
  onUpdateRelation,
  onDeleteRelation,
  onSelectAnnotation
}: {
  annotation: IimlAnnotation;
  doc?: IimlDocument;
  relations: import("./types").IimlRelation[];
  spatialCandidates?: import("./RelationsEditor").SpatialRelationCandidate[];
  processingRuns: import("./types").IimlProcessingRun[];
  onAddRelation: (relation: import("./types").IimlRelation) => void;
  onUpdateRelation: (id: string, patch: Partial<import("./types").IimlRelation>) => void;
  onDeleteRelation: (id: string) => void;
  onSelectAnnotation: (id?: string) => void;
}) {
  return (
    <div className="card-tab-grid">
      <AlternativeInterpretationsView
        annotation={annotation}
        annotations={doc?.annotations ?? []}
        relations={relations}
        onSelectAnnotation={onSelectAnnotation}
      />
      <RelationsEditor
        annotation={annotation}
        annotations={doc?.annotations ?? []}
        relations={relations}
        spatialCandidates={spatialCandidates}
        onAddRelation={onAddRelation}
        onUpdateRelation={onUpdateRelation}
        onDeleteRelation={onDeleteRelation}
        onSelectAnnotation={onSelectAnnotation}
      />
      <ProcessingRunsList annotation={annotation} runs={processingRuns} onSelectAnnotation={onSelectAnnotation} />
    </div>
  );
}
