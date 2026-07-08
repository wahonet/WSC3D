/**
 * 标注侧栏面板 `AnnotationPanel`（P3 重构为"摘要栏 + 标注卡片"）
 *
 * 右侧窄栏不再承担全部 IIML 字段——普通标注 10 秒内可保存，完整的形象学解释
 * 在宽标注卡片（`AnnotationCard`）里慢慢补。窄栏 tab：
 * - **标注（摘要）**：选中标注的最小集合——名称 / 类别 / 审核状态 / 训练徽章 /
 *   小预览图 + "打开详情卡片"入口
 * - **候选**：SAM3 产生的待审标注集中区，按类别 chip 过滤、批量接受 / 拒绝、
 *   mask 级合并
 * - **列表**：全部标注，带颜色 / 可见性 / 锁定 / 删除；底部训练池导出 + 下载
 * - **图谱**：cytoscape 知识图谱
 * - **资源**：IIML resources[] + 一键生成正射图
 *
 * 设计要点：
 * - 摘要 tab 的"确定 / 取消"仅对草稿生效；非草稿改动靠 reducer 的 autosave 写盘
 * - 宽卡片是模态浮层（AnnotationCard），5 页签分层承载 IIML 解释字段
 * - 合并按钮走 App 层的 mask 级合并（AI 服务不可用时回退矢量并集）
 */

import { Check, Download, Eye, EyeOff, FolderOpen, Group, Layers, Lock, Maximize2, Network, Package, RotateCcw, Save, Trash2, Unlock, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  IimlAnnotation,
  IimlAnnotationQualityTier,
  IimlHanStoneCategory,
  IimlReviewStatus,
  IimlTrainingRole,
  StoneListItem,
  StoneMetadata,
  VocabularyCategory,
  VocabularyTerm
} from "../../api/client";
import { AnnotationCard } from "./AnnotationCard";
import { KnowledgeGraphView } from "./KnowledgeGraphView";
import { ResourcesEditor } from "./ResourcesEditor";
import { annotationPalette } from "./store";
import { hanStoneCategoryOptions } from "./categories";
import { validateAnnotationForTraining } from "./training";
import { TrainingBadge } from "./training-ui";
import { recommendCooccurringTerms } from "./cooccurrence";

type AnnotationPanelProps = {
  doc?: import("./types").IimlDocument;
  selectedAnnotation?: IimlAnnotation;
  draftAnnotationId?: string;
  saveState?: {
    phase: "idle" | "dirty" | "saving" | "saved" | "error";
    savedAt?: string;
    error?: string;
  };
  statusMessage?: string;
  trainingDatasetLocation?: {
    datasetDir: string;
    absolutePath?: string;
    reportFileName?: string;
  };
  metadata?: StoneMetadata;
  vocabularyCategories: VocabularyCategory[];
  vocabularyTerms: VocabularyTerm[];
  onSelectAnnotation: (id?: string) => void;
  onUpdateAnnotation: (id: string, patch: Partial<IimlAnnotation>) => void;
  onDeleteAnnotation: (id: string) => void;
  onConfirmDraft: (id: string) => void;
  onExportIiml: () => void;
  onExportCsv: () => void;
  // SAM3 候选审核相关：单条 / 批量操作，都由 App 层实现
  onAcceptCandidate: (id: string) => void;
  onRejectCandidate: (id: string) => void;
  onRetryCandidate: (id: string) => void;
  onBulkAcceptCandidates: () => void;
  onBulkRejectCandidates: () => void;
  // D7 / D8 学术导出
  onExportCoco?: () => void;
  onExportIiif?: () => void;
  // G2 .hpsml 自定义研究包导出（IIML + 拼接方案 + 词表 + 关系网络快照）
  onExportHpsml?: () => void;
  // M5 Phase 1 A2 主动学习闭环：训练池导出
  onExportTraining?: () => void;
  onRevealTrainingDataset?: () => void;
  // D 阶段：上线前预检（pic 配对 / IIML 完整度 / 训练池估算 / 类别均衡）
  onPreflight?: () => void;
  // I3 v0.8.0：.hpsml 研究包解包 / 导入
  onImportHpsml?: () => void;
  onManualSave?: () => void;
  // G1 多资源版本管理：增 / 删 / 改 doc.resources
  onAddResource?: (resource: import("./types").IimlResourceEntry) => void;
  onUpdateResource?: (id: string, patch: Partial<import("./types").IimlResourceEntry>) => void;
  onDeleteResource?: (id: string) => void;
  // 资源 tab 需要用 stone 来取 modelUrl（正射渲染）和 stoneId（上传端点）
  stone?: StoneListItem;
  onStatusMessage?: (status: string) => void;
  // P2：mask 级合并（App 层实现，AI 不可用时回退矢量并集）
  onMergeCandidates: (ids: string[]) => void;
  relations: import("./types").IimlRelation[];
  spatialCandidates?: import("./RelationsEditor").SpatialRelationCandidate[];
  onAddRelation: (relation: import("./types").IimlRelation) => void;
  onUpdateRelation: (id: string, patch: Partial<import("./types").IimlRelation>) => void;
  onDeleteRelation: (id: string) => void;
  processingRuns?: import("./types").IimlProcessingRun[];
};

