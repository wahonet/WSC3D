/**
 * 标注侧栏面板 `AnnotationPanel`
 *
 * 标注模式右侧的多 tab 信息面板：
 * - **编辑**：当前选中标注的详情编辑（结构层级、ICON 三层、受控术语、证据源、
 *   备注、关系编辑器、AI 处理记录、多解释对比、删除按钮）
 * - **候选**：SAM / YOLO 产生的待审标注集中区，按类别 chip 过滤、批量
 *   接受 / 拒绝、几何并集合并
 * - **列表**：所有已确认的标注列表，带颜色 / 名称 / 可见性 / 锁定 / 删除等操作
 *   面板底部还有 IIML / CSV / COCO / IIIF / .hpsml 五种格式的导出按钮
 * - **图谱**：cytoscape 知识图谱（4 种中心性 + MCL 群组检测 + top-N 排行榜）
 * - **资源**：IIML resources[] + 后端落盘资源 + 一键生成正射图（v0.8.0 新增）
 *
 * 设计要点：
 * - 各 tab 共享同一份 IIML doc，但独占滚动条，避免长列表互相干扰
 * - 编辑 tab 的"确定 / 取消"仅对草稿生效；非草稿改动靠 reducer 的 autosave 写盘
 * - 候选 tab 的合并按钮调 `merge.ts:mergePolygonAnnotations`，做 polygon-clipping
 *   union 后只保留外环
 * - 关系编辑器（B1）+ 空间关系自动推导（B2）只在编辑 tab 当前选中标注时显示
 */

import { AlertTriangle, Check, CircleAlert, Download, Eye, EyeOff, FolderOpen, Group, Layers, Lock, Network, Package, RotateCcw, Save, Trash2, Unlock, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  IimlAnnotation,
  IimlAnnotationIssue,
  IimlAnnotationQualityTier,
  IimlDocument,
  IimlGeometryIntent,
  IimlHanStoneCategory,
  IimlSource,
  IimlStructuralLevel,
  IimlTermRef,
  IimlTrainingRole,
  StoneListItem,
  StoneMetadata,
  VocabularyCategory,
  VocabularyTerm
} from "../../api/client";
import { AlternativeInterpretationsView } from "./AlternativeInterpretationsView";
import { ColorPopover } from "./ColorPopover";
import { KnowledgeGraphView } from "./KnowledgeGraphView";
import { ProcessingRunsList } from "./ProcessingRunsList";
import { RelationsEditor } from "./RelationsEditor";
import { ResourcesEditor } from "./ResourcesEditor";
import { SourcesEditor } from "./SourcesEditor";
import { TermPicker } from "./TermPicker";
import { annotationPalette } from "./store";
import {
  allMotifSuggestions,
  hanStoneCategoryOptions,
  motifSuggestionsByCategory,
  narrativeCategoriesNeedMotif
} from "./categories";
import { validateAnnotationForTraining } from "./training";
import { recommendCooccurringTerms } from "./cooccurrence";

