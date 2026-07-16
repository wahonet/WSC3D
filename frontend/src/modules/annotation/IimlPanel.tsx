/**
 * IIML 四层标注主面板（基于形相学理论的重设计）
 *
 * 结构：顶部四层步骤导航（物理 → 视觉 → 图像学 → 文化）+ 各层完成度，
 * 中部当前层的编辑表单，底部导出与保存状态条。
 *
 * - 物理层：材质 / 技法 / 断代 / 出土 / 收藏 / 保存状况（+ 多源资源管理）
 * - 视觉层：构图 / 线条 / 空间组织 / 透视 / 对称 / 纹理
 * - 图像学层：主题与叙事类型 + 画布区域标注（annotations）+ SAM3 候选审阅
 *   + 空间关系（relations）+ 知识图谱
 * - 文化层：宗教意义 / 社会功能 / 文化背景 / 象征系统 / 比较分析 / 现代阐释
 *
 * 四层结构化数据存 doc.culturalObject.{physicalLayer,visualLayer,iconographyMeta,culturalLayer}，
 * 区域与关系仍是标准 IIML annotations / relations，全部走既有 autosave。
 */

import {
  Box,
  Check,
  Download,
  Eye,
  EyeOff,
  Landmark,
  Layers,
  Lock,
  Network,
  Package,
  Palette,
  Trash2,
  Unlock,
  Upload,
  Wand2,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { StoneListItem, StoneMetadata, VocabularyCategory, VocabularyTerm } from "../../api/client";
import { Button } from "../../ui/Button";
import { Field, Input, Select } from "../../ui/Field";
import { hanStoneCategoryOptions } from "./categories";
import { DraftInput, DraftTextarea } from "./DraftFields";
import {
  compositionTypes,
  getCulturalLayer,
  getIconographyMeta,
  getPhysicalLayer,
  getVisualLayer,
  layerProgress,
  narrativeTypes,
  type IimlCulturalLayer,
  type IimlSymbolEntry,
  type LayerKey
} from "./iiml-layers";
import { KnowledgeGraphView } from "./KnowledgeGraphView";
import { RegionEditor } from "./RegionEditor";
import type { SpatialRelationCandidate } from "./RelationsEditor";
import { ResourcesEditor } from "./ResourcesEditor";
import { getProcessingRuns, getRelations } from "./store";
import { TrainingBadge } from "./training-ui";
import { validateAnnotationForTraining } from "./training";
import type { AnnotationAction, IimlAnnotation, IimlDocument } from "./types";

// ---------------- props ----------------

export type IimlPanelProps = {
  doc?: IimlDocument;
  stone?: StoneListItem;
  metadata?: StoneMetadata;
  selectedAnnotationId?: string;
  draftAnnotationId?: string;
  saveState: { phase: "idle" | "dirty" | "saving" | "saved" | "error"; savedAt?: string; error?: string };
  statusMessage?: string;
  spatialCandidates: SpatialRelationCandidate[];
  vocabularyCategories: VocabularyCategory[];
  vocabularyTerms: VocabularyTerm[];
  trainingDatasetLocation?: { datasetDir: string; absolutePath?: string; reportFileName?: string };
  dispatch: (action: AnnotationAction) => void;
  onManualSave: () => void;
  onMergeCandidates: (ids: string[]) => void;
  onExportIiml: () => void;
  onExportCsv: () => void;
  onExportCoco: () => void;
  onExportIiif: () => void;
  onExportHpsml: () => void;
  onImportHpsml: () => void;
  onExportTraining: () => void;
  onRevealTrainingDataset: () => void;
  onPreflight: () => void;
  onStatusMessage: (status: string) => void;
};

// ---------------- 主面板 ----------------

const LAYER_STEPS: Array<{ key: LayerKey; label: string; icon: React.ReactNode; hint: string }> = [
  { key: "physical", label: "物理层", icon: <Box size={14} />, hint: "材质·技法·断代·出土·保存" },
  { key: "visual", label: "视觉层", icon: <Palette size={14} />, hint: "构图·线条·空间·对称" },
  { key: "iconography", label: "图像学层", icon: <Layers size={14} />, hint: "母题区域·空间关系·知识图谱" },
  { key: "cultural", label: "文化层", icon: <Landmark size={14} />, hint: "宗教·社会·象征·阐释" }
];

export function IimlPanel(props: IimlPanelProps) {
  const { doc, dispatch, selectedAnnotationId, draftAnnotationId } = props;
  const [step, setStep] = useState<LayerKey>("iconography");

  const progress = useMemo(() => layerProgress(doc), [doc]);
  const selectedAnnotation = useMemo(
    () => doc?.annotations.find((a) => a.id === selectedAnnotationId),
    [doc?.annotations, selectedAnnotationId]
  );

  // 画布新建草稿 / 选中区域 → 自动跳到图像学层
  useEffect(() => {
    if (draftAnnotationId) setStep("iconography");
  }, [draftAnnotationId]);
  useEffect(() => {
    if (selectedAnnotationId) setStep("iconography");
  }, [selectedAnnotationId]);

  return (
    <div className="iiml-panel">
      <nav className="iiml-steps" aria-label="IIML 四层标注">
        {LAYER_STEPS.map((entry, index) => {
          const p = progress[entry.key];
          const done = p.filled >= p.total;
          return (
            <button
              key={entry.key}
              type="button"
              className={`iiml-step${step === entry.key ? " is-active" : ""}${done ? " is-done" : ""}`}
              title={entry.hint}
              onClick={() => setStep(entry.key)}
            >
              <span className="iiml-step__index">{index + 1}</span>
              <span className="iiml-step__label">
                {entry.icon}
                {entry.label}
              </span>
              <span className="iiml-step__progress">
                {p.filled}/{p.total}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="iiml-body">
        {step === "physical" ? <PhysicalLayerForm {...props} /> : null}
        {step === "visual" ? <VisualLayerForm doc={doc} dispatch={dispatch} /> : null}
        {step === "iconography" ? (
          <IconographyLayerPanel {...props} selectedAnnotation={selectedAnnotation} />
        ) : null}
        {step === "cultural" ? <CulturalLayerForm doc={doc} dispatch={dispatch} /> : null}
      </div>

      <ExportBar {...props} />
      <SaveBar {...props} />
    </div>
  );
}

// ---------------- 第一层：物理层 ----------------

function PhysicalLayerForm(props: IimlPanelProps) {
  const { doc, dispatch, stone, metadata } = props;
  const physical = getPhysicalLayer(doc);
  const dims = metadata?.dimensions ?? stone?.metadata?.dimensions;

  const commit = (patch: Partial<typeof physical>) => {
    dispatch({ type: "set-cultural-node", key: "physicalLayer", value: { ...physical, ...patch } });
  };

  return (
    <div className="iiml-form">
      <p className="iiml-layer-intro">记录文物的物质属性与考古信息。尺寸取自结构化档案。</p>

      <div className="iiml-grid-2">
        <Field label="文物类型">
          <Input value="画像石" readOnly disabled />
        </Field>
        <Field label="尺寸（档案）">
          <Input
            value={
              dims?.width && dims.height
                ? `${dims.width} × ${dims.height}${dims.thickness ? ` × ${dims.thickness}` : ""} ${dims.unit ?? "cm"}`
                : dims?.raw ?? "待补充"
            }
            readOnly
            disabled
          />
        </Field>
        <Field label="材质">
          <DraftInput value={physical.material ?? ""} placeholder="如：石灰岩" onCommit={(v) => commit({ material: v })} />
        </Field>
        <Field label="制作技法">
          <DraftInput value={physical.technique ?? ""} placeholder="如：阴刻线刻 / 浅浮雕" onCommit={(v) => commit({ technique: v })} />
        </Field>
        <Field label="朝代">
          <DraftInput value={physical.dynasty ?? ""} placeholder="如：东汉" onCommit={(v) => commit({ dynasty: v })} />
        </Field>
        <Field label="时期">
          <DraftInput value={physical.period ?? ""} placeholder="如：公元2世纪" onCommit={(v) => commit({ period: v })} />
        </Field>
        <Field label="断代方法">
          <DraftInput
            value={physical.datingMethod ?? ""}
            placeholder="如：考古地层学 + 风格学"
            onCommit={(v) => commit({ datingMethod: v })}
          />
        </Field>
        <Field label="出土地点">
          <DraftInput
            value={physical.discoverySite ?? ""}
            placeholder="如：山东嘉祥武氏祠"
            onCommit={(v) => commit({ discoverySite: v })}
          />
        </Field>
        <Field label="现藏机构">
          <DraftInput
            value={physical.currentCollection ?? ""}
            placeholder="如：山东省博物馆"
            onCommit={(v) => commit({ currentCollection: v })}
          />
        </Field>
        <Field label="墓中位置">
          <DraftInput value={physical.positionInTomb ?? ""} placeholder="如：墓室后壁" onCommit={(v) => commit({ positionInTomb: v })} />
        </Field>
        <Field label="保存状况">
          <DraftInput
            value={physical.preservationCondition ?? ""}
            placeholder="如：良好 / 一般 / 较差"
            onCommit={(v) => commit({ preservationCondition: v })}
          />
        </Field>
        <Field label="修复历史">
          <DraftInput value={physical.restoration ?? ""} placeholder="如：1985 年表面清洗" onCommit={(v) => commit({ restoration: v })} />
        </Field>
      </div>

      <Field label="残损描述（每行一条）">
        <DraftTextarea
          value={(physical.damage ?? []).join("\n")}
          placeholder={"右下角风化\n部分线条模糊"}
          onCommit={(v) =>
            commit({ damage: v.split("\n").map((line) => line.trim()).filter(Boolean) })
          }
        />
      </Field>

      <details className="iiml-collapse">
        <summary>多源数字资源（正射图 / 拓片 / 法线图…）</summary>
        <ResourcesEditor
          doc={doc}
          stone={stone}
          onAddResource={(resource) => dispatch({ type: "add-resource", resource })}
          onUpdateResource={(id, patch) => dispatch({ type: "update-resource", id, patch })}
          onDeleteResource={(id) => dispatch({ type: "delete-resource", id })}
          onStatusMessage={props.onStatusMessage}
        />
      </details>
    </div>
  );
}

// ---------------- 第二层：视觉层 ----------------

function VisualLayerForm({ doc, dispatch }: { doc?: IimlDocument; dispatch: (a: AnnotationAction) => void }) {
  const visual = getVisualLayer(doc);
  const commit = (patch: Partial<typeof visual>) => {
    dispatch({ type: "set-cultural-node", key: "visualLayer", value: { ...visual, ...patch } });
  };

  return (
    <div className="iiml-form">
      <p className="iiml-layer-intro">分析图像的视觉形式特征：构图反映文化观念，线条体现时代风格。</p>

      <div className="iiml-grid-2">
        <Field label="构图类型">
          <Select value={visual.compositionType ?? ""} onChange={(e) => commit({ compositionType: e.target.value })}>
            <option value="">（未选择）</option>
            {compositionTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="透视方式">
          <DraftInput value={visual.perspective ?? ""} placeholder="如：散点透视" onCommit={(v) => commit({ perspective: v })} />
        </Field>
        <Field label="线条技法">
          <DraftInput value={visual.lineTechnique ?? ""} placeholder="如：阴刻线刻" onCommit={(v) => commit({ lineTechnique: v })} />
        </Field>
        <Field label="线条特质">
          <DraftInput value={visual.lineQuality ?? ""} placeholder="如：流畅有力，线条均匀" onCommit={(v) => commit({ lineQuality: v })} />
        </Field>
        <Field label="对称类型">
          <Select value={visual.symmetryType ?? ""} onChange={(e) => commit({ symmetryType: e.target.value })}>
            <option value="">（无 / 未分析）</option>
            <option value="vertical">纵轴对称</option>
            <option value="horizontal">横轴对称</option>
            <option value="radial">中心放射</option>
          </Select>
        </Field>
        <Field label="对称度（0-1）">
          <DraftInput
            value={visual.symmetryDegree !== undefined ? String(visual.symmetryDegree) : ""}
            placeholder="如：0.85"
            onCommit={(v) => {
              const num = Number(v);
              commit({ symmetryDegree: Number.isFinite(num) && v.trim() !== "" ? Math.max(0, Math.min(1, num)) : undefined });
            }}
          />
        </Field>
      </div>

      <Field label="构图描述">
        <DraftTextarea
          value={visual.compositionDescription ?? ""}
          placeholder="如：西王母居中，东王公对坐，周围环绕侍从"
          onCommit={(v) => commit({ compositionDescription: v })}
        />
      </Field>
      <Field label="空间层次（每行一层，由前到后）">
        <DraftTextarea
          value={(visual.spatialLayers ?? []).join("\n")}
          placeholder={"前景人物\n中景云气\n背景装饰"}
          onCommit={(v) =>
            commit({ spatialLayers: v.split("\n").map((line) => line.trim()).filter(Boolean) })
          }
        />
      </Field>
      <Field label="纹理表现">
        <DraftTextarea
          value={visual.texturePatterns ?? ""}
          placeholder="如：服饰用密集短线表现褶皱；云气用卷云纹"
          onCommit={(v) => commit({ texturePatterns: v })}
        />
      </Field>
    </div>
  );
}

// ---------------- 第三层：图像学层 ----------------

function IconographyLayerPanel(
  props: IimlPanelProps & { selectedAnnotation?: IimlAnnotation }
) {
  const { doc, dispatch, selectedAnnotation, draftAnnotationId, spatialCandidates } = props;
  const meta = getIconographyMeta(doc);
  const [view, setView] = useState<"regions" | "graph">("regions");
  const [mergeIds, setMergeIds] = useState<Set<string>>(new Set());

  const annotations = doc?.annotations ?? [];
  const candidates = useMemo(() => annotations.filter((a) => a.reviewStatus === "candidate"), [annotations]);
  const allRegions = useMemo(() => annotations.filter((a) => a.reviewStatus !== "candidate"), [annotations]);
  // Claim 化审核过滤：对照参照系统"图-词-文段关联"工作台的状态 chips
  const [claimFilter, setClaimFilter] = useState<ClaimFilter>("all");
  const claimCounts = useMemo(() => countClaimFilters(allRegions), [allRegions]);
  const regions = useMemo(
    () => allRegions.filter((a) => matchClaimFilter(a, claimFilter)),
    [allRegions, claimFilter]
  );
  const relations = useMemo(() => getRelations(doc), [doc]);
  const processingRuns = useMemo(() => getProcessingRuns(doc), [doc]);
  // 训练就绪度：每条标注 ✓/⚠/✗ 徽章（hover 列原因），与训练导出准入同一套校验
  const trainingResults = useMemo(() => {
    const map = new Map<string, ReturnType<typeof validateAnnotationForTraining>>();
    for (const annotation of annotations) {
      map.set(annotation.id, validateAnnotationForTraining(annotation, doc));
    }
    return map;
  }, [annotations, doc]);

  const commitMeta = (patch: Partial<typeof meta>) => {
    dispatch({ type: "set-cultural-node", key: "iconographyMeta", value: { ...meta, ...patch } });
  };

  const toggleMerge = (id: string) => {
    setMergeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="iiml-form">
      <div className="iiml-grid-2">
        <Field label="画面主题">
          <DraftInput value={meta.mainTheme ?? ""} placeholder="如：西王母会见" onCommit={(v) => commitMeta({ mainTheme: v })} />
        </Field>
        <Field label="叙事类型">
          <Select value={meta.narrativeType ?? ""} onChange={(e) => commitMeta({ narrativeType: e.target.value })}>
            <option value="">（未选择）</option>
            {narrativeTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {candidates.length > 0 ? (
        <section className="iiml-candidates">
          <header className="iiml-subheader">
            <Wand2 size={13} />
            <strong>AI 候选审阅（{candidates.length}）</strong>
            <span className="iiml-subheader__actions">
              {mergeIds.size >= 2 ? (
                <Button compact variant="primary" onClick={() => { props.onMergeCandidates([...mergeIds]); setMergeIds(new Set()); }}>
                  合并 {mergeIds.size} 项
                </Button>
              ) : null}
              <Button
                compact
                onClick={() =>
                  candidates.forEach((c) => dispatch({ type: "update-annotation", id: c.id, patch: { reviewStatus: "approved" } }))
                }
              >
                全部接受
              </Button>
              <Button compact variant="danger" onClick={() => candidates.forEach((c) => dispatch({ type: "delete-annotation", id: c.id }))}>
                全部拒绝
              </Button>
            </span>
          </header>
          <ul className="iiml-region-list">
            {candidates.map((c) => (
              <li
                key={c.id}
                className={`iiml-region${props.selectedAnnotationId === c.id ? " is-selected" : ""}`}
                onClick={() => dispatch({ type: "select", id: c.id })}
              >
                <input
                  type="checkbox"
                  checked={mergeIds.has(c.id)}
                  title="勾选后可合并"
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleMerge(c.id)}
                />
                <span className="iiml-region__dot" style={{ background: c.color }} />
                <span className="iiml-region__label">{c.label ?? c.id}</span>
                <span className="iiml-region__meta">{Math.round((c.generation?.confidence ?? 0) * 100)}%</span>
                <span className="iiml-region__actions">
                  <button
                    type="button"
                    title="接受"
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({ type: "update-annotation", id: c.id, patch: { reviewStatus: "approved" } });
                    }}
                  >
                    <Check size={13} />
                  </button>
                  <button
                    type="button"
                    title="拒绝并删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({ type: "delete-annotation", id: c.id });
                    }}
                  >
                    <X size={13} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <header className="iiml-subheader">
          <strong>
            母题区域（{claimFilter === "all" ? allRegions.length : `${regions.length}/${allRegions.length}`}）
          </strong>
          <span className="iiml-subheader__actions">
            <button
              type="button"
              className={`iiml-view-toggle${view === "regions" ? " is-active" : ""}`}
              onClick={() => setView("regions")}
            >
              列表
            </button>
            <button
              type="button"
              className={`iiml-view-toggle${view === "graph" ? " is-active" : ""}`}
              onClick={() => setView("graph")}
            >
              <Network size={12} /> 图谱
            </button>
          </span>
        </header>

        {view === "regions" && allRegions.length > 0 ? (
          <div className="iiml-claim-filters" role="group" aria-label="按概念断言状态过滤">
            {CLAIM_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                className={`iiml-claim-filter${claimFilter === filter.id ? " is-active" : ""}`}
                title={filter.hint}
                onClick={() => setClaimFilter(filter.id)}
              >
                {filter.label}（{claimCounts[filter.id]}）
              </button>
            ))}
          </div>
        ) : null}

        {view === "graph" ? (
          <div className="iiml-graph-host">
            <KnowledgeGraphView
              doc={doc}
              relations={relations}
              selectedAnnotationId={props.selectedAnnotationId}
              onSelectAnnotation={(id) => dispatch({ type: "select", id })}
            />
          </div>
        ) : (
          <>
            {regions.length === 0 ? (
              <p className="ui-muted">在左侧图上用矩形 / 钢笔等工具框出母题区域，或用 SAM3 概念分割生成候选。</p>
            ) : (
              <ul className="iiml-region-list">
                {regions.map((a) => (
                  <li
                    key={a.id}
                    className={`iiml-region${props.selectedAnnotationId === a.id ? " is-selected" : ""}`}
                    onClick={() => dispatch({ type: "select", id: a.id })}
                  >
                    <span className="iiml-region__dot" style={{ background: a.color }} />
                    <span className="iiml-region__label">{a.label || a.semantics?.name || "（未命名）"}</span>
                    <TrainingBadge result={trainingResults.get(a.id)} />
                    {a.conceptRef ? (
                      <span className="iiml-region__concept" title={`已绑概念：${a.conceptRef.label}`}>
                        {a.conceptRef.label}
                      </span>
                    ) : null}
                    <span className="iiml-region__meta">
                      {hanStoneCategoryOptions.find((o) => o.value === a.category)?.label ?? ""}
                    </span>
                    <span className="iiml-region__actions">
                      <button
                        type="button"
                        title={a.visible === false ? "显示" : "隐藏"}
                        onClick={(e) => {
                          e.stopPropagation();
                          dispatch({ type: "update-annotation", id: a.id, patch: { visible: a.visible === false } });
                        }}
                      >
                        {a.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                      <button
                        type="button"
                        title={a.locked ? "解锁" : "锁定"}
                        onClick={(e) => {
                          e.stopPropagation();
                          dispatch({ type: "update-annotation", id: a.id, patch: { locked: !a.locked } });
                        }}
                      >
                        {a.locked ? <Lock size={13} /> : <Unlock size={13} />}
                      </button>
                      <button
                        type="button"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          dispatch({ type: "delete-annotation", id: a.id });
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {selectedAnnotation && view === "regions" ? (
        <RegionEditor
          annotation={selectedAnnotation}
          isDraft={draftAnnotationId === selectedAnnotation.id}
          doc={doc}
          metadata={props.metadata}
          annotations={annotations}
          relations={relations}
          spatialCandidates={spatialCandidates}
          processingRuns={processingRuns}
          vocabularyCategories={props.vocabularyCategories}
          vocabularyTerms={props.vocabularyTerms}
          dispatch={dispatch}
        />
      ) : null}
    </div>
  );
}

// ---------------- Claim 审核过滤 ----------------

type ClaimFilter = "all" | "bound" | "evidence" | "auto-evidence" | "review" | "unbound";

const CLAIM_FILTERS: Array<{ id: ClaimFilter; label: string; hint: string }> = [
  { id: "all", label: "全部", hint: "全部区域" },
  { id: "bound", label: "已绑概念", hint: "已绑定知识库概念" },
  { id: "evidence", label: "有证据", hint: "至少一条已确认的文献证据" },
  { id: "auto-evidence", label: "自动证据", hint: "有字面匹配的自动证据待人工确认" },
  { id: "review", label: "需复核", hint: "断言状态 = review_required" },
  { id: "unbound", label: "未绑概念", hint: "未绑定概念且未标记「无对应概念」" }
];

function matchClaimFilter(annotation: IimlAnnotation, filter: ClaimFilter): boolean {
  const evidence = annotation.claim?.evidence ?? [];
  switch (filter) {
    case "all":
      return true;
    case "bound":
      return Boolean(annotation.conceptRef);
    case "evidence":
      return evidence.some((entry) => entry.status === "confirmed");
    case "auto-evidence":
      return evidence.some((entry) => entry.status === "auto_text_match_unconfirmed");
    case "review":
      return annotation.claim?.status === "review_required";
    case "unbound":
      return !annotation.conceptRef && annotation.claim?.status !== "no_concept_expected";
  }
}

function countClaimFilters(annotations: IimlAnnotation[]): Record<ClaimFilter, number> {
  const counts: Record<ClaimFilter, number> = {
    all: annotations.length,
    bound: 0,
    evidence: 0,
    "auto-evidence": 0,
    review: 0,
    unbound: 0
  };
  for (const annotation of annotations) {
    for (const filter of ["bound", "evidence", "auto-evidence", "review", "unbound"] as ClaimFilter[]) {
      if (matchClaimFilter(annotation, filter)) counts[filter] += 1;
    }
  }
  return counts;
}

// ---------------- 第四层：文化层 ----------------

function CulturalLayerForm({ doc, dispatch }: { doc?: IimlDocument; dispatch: (a: AnnotationAction) => void }) {
  const cultural = getCulturalLayer(doc);
  const commit = (patch: Partial<IimlCulturalLayer>) => {
    dispatch({
      type: "set-cultural-node",
      key: "culturalLayer",
      value: { ...cultural, ...patch } as Record<string, unknown>
    });
  };

  const symbols = cultural.symbolicSystem ?? [];
  const commitSymbols = (next: IimlSymbolEntry[]) => commit({ symbolicSystem: next });

  return (
    <div className="iiml-form">
      <p className="iiml-layer-intro">阐释图像的宗教意义、社会功能与象征系统——不仅记录"是什么"，更阐释"为什么"。</p>

      <strong className="iiml-group-title">宗教意义</strong>
      <div className="iiml-grid-2">
        <Field label="信仰体系">
          <DraftInput
            value={cultural.religiousMeaning?.beliefSystem ?? ""}
            placeholder="如：汉代升仙信仰"
            onCommit={(v) => commit({ religiousMeaning: { ...cultural.religiousMeaning, beliefSystem: v } })}
          />
        </Field>
        <Field label="仪式语境">
          <DraftInput
            value={cultural.religiousMeaning?.ritualContext ?? ""}
            placeholder="如：墓葬仪式的视觉表达"
            onCommit={(v) => commit({ religiousMeaning: { ...cultural.religiousMeaning, ritualContext: v } })}
          />
        </Field>
      </div>
      <Field label="核心观念">
        <DraftTextarea
          value={cultural.religiousMeaning?.coreConcept ?? ""}
          placeholder="如：通过西王母获得不死之药，实现升仙"
          rows={2}
          onCommit={(v) => commit({ religiousMeaning: { ...cultural.religiousMeaning, coreConcept: v } })}
        />
      </Field>

      <strong className="iiml-group-title">社会功能</strong>
      <div className="iiml-grid-2">
        <Field label="使用语境">
          <DraftInput
            value={cultural.socialFunction?.context ?? ""}
            placeholder="如：墓室后壁装饰"
            onCommit={(v) => commit({ socialFunction: { ...cultural.socialFunction, context: v } })}
          />
        </Field>
        <Field label="面向人群">
          <DraftInput
            value={cultural.socialFunction?.audience ?? ""}
            placeholder="如：墓主人及其家族"
            onCommit={(v) => commit({ socialFunction: { ...cultural.socialFunction, audience: v } })}
          />
        </Field>
      </div>
      <Field label="功能阐释">
        <DraftTextarea
          value={cultural.socialFunction?.function ?? ""}
          placeholder="如：引导墓主人灵魂升仙；显示墓主文化修养与社会地位"
          rows={2}
          onCommit={(v) => commit({ socialFunction: { ...cultural.socialFunction, function: v } })}
        />
      </Field>

      <strong className="iiml-group-title">文化背景</strong>
      <div className="iiml-grid-2">
        <Field label="历史时期">
          <DraftInput
            value={cultural.culturalBackground?.period ?? ""}
            placeholder="如：东汉中期"
            onCommit={(v) => commit({ culturalBackground: { ...cultural.culturalBackground, period: v } })}
          />
        </Field>
        <Field label="地域文化">
          <DraftInput
            value={cultural.culturalBackground?.region ?? ""}
            placeholder="如：山东地区儒家文化与神仙信仰融合"
            onCommit={(v) => commit({ culturalBackground: { ...cultural.culturalBackground, region: v } })}
          />
        </Field>
      </div>
      <Field label="思想背景">
        <DraftTextarea
          value={cultural.culturalBackground?.intellectual ?? ""}
          placeholder="如：谶纬学说盛行，神仙方术流行；厚葬之风，画像石墓流行"
          rows={2}
          onCommit={(v) => commit({ culturalBackground: { ...cultural.culturalBackground, intellectual: v } })}
        />
      </Field>

      <strong className="iiml-group-title">象征系统</strong>
      {symbols.map((entry, index) => (
        <div className="iiml-symbol-row" key={index}>
          <DraftInput
            value={entry.symbol}
            placeholder="象征物，如：戴胜"
            onCommit={(v) => commitSymbols(symbols.map((s, i) => (i === index ? { ...s, symbol: v } : s)))}
          />
          <DraftInput
            value={entry.meaning}
            placeholder="含义，如：神鸟，沟通天地"
            onCommit={(v) => commitSymbols(symbols.map((s, i) => (i === index ? { ...s, meaning: v } : s)))}
          />
          <button
            type="button"
            className="iiml-symbol-remove"
            title="删除"
            onClick={() => commitSymbols(symbols.filter((_, i) => i !== index))}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <Button compact onClick={() => commitSymbols([...symbols, { symbol: "", meaning: "" }])}>
        + 添加象征条目
      </Button>

      <strong className="iiml-group-title">比较分析与现代阐释</strong>
      <Field label="比较分析（跨地域 / 跨文化）">
        <DraftTextarea
          value={cultural.comparativeAnalysis ?? ""}
          placeholder="如：河南南阳的西王母形象更写实；陕西绥德构图更简洁，受北方草原文化影响"
          onCommit={(v) => commit({ comparativeAnalysis: v })}
        />
      </Field>
      <Field label="现代阐释">
        <DraftTextarea
          value={cultural.modernInterpretation ?? ""}
          placeholder="如：汉代死亡观念的视觉表达；汉代线刻艺术的高峰"
          onCommit={(v) => commit({ modernInterpretation: v })}
        />
      </Field>
    </div>
  );
}

// ---------------- 导出与保存 ----------------

function ExportBar(props: IimlPanelProps) {
  return (
    <details className="iiml-exports">
      <summary>
        <Package size={13} /> 数据导出 / 导入
      </summary>
      <div className="iiml-exports__grid">
        <Button compact onClick={props.onExportIiml}>
          <Download size={12} /> IIML JSON
        </Button>
        <Button compact onClick={props.onExportCsv}>
          <Download size={12} /> CSV
        </Button>
        <Button compact onClick={props.onExportCoco}>
          <Download size={12} /> COCO
        </Button>
        <Button compact onClick={props.onExportIiif}>
          <Download size={12} /> IIIF
        </Button>
        <Button compact onClick={props.onExportHpsml}>
          <Download size={12} /> 研究包
        </Button>
        <Button compact onClick={props.onImportHpsml}>
          <Upload size={12} /> 导入研究包
        </Button>
        <Button compact onClick={props.onExportTraining}>
          <Download size={12} /> 训练集
        </Button>
        <Button compact onClick={props.onPreflight}>
          预检
        </Button>
        {props.trainingDatasetLocation ? (
          <Button compact onClick={props.onRevealTrainingDataset}>
            打开训练集目录
          </Button>
        ) : null}
      </div>
    </details>
  );
}

function SaveBar(props: IimlPanelProps) {
  const { saveState, statusMessage } = props;
  const phaseText =
    saveState.phase === "dirty"
      ? "有未保存改动"
      : saveState.phase === "saving"
        ? "保存中…"
        : saveState.phase === "saved"
          ? `已保存${saveState.savedAt ? ` ${new Date(saveState.savedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : ""}`
          : saveState.phase === "error"
            ? `保存失败：${saveState.error ?? ""}`
            : "";

  return (
    <footer className={`iiml-savebar is-${saveState.phase}`}>
      <span className="iiml-savebar__status" title={statusMessage || phaseText}>
        {statusMessage?.trim() ? statusMessage : phaseText}
      </span>
      <Button compact onClick={props.onManualSave} disabled={saveState.phase === "saving"}>
        保存
      </Button>
    </footer>
  );
}