// 摘要栏用的紧凑选项（宽卡片里有带说明的完整版）。
const reviewStatusOptions: Array<{ value: IimlReviewStatus; label: string }> = [
  { value: "candidate", label: "候选" },
  { value: "reviewed", label: "已审核" },
  { value: "approved", label: "已通过" },
  { value: "rejected", label: "已拒绝" }
];

const annotationQualityOptions: Array<{ value: IimlAnnotationQualityTier; label: string }> = [
  { value: "weak", label: "weak · 粗略" },
  { value: "silver", label: "silver · 可用" },
  { value: "gold", label: "gold · 精确" }
];

const trainingRoleOptions: Array<{ value: IimlTrainingRole; label: string; title: string }> = [
  { value: "train", label: "训练", title: "常规训练候选" },
  { value: "validation", label: "验证/评估", title: "gold 子集，优先留作验证或论文评估" },
  { value: "holdout", label: "暂存", title: "保留在 IIML 中，但导出报告会单独标记" }
];

type TabKey = "edit" | "review" | "list" | "graph" | "resources";

export function AnnotationPanel(props: AnnotationPanelProps) {
  const { selectedAnnotation, doc, draftAnnotationId, onSelectAnnotation, relations } = props;
  const annotations = doc?.annotations ?? [];
  const candidateCount = useMemo(
    () => annotations.filter((annotation) => annotation.reviewStatus === "candidate").length,
    [annotations]
  );
  const [tab, setTab] = useState<TabKey>("edit");
  // P3：宽标注卡片开关。选中标注消失（删除 / 切石头）时自动关闭。
  const [cardOpen, setCardOpen] = useState(false);
  useEffect(() => {
    if (!selectedAnnotation) {
      setCardOpen(false);
    }
  }, [selectedAnnotation]);

  // D6 共现术语推荐：基于全文档统计 + 当前 annotation 已有 terms（传给宽卡片）。
  const suggestedTerms = useMemo(() => {
    if (!selectedAnnotation || props.vocabularyTerms.length === 0) return [];
    const currentTermIds = selectedAnnotation.semantics?.terms?.map((term) => term.id) ?? [];
    return recommendCooccurringTerms(doc?.annotations ?? [], currentTermIds, props.vocabularyTerms);
  }, [selectedAnnotation, doc?.annotations, props.vocabularyTerms]);

  // 新建草稿时自动切到"标注"tab；选中已有标注不强制跳转。
  useEffect(() => {
    if (draftAnnotationId) {
      setTab("edit");
    }
  }, [draftAnnotationId]);

  // 候选清空后若仍停留在候选 tab，自动退回列表 tab。
  useEffect(() => {
    if (tab === "review" && candidateCount === 0) {
      setTab("list");
    }
  }, [candidateCount, tab]);

  const handlePickCandidate = (id: string) => {
    onSelectAnnotation(id);
    setTab("edit");
  };

  return (
    <div className="annotation-panel-root">
      <nav className="annotation-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "edit"}
          className={tab === "edit" ? "annotation-tab-btn is-active" : "annotation-tab-btn"}
          onClick={() => setTab("edit")}
        >
          标注
        </button>
        {candidateCount > 0 ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === "review"}
            className={tab === "review" ? "annotation-tab-btn is-active" : "annotation-tab-btn"}
            onClick={() => setTab("review")}
          >
            <Wand2 size={13} />
            候选
            <span className="annotation-tab-count annotation-tab-count--accent">{candidateCount}</span>
          </button>
        ) : null}
        <button
          type="button"
          role="tab"
          aria-selected={tab === "list"}
          className={tab === "list" ? "annotation-tab-btn is-active" : "annotation-tab-btn"}
          onClick={() => setTab("list")}
        >
          列表
          {annotations.length > 0 ? <span className="annotation-tab-count">{annotations.length}</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "resources"}
          className={tab === "resources" ? "annotation-tab-btn is-active" : "annotation-tab-btn"}
          onClick={() => setTab("resources")}
          title="资源版本：原图 / 拓片 / 法线图 / RTI / 点云 / 从三维模型生成的正射图"
        >
          <Layers size={13} />
          资源
          {(doc?.resources?.length ?? 0) > 0 ? (
            <span className="annotation-tab-count">{doc?.resources?.length ?? 0}</span>
          ) : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "graph"}
          className={tab === "graph" ? "annotation-tab-btn is-active" : "annotation-tab-btn"}
          onClick={() => setTab("graph")}
          title="知识图谱：标注与关系的节点-边视图"
        >
          <Network size={13} />
          图谱
          {relations.length > 0 ? <span className="annotation-tab-count">{relations.length}</span> : null}
        </button>
      </nav>

      {props.saveState ? (
        <AnnotationSaveBar
          saveState={props.saveState}
          statusMessage={props.statusMessage}
          trainingDatasetLocation={props.trainingDatasetLocation}
          onManualSave={props.onManualSave}
          onRevealTrainingDataset={props.onRevealTrainingDataset}
        />
      ) : props.statusMessage ? (
        <div className="annotation-save-bar annotation-save-bar--idle" role="status" aria-live="polite" title={props.statusMessage}>
          <span className="annotation-save-dot" aria-hidden />
          <span className="annotation-save-copy">
            <span className="annotation-status-inline">{props.statusMessage}</span>
          </span>
        </div>
      ) : null}

      <div className="annotation-tab-body" role="tabpanel">
        {tab === "edit" ? (
          <SummaryTab {...props} annotation={selectedAnnotation} onOpenCard={() => setCardOpen(true)} />
        ) : tab === "review" ? (
          <ReviewTab {...props} onPickCandidate={handlePickCandidate} />
        ) : tab === "graph" ? (
          <KnowledgeGraphView
            doc={doc}
            relations={relations}
            selectedAnnotationId={selectedAnnotation?.id}
            onSelectAnnotation={onSelectAnnotation}
          />
        ) : tab === "resources" ? (
          props.onAddResource && props.onUpdateResource && props.onDeleteResource ? (
            <ResourcesEditor
              doc={doc}
              stone={props.stone}
              onAddResource={props.onAddResource}
              onUpdateResource={props.onUpdateResource}
              onDeleteResource={props.onDeleteResource}
              onStatusMessage={props.onStatusMessage}
            />
          ) : (
            <p className="annotation-empty">资源管理未启用。</p>
          )
        ) : (
          <ListTab {...props} />
        )}
      </div>

      {cardOpen && selectedAnnotation ? (
        <AnnotationCard
          annotation={selectedAnnotation}
          doc={doc}
          metadata={props.metadata}
          vocabularyCategories={props.vocabularyCategories}
          vocabularyTerms={props.vocabularyTerms}
          relations={relations}
          spatialCandidates={props.spatialCandidates}
          processingRuns={props.processingRuns}
          suggestedTerms={suggestedTerms}
          onUpdateAnnotation={props.onUpdateAnnotation}
          onDeleteAnnotation={props.onDeleteAnnotation}
          onSelectAnnotation={onSelectAnnotation}
          onAddRelation={props.onAddRelation}
          onUpdateRelation={props.onUpdateRelation}
          onDeleteRelation={props.onDeleteRelation}
          onClose={() => setCardOpen(false)}
        />
      ) : null}
    </div>
  );
}