type AnnotationPanelProps = {
  doc?: IimlDocument;
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
  // SAM 候选审核相关：单条 / 批量操作，都由 App 层实现
  onAcceptCandidate: (id: string) => void;
  onRejectCandidate: (id: string) => void;
  onRetryCandidate: (id: string) => void;
  onBulkAcceptCandidates: () => void;
  onBulkRejectCandidates: () => void;
  // F3：YOLO 候选 → SAM 精修。单条用 onRefineWithSam(id)；批量用 onBulkRefineYoloWithSam()
  onRefineWithSam?: (id: string) => void;
  onBulkRefineYoloWithSam?: () => void;
  // D7 / D8 学术导出
  onExportCoco?: () => void;
  onExportIiif?: () => void;
  // G2 .hpsml 自定义研究包导出（IIML + 拼接方案 + 词表 + 关系网络快照）
  onExportHpsml?: () => void;
  // M5 Phase 1 A2 主动学习闭环：把 data/iiml/*.iiml.json 跨石头聚合 + 校验 +
  // 70/15/15 划分 + 写 data/datasets/wsc-han-stone-v0/ 整套目录（COCO + IIML 双轨）
  onExportTraining?: () => void;
  onRevealTrainingDataset?: () => void;
  // D 阶段：上线前预检（pic 配对 / IIML 完整度 / 训练池估算 / 类别均衡）
  onPreflight?: () => void;
  // I3 v0.8.0：.hpsml 研究包解包 / 导入（文件选择 → POST /api/hpsml/import）
  onImportHpsml?: () => void;
  onManualSave?: () => void;
  // G1 多资源版本管理：增 / 删 / 改 doc.resources。v0.7.0 独立 tab，
  // 可从三维模型生成正射图自动落盘 + 关联到 IIML。
  onAddResource?: (resource: import("./types").IimlResourceEntry) => void;
  onUpdateResource?: (id: string, patch: Partial<import("./types").IimlResourceEntry>) => void;
  onDeleteResource?: (id: string) => void;
  // 资源 tab 需要用 stone 来取 modelUrl（正射渲染）和 stoneId（上传端点）
  stone?: StoneListItem;
  // 资源 tab 内部操作要能更新全局 status（如"正射生成中…"）
  onStatusMessage?: (status: string) => void;
  // 把多个候选做几何并集合并成一个新候选（保留外环、丢孔洞）。
  // 由 App 层调用 mergePolygonAnnotations，并替换 store 中的旧条目。
  onMergeCandidates: (ids: string[]) => void;
  // 标注间关系：B1 引入。relations 已在 store getRelations 过滤后传入；
  // spatialCandidates 由 App 层调 deriveSpatialRelations 实时算出（不入库）。
  relations: import("./types").IimlRelation[];
  spatialCandidates?: import("./RelationsEditor").SpatialRelationCandidate[];
  onAddRelation: (relation: import("./types").IimlRelation) => void;
  onUpdateRelation: (id: string, patch: Partial<import("./types").IimlRelation>) => void;
  onDeleteRelation: (id: string) => void;
  // D3 + D4 AI 处理记录；store getProcessingRuns 过滤后传入
  processingRuns?: import("./types").IimlProcessingRun[];
};

// 结构层级：按 IIML schema 顺序排列；label 使用纯中文，视觉更克制。
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

const annotationQualityOptions: Array<{ value: IimlAnnotationQualityTier; label: string; title: string }> = [
  { value: "weak", label: "weak", title: "框、点、涂鸦、局部线索；用于覆盖和弱监督" },
  { value: "silver", label: "silver", title: "AI 或人工快速修正的 polygon/mask；可训练但需统计噪声" },
  { value: "gold", label: "gold", title: "专家精修；用于验证集、测试集或论文评估" }
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

type TabKey = "edit" | "review" | "list" | "graph" | "resources";

export function AnnotationPanel(props: AnnotationPanelProps) {
  const { selectedAnnotation, doc, draftAnnotationId, onSelectAnnotation, relations } = props;
  const annotations = doc?.annotations ?? [];
  const candidateCount = useMemo(
    () => annotations.filter((annotation) => annotation.reviewStatus === "candidate").length,
    [annotations]
  );
  const [tab, setTab] = useState<TabKey>("edit");

  // 新建草稿时自动切到"标注"tab；产出 SAM 候选时自动切到"候选"tab；
  // 选中已有标注不强制跳转，避免在列表里操作被打断。
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
          <EditTab annotation={selectedAnnotation} {...props} />
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
    </div>
  );
}

type EditTabProps = AnnotationPanelProps & {
  annotation?: IimlAnnotation;
};

// 默认透明度；与 AnnotationCanvas 的 defaultAnnotationAlpha 保持一致。
const DEFAULT_OPACITY = 0.15;

