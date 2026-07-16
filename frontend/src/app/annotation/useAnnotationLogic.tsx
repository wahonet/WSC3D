/**
 * 标注工作区逻辑 hook（从 App.tsx 拆分）
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  composeMask,
  fetchIimlDocument,
  fetchTerms,
  exportTrainingDataset,
  fetchPreflight,
  getSourceImageUrl,
  importHpsmlPackage,
  revealTrainingDataset,
  runSam3ConceptSegmentation,
  saveIimlDocument,
  type SamSegmentationResponse,
  type VocabularyCategory,
  type VocabularyTerm
} from "../../api/client";
import { exportToCoco, exportToHpsml, exportToIiifAnnotationPage, downloadJson } from "../../modules/annotation/exporters";
import { createAnnotationFromGeometry, polygonFromUVs } from "../../modules/annotation/geometry";
import { formatSam3Error, sam3PromptCandidates } from "../../modules/annotation/sam3-prompts";
import {
  buildMergedAnnotation,
  describeMergeFailure,
  geometryFromMaskPolygons,
  mergePolygonAnnotations,
  validateMergeTargets
} from "../../modules/annotation/merge";
import { annotationPalette, annotationReducer, getProcessingRuns, getRelations, initialAnnotationState } from "../../modules/annotation/store";
import { deriveSpatialRelations } from "../../modules/annotation/spatial";
import type { ActiveImageResourceInfo, AnnotationSourceMode } from "../../modules/annotation/AnnotationWorkspace";
import type { Sam3ConceptInput } from "../../modules/annotation/AnnotationToolbar";
import { useAiHealth } from "../../modules/app/useAiHealth";
import { useAnnotationStatus } from "../contexts/AnnotationStatusContext";
import { useAssemblyPlans } from "../contexts/AssemblyPlansContext";
import { useStoneSelection } from "../contexts/StoneSelectionContext";
import { useTasks } from "../contexts/TasksContext";
import { useViewport } from "../contexts/ViewportContext";
import { useWorkspaceMode } from "../contexts/WorkspaceModeContext";
import { buildAnnotationCsv, docBelongsToStone, downloadBlob, formatExportTimestamp } from "../utils";
import type { AnnotationSaveState } from "../contexts/AnnotationStatusContext";

type TrainingDatasetLocation = {
  datasetDir: string;
  absolutePath?: string;
  reportFileName?: string;
};

export function useAnnotationLogic() {
  const { metadata, selectedId, selectedStone, setHasUnsavedAnnotation } = useStoneSelection();
  const { workspaceMode, isAnnotationActive } = useWorkspaceMode();
  const { bumpReset } = useViewport();
  const { savedPlans } = useAssemblyPlans();
  const { setSaveState, setStatusMessage, setHasAlignment } = useAnnotationStatus();
  const { upsertTask, cancelRequestedRef } = useTasks();
  const [annotationState, dispatchAnnotation] = useReducer(annotationReducer, initialAnnotationState);
  const [annotationSaveState, setAnnotationSaveState] = useState<AnnotationSaveState>({ phase: "idle" });
  const [trainingDatasetLocation, setTrainingDatasetLocation] = useState<TrainingDatasetLocation>();
  const lastSavedAnnotationRef = useRef<{ stoneId: string; json: string } | undefined>(undefined);
  const annotationSaveSeqRef = useRef(0);
  // 标注底图来源：默认 3D 模型，可切到高清原图（来自 ai-service /ai/source-image）。
  // 切到高清图后 SAM 候选与画布显示在同一坐标系，对齐天然准确。
  const [annotationSourceMode, setAnnotationSourceMode] = useState<AnnotationSourceMode>("image");
  // 当前是否处于"对齐校准"流程；只是把 activeTool 同步给 toolbar 显示用。
  const isCalibrating = annotationState.activeTool === "calibrate";
  const hasAlignment = Boolean(
    annotationState.doc?.culturalObject &&
      (annotationState.doc.culturalObject as { alignment?: unknown }).alignment
  );
  const [sam3Scanning, setSam3Scanning] = useState(false);
  // J v0.8.0：当前底图资源（正射图 / 拓片 / 法线图等）；undefined = 默认 pic/ 原图。
  // 由 AnnotationWorkspace 通过 onActiveImageResourceChange 回传，供 SAM3 概念
  // 分割路由到正确 imageUri，并决定候选 frame / resourceId 绑定。
  const [activeImageResource, setActiveImageResource] = useState<ActiveImageResourceInfo | undefined>(undefined);
    // G3 任务进度面板：长任务（SAM 批量精修 / 多石头 YOLO）的进度 + 取消
  const [vocabularyCategories, setVocabularyCategories] = useState<VocabularyCategory[]>([]);
  const [vocabularyTerms, setVocabularyTerms] = useState<VocabularyTerm[]>([]);
  const aiHealth = useAiHealth();
  const sam3Status = aiHealth?.sam3;

  // 进入标注模式时默认切到高清图底图（主工作流在图上标注）
  const prevWorkspaceRef = useRef(workspaceMode);
  useEffect(() => {
    if (workspaceMode === "annotation" && prevWorkspaceRef.current !== "annotation") {
      setAnnotationSourceMode("image");
    }
    prevWorkspaceRef.current = workspaceMode;
  }, [workspaceMode]);

  // 切换画像石时回到高清图，避免仍停留在 3D 模型视图
  useEffect(() => {
    if (workspaceMode === "annotation" && selectedId) {
      setAnnotationSourceMode("image");
    }
  }, [selectedId, workspaceMode]);

  useEffect(() => {
    fetchTerms()
      .then(({ categories, terms }) => {
        setVocabularyCategories(categories);
        setVocabularyTerms(terms);
      })
      .catch(() => {
        setVocabularyCategories([]);
        setVocabularyTerms([]);
      });
  }, []);

  // C2 全局键盘快捷键：仅在标注模式 + 焦点不在 input/textarea/contenteditable
  // 时生效，避免在编辑标签 / 备注 / 释文等输入框时被打断。
  useEffect(() => {
    if (!isAnnotationActive) {
      return;
    }
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (target.isContentEditable) return true;
      return false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }
      const key = event.key.toLowerCase();
      const ctrl = event.ctrlKey || event.metaKey;
      // 撤销 / 重做
      if (ctrl && key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          dispatchAnnotation({ type: "redo" });
        } else {
          dispatchAnnotation({ type: "undo" });
        }
        return;
      }
      if (ctrl && key === "y") {
        event.preventDefault();
        dispatchAnnotation({ type: "redo" });
        return;
      }
      // 标定流程中不让 R/E/P/V/S 这种工具切换抢走
      if (annotationState.activeTool === "calibrate") {
        return;
      }
      // 工具切换
      if (!ctrl && !event.shiftKey && !event.altKey) {
        if (key === "v" || key === "escape") {
          if (key === "v") {
            event.preventDefault();
            dispatchAnnotation({ type: "set-tool", tool: "select" });
          }
          // Esc 已经在 AnnotationCanvas 内监听做更细致的"清 SAM / pen"处理；
          // 这里只在 v 上触发，不重复处理 Esc
          return;
        }
        if (key === "r") {
          event.preventDefault();
          dispatchAnnotation({ type: "set-tool", tool: "rect" });
          return;
        }
        if (key === "e") {
          event.preventDefault();
          dispatchAnnotation({ type: "set-tool", tool: "ellipse" });
          return;
        }
        if (key === "p") {
          event.preventDefault();
          dispatchAnnotation({ type: "set-tool", tool: "pen" });
          return;
        }
        if (key === "n") {
          event.preventDefault();
          dispatchAnnotation({ type: "set-tool", tool: "point" });
          return;
        }
        if (key === "f") {
          event.preventDefault();
          bumpReset();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [annotationState.activeTool, isAnnotationActive]);

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    let cancelled = false;
    setAnnotationSaveState({ phase: "idle" });
    fetchIimlDocument(selectedId)
      .then((doc) => {
        if (cancelled) return;
        lastSavedAnnotationRef.current = { stoneId: selectedId, json: JSON.stringify(doc) };
        setAnnotationSaveState({ phase: "saved", savedAt: new Date().toISOString() });
        dispatchAnnotation({ type: "set-doc", doc });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setAnnotationSaveState({ phase: "error", error: error.message });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const saveAnnotationDocumentNow = useCallback(async () => {
    const doc = annotationState.doc;
    if (!selectedId || !doc || !docBelongsToStone(doc, selectedId)) {
      return false;
    }
    const json = JSON.stringify(doc);
    const last = lastSavedAnnotationRef.current;
    if (last?.stoneId === selectedId && last.json === json) {
      setAnnotationSaveState((prev) => ({ phase: "saved", savedAt: prev.savedAt ?? new Date().toISOString() }));
      return true;
    }
    const seq = annotationSaveSeqRef.current + 1;
    annotationSaveSeqRef.current = seq;
    setAnnotationSaveState({ phase: "saving" });
    try {
      await saveIimlDocument(selectedId, doc);
      if (annotationSaveSeqRef.current !== seq) {
        return true;
      }
      lastSavedAnnotationRef.current = { stoneId: selectedId, json };
      const savedAt = new Date().toISOString();
      setAnnotationSaveState({ phase: "saved", savedAt });
      dispatchAnnotation({ type: "set-status", status: "标注已保存" });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (annotationSaveSeqRef.current === seq) {
        setAnnotationSaveState({ phase: "error", error: message });
        dispatchAnnotation({ type: "set-status", status: message });
      }
      return false;
    }
  }, [annotationState.doc, selectedId]);

  useEffect(() => {
    if (workspaceMode !== "annotation" || !selectedId || !annotationState.doc) {
      return;
    }
    if (!docBelongsToStone(annotationState.doc, selectedId)) {
      return;
    }
    const json = JSON.stringify(annotationState.doc);
    const last = lastSavedAnnotationRef.current;
    if (last?.stoneId === selectedId && last.json === json) {
      return;
    }
    setAnnotationSaveState((prev) => (prev.phase === "saving" ? prev : { ...prev, phase: "dirty", error: undefined }));
    const timer = window.setTimeout(() => {
      void saveAnnotationDocumentNow();
    }, 900);
    return () => window.clearTimeout(timer);
  }, [annotationState.doc, saveAnnotationDocumentNow, selectedId, workspaceMode]);

  useEffect(() => {
    const shouldWarn = annotationSaveState.phase === "dirty" || annotationSaveState.phase === "saving" || annotationSaveState.phase === "error";
    if (!shouldWarn) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [annotationSaveState.phase]);

    const selectedAnnotation = useMemo(
    () => annotationState.doc?.annotations.find((annotation) => annotation.id === annotationState.selectedAnnotationId),
    [annotationState.doc?.annotations, annotationState.selectedAnnotationId]
  );
  // P2：mask 修正（补笔/擦除）可用性——高清图底图 + 选中面状标注。
  const maskEditAvailable =
    annotationSourceMode === "image" &&
    Boolean(
      selectedAnnotation &&
        (selectedAnnotation.target.type === "Polygon" ||
          selectedAnnotation.target.type === "MultiPolygon" ||
          selectedAnnotation.target.type === "BBox")
    );
  // 标注间关系（B1 + B2）：
  // - annotationRelations: doc.relations 里的正式关系（人工创建 / 已采纳的空间关系）
  // - spatialRelationCandidates: 运行时基于几何推导出的空间关系候选，不入库；
  //   RelationsEditor 在选中标注时把"涉及该标注且未入库"的候选列出，让用户采纳
  const annotationRelations = useMemo(() => getRelations(annotationState.doc), [annotationState.doc]);
  const spatialRelationCandidates = useMemo(
    () => deriveSpatialRelations(annotationState.doc?.annotations ?? []),
    [annotationState.doc?.annotations]
  );
  // D3 + D4 AI 处理记录
  const annotationProcessingRuns = useMemo(
    () => getProcessingRuns(annotationState.doc),
    [annotationState.doc]
  );

  const deleteSelectedAnnotation = () => {
    if (annotationState.selectedAnnotationId) {
      dispatchAnnotation({ type: "delete-annotation", id: annotationState.selectedAnnotationId });
    }
  };

  const handleExportIiml = useCallback(() => {
    const doc = annotationState.doc;
    if (!doc || !selectedId) {
      return;
    }
    const fileName = `${selectedId}-${formatExportTimestamp()}.iiml.json`;
    downloadBlob(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }), fileName);
    dispatchAnnotation({ type: "set-status", status: `已导出 ${fileName}` });
  }, [annotationState.doc, selectedId]);

  const handleExportCsv = useCallback(() => {
    const doc = annotationState.doc;
    if (!doc || !selectedId) {
      return;
    }
    const fileName = `${selectedId}-${formatExportTimestamp()}.csv`;
    downloadBlob(new Blob([buildAnnotationCsv(doc)], { type: "text/csv;charset=utf-8" }), fileName);
    dispatchAnnotation({ type: "set-status", status: `已导出 ${fileName}` });
  }, [annotationState.doc, selectedId]);

  // D7 COCO 导出：用 stone.metadata.dimensions 推断像素尺寸；若未知用默认 1000
  // 实际 ML 训练时一般会重新校对图像尺寸，这里给一个可用的初值。
  const handleExportCoco = useCallback(() => {
    const doc = annotationState.doc;
    if (!doc || !selectedId) return;
    const dimensions = selectedStone?.metadata?.dimensions;
    const imageSize = {
      width: Math.round(dimensions?.width ?? 1000),
      height: Math.round(dimensions?.height ?? 1000)
    };
    const dataset = exportToCoco(doc, {
      imageSize,
      imageFileName: `${selectedId}.png`
    });
    downloadJson(dataset, `${selectedId}-${formatExportTimestamp()}.coco.json`);
    dispatchAnnotation({
      type: "set-status",
      status: `已导出 COCO（${dataset.annotations.length} 条标注，${imageSize.width}x${imageSize.height}）`
    });
  }, [annotationState.doc, selectedId, selectedStone]);

  // D8 IIIF Web Annotation 导出：canvasId 用占位 URN，后续可自行替换
  // 为真实 IIIF Canvas URL 后再上传到外部平台。
  const handleExportIiif = useCallback(() => {
    const doc = annotationState.doc;
    if (!doc || !selectedId) return;
    const dimensions = selectedStone?.metadata?.dimensions;
    const imageSize = {
      width: Math.round(dimensions?.width ?? 1000),
      height: Math.round(dimensions?.height ?? 1000)
    };
    const page = exportToIiifAnnotationPage(doc, {
      imageSize,
      canvasId: `urn:wsc3d:${selectedId}:canvas`
    });
    downloadJson(page, `${selectedId}-${formatExportTimestamp()}.iiif.json`);
    dispatchAnnotation({
      type: "set-status",
      status: `已导出 IIIF AnnotationPage（${page.items.length} 条 Annotation）`
    });
  }, [annotationState.doc, selectedId, selectedStone]);

  // I3 v0.8.0：.hpsml 研究包导入。用隐藏 file input 触发文件选择，解析 JSON
  // 后 POST 到 /api/hpsml/import；成功后若导入的是当前 stoneId，重新拉 IIML
  // 让画布刷新；否则只显示 status。
  const handleImportHpsml = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.hpsml";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      dispatchAnnotation({
        type: "set-status",
        status: `正在解包 ${file.name}…`
      });
      try {
        const text = await file.text();
        const payload = JSON.parse(text) as unknown;
        const summary = await importHpsmlPackage(payload);
        const reload = summary.stoneId === selectedId;
        dispatchAnnotation({
          type: "set-status",
          status: `已导入 .hpsml（stoneId=${summary.stoneId}）：IIML ${summary.imported.iiml ? "写入" : summary.skipped.iiml ? "跳过" : "未写入"}、标注 ${summary.imported.annotations} / 关系 ${summary.imported.relations} / 拼接方案 ${summary.imported.assemblyPlans}${reload ? "，当前画像石将刷新" : ""}`
        });
        if (reload) {
          try {
            const doc = await fetchIimlDocument(summary.stoneId);
            dispatchAnnotation({ type: "set-doc", doc });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            dispatchAnnotation({
              type: "set-status",
              status: `已导入但刷新画布失败：${message}`
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dispatchAnnotation({
          type: "set-status",
          status: `导入 .hpsml 失败：${message}`
        });
      }
    };
    input.click();
  }, [selectedId]);

  // G2 .hpsml 自定义研究包导出：把 IIML + 拼接方案 + 词表 + 元数据 + 关系网络
  // 打成一个 JSON 包。这是项目自有的研究档案完整格式，便于多机协作 / 长期归档。
  const handleExportHpsml = useCallback(() => {
    const doc = annotationState.doc;
    if (!doc || !selectedId) return;
    // 找出与该 stoneId 相关的拼接方案（任一 item.stoneId 命中即算相关）
    const relatedAssemblyPlans = savedPlans.filter((plan) =>
      plan.items.some((item) => item.stoneId === selectedId)
    );
    const pkg = exportToHpsml(doc, annotationRelations, {
      stone: selectedStone,
      metadata,
      relatedAssemblyPlans,
      vocabularyCategories,
      vocabularyTerms,
      exporter: "local-user"
    });
    downloadJson(pkg, `${selectedId}-${formatExportTimestamp()}.hpsml.json`);
    dispatchAnnotation({
      type: "set-status",
      status: `已导出 .hpsml 研究包（标注 ${pkg.context.networkStats.annotationCount} 条 / 关系 ${pkg.context.networkStats.relationCount} 条 / AI 记录 ${pkg.context.networkStats.processingRunCount} 条 / 拼接方案 ${pkg.context.relatedAssemblyPlans.length} 个）`
    });
  }, [
    annotationState.doc,
    annotationRelations,
    selectedId,
    selectedStone,
    metadata,
    savedPlans,
    vocabularyCategories,
    vocabularyTerms
  ]);

  // M5 Phase 1 A2 主动学习闭环：把 data/iiml/*.iiml.json 跨石头聚合 + SOP §11
  // 准入校验 + 70/15/15 划分 + 写 data/datasets/wsc-han-stone-v0/ 整套目录。
  // 成功后 status 显示三段：accepted / skipped / 报告路径，方便点开看 reports/。
  const handleExportTraining = useCallback(async () => {
    const taskId = `training-export-${Date.now()}`;
    upsertTask({
      id: taskId,
      title: "训练池导出",
      status: "running",
      message: "扫所有 IIML + 校验 + 写盘（后端原子操作，不可取消）"
    });
    dispatchAnnotation({ type: "set-status", status: "训练池导出中（扫所有 IIML + 校验 + 写盘）…" });
    try {
      const summary = await exportTrainingDataset();
      const top3Categories = Object.entries(summary.categoryDistribution)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}=${v}`)
        .join(" / ");
      const warnLine = Object.entries(summary.warningCounts).length === 0
        ? ""
        : ` · 警告 ${Object.values(summary.warningCounts).reduce((a, b) => a + b, 0)}`;
      const qualityLine = Object.entries(summary.annotationQualityDistribution)
        .map(([k, v]) => `${k}=${v}`)
        .join(" / ");
      setTrainingDatasetLocation({
        datasetDir: summary.datasetDir,
        absolutePath: summary.absoluteDatasetDir,
        reportFileName: summary.reportFileName
      });
      upsertTask({
        id: taskId,
        title: "训练池导出",
        status: "done",
        progress: 1,
        message: `${summary.acceptedAnnotations} 条进池 → ${summary.datasetDir}`
      });
      dispatchAnnotation({
        type: "set-status",
        status: `已导出训练集 → ${summary.datasetDir}（${summary.acceptedAnnotations}/${summary.acceptedAnnotations + summary.skippedAnnotations} 进池，train ${summary.splits.train} / val ${summary.splits.val} / test ${summary.splits.test}${warnLine}；质量层 ${qualityLine || "暂无"}；主动学习 ${summary.activeLearningQueueSize} 条；Top: ${top3Categories || "（暂无）"}；报告 reports/${summary.reportFileName}）`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      upsertTask({ id: taskId, title: "训练池导出", status: "failed", message });
      dispatchAnnotation({ type: "set-status", status: `训练池导出失败：${message}` });
    }
  }, [upsertTask]);

  const handleRevealTrainingDataset = useCallback(async () => {
    try {
      const result = await revealTrainingDataset();
      setTrainingDatasetLocation({
        datasetDir: result.datasetDir,
        absolutePath: result.absolutePath
      });
      dispatchAnnotation({
        type: "set-status",
        status: `已打开训练集目录：${result.absolutePath}`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatchAnnotation({ type: "set-status", status: `打开训练集目录失败：${message}` });
    }
  }, []);

  // D 阶段：标注上线前预检。一次接口跑全（pic 配对 / IIML 完整度 / 训练池估算 /
  // 类别均衡），把简化的 status 串拼出来；想看详细可以直接打 /api/preflight 取 JSON。
  const handlePreflight = useCallback(async () => {
    dispatchAnnotation({ type: "set-status", status: "正在预检（pic + IIML + 训练池）…" });
    try {
      const r = await fetchPreflight();
      const catalogLine = (() => {
        const issues: string[] = [];
        if (r.catalog.numericKeyConflictCount > 0) issues.push(`ID 冲突 ${r.catalog.numericKeyConflictCount}`);
        if (r.catalog.orphanModelCount > 0) issues.push(`孤儿模型 ${r.catalog.orphanModelCount}`);
        if (r.catalog.unmatchedMetadataCount > 0) issues.push(`无模型档案 ${r.catalog.unmatchedMetadataCount}`);
        return `catalog ${r.catalog.totalStones} 块（${issues.length ? issues.join(" / ") : "干净"}）`;
      })();
      const picLine = r.pic.exists
        ? `pic ${r.pic.matchedCount}/${r.pic.matchedCount + r.pic.unmatchedStones.length} 配对${r.pic.duplicateKeys.length ? ` · ${r.pic.duplicateKeys.length} 冲突` : ""}`
        : `pic 目录不存在 (${r.pic.picDir})`;
      const iimlLine = `IIML ${r.iiml.totalDocs} 份 / ${r.iiml.annotationsTotal} 条；缺 category ${r.iiml.missingCategoryCount}，缺 motif ${r.iiml.missingMotifInNarrativeCount}，frame=model 未对齐 ${r.iiml.frameModelNoAlignmentCount}`;
      const trainLine = `训练池估算：进池 ${r.trainingReadiness.estimatedAccepted} / 跳过 ${r.trainingReadiness.estimatedSkipped}；样本不足类 ${r.trainingReadiness.underrepresentedCategories.length}`;
      const qualityLine = Object.entries(r.iiml.annotationQualityDistribution)
        .map(([k, v]) => `${k}=${v}`)
        .join(" / ");
      const skipTop = r.trainingReadiness.skipReasonTop
        .slice(0, 3)
        .map((s) => `${s.reason}=${s.count}`)
        .join(" / ");
      dispatchAnnotation({
        type: "set-status",
        status: `预检 · ${catalogLine}；${picLine}；${iimlLine}；质量 ${qualityLine || "暂无"}；${trainLine}${skipTop ? `；Top 阻塞: ${skipTop}` : ""}`
      });
      // eslint-disable-next-line no-console
      console.log("[preflight] full report:", r);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatchAnnotation({ type: "set-status", status: `预检失败：${message}` });
    }
  }, []);

  // SAM 候选审核：接受 = 标记 approved；拒绝 = 直接删除；重试 = 删除后切回 SAM 工具让用户重点。
  const handleAcceptCandidate = useCallback((id: string) => {
    dispatchAnnotation({ type: "update-annotation", id, patch: { reviewStatus: "approved" } });
  }, []);

  const handleRejectCandidate = useCallback((id: string) => {
    dispatchAnnotation({ type: "delete-annotation", id });
  }, []);

  const handleRetryCandidate = useCallback((id: string) => {
    dispatchAnnotation({ type: "delete-annotation", id });
    dispatchAnnotation({
      type: "set-status",
      status: "候选已删除；可在工具栏 SAM3 里换概念词或阈值重新生成"
    });
  }, []);

  const handleBulkAcceptCandidates = useCallback(() => {
    const candidates = annotationState.doc?.annotations.filter((a) => a.reviewStatus === "candidate") ?? [];
    candidates.forEach((annotation) => {
      dispatchAnnotation({ type: "update-annotation", id: annotation.id, patch: { reviewStatus: "approved" } });
    });
  }, [annotationState.doc]);

  const handleBulkRejectCandidates = useCallback(() => {
    const candidates = annotationState.doc?.annotations.filter((a) => a.reviewStatus === "candidate") ?? [];
    candidates.forEach((annotation) => {
      dispatchAnnotation({ type: "delete-annotation", id: annotation.id });
    });
  }, [annotationState.doc]);

  // P2：合并升级为"mask 级"主路径——所有几何栅格化到同一像素网格做 OR，
  // 经形态学清理后重新矢量化（保留洞、清小碎片），比矢量 union 对 SAM 噪声
  // 轮廓稳定得多。AI 服务不可用时回退到旧 polygon-clipping 矢量并集。
  const handleMergeCandidates = useCallback(
    async (ids: string[]) => {
      const doc = annotationState.doc;
      if (!doc || ids.length < 2) {
        return;
      }
      const targets = doc.annotations.filter((annotation) => ids.includes(annotation.id));
      if (targets.length < 2) {
        return;
      }
      const invalid = validateMergeTargets(targets);
      if (invalid) {
        dispatchAnnotation({ type: "set-status", status: describeMergeFailure(invalid) });
        return;
      }

      const commitMerged = (annotation: (typeof targets)[number], method: string) => {
        ids.forEach((id) => dispatchAnnotation({ type: "delete-annotation", id }));
        dispatchAnnotation({ type: "add-annotation", annotation });
        dispatchAnnotation({ type: "select", id: annotation.id });
        dispatchAnnotation({ type: "set-status", status: `已合并 ${targets.length} 个标注（${method}）` });
      };

      // mask 合并的像素网格：image frame 用当前底图 / pic 原图；model frame
      // 用石头档案的宽高比近似（分辨率只影响边缘精度，不影响 UV 坐标系）。
      const frame = targets[0].frame ?? "model";
      const maskPayload: Parameters<typeof composeMask>[0] = {
        baseGeometries: targets.map((annotation) => annotation.target),
        strokes: [],
        returnMask: false,
        returnCutout: false
      };
      if (frame === "image") {
        maskPayload.imageUri = activeImageResource?.uri ?? (selectedStone ? getSourceImageUrl(selectedStone.id) : undefined);
      } else {
        const dimensions = selectedStone?.metadata?.dimensions;
        const aspect = dimensions?.width && dimensions.height ? dimensions.width / dimensions.height : 1;
        const longEdge = 4096;
        maskPayload.imageSize = aspect >= 1
          ? [longEdge, Math.max(64, Math.round(longEdge / aspect))]
          : [Math.max(64, Math.round(longEdge * aspect)), longEdge];
      }

      dispatchAnnotation({ type: "set-status", status: "mask 级合并中…" });
      try {
        const response = await composeMask(maskPayload);
        if (response.ok && response.polygons && response.polygons.length > 0) {
          const geometry = geometryFromMaskPolygons(response.polygons);
          if (geometry) {
            const merged = buildMergedAnnotation(targets, geometry, response.model ?? "mask-compose-v1");
            merged.editOperations = [
              {
                type: "mask-compose",
                at: new Date().toISOString(),
                params: { operation: "merge", sourceCount: targets.length }
              }
            ];
            commitMerged(merged, "mask 合成");
            return;
          }
        }
        console.warn("mask merge returned empty result, falling back to vector union:", response.error);
      } catch (error) {
        console.warn("mask merge unavailable, falling back to vector union:", error);
      }

      // 回退：矢量并集（只保留外环，与历史行为一致）
      const result = mergePolygonAnnotations(targets);
      if (!result.ok) {
        dispatchAnnotation({ type: "set-status", status: describeMergeFailure(result.reason) });
        return;
      }
      commitMerged(result.annotation, "矢量并集回退");
    },
    [annotationState.doc, activeImageResource, selectedStone]
  );

  const handleStartSam3 = useCallback(async (options: Sam3ConceptInput) => {
    if (!selectedStone || !annotationState.doc) {
      return;
    }
    if (sam3Scanning) {
      dispatchAnnotation({ type: "set-status", status: "SAM3 正在运行中，请等待当前任务完成…" });
      return;
    }
    const prompt = options.prompt.trim();
    if (!prompt) {
      return;
    }
    const displayLabel = options.label.trim() || prompt;

    const doc = annotationState.doc;
    const activeUri = activeImageResource?.uri;
    const candidateFrame: AnnotationSourceMode = activeImageResource?.equivalentToModel
      ? "model"
      : annotationSourceMode;
    const candidateResourceId = activeImageResource?.id
      ?? doc.resources?.[0]?.id
      ?? `${selectedStone.id}:model`;
    const startedAt = new Date().toISOString();
    const createdIds: string[] = [];
    let runModel = "sam3";
    let runError: string | undefined;
    let effectivePrompt = prompt;
    let effectiveThreshold = options.threshold;
    let sam3StillRunning = true;
    // G3 任务进度：autoExpand 会尝试 概念词 × 阈值 多个组合，走右下角任务面板，
    // 组合之间可取消（单次推理调用本身不可中断）。
    const taskId = `sam3-${Date.now()}`;
    let cancelled = false;

    setSam3Scanning(true);
    upsertTask({
      id: taskId,
      title: `SAM3 · ${displayLabel}`,
      status: "running",
      cancellable: true,
      message: "准备中…"
    });
    dispatchAnnotation({
      type: "set-status",
      status: activeUri ? `SAM3 正在分割“${displayLabel}”…（${activeImageResource?.type ?? "资源"}）` : `SAM3 正在分割“${displayLabel}”…`
    });
    window.setTimeout(() => {
      if (!sam3StillRunning) return;
      dispatchAnnotation({
        type: "set-status",
        status: `SAM3 首次调用可能正在加载模型。“${displayLabel}”完成后会自动生成候选；若失败会显示错误详情。`
      });
    }, 2000);

    try {
      const promptCandidates = options.autoExpand ? sam3PromptCandidates(prompt) : [prompt];
      const retryThreshold = Math.max(0.1, Number((options.threshold - 0.2).toFixed(2)));
      const thresholds = options.autoExpand && retryThreshold < options.threshold
        ? [options.threshold, retryThreshold]
        : [options.threshold];
      const totalAttempts = thresholds.length * promptCandidates.length;
      let attemptIndex = 0;
      let response: SamSegmentationResponse | undefined;
      let lastEmptyPrompt = prompt;
      outer: for (const threshold of thresholds) {
        for (const candidatePrompt of promptCandidates) {
          if (cancelRequestedRef.current.has(taskId)) {
            cancelled = true;
            break outer;
          }
          attemptIndex += 1;
          upsertTask({
            id: taskId,
            title: `SAM3 · ${displayLabel}`,
            status: "running",
            cancellable: true,
            progress: totalAttempts > 1 ? (attemptIndex - 1) / totalAttempts : undefined,
            message: `尝试“${candidatePrompt}”（阈值 ${threshold}）`
          });
          dispatchAnnotation({
            type: "set-status",
            status: `SAM3 正在尝试“${candidatePrompt}”（阈值 ${threshold}）…`
          });
          const attempt = await runSam3ConceptSegmentation({
            stoneId: activeUri ? undefined : selectedStone.id,
            imageUri: activeUri,
            textPrompt: candidatePrompt,
            threshold,
            maxResults: options.maxResults
          });
          runModel = attempt.model;
          if (attempt.error) {
            response = attempt;
            break;
          }
          if ((attempt.polygons ?? []).length > 0) {
            response = attempt;
            effectivePrompt = candidatePrompt;
            effectiveThreshold = threshold;
            break;
          }
          response = attempt;
          lastEmptyPrompt = candidatePrompt;
        }
        if (response?.error || (response?.polygons ?? []).length > 0) {
          break;
        }
      }
      if (cancelled) {
        runError = "用户取消";
        upsertTask({ id: taskId, title: `SAM3 · ${displayLabel}`, status: "cancelled", message: "已在组合间取消" });
        dispatchAnnotation({ type: "set-status", status: `SAM3 “${displayLabel}”已取消` });
        return;
      }
      if (!response) {
        throw new Error("SAM3 未返回结果");
      }
      runModel = response.model;
      if (response.error) {
        runError = formatSam3Error(response.error, response.detail);
        upsertTask({ id: taskId, title: `SAM3 · ${displayLabel}`, status: "failed", message: runError });
        dispatchAnnotation({ type: "set-status", status: `SAM3 分割失败：${runError}` });
        window.alert(`SAM3 分割失败：${runError}`);
        return;
      }

      const polygons = response.polygons ?? [];
      if (polygons.length === 0) {
        upsertTask({ id: taskId, title: `SAM3 · ${displayLabel}`, status: "done", message: "未找到对应区域" });
        dispatchAnnotation({ type: "set-status", status: `SAM3 未找到“${displayLabel}”对应区域` });
        window.alert(`SAM3 未找到“${displayLabel}”对应区域。已尝试 ${promptCandidates.join(" / ")}，最后尝试为“${lastEmptyPrompt}”。可以换更具体的英文概念词，或用普通 SAM 点选/框选精修。`);
        return;
      }

      const baseColorIndex = doc.annotations.length;
      polygons.forEach((polygon, index) => {
        const uvs = polygon
          .map((point) => ({ u: Number(point[0] ?? 0), v: Number(point[1] ?? 0) }))
          .filter((uv) => Number.isFinite(uv.u) && Number.isFinite(uv.v));
        if (uvs.length < 3) return;
        const detection = response.detections?.[index];
        const annotation = createAnnotationFromGeometry({
          geometry: polygonFromUVs(uvs),
          resourceId: candidateResourceId,
          color: annotationPalette[(baseColorIndex + index) % annotationPalette.length],
          frame: candidateFrame,
          label: `SAM3 候选：${displayLabel}`,
          structuralLevel: "figure",
          reviewStatus: "candidate",
          generation: {
            method: "sam3",
            model: response.model,
            confidence: detection?.score ?? response.confidence,
            prompt: {
              textPrompt: prompt,
              label: displayLabel,
              effectiveTextPrompt: effectivePrompt,
              imageUri: activeUri ?? null,
              threshold: effectiveThreshold,
              maxResults: options.maxResults,
              autoExpand: options.autoExpand
            }
          }
        });
        dispatchAnnotation({ type: "add-annotation", annotation });
        createdIds.push(annotation.id);
      });

      upsertTask({
        id: taskId,
        title: `SAM3 · ${displayLabel}`,
        status: "done",
        progress: 1,
        message: `${createdIds.length} 个候选（概念词：${effectivePrompt}）`
      });
      dispatchAnnotation({
        type: "set-status",
        status: `SAM3 完成，落入 ${createdIds.length} 个“${displayLabel}”候选（实际概念词：${effectivePrompt}）`
      });
    } catch (error) {
      runError = formatSam3Error("sam3-request-failed", error instanceof Error ? error.message : String(error));
      upsertTask({ id: taskId, title: `SAM3 · ${displayLabel}`, status: "failed", message: runError });
      dispatchAnnotation({ type: "set-status", status: `SAM3 调用出错：${runError}` });
      window.alert(`SAM3 调用出错：${runError}`);
    } finally {
      sam3StillRunning = false;
      dispatchAnnotation({
        type: "add-processing-run",
        run: {
          id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          method: "sam3",
          model: runModel,
          input: {
            stoneId: selectedStone.id,
            textPrompt: prompt,
            label: displayLabel,
            effectiveTextPrompt: effectivePrompt,
            threshold: effectiveThreshold,
            maxResults: options.maxResults,
            autoExpand: options.autoExpand,
            imageUri: activeUri ?? null,
            sourceMode: annotationSourceMode
          },
          output: {
            ok: createdIds.length > 0,
            detectionsCount: createdIds.length
          },
          resultAnnotationIds: createdIds,
          resourceId: candidateResourceId,
          frame: candidateFrame,
          startedAt,
          endedAt: new Date().toISOString(),
          error: runError
        }
      });
      cancelRequestedRef.current.delete(taskId);
      setSam3Scanning(false);
    }
  }, [
    activeImageResource,
    annotationSourceMode,
    annotationState.doc,
    cancelRequestedRef,
    sam3Scanning,
    selectedStone,
    upsertTask
  ]);
  useEffect(() => {
    setHasUnsavedAnnotation(
      annotationSaveState.phase === "dirty" ||
        annotationSaveState.phase === "saving" ||
        annotationSaveState.phase === "error"
    );
  }, [annotationSaveState.phase, setHasUnsavedAnnotation]);

  useEffect(() => {
    setSaveState(annotationSaveState);
  }, [annotationSaveState, setSaveState]);

  useEffect(() => {
    setStatusMessage(annotationState.status ?? "");
  }, [annotationState.status, setStatusMessage]);

  useEffect(() => {
    setHasAlignment(hasAlignment);
  }, [hasAlignment, setHasAlignment]);

  return {
    annotationState,
    dispatchAnnotation,
    annotationSaveState,
    trainingDatasetLocation,
    annotationSourceMode,
    setAnnotationSourceMode,
    activeImageResource,
    setActiveImageResource,
    isCalibrating,
    hasAlignment,
    sam3Scanning,
    sam3Status,
    maskEditAvailable,
    vocabularyCategories,
    vocabularyTerms,
    selectedAnnotation,
    annotationRelations,
    spatialRelationCandidates,
    annotationProcessingRuns,
    deleteSelectedAnnotation,
    saveAnnotationDocumentNow,
    handleStartSam3,
    handleMergeCandidates,
    handleAcceptCandidate,
    handleRejectCandidate,
    handleRetryCandidate,
    handleBulkAcceptCandidates,
    handleBulkRejectCandidates,
    handleExportIiml,
    handleExportCsv,
    handleExportCoco,
    handleExportIiif,
    handleExportHpsml,
    handleImportHpsml,
    handleExportTraining,
    handleRevealTrainingDataset,
    handlePreflight
  };
}