// ============================================================
//  SummaryTab：右侧窄栏只保留最小字段（P3）
// ============================================================

type SummaryTabProps = AnnotationPanelProps & {
  annotation?: IimlAnnotation;
  onOpenCard: () => void;
};

function SummaryTab({
  annotation,
  doc,
  draftAnnotationId,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onConfirmDraft,
  onOpenCard
}: SummaryTabProps) {
  const [labelDraft, setLabelDraft] = useState("");
  useEffect(() => {
    setLabelDraft(annotation?.label ?? "");
  }, [annotation?.id, annotation?.label]);

  const trainingResult = useMemo(
    () => (annotation ? validateAnnotationForTraining(annotation, doc) : undefined),
    [annotation, doc]
  );

  if (!annotation) {
    return (
      <div className="annotation-summary-empty">
        <p className="annotation-empty">选择或新建一条标注。</p>
        <p className="muted-text annotation-summary-hint">
          工作流：SAM3 生成候选 → 在候选 tab 审阅 → 选中后这里填名称与类别（10 秒即可保存）→
          需要深入解释时打开"详情卡片"分层补充。
        </p>
      </div>
    );
  }

  const isDraft = annotation.id === draftAnnotationId;
  const confidence = annotation.generation?.confidence;
  const thumbnail = annotation.appearance?.thumbnailUri ?? annotation.appearance?.cutoutUri;

  const commitLabel = () => {
    if (labelDraft !== (annotation.label ?? "")) {
      onUpdateAnnotation(annotation.id, { label: labelDraft });
    }
  };

  return (
    <div className="annotation-summary">
      <div className="annotation-summary-head">
        <span
          className="annotation-color-dot annotation-color-dot--static"
          style={{ background: annotation.color ?? annotationPalette[0] }}
          aria-hidden
        />
        <TrainingBadge result={trainingResult} />
        {isDraft ? <span className="edit-draft-tag">草稿</span> : null}
        {typeof confidence === "number" ? (
          <span className="review-card-confidence" title={`模型：${annotation.generation?.model ?? "?"}`}>
            {Math.round(confidence * 100)}%
          </span>
        ) : null}
        <span className="annotation-summary-type muted-text">{annotation.target.type}</span>
      </div>

      {thumbnail ? (
        <button type="button" className="annotation-summary-thumb" onClick={onOpenCard} title="打开详情卡片查看资产">
          <img src={thumbnail} alt="标注抠图预览" />
        </button>
      ) : null}

      <label className="summary-field">
        <span>名称</span>
        <input
          autoFocus={isDraft}
          type="text"
          value={labelDraft}
          placeholder="例如：执笏人物"
          onChange={(event) => setLabelDraft(event.target.value)}
          onBlur={commitLabel}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              (event.target as HTMLInputElement).blur();
            }
          }}
        />
      </label>

      <label className="summary-field">
        <span>类别</span>
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
      </label>

      <div className="summary-field-row">
        <label className="summary-field">
          <span>审核</span>
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
        </label>
        <label className="summary-field">
          <span>边界质量</span>
          <select
            value={annotation.annotationQuality ?? getAnnotationQuality(annotation)}
            onChange={(event) =>
              onUpdateAnnotation(annotation.id, { annotationQuality: event.target.value as IimlAnnotationQualityTier })
            }
          >
            {annotationQualityOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="summary-field">
          <span>训练</span>
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
        </label>
      </div>

      <button type="button" className="primary-action annotation-summary-open" onClick={onOpenCard}>
        <Maximize2 size={14} /> 打开详情卡片
        <span className="muted-text">位置 / 视觉层 / 图像志 / 关系</span>
      </button>

      <div className="edit-actions">
        {isDraft ? (
          <>
            <button
              type="button"
              className="primary-action small"
              onClick={() => {
                commitLabel();
                onConfirmDraft(annotation.id);
              }}
              title="确认草稿为正式标注"
            >
              <Check size={14} /> 确定
            </button>
            <button
              type="button"
              className="secondary-action"
              onClick={() => onDeleteAnnotation(annotation.id)}
              title="放弃此次标注"
            >
              <X size={14} /> 取消
            </button>
          </>
        ) : (
          <button type="button" className="secondary-action danger" onClick={() => onDeleteAnnotation(annotation.id)}>
            <Trash2 size={14} /> 删除
          </button>
        )}
      </div>
    </div>
  );
}