function EditTab({
  annotation,
  draftAnnotationId,
  doc,
  metadata,
  relations,
  spatialCandidates,
  processingRuns = [],
  vocabularyCategories,
  vocabularyTerms,
  onAddRelation,
  onDeleteRelation,
  onUpdateAnnotation,
  onUpdateRelation,
  onDeleteAnnotation,
  onConfirmDraft,
  onSelectAnnotation
}: EditTabProps) {
  const [labelDraft, setLabelDraft] = useState("");
  const [motifDraft, setMotifDraft] = useState("");
  const [preIconographicDraft, setPreIconographicDraft] = useState("");
  const [iconographicDraft, setIconographicDraft] = useState("");
  const [iconologicalDraft, setIconologicalDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [transcriptionDraft, setTranscriptionDraft] = useState("");
  const [translationDraft, setTranslationDraft] = useState("");
  const [readingNoteDraft, setReadingNoteDraft] = useState("");
  // immediateDirty 是 dirty 状态的唯一来源：用户在任何字段做过改动就置 true，
  // 直到点保存或切换到别的标注才清掉。这样即使 textarea onBlur 已经把 draft
  // commit 到 store（导致 draft == annotation），保存按钮也仍然亮，避免出现
  // "在屏幕上方编辑文本，滚动下来想点保存却发现按钮是灰的" 这种迷惑情况。
  const [immediateDirty, setImmediateDirty] = useState(false);

  // D6 共现术语推荐：基于全文档统计 + 当前 annotation 已有 terms
  const suggestedTerms = useMemo(() => {
    if (!annotation || vocabularyTerms.length === 0) return [];
    const currentTermIds = annotation.semantics?.terms?.map((term) => term.id) ?? [];
    return recommendCooccurringTerms(
      doc?.annotations ?? [],
      currentTermIds,
      vocabularyTerms
    );
  }, [annotation, doc?.annotations, vocabularyTerms]);

  useEffect(() => {
    setLabelDraft(annotation?.label ?? "");
    setMotifDraft(annotation?.motif ?? "");
    setPreIconographicDraft(annotation?.semantics?.preIconographic ?? "");
    setIconographicDraft(annotation?.semantics?.iconographicMeaning ?? "");
    setIconologicalDraft(annotation?.semantics?.iconologicalMeaning ?? "");
    setNotesDraft(annotation?.notes ?? "");
    setTranscriptionDraft(annotation?.semantics?.inscription?.transcription ?? "");
    setTranslationDraft(annotation?.semantics?.inscription?.translation ?? "");
    setReadingNoteDraft(annotation?.semantics?.inscription?.readingNote ?? "");
    setImmediateDirty(false);
  }, [annotation?.id]);

  if (!annotation) {
    return <p className="annotation-empty">选择或新建一条标注以编辑。</p>;
  }

  const isDraft = annotation.id === draftAnnotationId;
  const structuralLevel = annotation.structuralLevel ?? "unknown";
  const showInscription = structuralLevel === "inscription";

  const patchSemantics = (
    key: "preIconographic" | "iconographicMeaning" | "iconologicalMeaning",
    nextValue: string,
    previousValue: string
  ) => {
    if (nextValue === previousValue) return;
    onUpdateAnnotation(annotation.id, {
      semantics: { ...(annotation.semantics ?? {}), [key]: nextValue }
    });
  };

  const patchInscription = (
    key: "transcription" | "translation" | "readingNote",
    nextValue: string,
    previousValue: string
  ) => {
    if (nextValue === previousValue) return;
    const inscription = { ...(annotation.semantics?.inscription ?? {}) };
    inscription[key] = nextValue;
    onUpdateAnnotation(annotation.id, {
      semantics: { ...(annotation.semantics ?? {}), inscription }
    });
  };

  const commitLabel = () => {
    if (labelDraft !== (annotation.label ?? "")) {
      onUpdateAnnotation(annotation.id, { label: labelDraft });
    }
  };
  const commitMotif = () => {
    const trimmed = motifDraft.trim();
    const current = annotation.motif ?? "";
    if (trimmed !== current) {
      // 空字符串 → 清字段。Partial<IimlAnnotation> 不支持 undefined 区分，
      // 这里写空字符串"等价于无 motif"；A2 训练池准入会把空当作未填。
      onUpdateAnnotation(annotation.id, { motif: trimmed });
    }
  };
  const commitNotes = () => {
    if (notesDraft !== (annotation.notes ?? "")) {
      onUpdateAnnotation(annotation.id, { notes: notesDraft });
    }
  };
  const commitPreIconographic = () =>
    patchSemantics("preIconographic", preIconographicDraft, annotation.semantics?.preIconographic ?? "");
  const commitIconographic = () =>
    patchSemantics("iconographicMeaning", iconographicDraft, annotation.semantics?.iconographicMeaning ?? "");
  const commitIconological = () =>
    patchSemantics("iconologicalMeaning", iconologicalDraft, annotation.semantics?.iconologicalMeaning ?? "");
  const commitTranscription = () =>
    patchInscription("transcription", transcriptionDraft, annotation.semantics?.inscription?.transcription ?? "");
  const commitTranslation = () =>
    patchInscription("translation", translationDraft, annotation.semantics?.inscription?.translation ?? "");
  const commitReadingNote = () =>
    patchInscription("readingNote", readingNoteDraft, annotation.semantics?.inscription?.readingNote ?? "");

  const markDirty = () => setImmediateDirty(true);

  const handleLevelChange = (value: IimlStructuralLevel) => {
    onUpdateAnnotation(annotation.id, { structuralLevel: value });
    markDirty();
  };
  const handleCategoryChange = (value: IimlHanStoneCategory | "") => {
    // 空字符串 = 选回"未填"占位项 → 等同于清字段（写空串保留兼容，A2 跳过）
    const next = value === "" ? undefined : value;
    onUpdateAnnotation(annotation.id, { category: next });
    markDirty();
  };
  const handleQualityChange = (value: IimlAnnotationQualityTier) => {
    onUpdateAnnotation(annotation.id, { annotationQuality: value });
    markDirty();
  };
  const handleGeometryIntentChange = (value: IimlGeometryIntent) => {
    onUpdateAnnotation(annotation.id, { geometryIntent: value });
    markDirty();
  };
  const handleTrainingRoleChange = (value: IimlTrainingRole) => {
    onUpdateAnnotation(annotation.id, { trainingRole: value });
    markDirty();
  };
  const handleIssueToggle = (issue: IimlAnnotationIssue) => {
    const current = new Set(annotation.annotationIssues ?? []);
    if (current.has(issue)) {
      current.delete(issue);
    } else {
      current.add(issue);
    }
    onUpdateAnnotation(annotation.id, { annotationIssues: Array.from(current) });
    markDirty();
  };
  const handleColorChange = (color: string) => {
    onUpdateAnnotation(annotation.id, { color });
    markDirty();
  };
  const handleOpacityChange = (value: number) => {
    onUpdateAnnotation(annotation.id, { opacity: value });
    markDirty();
  };
  const handleTermsChange = (nextTerms: IimlTermRef[]) => {
    onUpdateAnnotation(annotation.id, {
      semantics: { ...(annotation.semantics ?? {}), terms: nextTerms }
    });
    markDirty();
  };
  const handleSourcesChange = (nextSources: IimlSource[]) => {
    onUpdateAnnotation(annotation.id, { sources: nextSources });
    markDirty();
  };

  const opacityValue = annotation.opacity ?? DEFAULT_OPACITY;

  // 文本字段基于 draft 与 annotation 的差异判定，即时字段靠 immediateDirty 标记。
  const isDirty =
    immediateDirty ||
    labelDraft !== (annotation.label ?? "") ||
    motifDraft.trim() !== (annotation.motif ?? "") ||
    preIconographicDraft !== (annotation.semantics?.preIconographic ?? "") ||
    iconographicDraft !== (annotation.semantics?.iconographicMeaning ?? "") ||
    iconologicalDraft !== (annotation.semantics?.iconologicalMeaning ?? "") ||
    notesDraft !== (annotation.notes ?? "") ||
    (showInscription &&
      (transcriptionDraft !== (annotation.semantics?.inscription?.transcription ?? "") ||
        translationDraft !== (annotation.semantics?.inscription?.translation ?? "") ||
        readingNoteDraft !== (annotation.semantics?.inscription?.readingNote ?? "")));
  const canSave = isDraft || isDirty;

  const handleSave = () => {
    commitLabel();
    commitMotif();
    commitNotes();
    commitPreIconographic();
    commitIconographic();
    commitIconological();
    if (showInscription) {
      commitTranscription();
      commitTranslation();
      commitReadingNote();
    }
    setImmediateDirty(false);
    if (isDraft) {
      onConfirmDraft(annotation.id);
    }
  };

  // SOP §1.6：故事类 category 缺 motif 时给出 warning（不阻塞）。
  const motifSuggestions = annotation.category
    ? motifSuggestionsByCategory[annotation.category]
    : allMotifSuggestions;
  const motifMissingWarning =
    annotation.category &&
    narrativeCategoriesNeedMotif.has(annotation.category) &&
    motifDraft.trim() === "";

  return (
    <div className="annotation-edit">
      <div className="edit-head">
        <ColorPopover
          color={annotation.color ?? annotationPalette[0]}
          onChange={handleColorChange}
          title="更改颜色"
          size={20}
        />
        <label className="edit-level">
          <span>层级</span>
          <select
            value={structuralLevel}
            onChange={(event) => handleLevelChange(event.target.value as IimlStructuralLevel)}
          >
            {structuralLevelOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="edit-level edit-category" title="汉画像石领域类别（SOP §1，13 类 + 未识别）">
          <span>类别</span>
          <select
            value={annotation.category ?? ""}
            onChange={(event) => handleCategoryChange(event.target.value as IimlHanStoneCategory | "")}
          >
            <option value="">— 未填 —</option>
            {hanStoneCategoryOptions.map((option) => (
              <option key={option.value} value={option.value} title={option.description}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {isDraft ? <span className="edit-draft-tag">草稿</span> : null}
      </div>

      <Field label="标签">
        <input
          autoFocus={isDraft}
          type="text"
          value={labelDraft}
          placeholder="例如：青龙"
          onChange={(event) => {
            setLabelDraft(event.target.value);
            markDirty();
          }}
          onBlur={commitLabel}
        />
      </Field>

      <Field label="母题 / 格套">
        <input
          type="text"
          list={`motif-options-${annotation.id}`}
          value={motifDraft}
          placeholder={
            annotation.category
              ? `${motifSuggestions.length} 项建议，可自由填写`
              : "先选类别可获得受控建议"
          }
          onChange={(event) => {
            setMotifDraft(event.target.value);
            markDirty();
          }}
          onBlur={commitMotif}
        />
        <datalist id={`motif-options-${annotation.id}`}>
          {motifSuggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
        {motifMissingWarning ? (
          <p className="edit-hint edit-hint--warn">
            提示：故事类标注建议填具体母题（SOP 附录 A）；空值不阻塞但 A2 导出会标记。
          </p>
        ) : null}
      </Field>

      <Field label="训练质量">
        <div className="edit-row">
          <select
            value={annotation.annotationQuality ?? (annotation.target.type === "BBox" || annotation.target.type === "Point" || annotation.target.type === "LineString" ? "weak" : "silver")}
            onChange={(event) => handleQualityChange(event.target.value as IimlAnnotationQualityTier)}
            title="weak/silver/gold 分层，导出报告和 stats 会单独统计"
          >
            {annotationQualityOptions.map((option) => (
              <option key={option.value} value={option.value} title={option.title}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            value={annotation.geometryIntent ?? "semantic_extent"}
            onChange={(event) => handleGeometryIntentChange(event.target.value as IimlGeometryIntent)}
            title="区分可见刻痕、语义范围和专家复原范围"
          >
            {geometryIntentOptions.map((option) => (
              <option key={option.value} value={option.value} title={option.title}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            value={annotation.trainingRole ?? "train"}
            onChange={(event) => handleTrainingRoleChange(event.target.value as IimlTrainingRole)}
            title="gold 子集可标 validation，争议或暂不用样本可标 holdout"
          >
            {trainingRoleOptions.map((option) => (
              <option key={option.value} value={option.value} title={option.title}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <p className="edit-hint">
          weak 用于框/点/涂鸦覆盖，silver 用于可训练粗 mask，gold 优先留作验证与论文评估。
        </p>
      </Field>

      <Field label="问题标签">
        <div className="issue-chip-list">
          {annotationIssueOptions.map((option) => {
            const checked = (annotation.annotationIssues ?? []).includes(option.value);
            return (
              <label key={option.value} className={checked ? "issue-chip is-on" : "issue-chip"}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => handleIssueToggle(option.value)}
                />
                {option.label}
              </label>
            );
          })}
        </div>
        <p className="edit-hint">用于记录 SAM 失败原因，并进入主动学习队列排序。</p>
      </Field>

      <Field label="透明度">
        <div className="edit-opacity">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={opacityValue}
            onChange={(event) => handleOpacityChange(Number(event.target.value))}
          />
          <span className="edit-opacity-value">{Math.round(opacityValue * 100)}%</span>
        </div>
      </Field>

      <Field label="前图像志">
        <textarea
          rows={2}
          value={preIconographicDraft}
          placeholder="看得见的对象，如：长身有角的四足生物…"
          onChange={(event) => {
            setPreIconographicDraft(event.target.value);
            markDirty();
          }}
          onBlur={commitPreIconographic}
        />
      </Field>

      <Field label="图像志">
        <textarea
          rows={2}
          value={iconographicDraft}
          placeholder="主题识别，如：青龙，四象之一…"
          onChange={(event) => {
            setIconographicDraft(event.target.value);
            markDirty();
          }}
          onBlur={commitIconographic}
        />
      </Field>

      <Field label="图像学">
        <textarea
          rows={2}
          value={iconologicalDraft}
          placeholder="文化解释，如：象征东方与春…"
          onChange={(event) => {
            setIconologicalDraft(event.target.value);
            markDirty();
          }}
          onBlur={commitIconological}
        />
      </Field>

      <Field label="受控术语">
        <TermPicker
          value={annotation.semantics?.terms}
          categories={vocabularyCategories}
          terms={vocabularyTerms}
          suggestedTerms={suggestedTerms}
          onChange={handleTermsChange}
        />
      </Field>

      <Field label="证据源">
        <SourcesEditor value={annotation.sources} metadata={metadata} onChange={handleSourcesChange} />
      </Field>

      {showInscription ? (
        <>
          <Field label="题刻释文">
            <textarea
              rows={2}
              value={transcriptionDraft}
              placeholder="原文释读…"
              onChange={(event) => {
                setTranscriptionDraft(event.target.value);
                markDirty();
              }}
              onBlur={commitTranscription}
            />
          </Field>
          <Field label="题刻翻译">
            <textarea
              rows={2}
              value={translationDraft}
              placeholder="今译 / 外文翻译…"
              onChange={(event) => {
                setTranslationDraft(event.target.value);
                markDirty();
              }}
              onBlur={commitTranslation}
            />
          </Field>
          <Field label="释读注">
            <textarea
              rows={2}
              value={readingNoteDraft}
              placeholder="释读难点、异体字、残损…"
              onChange={(event) => {
                setReadingNoteDraft(event.target.value);
                markDirty();
              }}
              onBlur={commitReadingNote}
            />
          </Field>
        </>
      ) : null}

      <Field label="备注">
        <textarea
          rows={2}
          value={notesDraft}
          placeholder="研究思路、参考等…"
          onChange={(event) => {
            setNotesDraft(event.target.value);
            markDirty();
          }}
          onBlur={commitNotes}
        />
      </Field>

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

      <ProcessingRunsList
        annotation={annotation}
        runs={processingRuns}
        onSelectAnnotation={onSelectAnnotation}
      />

      <div className="edit-actions">
        <button
          type="button"
          className="primary-action small"
          onClick={handleSave}
          disabled={!canSave}
          title={canSave ? "保存改动" : "无待保存的改动"}
        >
          <Check size={14} /> 保存
        </button>
        <button
          type="button"
          className="secondary-action danger"
          onClick={() => onDeleteAnnotation(annotation.id)}
        >
          <Trash2 size={14} /> 删除
        </button>
        {isDraft ? (
          <button
            type="button"
            className="secondary-action"
            onClick={() => onDeleteAnnotation(annotation.id)}
            title="放弃此次标注"
          >
            <X size={14} /> 取消
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="edit-field">
      <label className="edit-field-label">{label}</label>
      <div className="edit-field-body">{children}</div>
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

  // M5 Phase 1 A2 子任务：训练池徽标。每条 annotation 实时算 ready/warned/blocked 状态
  // + errors / warnings 列表，让标员一眼看到这条离训练池准入还差什么。
  const trainingResultsById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof validateAnnotationForTraining>>();
    if (!doc) return map;
    for (const annotation of annotations) {
      map.set(annotation.id, validateAnnotationForTraining(annotation, doc));
    }
    return map;
  }, [doc, annotations]);

  // 训练池整体进度：进 / 警告 / 阻塞 三档计数，给"导出训练集"按钮做提示
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

  // 多选合并：与候选 tab 同形态的状态。这里合并的对象不限于 candidate；
  // 已 approved 的标注合并后跟着保持 approved（详见 merge.ts），不会被打回未审。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  // 列表外部变动（删除、接受、跨画像石切换）后剔除已不存在的 id，
  // 避免 UI 卡在"已选 N 个"的死状态。
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
              title="把选中的标注做几何并集，得到一条新的合并标注（保留最外侧轮廓）"
            >
              <Group size={13} /> 合并选中（{selectedCount}）
            </button>
          </div>
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
              <AlertTriangle size={12} /> {trainingStats.warned}
            </span>
            <span className="training-stat training-stat--blocked" title="本石头不进训练池（缺字段 / 几何无效 / 未审核等）">
              <CircleAlert size={12} /> {trainingStats.blocked}
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
                <CircleAlert size={14} /> 预检
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
              title="导出 COCO JSON（单石头浏览器下载，含 structuralLevel 当 category；正式训练集请用上方「导出训练集」按钮）"
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
  // M5 Phase 1 A2：本条标注的训练池准入校验结果（SOP §11）。
  // ready=true 且 warnings=[] → ✓；ready=true 但 warnings>0 → ⚠；ready=false → ✗
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

// M5 Phase 1 A2 子任务：训练池徽标。把 SOP §11 校验结果可视化为 ✓/⚠/✗ 三档图标。
// hover title 列出全部 errors / warnings 原因码，标员一眼看到这条离 ready 还差什么。
const TRAINING_REASON_LABELS: Record<string, string> = {
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

function describeTrainingReasons(codes: string[]): string {
  return codes.map((code) => `${code}: ${TRAINING_REASON_LABELS[code] ?? code}`).join("\n");
}

function TrainingBadge({ result }: { result?: ReturnType<typeof validateAnnotationForTraining> }) {
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

// ============================================================
//  ReviewTab：SAM 候选审阅
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
  onMergeCandidates,
  onRefineWithSam,
  onBulkRefineYoloWithSam
}: ReviewTabProps) {
  const candidates = useMemo(
    () => (doc?.annotations ?? []).filter((annotation) => annotation.reviewStatus === "candidate"),
    [doc?.annotations]
  );

  // 多选合并：选中的候选 id 集合，操作完合并后或候选列表变化后会自动同步剔除已不存在的 id。
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

  // 候选列表随外部操作（接受 / 拒绝 / 合并）实时变动；从已选集合里删掉不再存在的 id，
  // 避免合并完成后 UI 还显示"已选 N 个"。
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

  // 类别过滤集合：剔除已不在 labelGroups 中的 label（合并 / 拒绝后某 label 可能消失）
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
          {onBulkRefineYoloWithSam ? (
            <button
              type="button"
              className="secondary-action small"
              onClick={onBulkRefineYoloWithSam}
              title="把所有 YOLO bbox 候选喂给 SAM 跑精修，bbox 升级为 polygon（串行，每条 1-2s）"
            >
              <Wand2 size={13} /> SAM 精修全部 YOLO
            </button>
          ) : null}
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
              title="把选中的候选做几何并集，得到一条新的合并候选（保留最外侧轮廓）"
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
            onRefine={
              onRefineWithSam &&
              annotation.target.type === "BBox" &&
              annotation.generation?.method === "yolo"
                ? () => onRefineWithSam(annotation.id)
                : undefined
            }
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
  onRetry,
  onRefine
}: {
  annotation: IimlAnnotation;
  index: number;
  isSelected: boolean;
  onToggleSelected: () => void;
  onPick: () => void;
  onAccept: () => void;
  onReject: () => void;
  onRetry: () => void;
  // F3：仅 YOLO bbox 候选才有 SAM 精修按钮，由父组件按 method/geometry 判定后传入或省略
  onRefine?: () => void;
}) {
  const color = annotation.color ?? annotationPalette[index % annotationPalette.length];
  const label = annotation.label ?? "SAM 候选";
  const confidence = annotation.generation?.confidence;
  const model = annotation.generation?.model ?? "SAM";

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
        {onRefine ? (
          <button
            type="button"
            className="secondary-action small"
            onClick={onRefine}
            title="把此 YOLO bbox 喂给 SAM 跑精修，bbox 升级为精确 polygon"
          >
            <Wand2 size={13} /> SAM 精修
          </button>
        ) : null}
        <button type="button" className="secondary-action small" onClick={onRetry} title="重试：删除此候选并重新使用 SAM 工具">
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
