import { Check, Download, Eye, EyeOff, Group, Lock, Network, RotateCcw, Trash2, Unlock, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  IimlAnnotation,
  IimlDocument,
  IimlSource,
  IimlStructuralLevel,
  IimlTermRef,
  StoneMetadata,
  VocabularyCategory,
  VocabularyTerm
} from "../../api/client";
import { ColorPopover } from "./ColorPopover";
import { KnowledgeGraphView } from "./KnowledgeGraphView";
import { RelationsEditor } from "./RelationsEditor";
import { SourcesEditor } from "./SourcesEditor";
import { TermPicker } from "./TermPicker";
import { annotationPalette } from "./store";

type AnnotationPanelProps = {
  doc?: IimlDocument;
  selectedAnnotation?: IimlAnnotation;
  draftAnnotationId?: string;
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

type TabKey = "edit" | "review" | "list" | "graph";

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
  const [preIconographicDraft, setPreIconographicDraft] = useState("");
  const [iconographicDraft, setIconographicDraft] = useState("");
  const [iconologicalDraft, setIconologicalDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [transcriptionDraft, setTranscriptionDraft] = useState("");
  const [translationDraft, setTranslationDraft] = useState("");
  const [readingNoteDraft, setReadingNoteDraft] = useState("");
  // 即时写入 store 的字段（层级 / 颜色 / 透明度 / 术语 / 证据源）也要能点亮
  // 保存按钮；用 immediateDirty 作为"有过未确认的即时改动"的标记。
  const [immediateDirty, setImmediateDirty] = useState(false);

  useEffect(() => {
    setLabelDraft(annotation?.label ?? "");
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
        {isDraft ? <span className="edit-draft-tag">草稿</span> : null}
      </div>

      <Field label="标签">
        <input
          autoFocus={isDraft}
          type="text"
          value={labelDraft}
          placeholder="例如：青龙"
          onChange={(event) => setLabelDraft(event.target.value)}
          onBlur={commitLabel}
        />
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
          onChange={(event) => setPreIconographicDraft(event.target.value)}
          onBlur={commitPreIconographic}
        />
      </Field>

      <Field label="图像志">
        <textarea
          rows={2}
          value={iconographicDraft}
          placeholder="主题识别，如：青龙，四象之一…"
          onChange={(event) => setIconographicDraft(event.target.value)}
          onBlur={commitIconographic}
        />
      </Field>

      <Field label="图像学">
        <textarea
          rows={2}
          value={iconologicalDraft}
          placeholder="文化解释，如：象征东方与春…"
          onChange={(event) => setIconologicalDraft(event.target.value)}
          onBlur={commitIconological}
        />
      </Field>

      <Field label="受控术语">
        <TermPicker
          value={annotation.semantics?.terms}
          categories={vocabularyCategories}
          terms={vocabularyTerms}
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
              onChange={(event) => setTranscriptionDraft(event.target.value)}
              onBlur={commitTranscription}
            />
          </Field>
          <Field label="题刻翻译">
            <textarea
              rows={2}
              value={translationDraft}
              placeholder="今译 / 外文翻译…"
              onChange={(event) => setTranslationDraft(event.target.value)}
              onBlur={commitTranslation}
            />
          </Field>
          <Field label="释读注">
            <textarea
              rows={2}
              value={readingNoteDraft}
              placeholder="释读难点、异体字、残损…"
              onChange={(event) => setReadingNoteDraft(event.target.value)}
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
          onChange={(event) => setNotesDraft(event.target.value)}
          onBlur={commitNotes}
        />
      </Field>

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

function ListTab({
  doc,
  selectedAnnotation,
  onSelectAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onMergeCandidates,
  onExportIiml,
  onExportCsv
}: AnnotationPanelProps) {
  const annotations = doc?.annotations ?? [];

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
        title={label || "未命名"}
        aria-pressed={isSelected}
      >
        {label ? label : <em>未命名</em>}
        {isCandidate ? <span className="annotation-candidate-badge" title="AI 候选，待审核">候选</span> : null}
      </button>
      <button className="mini-icon" title={visible ? "隐藏" : "显示"} onClick={onToggleVisible}>
        {visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
      <button className="mini-icon" title={locked ? "解锁" : "锁定"} onClick={onToggleLocked}>
        {locked ? <Lock size={14} /> : <Unlock size={14} />}
      </button>
      <button className="mini-icon danger" title="删除" onClick={onDelete}>
        <Trash2 size={14} />
      </button>
    </li>
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
  onMergeCandidates
}: ReviewTabProps) {
  const candidates = useMemo(
    () => (doc?.annotations ?? []).filter((annotation) => annotation.reviewStatus === "candidate"),
    [doc?.annotations]
  );

  // 多选合并：选中的候选 id 集合，操作完合并后或候选列表变化后会自动同步剔除已不存在的 id。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

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
              title="把选中的候选做几何并集，得到一条新的合并候选（保留最外侧轮廓）"
            >
              <Group size={13} /> 合并选中（{selectedCount}）
            </button>
          </div>
        </div>
      ) : null}

      <ul className="review-list">
        {candidates.map((annotation, index) => (
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