function AnnotationSaveBar({
  saveState,
  statusMessage,
  trainingDatasetLocation,
  onRevealTrainingDataset,
  onManualSave
}: {
  saveState: NonNullable<AnnotationPanelProps["saveState"]>;
  statusMessage?: string;
  trainingDatasetLocation?: AnnotationPanelProps["trainingDatasetLocation"];
  onRevealTrainingDataset?: () => void;
  onManualSave?: () => void;
}) {
  const label =
    saveState.phase === "dirty"
      ? "有未保存改动"
      : saveState.phase === "saving"
        ? "保存中..."
        : saveState.phase === "saved"
          ? `已保存${saveState.savedAt ? ` ${formatSaveTime(saveState.savedAt)}` : ""}`
          : saveState.phase === "error"
            ? "保存失败"
            : "等待标注";
  const detail = saveState.phase === "error" ? saveState.error : undefined;
  const datasetPath = trainingDatasetLocation?.absolutePath ?? trainingDatasetLocation?.datasetDir;
  const title = [detail || label, statusMessage, datasetPath ? `训练集目录：${datasetPath}` : ""].filter(Boolean).join(" · ");
  return (
    <div className={`annotation-save-bar annotation-save-bar--${saveState.phase}`} role="status" aria-live="polite" title={title}>
      <span className="annotation-save-dot" aria-hidden />
      <span className="annotation-save-copy">
        <span className="annotation-save-text">{label}</span>
        {statusMessage ? <span className="annotation-status-inline">{statusMessage}</span> : null}
      </span>
      <span className="annotation-save-actions">
        {trainingDatasetLocation ? (
          <button
            type="button"
            className="secondary-action small annotation-dataset-button"
            onClick={onRevealTrainingDataset}
            disabled={!onRevealTrainingDataset}
            title={`打开训练集目录：${datasetPath ?? trainingDatasetLocation.datasetDir}`}
          >
            <FolderOpen size={13} /> 目录
          </button>
        ) : null}
        <button
          type="button"
          className="mini-icon annotation-save-button"
          onClick={onManualSave}
          disabled={!onManualSave || saveState.phase === "saving"}
          title="立即保存当前画像石的 IIML 标注文档"
          aria-label="立即保存"
        >
          <Save size={14} />
        </button>
      </span>
    </div>
  );
}

function formatSaveTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function ListTab({
  doc,
  selectedAnnotation,
  onSelectAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onMergeCandidates,
  onExportIiml,
  onExportCsv,
  onExportCoco,
  onExportIiif,
  onExportHpsml,
  onExportTraining,
  onPreflight,
  onImportHpsml
}: AnnotationPanelProps) {
  const annotations = doc?.annotations ?? [];

  // M5 Phase 1 A2 子任务：训练池徽标。每条 annotation 实时算 ready/warned/blocked 状态。
  const trainingResultsById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof validateAnnotationForTraining>>();
    if (!doc) return map;
    for (const annotation of annotations) {
      map.set(annotation.id, validateAnnotationForTraining(annotation, doc));
    }
    return map;
  }, [doc, annotations]);

  // 训练池整体进度：进 / 警告 / 阻塞 三档计数
  const trainingStats = useMemo(() => {
    let ready = 0;
    let warned = 0;
    let blocked = 0;
    for (const result of trainingResultsById.values()) {
      if (!result.ready) blocked += 1;
      else if (result.warnings.length > 0) warned += 1;
      else ready += 1;
    }
    return { ready, warned, blocked };
  }, [trainingResultsById]);

  // 多选合并：合并对象不限于 candidate；已 approved 的标注合并后保持 approved。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      const known = new Set(annotations.map((annotation) => annotation.id));
      for (const id of prev) {
        if (known.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [annotations]);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleMerge = () => {
    if (selectedIds.size < 2) {
      return;
    }
    onMergeCandidates(Array.from(selectedIds));
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  // P1 批量修复：给所有选中标注统一设字段。
  const applyBatch = (patch: Partial<IimlAnnotation>) => {
    for (const id of selectedIds) {
      onUpdateAnnotation(id, patch);
    }
  };

  const selectedCount = selectedIds.size;
  const canMerge = selectedCount >= 2;

  return (
    <div className="annotation-list-tab">
      {selectedCount > 0 ? (
        <div className="review-merge-bar">
          <span className="review-merge-info">
            已选 <strong>{selectedCount}</strong> 个标注
            {canMerge ? null : (
              <span className="muted-text"> · 至少 2 个才能合并</span>
            )}
          </span>
          <div className="review-merge-actions">
            <button type="button" className="secondary-action small" onClick={handleClearSelection}>
              清空选择
            </button>
            <button
              type="button"
              className="primary-action small"
              disabled={!canMerge}
              onClick={handleMerge}
              title="mask 级合并：栅格化 → 布尔并 → 清小碎片/保留洞 → 重新矢量化（AI 服务不可用时回退矢量并集）"
            >
              <Group size={13} /> 合并选中（{selectedCount}）
            </button>
          </div>
        </div>
      ) : null}
      {selectedCount > 0 ? (
        <div className="list-batch-fix" title="给所有选中标注批量设字段（每条进 undo 栈）">
          <span className="list-batch-fix-label">批量设：</span>
          <select
            aria-label="批量设审核状态"
            defaultValue=""
            onChange={(event) => {
              const value = event.target.value as IimlAnnotation["reviewStatus"];
              if (value) applyBatch({ reviewStatus: value });
              event.target.value = "";
            }}
          >
            <option value="">审核状态…</option>
            <option value="reviewed">已审核 reviewed</option>
            <option value="approved">已通过 approved</option>
            <option value="candidate">候选 candidate</option>
            <option value="rejected">已拒绝 rejected</option>
          </select>
          <select
            aria-label="批量设类别"
            defaultValue=""
            onChange={(event) => {
              const value = event.target.value as IimlHanStoneCategory;
              if (value) applyBatch({ category: value });
              event.target.value = "";
            }}
          >
            <option value="">类别…</option>
            {hanStoneCategoryOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            aria-label="批量设质量"
            defaultValue=""
            onChange={(event) => {
              const value = event.target.value as IimlAnnotationQualityTier;
              if (value) applyBatch({ annotationQuality: value });
              event.target.value = "";
            }}
          >
            <option value="">质量…</option>
            {annotationQualityOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            aria-label="批量设训练角色"
            defaultValue=""
            onChange={(event) => {
              const value = event.target.value as IimlTrainingRole;
              if (value) applyBatch({ trainingRole: value });
              event.target.value = "";
            }}
          >
            <option value="">训练角色…</option>
            {trainingRoleOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {annotations.length === 0 ? (
        <p className="annotation-empty">暂无标注。在画布上创建矩形、圆、点或多边形。</p>
      ) : (
        <ul className="annotation-list">
          {annotations.map((annotation, index) => (
            <AnnotationRow
              annotation={annotation}
              fallbackColor={annotationPalette[index % annotationPalette.length]}
              isSelected={annotation.id === selectedAnnotation?.id}
              isChecked={selectedIds.has(annotation.id)}
              trainingResult={trainingResultsById.get(annotation.id)}
              key={annotation.id}
              onDelete={() => onDeleteAnnotation(annotation.id)}
              onSelect={() => onSelectAnnotation(annotation.id)}
              onToggleChecked={() => toggleSelected(annotation.id)}
              onToggleLocked={() => onUpdateAnnotation(annotation.id, { locked: !(annotation.locked === true) })}
              onToggleVisible={() => onUpdateAnnotation(annotation.id, { visible: annotation.visible === false })}
            />
          ))}
        </ul>
      )}

      {onExportTraining ? (
        <div
          className="training-export-bar"
          title="A2 主动学习闭环：扫所有 IIML → SOP §11 准入校验 → 70/15/15 划分 → 写 data/datasets/wsc-han-stone-v0/"
        >
          <div className="training-export-info">
            <span className="training-export-label">训练池（本石头）</span>
            <span className="training-stat training-stat--ready" title="本石头进训练池（无错无警）">
              <Check size={12} /> {trainingStats.ready}
            </span>
            <span className="training-stat training-stat--warn" title="本石头进训练池但有 warning（如故事类缺 motif）">
              ⚠ {trainingStats.warned}
            </span>
            <span className="training-stat training-stat--blocked" title="本石头不进训练池（缺字段 / 几何无效 / 未审核等）">
              ✗ {trainingStats.blocked}
            </span>
          </div>
          <div className="training-export-actions">
            {onPreflight ? (
              <button
                type="button"
                className="secondary-action small"
                onClick={onPreflight}
                title="批量标注前预检：pic/ 配对 / IIML 缺字段 / 训练池估算 / 类别均衡。结果写入 status，详细 JSON 在浏览器 Console。"
              >
                预检
              </button>
            ) : null}
            <button
              type="button"
              className="primary-action small"
              onClick={onExportTraining}
              title="跨所有石头导出 COCO + IIML 双轨训练集到 data/datasets/wsc-han-stone-v0/"
            >
              <Package size={14} /> 导出训练集
            </button>
          </div>
        </div>
      ) : null}

      <div className="annotation-downloads">
        <span className="annotation-downloads-label">下载</span>
        <div className="annotation-downloads-buttons">
          <button
            type="button"
            className="secondary-action small"
            onClick={onExportIiml}
            disabled={!doc}
            title="导出当前标注的 IIML JSON"
          >
            <Download size={14} /> JSON
          </button>
          <button
            type="button"
            className="secondary-action small"
            onClick={onExportCsv}
            disabled={!doc || annotations.length === 0}
            title="导出 CSV 表格"
          >
            <Download size={14} /> CSV
          </button>
          {onExportCoco ? (
            <button
              type="button"
              className="secondary-action small"
              onClick={onExportCoco}
              disabled={!doc || annotations.length === 0}
              title="导出 COCO JSON（单石头浏览器下载；正式训练集请用上方「导出训练集」按钮）"
            >
              <Download size={14} /> COCO
            </button>
          ) : null}
          {onExportIiif ? (
            <button
              type="button"
              className="secondary-action small"
              onClick={onExportIiif}
              disabled={!doc || annotations.length === 0}
              title="导出 IIIF Web Annotation：与外部文物 / 博物馆平台互操作"
            >
              <Download size={14} /> IIIF
            </button>
          ) : null}
          {onExportHpsml ? (
            <button
              type="button"
              className="secondary-action small"
              onClick={onExportHpsml}
              disabled={!doc}
              title=".hpsml 研究包：IIML + 拼接方案 + 词表 + 关系网络快照（项目自有完整档案格式）"
            >
              <Download size={14} /> .hpsml
            </button>
          ) : null}
          {onImportHpsml ? (
            <button
              type="button"
              className="secondary-action small"
              onClick={onImportHpsml}
              title="导入 .hpsml 研究包：解包后写入 data/iiml/ 与 data/assembly-plans/"
            >
              <Wand2 size={14} /> 导入 .hpsml
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AnnotationRow({
  annotation,
  fallbackColor,
  isSelected,
  isChecked,
  trainingResult,
  onDelete,
  onSelect,
  onToggleChecked,
  onToggleLocked,
  onToggleVisible
}: {
  annotation: IimlAnnotation;
  fallbackColor: string;
  isSelected: boolean;
  // 是否被勾选用于"合并"。与 isSelected（编辑选中态）独立。
  isChecked: boolean;
  trainingResult?: ReturnType<typeof validateAnnotationForTraining>;
  onDelete: () => void;
  onSelect: () => void;
  onToggleChecked: () => void;
  onToggleLocked: () => void;
  onToggleVisible: () => void;
}) {
  const visible = annotation.visible !== false;
  const locked = annotation.locked === true;
  const isCandidate = annotation.reviewStatus === "candidate";
  const color = annotation.color ?? fallbackColor;
  const label = annotation.label ?? "";
  const quality = getAnnotationQuality(annotation);
  const category = annotation.category ?? "未分类";
  const role = annotation.trainingRole ?? "train";
  const issueCount = annotation.annotationIssues?.length ?? 0;

  return (
    <li
      className={[
        "annotation-row",
        isSelected ? "is-active" : "",
        isChecked ? "is-checked" : ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <label className="annotation-row-check" title="勾选后可与其他标注合并">
        <input
          type="checkbox"
          checked={isChecked}
          onChange={onToggleChecked}
          aria-label="选择此标注用于合并"
        />
      </label>
      <span
        className="annotation-color-dot annotation-color-dot--static"
        style={{ background: color }}
        aria-hidden
      />
      <button
        type="button"
        className="annotation-row-name"
        onClick={onSelect}
        title={`${label || "未命名"} · ${category} · ${annotation.target.type}`}
        aria-pressed={isSelected}
      >
        <span className="annotation-row-title">
          <span className="annotation-row-label">{label ? label : <em>未命名</em>}</span>
          {isCandidate ? <span className="annotation-candidate-badge" title="AI 候选，待审核">候选</span> : null}
        </span>
        <span className="annotation-row-meta">
          <TrainingBadge result={trainingResult} />
          <span className={`annotation-quality-badge annotation-quality-badge--${quality}`}>
            {quality}
          </span>
          <span className="annotation-meta-chip">{annotation.target.type}</span>
          <span className="annotation-meta-chip">{category}</span>
          {role !== "train" ? <span className="annotation-meta-chip">{role}</span> : null}
          {issueCount > 0 ? <span className="annotation-meta-chip">问题×{issueCount}</span> : null}
        </span>
      </button>
      <div className="annotation-row-actions">
        <button className="mini-icon" title={visible ? "隐藏" : "显示"} onClick={onToggleVisible}>
          {visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        <button className="mini-icon" title={locked ? "解锁" : "锁定"} onClick={onToggleLocked}>
          {locked ? <Lock size={14} /> : <Unlock size={14} />}
        </button>
        <button className="mini-icon danger" title="删除" onClick={onDelete}>
          <Trash2 size={14} />
        </button>
      </div>
    </li>
  );
}

function getAnnotationQuality(annotation: IimlAnnotation): IimlAnnotationQualityTier {
  if (annotation.annotationQuality) return annotation.annotationQuality;
  if (annotation.target.type === "BBox" || annotation.target.type === "Point" || annotation.target.type === "LineString") {
    return "weak";
  }
  return "silver";
}

// ============================================================
//  ReviewTab：SAM3 候选审阅
// ============================================================

type ReviewTabProps = AnnotationPanelProps & {
  onPickCandidate: (id: string) => void;
};

function ReviewTab({
  doc,
  onPickCandidate,
  onAcceptCandidate,
  onRejectCandidate,
  onRetryCandidate,
  onBulkAcceptCandidates,
  onBulkRejectCandidates,
  onMergeCandidates
}: ReviewTabProps) {
  const candidates = useMemo(
    () => (doc?.annotations ?? []).filter((annotation) => annotation.reviewStatus === "candidate"),
    [doc?.annotations]
  );

  // 多选合并：选中的候选 id 集合，候选列表变化后自动剔除已不存在的 id。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  // C6 类别 chip 过滤：按候选 label 分组；过滤集合为空 = 不过滤。
  const labelGroups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const annotation of candidates) {
      const label = annotation.label?.trim() || "未命名";
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  }, [candidates]);
  const [labelFilter, setLabelFilter] = useState<Set<string>>(() => new Set());

  const filteredCandidates = useMemo(() => {
    if (labelFilter.size === 0) {
      return candidates;
    }
    return candidates.filter((annotation) => labelFilter.has(annotation.label?.trim() || "未命名"));
  }, [candidates, labelFilter]);

  useEffect(() => {
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      const known = new Set(candidates.map((annotation) => annotation.id));
      for (const id of prev) {
        if (known.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [candidates]);

  useEffect(() => {
    setLabelFilter((prev) => {
      let changed = false;
      const next = new Set<string>();
      const known = new Set(labelGroups.map((group) => group.label));
      for (const label of prev) {
        if (known.has(label)) {
          next.add(label);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [labelGroups]);

  const toggleLabel = (label: string) => {
    setLabelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  };

  const clearLabelFilter = () => setLabelFilter(new Set());

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleMerge = () => {
    if (selectedIds.size < 2) {
      return;
    }
    onMergeCandidates(Array.from(selectedIds));
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  if (candidates.length === 0) {
    return <p className="annotation-empty">没有待审核的 AI 候选。</p>;
  }

  const selectedCount = selectedIds.size;
  const canMerge = selectedCount >= 2;

  return (
    <div className="review-tab">
      <div className="review-banner">
        <span className="review-banner-count">
          <strong>{candidates.length}</strong> 条 AI 候选待审
        </span>
        <div className="review-banner-actions">
          <button type="button" className="secondary-action small" onClick={onBulkRejectCandidates} title="拒绝全部候选">
            全部拒绝
          </button>
          <button type="button" className="primary-action small" onClick={onBulkAcceptCandidates} title="接受全部候选">
            全部接受
          </button>
        </div>
      </div>

      {selectedCount > 0 ? (
        <div className="review-merge-bar">
          <span className="review-merge-info">
            已选 <strong>{selectedCount}</strong> 个候选
            {canMerge ? null : (
              <span className="muted-text"> · 至少 2 个才能合并</span>
            )}
          </span>
          <div className="review-merge-actions">
            <button type="button" className="secondary-action small" onClick={handleClearSelection}>
              清空选择
            </button>
            <button
              type="button"
              className="primary-action small"
              disabled={!canMerge}
              onClick={handleMerge}
              title="mask 级合并：栅格化 → 布尔并 → 清小碎片/保留洞 → 重新矢量化"
            >
              <Group size={13} /> 合并选中（{selectedCount}）
            </button>
          </div>
        </div>
      ) : null}

      {labelGroups.length > 1 ? (
        <div className="review-filter-chips" role="group" aria-label="候选类别过滤">
          {labelGroups.map((group) => (
            <button
              key={group.label}
              type="button"
              className={
                labelFilter.has(group.label)
                  ? "review-filter-chip is-on"
                  : "review-filter-chip"
              }
              onClick={() => toggleLabel(group.label)}
              title={`仅显示标签为"${group.label}"的候选`}
            >
              {group.label}
              <span className="review-filter-chip-count">{group.count}</span>
            </button>
          ))}
          {labelFilter.size > 0 ? (
            <button type="button" className="ghost-link review-filter-clear" onClick={clearLabelFilter}>
              清除过滤
            </button>
          ) : null}
        </div>
      ) : null}

      {filteredCandidates.length === 0 && labelFilter.size > 0 ? (
        <p className="muted-text">当前过滤下没有候选；点"清除过滤"恢复全部。</p>
      ) : null}

      <ul className="review-list">
        {filteredCandidates.map((annotation, index) => (
          <CandidateCard
            key={annotation.id}
            annotation={annotation}
            index={index}
            isSelected={selectedIds.has(annotation.id)}
            onToggleSelected={() => toggleSelected(annotation.id)}
            onPick={() => onPickCandidate(annotation.id)}
            onAccept={() => onAcceptCandidate(annotation.id)}
            onReject={() => onRejectCandidate(annotation.id)}
            onRetry={() => onRetryCandidate(annotation.id)}
          />
        ))}
      </ul>
    </div>
  );
}

function CandidateCard({
  annotation,
  index,
  isSelected,
  onToggleSelected,
  onPick,
  onAccept,
  onReject,
  onRetry
}: {
  annotation: IimlAnnotation;
  index: number;
  isSelected: boolean;
  onToggleSelected: () => void;
  onPick: () => void;
  onAccept: () => void;
  onReject: () => void;
  onRetry: () => void;
}) {
  const color = annotation.color ?? annotationPalette[index % annotationPalette.length];
  const label = annotation.label ?? "SAM3 候选";
  const confidence = annotation.generation?.confidence;
  const model = annotation.generation?.model ?? "SAM3";

  return (
    <li className={isSelected ? "review-card is-selected" : "review-card"}>
      <div className="review-card-head">
        <label className="review-card-check" title="勾选后可与其他候选合并">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelected}
            aria-label="选择此候选用于合并"
          />
        </label>
        <span className="annotation-color-dot annotation-color-dot--static" style={{ background: color }} aria-hidden />
        <button type="button" className="review-card-title" onClick={onPick} title="查看并编辑此候选">
          {label}
        </button>
        {typeof confidence === "number" ? (
          <span className="review-card-confidence" title={`模型：${model}`}>
            {Math.round(confidence * 100)}%
          </span>
        ) : null}
      </div>
      <div className="review-card-actions">
        <button type="button" className="secondary-action small" onClick={onRetry} title="重试：删除此候选，再用工具栏 SAM3 换概念词 / 阈值重新生成">
          <RotateCcw size={13} /> 重试
        </button>
        <button type="button" className="secondary-action danger small" onClick={onReject} title="拒绝并删除">
          <X size={13} /> 拒绝
        </button>
        <button type="button" className="primary-action small" onClick={onAccept} title="接受为正式标注">
          <Check size={13} /> 接受
        </button>
      </div>
    </li>
  );
}
