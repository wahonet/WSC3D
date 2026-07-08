/**
 * 应用根组件 `App`
 *
 * 总装整套工作台的全局状态、路由与三大模式切换：
 * - **viewer**（浏览）：单块画像石的 3D / 2D / 正射视图与测距
 * - **assembly**（拼接）：多块模型加载到统一场景的拼接编排
 * - **annotation**（标注）：基于 IIML 文档的图像志标注 + AI 候选闭环
 *
 * 主要职责：
 * 1. 拉取目录数据、画像石元数据、术语库、拼接方案、AI 健康状态等远端资源
 * 2. 维护各模式的本地状态（含 Reducer 管理的标注 store）
 * 3. 处理标注 / 拼接的自动保存、批量任务的进度与取消
 * 4. 派发键盘快捷键、模式切换时的视图重置等跨组件交互
 *
 * 设计要点：
 * - 三大工作区组件全部走 `lazy()` 加载，按需切分主 chunk（D5 优化项）
 * - 一旦进入过 assembly / annotation 就保持组件 mount，仅靠 CSS 控制可见性，
 *   避免 Three.js / Konva 场景被 remount 重建导致 gizmo 与事件链路失效
 * - SAM 健康状态走指数退避轮询 `/ai/health`（10s → 60s 上限）
 * - 标注文档进入 `annotation` 模式后 900 ms 防抖 autosave
 */

import { Camera, MousePointer2, Ruler, RotateCcw, SquareDashedMousePointer, Trash2 } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import * as THREE from "three";
import {
  composeMask,
  fetchAssemblyPlan,
  fetchAssemblyPlans,
  fetchIimlDocument,
  fetchStoneMetadata,
  fetchStones,
  fetchTerms,
  exportTrainingDataset,
  fetchPreflight,
  getSourceImageUrl,
  importHpsmlPackage,
  revealTrainingDataset,
  runSam3ConceptSegmentation,
  saveAssemblyPlan,
  saveIimlDocument,
  type AssemblyPlanRecord,
  type IimlDocument,
  type IimlSource,
  type SamSegmentationResponse,
  type StoneListItem,
  type StoneListResponse,
  type StoneMetadata,
  type VocabularyCategory,
  type VocabularyTerm
} from "./api/client";
import { exportToCoco, exportToHpsml, exportToIiifAnnotationPage, downloadJson } from "./modules/annotation/exporters";
import { createAnnotationFromGeometry, polygonFromUVs } from "./modules/annotation/geometry";
import { computeAlignmentError } from "./modules/annotation/homography";
import {
  formatSam3Error,
  sam3PromptCandidates,
  uniqueSam3Prompts
} from "./modules/annotation/sam3-prompts";
import {
  buildMergedAnnotation,
  describeMergeFailure,
  geometryFromMaskPolygons,
  mergePolygonAnnotations,
  validateMergeTargets
} from "./modules/annotation/merge";
import { TaskProgressPanel, type TaskProgress } from "./modules/annotation/TaskProgressPanel";
import { annotationPalette, annotationReducer, getProcessingRuns, getRelations, initialAnnotationState } from "./modules/annotation/store";
import { deriveSpatialRelations } from "./modules/annotation/spatial";
import type { ActiveImageResourceInfo, AnnotationSourceMode } from "./modules/annotation/AnnotationWorkspace";
import { useAlignmentStatuses } from "./modules/annotation/useAlignmentStatuses";
import type { Sam3ConceptInput } from "./modules/annotation/AnnotationToolbar";
import { useAiHealth } from "./modules/app/useAiHealth";
import type { AdjustmentAxis, AdjustmentMode } from "./modules/assembly/AssemblyAdjustControls";
import type { AssemblyCameraState } from "./modules/assembly/AssemblyWorkspace";
import type { AssemblyDimensions, AssemblyItem, AssemblyTransform } from "./modules/assembly/types";
import type { MeasurementResult, ViewerMode } from "./modules/viewer/StoneViewer";
import type { ViewCubeView } from "./modules/shared/ViewCube";

// D5 代码分割：StoneViewer 也走 lazy（首次进 viewer / annotation / assembly
// 任一模式时才加载 Three.js / OrbitControls / GLTFLoader，主 chunk 显著瘦身）；
// 用 Suspense 兜住首次加载的 1-2s loading 闪烁。
const StoneViewer = lazy(() =>
  import("./modules/viewer/StoneViewer").then((module) => ({ default: module.StoneViewer }))
);
// 按工作模式懒加载拼接/标注两大区的代码。
const AssemblyWorkspace = lazy(() =>
  import("./modules/assembly/AssemblyWorkspace").then((module) => ({ default: module.AssemblyWorkspace }))
);
const AssemblyPanel = lazy(() =>
  import("./modules/assembly/AssemblyPanel").then((module) => ({ default: module.AssemblyPanel }))
);
const AnnotationWorkspace = lazy(() =>
  import("./modules/annotation/AnnotationWorkspace").then((module) => ({ default: module.AnnotationWorkspace }))
);
const AnnotationPanel = lazy(() =>
  import("./modules/annotation/AnnotationPanel").then((module) => ({ default: module.AnnotationPanel }))
);
const AnnotationToolbar = lazy(() =>
  import("./modules/annotation/AnnotationToolbar").then((module) => ({ default: module.AnnotationToolbar }))
);
const BindingWorkspace = lazy(() =>
  import("./modules/binding/BindingWorkspace").then((module) => ({ default: module.BindingWorkspace }))
);

type WorkspaceMode = "viewer" | "assembly" | "annotation" | "binding";
type BackgroundMode = "black" | "gray" | "white";
type AnnotationSavePhase = "idle" | "dirty" | "saving" | "saved" | "error";
type AnnotationSaveState = {
  phase: AnnotationSavePhase;
  savedAt?: string;
  error?: string;
};
type TrainingDatasetLocation = {
  datasetDir: string;
  absolutePath?: string;
  reportFileName?: string;
};

const viewerModeLabels: Record<ViewerMode, string> = {
  "3d": "3D",
  "2d": "2D",
  ortho: "正射"
};

const backgroundLabels: Record<BackgroundMode, string> = {
  black: "黑",
  gray: "灰",
  white: "白"
};

export function App() {
  const [catalog, setCatalog] = useState<StoneListResponse>();
  const [metadata, setMetadata] = useState<StoneMetadata>();
  const [selectedId, setSelectedId] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("viewer");
  const [viewMode, setViewMode] = useState<ViewerMode>("3d");
  const [background, setBackground] = useState<BackgroundMode>("black");
  const [resetToken, setResetToken] = useState(0);
  const [viewerCubeView, setViewerCubeView] = useState<ViewCubeView>("front");
  const [measuring, setMeasuring] = useState(false);
  const [measureClearToken, setMeasureClearToken] = useState(0);
  const [measurement, setMeasurement] = useState<MeasurementResult>();
  const [error, setError] = useState<string>();
  const [assemblyItems, setAssemblyItems] = useState<AssemblyItem[]>([]);
  const [addStoneId, setAddStoneId] = useState("");
  const [selectedAssemblyId, setSelectedAssemblyId] = useState("");
  const [adjustmentStep, setAdjustmentStep] = useState(5);
  const [rotationStep, setRotationStep] = useState(5);
  const [gizmoMode, setGizmoMode] = useState<AdjustmentMode>("translate");
  const [assemblyCameraState, setAssemblyCameraState] = useState<AssemblyCameraState>();
  const [assemblyView, setAssemblyView] = useState<ViewCubeView>("front");
  const [planName, setPlanName] = useState("");
  const [saveStatus, setSaveStatus] = useState<string>();
  const [savedPlans, setSavedPlans] = useState<AssemblyPlanRecord[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [currentPlanId, setCurrentPlanId] = useState<string>();
  const [annotationState, dispatchAnnotation] = useReducer(annotationReducer, initialAnnotationState);
  const [annotationSaveState, setAnnotationSaveState] = useState<AnnotationSaveState>({ phase: "idle" });
  const [trainingDatasetLocation, setTrainingDatasetLocation] = useState<TrainingDatasetLocation>();
  const lastSavedAnnotationRef = useRef<{ stoneId: string; json: string } | undefined>(undefined);
  const annotationSaveSeqRef = useRef(0);
  // 标注底图来源：默认 3D 模型，可切到高清原图（来自 ai-service /ai/source-image）。
  // 切到高清图后 SAM 候选与画布显示在同一坐标系，对齐天然准确。
  const [annotationSourceMode, setAnnotationSourceMode] = useState<AnnotationSourceMode>("model");
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
  const alignmentStatuses = useAlignmentStatuses(selectedId, hasAlignment);
  // G3 任务进度面板：长任务（SAM 批量精修 / 多石头 YOLO）的进度 + 取消
  const [tasks, setTasks] = useState<TaskProgress[]>([]);
  // 取消请求集合：循环里检查 cancelRequestedRef.current.has(taskId) 提前 return
  const cancelRequestedRef = useRef<Set<string>>(new Set());

  const upsertTask = useCallback((task: TaskProgress) => {
    setTasks((prev) => {
      const next = prev.filter((t) => t.id !== task.id);
      next.push(task);
      // 仅保留最新 6 条，避免面板无限增长
      return next.slice(-6);
    });
  }, []);

  const requestCancelTask = useCallback((id: string) => {
    cancelRequestedRef.current.add(id);
  }, []);

  const dismissTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    cancelRequestedRef.current.delete(id);
  }, []);
  const [vocabularyCategories, setVocabularyCategories] = useState<VocabularyCategory[]>([]);
  const [vocabularyTerms, setVocabularyTerms] = useState<VocabularyTerm[]>([]);
  const aiHealth = useAiHealth();
  const sam3Status = aiHealth?.sam3;
  // 一旦进入过拼接/标注模式，保持组件 mount，用 CSS 切换可见性，
  // 避免重建 Three.js / Konva 场景导致 gizmo、相机、TransformControls 链路失效。
  const [hasEnteredAssembly, setHasEnteredAssembly] = useState(false);
  const [hasEnteredAnnotation, setHasEnteredAnnotation] = useState(false);
  const isAssemblyActive = workspaceMode === "assembly";
  const isAnnotationActive = workspaceMode === "annotation";
  const hasUnsavedAnnotation =
    annotationSaveState.phase === "dirty" ||
    annotationSaveState.phase === "saving" ||
    annotationSaveState.phase === "error";

  const requestSelectStone = useCallback(
    (nextId: string) => {
      if (!nextId || nextId === selectedId) return;
      if (
        workspaceMode === "annotation" &&
        hasUnsavedAnnotation &&
        !window.confirm("当前标注还有未保存或保存失败的改动。确定要切换画像石吗？")
      ) {
        return;
      }
      setSelectedId(nextId);
    },
    [hasUnsavedAnnotation, selectedId, workspaceMode]
  );

  useEffect(() => {
    if (isAssemblyActive && !hasEnteredAssembly) {
      setHasEnteredAssembly(true);
    }
    if (isAnnotationActive && !hasEnteredAnnotation) {
      setHasEnteredAnnotation(true);
    }
  }, [hasEnteredAnnotation, hasEnteredAssembly, isAnnotationActive, isAssemblyActive]);

  useEffect(() => {
    fetchStones()
      .then((data) => {
        setCatalog(data);
        const firstWithModel = data.stones.find((stone) => stone.hasModel);
        setSelectedId(firstWithModel?.id ?? data.stones[0]?.id ?? "");
        setAddStoneId(firstWithModel?.id ?? "");
      })
      .catch((err: Error) => setError(err.message));
  }, []);

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

  useEffect(() => {
    fetchAssemblyPlans()
      .then((plans) => {
        setSavedPlans(plans);
        setSelectedPlanId((value) => value || plans[0]?.id || "");
      })
      .catch(() => setSavedPlans([]));
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
          setResetToken((value) => value + 1);
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
    setMetadata(undefined);
    fetchStoneMetadata(selectedId)
      .then(setMetadata)
      .catch(() => setMetadata(undefined));
  }, [selectedId]);

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

  const selectedStone = useMemo(() => catalog?.stones.find((stone) => stone.id === selectedId), [catalog?.stones, selectedId]);
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

  useEffect(() => {
    if (workspaceMode === "assembly" && !planName) {
      setPlanName(createDefaultPlanName());
    }
  }, [planName, workspaceMode]);

  useEffect(() => {
    if (selectedStone?.hasModel) {
      setAddStoneId(selectedStone.id);
    }
  }, [selectedStone]);

  const addAssemblyStone = useCallback(
    (stone: StoneListItem | undefined) => {
      if (!stone?.hasModel || assemblyItems.length >= 10) {
        return;
      }
      const instanceId = `${stone.id}-${Date.now()}-${assemblyItems.length}`;
      const lastItem = assemblyItems[assemblyItems.length - 1];
      const lastX = lastItem?.transform.position[0] ?? 0;
      const lastWidth = lastItem?.baseDimensions?.width ?? 120;
      const newWidth = dimensionsFromStone(stone)?.width ?? 120;
      const offset = assemblyItems.length === 0 ? 0 : lastX + (lastWidth + newWidth) / 2 + 12;
      const item: AssemblyItem = {
        instanceId,
        stone,
        locked: false,
        transform: {
          position: [offset, 0, 0],
          quaternion: [0, 0, 0, 1],
          scale: 1
        },
        baseDimensions: dimensionsFromStone(stone)
      };
      setAssemblyItems((items) => [...items, item]);
      setSelectedAssemblyId(item.instanceId);
      setGizmoMode("translate");
      setSaveStatus(undefined);
      setCurrentPlanId(undefined);
    },
    [assemblyItems]
  );

  const handleAddAssemblyStone = () => {
    const stone = catalog?.stones.find((item) => item.id === addStoneId);
    addAssemblyStone(stone);
  };

  const handleRemoveAssemblyItem = (instanceId: string) => {
    setAssemblyItems((items) => {
      const nextItems = items.filter((item) => item.instanceId !== instanceId);
      if (selectedAssemblyId === instanceId) {
        setSelectedAssemblyId(nextItems[0]?.instanceId ?? "");
      }
      return nextItems;
    });
    setSaveStatus(undefined);
    setCurrentPlanId(undefined);
  };

  const handleSelectAssemblyItem = (instanceId: string) => {
    setSelectedAssemblyId(instanceId);
  };

  const handleClearAssemblySelection = () => {
    setSelectedAssemblyId("");
    setGizmoMode("translate");
  };

  const handleTransformChange = useCallback((instanceId: string, transform: AssemblyTransform) => {
    setAssemblyItems((items) => items.map((item) => (item.instanceId === instanceId ? { ...item, transform } : item)));
    setSaveStatus(undefined);
  }, []);

  const handleDimensionsReady = useCallback((instanceId: string, dimensions: AssemblyDimensions) => {
    setAssemblyItems((items) =>
      items.map((item) => (item.instanceId === instanceId && !item.baseDimensions ? { ...item, baseDimensions: dimensions } : item))
    );
  }, []);

  const adjustSelectedStone = useCallback(
    (mode: AdjustmentMode, axis: AdjustmentAxis, direction: -1 | 1) => {
      setAssemblyItems((items) =>
        items.map((item) => {
          if (item.instanceId !== selectedAssemblyId || item.locked) {
            return item;
          }

          if (mode === "translate") {
            const position = [...item.transform.position] as [number, number, number];
            const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
            position[axisIndex] += adjustmentStep * direction;
            return {
              ...item,
              transform: {
                ...item.transform,
                position
              }
            };
          }

          const axisVector =
            axis === "x" ? new THREE.Vector3(1, 0, 0) : axis === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
          const current = new THREE.Quaternion().fromArray(item.transform.quaternion);
          const delta = new THREE.Quaternion().setFromAxisAngle(axisVector, THREE.MathUtils.degToRad(rotationStep * direction));
          current.premultiply(delta).normalize();
          snapQuaternionToImportantAngles(current, rotationStep);

          return {
            ...item,
            transform: {
              ...item.transform,
              quaternion: current.toArray() as [number, number, number, number]
            }
          };
        })
      );
      setSaveStatus(undefined);
    },
    [adjustmentStep, rotationStep, selectedAssemblyId]
  );

  const resetSelectedStone = useCallback(() => {
    setAssemblyItems((items) =>
      items.map((item, index) =>
        item.instanceId === selectedAssemblyId && !item.locked
          ? {
              ...item,
              transform: {
                position: [index * 150, 0, 0],
                quaternion: [0, 0, 0, 1],
                scale: 1
              }
            }
          : item
      )
    );
    setSaveStatus(undefined);
  }, [selectedAssemblyId]);

  const handleScaleLongEdge = useCallback((instanceId: string, targetLongEdge: number) => {
    setAssemblyItems((items) =>
      items.map((item) => {
        if (item.instanceId !== instanceId || item.locked || !item.baseDimensions || targetLongEdge <= 0) {
          return item;
        }
        return {
          ...item,
          transform: {
            ...item.transform,
            scale: clamp(targetLongEdge / item.baseDimensions.longEdge, 0.01, 100)
          }
        };
      })
    );
    setSaveStatus(undefined);
  }, []);

  const handleSavePlan = useCallback(async () => {
    if (assemblyItems.length === 0) {
      return;
    }

    const nextName = planName.trim() || createDefaultPlanName();
    setSaveStatus("正在保存...");
    try {
      const saved = await saveAssemblyPlan({
        id: currentPlanId,
        name: nextName,
        items: assemblyItems.map((item) => ({
          instanceId: item.instanceId,
          stoneId: item.stone.id,
          displayName: item.stone.displayName,
          locked: item.locked,
          transform: item.transform,
          baseDimensions: item.baseDimensions
        }))
      });
      setCurrentPlanId(saved.id);
      setPlanName(saved.name);
      setSelectedPlanId(saved.id);
      setSavedPlans((plans) => [saved, ...plans.filter((plan) => plan.id !== saved.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setSaveStatus(`已保存：${saved.name}`);
    } catch (err) {
      setSaveStatus(err instanceof Error ? err.message : "保存失败");
    }
  }, [assemblyItems, currentPlanId, planName]);

  const handleLoadPlan = useCallback(async () => {
    if (!selectedPlanId || !catalog) {
      return;
    }
    setSaveStatus("正在加载...");
    try {
      const plan = await fetchAssemblyPlan(selectedPlanId);
      const restoredItems = plan.items
        .map((saved, index): AssemblyItem | undefined => {
          const stone = catalog.stones.find((item) => item.id === saved.stoneId);
          if (!stone?.hasModel) {
            return undefined;
          }
          const baseDimensions = saved.baseDimensions ?? dimensionsFromStone(stone);
          return {
            instanceId: saved.instanceId || `${stone.id}-${Date.now()}-${index}`,
            stone,
            locked: saved.locked,
            transform: coerceTransform(saved.transform, index),
            ...(baseDimensions ? { baseDimensions } : {})
          };
        })
        .filter((item): item is AssemblyItem => item !== undefined);

      setAssemblyItems(restoredItems);
      setSelectedAssemblyId(restoredItems[0]?.instanceId ?? "");
      setGizmoMode("translate");
      setCurrentPlanId(plan.id);
      setPlanName(plan.name);
      setSaveStatus(`已加载：${plan.name}`);
    } catch (err) {
      setSaveStatus(err instanceof Error ? err.message : "加载失败");
    }
  }, [catalog, selectedPlanId]);

  const enterAnnotationMode = () => {
    if (viewMode !== "2d") {
      setViewMode("2d");
    }
    setWorkspaceMode("annotation");
    dispatchAnnotation({ type: "set-tool", tool: "select" });
  };

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
      dispatchAnnotation({
        type: "set-status",
        status: `已导出训练集 → ${summary.datasetDir}（${summary.acceptedAnnotations}/${summary.acceptedAnnotations + summary.skippedAnnotations} 进池，train ${summary.splits.train} / val ${summary.splits.val} / test ${summary.splits.test}${warnLine}；质量层 ${qualityLine || "暂无"}；主动学习 ${summary.activeLearningQueueSize} 条；Top: ${top3Categories || "（暂无）"}；报告 reports/${summary.reportFileName}）`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatchAnnotation({ type: "set-status", status: `训练池导出失败：${message}` });
    }
  }, []);

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
    if (!selectedStone || !annotationState.doc || sam3Scanning) {
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

    setSam3Scanning(true);
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
      let response: SamSegmentationResponse | undefined;
      let lastEmptyPrompt = prompt;
      for (const threshold of thresholds) {
        for (const candidatePrompt of promptCandidates) {
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
      if (!response) {
        throw new Error("SAM3 未返回结果");
      }
      runModel = response.model;
      if (response.error) {
        runError = formatSam3Error(response.error, response.detail);
        dispatchAnnotation({ type: "set-status", status: `SAM3 分割失败：${runError}` });
        window.alert(`SAM3 分割失败：${runError}`);
        return;
      }

      const polygons = response.polygons ?? [];
      if (polygons.length === 0) {
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

      dispatchAnnotation({
        type: "set-status",
        status: `SAM3 完成，落入 ${createdIds.length} 个“${displayLabel}”候选（实际概念词：${effectivePrompt}）`
      });
    } catch (error) {
      runError = formatSam3Error("sam3-request-failed", error instanceof Error ? error.message : String(error));
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
      setSam3Scanning(false);
    }
  }, [
    activeImageResource,
    annotationSourceMode,
    annotationState.doc,
    sam3Scanning,
    selectedStone
  ]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src="/嘉logo.png" alt="" />
          <div>
            <strong>汉画像石数字化研究平台</strong>
            <small>工作版</small>
          </div>
        </div>

        <nav className="mode-tabs" aria-label="工作模式">
          <button className={workspaceMode === "viewer" ? "active" : ""} onClick={() => setWorkspaceMode("viewer")}>
            浏览
          </button>
          <button className={workspaceMode === "assembly" ? "active" : ""} onClick={() => setWorkspaceMode("assembly")}>
            拼接
          </button>
          <button className={workspaceMode === "annotation" ? "active" : ""} disabled={!selectedStone?.hasModel} onClick={enterAnnotationMode}>
            标注
          </button>
          <button className={workspaceMode === "binding" ? "active" : ""} onClick={() => setWorkspaceMode("binding")}>
            关联
          </button>
        </nav>

        <label className="stone-select">
          <span>画像石</span>
          <select value={selectedId} onChange={(event) => requestSelectStone(event.target.value)}>
            {catalog?.stones.map((stone) => {
              // ✓ 表示已完成 4 点对齐校准；前缀让用户在下拉里一眼区分
              const aligned = alignmentStatuses[stone.id];
              const prefix = aligned ? "✓ " : "  ";
              return (
                <option value={stone.id} key={stone.id}>
                  {prefix}
                  {stone.id.replace("asset-", "#")} {stone.displayName}
                </option>
              );
            })}
          </select>
        </label>
      </header>

      <div className={`workspace-grid${workspaceMode === "binding" ? " is-wide" : ""}`}>
        <aside className="tool-rail" aria-label="工具栏">
          {workspaceMode === "annotation" ? (
            <Suspense fallback={null}>
              <AnnotationToolbar
                activeTool={annotationState.activeTool}
                calibrating={isCalibrating}
                canDelete={Boolean(annotationState.selectedAnnotationId)}
                canRedo={annotationState.redoStack.length > 0}
                canUndo={annotationState.undoStack.length > 0}
                hasAlignment={hasAlignment}
                maskEditAvailable={maskEditAvailable}
                sam3Scanning={sam3Scanning}
                sam3Status={sam3Status}
                onCancelCalibration={() => dispatchAnnotation({ type: "set-tool", tool: "select" })}
                onDeleteSelected={deleteSelectedAnnotation}
                onRedo={() => dispatchAnnotation({ type: "redo" })}
                onResetView={() => setResetToken((value) => value + 1)}
                onStartCalibration={() => dispatchAnnotation({ type: "set-tool", tool: "calibrate" })}
                onStartSam3={handleStartSam3}
                onToolChange={(tool) => dispatchAnnotation({ type: "set-tool", tool })}
                onUndo={() => dispatchAnnotation({ type: "undo" })}
              />
            </Suspense>
          ) : (
            <>
              <IconButton title="选择" icon={<MousePointer2 size={18} />} active />
              <IconButton title="框选预留" icon={<SquareDashedMousePointer size={18} />} disabled />
              <IconButton title="重置视角" icon={<RotateCcw size={18} />} onClick={() => setResetToken((value) => value + 1)} />
              <IconButton title="截图" icon={<Camera size={18} />} disabled />
            </>
          )}
        </aside>

        <main className="main-viewport">
          {error ? <div className="empty-state">{error}</div> : null}
          {workspaceMode === "viewer" && selectedStone ? (
            <Suspense fallback={<div className="empty-state">正在加载浏览模块...</div>}>
              <StoneViewer
                key={`${selectedStone.id}-${resetToken}`}
                stone={selectedStone}
                viewMode={viewMode}
                background={background}
                measuring={measuring}
                measureToken={measureClearToken}
                cubeView={viewerCubeView}
                onCubeViewChange={setViewerCubeView}
                onMeasureChange={setMeasurement}
              />
            </Suspense>
          ) : null}
          {hasEnteredAssembly ? (
            <Suspense fallback={<div className="empty-state">正在加载拼接模块...</div>}>
              <div className={isAssemblyActive ? "workspace-layer is-active" : "workspace-layer is-hidden"}>
                <AssemblyWorkspace
                  active={isAssemblyActive}
                  items={assemblyItems}
                  selectedItemId={selectedAssemblyId}
                  adjustmentStep={adjustmentStep}
                  rotationStep={rotationStep}
                  gizmoMode={gizmoMode}
                  resetToken={resetToken}
                  activeView={assemblyView}
                  cameraState={assemblyCameraState}
                  onSelectItem={handleSelectAssemblyItem}
                  onClearSelection={handleClearAssemblySelection}
                  onStepChange={setAdjustmentStep}
                  onRotationStepChange={setRotationStep}
                  onGizmoModeChange={setGizmoMode}
                  onViewChange={setAssemblyView}
                  onAdjust={adjustSelectedStone}
                  onResetSelected={resetSelectedStone}
                  onTransformChange={handleTransformChange}
                  onDimensionsReady={handleDimensionsReady}
                  onCameraStateChange={setAssemblyCameraState}
                />
              </div>
            </Suspense>
          ) : null}
          {workspaceMode === "binding" ? (
            <Suspense fallback={<div className="empty-state">正在加载关联模块...</div>}>
              <BindingWorkspace
                active={workspaceMode === "binding"}
                stones={catalog?.stones ?? []}
                selectedStoneId={selectedId}
                onSelectStone={requestSelectStone}
                onChanged={() => setResetToken((v) => v + 1)}
              />
            </Suspense>
          ) : null}
          {hasEnteredAnnotation && selectedStone ? (
            <Suspense fallback={<div className="empty-state">正在加载标注模块...</div>}>
              <div className={isAnnotationActive ? "workspace-layer is-active" : "workspace-layer is-hidden"}>
                <AnnotationWorkspace
                  active={isAnnotationActive}
                  activeTool={annotationState.activeTool}
                  background={background}
                  doc={annotationState.doc}
                  draftAnnotationId={annotationState.draftAnnotationId}
                  fitToken={resetToken}
                  selectedAnnotationId={annotationState.selectedAnnotationId}
                  sourceMode={annotationSourceMode}
                  stone={selectedStone}
                  onActiveImageResourceChange={setActiveImageResource}
                  onCreate={(annotation, asDraft) => dispatchAnnotation({ type: "add-annotation", annotation, asDraft })}
                  onDelete={(id) => dispatchAnnotation({ type: "delete-annotation", id })}
                  onSaveAlignment={(alignment) => {
                    dispatchAnnotation({ type: "set-alignment", alignment });
                    // P2：保存后给出重投影误差反馈（4 点时≈0，主要确认矩阵非退化；
                    // >4 点时反映真实标定质量）。状态条提示，不阻断流程。
                    const report = computeAlignmentError(alignment);
                    if (report) {
                      const px = report.meanError * 1500;
                      dispatchAnnotation({
                        type: "set-status",
                        status: report.ready
                          ? `对齐已保存（${report.pointCount} 点，重投影误差 ${report.meanError.toFixed(4)} UV ≈ ${px.toFixed(0)} px）`
                          : `对齐已保存，但重投影误差偏大（${report.meanError.toFixed(4)} UV ≈ ${px.toFixed(0)} px），建议复查控制点`
                      });
                    }
                  }}
                  onSelect={(id) => dispatchAnnotation({ type: "select", id })}
                  onSourceModeChange={setAnnotationSourceMode}
                  onStatusMessage={(status) => dispatchAnnotation({ type: "set-status", status })}
                  onToolChange={(tool) => dispatchAnnotation({ type: "set-tool", tool })}
                  onUpdate={(id, patch) => dispatchAnnotation({ type: "update-annotation", id, patch })}
                />
              </div>
            </Suspense>
          ) : null}
        </main>

        {workspaceMode === "binding" ? null : (
        <aside className="side-panel">
          {workspaceMode === "annotation" ? (
            <Suspense fallback={<section className="panel-section"><p className="muted-text">正在加载标注面板...</p></section>}>
              <AnnotationPanel
                doc={annotationState.doc}
                draftAnnotationId={annotationState.draftAnnotationId}
                metadata={metadata}
                selectedAnnotation={selectedAnnotation}
                saveState={annotationSaveState}
                statusMessage={annotationState.status}
                trainingDatasetLocation={trainingDatasetLocation}
                vocabularyCategories={vocabularyCategories}
                vocabularyTerms={vocabularyTerms}
                onAcceptCandidate={handleAcceptCandidate}
                onBulkAcceptCandidates={handleBulkAcceptCandidates}
                onBulkRejectCandidates={handleBulkRejectCandidates}
                onConfirmDraft={() => {
                  dispatchAnnotation({ type: "set-draft", id: undefined });
                  dispatchAnnotation({ type: "set-status", status: "标注已完成" });
                }}
                onDeleteAnnotation={(id) => dispatchAnnotation({ type: "delete-annotation", id })}
                onExportCsv={handleExportCsv}
                onExportIiml={handleExportIiml}
                onExportCoco={handleExportCoco}
                onExportIiif={handleExportIiif}
                onExportHpsml={handleExportHpsml}
                onExportTraining={handleExportTraining}
                onRevealTrainingDataset={handleRevealTrainingDataset}
                onPreflight={handlePreflight}
                onImportHpsml={handleImportHpsml}
                onManualSave={saveAnnotationDocumentNow}
                onAddResource={(resource) => dispatchAnnotation({ type: "add-resource", resource })}
                onUpdateResource={(id, patch) => dispatchAnnotation({ type: "update-resource", id, patch })}
                onDeleteResource={(id) => dispatchAnnotation({ type: "delete-resource", id })}
                stone={selectedStone}
                onStatusMessage={(status) => dispatchAnnotation({ type: "set-status", status })}
                onMergeCandidates={handleMergeCandidates}
                onRejectCandidate={handleRejectCandidate}
                onRetryCandidate={handleRetryCandidate}
                onSelectAnnotation={(id) => dispatchAnnotation({ type: "select", id })}
                onUpdateAnnotation={(id, patch) => dispatchAnnotation({ type: "update-annotation", id, patch })}
                processingRuns={annotationProcessingRuns}
                relations={annotationRelations}
                spatialCandidates={spatialRelationCandidates}
                onAddRelation={(relation) => dispatchAnnotation({ type: "add-relation", relation })}
                onUpdateRelation={(id, patch) => dispatchAnnotation({ type: "update-relation", id, patch })}
                onDeleteRelation={(id) => dispatchAnnotation({ type: "delete-relation", id })}
              />
            </Suspense>
          ) : (
            <>
              <CurrentRecord metadata={metadata} stone={selectedStone} />

              {workspaceMode === "viewer" ? (
                <>
                  <section className="panel-section">
                    <div className="section-title">视图</div>
                    <div className="segmented">
                      {(Object.keys(viewerModeLabels) as ViewerMode[]).map((mode) => (
                        <button key={mode} className={viewMode === mode ? "active" : ""} onClick={() => setViewMode(mode)}>
                          {viewerModeLabels[mode]}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="panel-section">
                    <label className="select-row">
                      <span>背景</span>
                      <select value={background} onChange={(event) => setBackground(event.target.value as BackgroundMode)}>
                        {Object.entries(backgroundLabels).map(([value, label]) => (
                          <option value={value} key={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </section>

                  <MeasurePanel
                    stone={selectedStone}
                    measuring={measuring}
                    measurement={measurement}
                    onToggle={() => {
                      setMeasuring((value) => !value);
                      setMeasurement(undefined);
                    }}
                    onClear={() => {
                      setMeasurement(undefined);
                      setMeasureClearToken((value) => value + 1);
                    }}
                  />

                  <IntroPanel metadata={metadata} />
                </>
              ) : (
                <Suspense fallback={<section className="panel-section"><p className="muted-text">正在加载拼接面板...</p></section>}>
                  <AssemblyPanel
                    stones={catalog?.stones ?? []}
                    items={assemblyItems}
                    addStoneId={addStoneId}
                    selectedItemId={selectedAssemblyId}
                    planName={planName}
                    saveStatus={saveStatus}
                    savedPlans={savedPlans}
                    selectedPlanId={selectedPlanId}
                    canSave={assemblyItems.length > 0}
                    canLoadPlan={Boolean(selectedPlanId && catalog)}
                    onAddStoneIdChange={setAddStoneId}
                    onAddStone={handleAddAssemblyStone}
                    onSelectItem={handleSelectAssemblyItem}
                    onRemove={handleRemoveAssemblyItem}
                    onToggleLock={(instanceId) =>
                      setAssemblyItems((items) => items.map((item) => (item.instanceId === instanceId ? { ...item, locked: !item.locked } : item)))
                    }
                    onScaleLongEdge={handleScaleLongEdge}
                    onPlanNameChange={(name) => {
                      setPlanName(name);
                      setCurrentPlanId(undefined);
                    }}
                    onSavePlan={handleSavePlan}
                    onSelectedPlanChange={setSelectedPlanId}
                    onLoadPlan={handleLoadPlan}
                  />
                </Suspense>
              )}
            </>
          )}
        </aside>
        )}
      </div>
      <TaskProgressPanel
        tasks={tasks}
        onCancel={requestCancelTask}
        onDismiss={dismissTask}
      />
    </div>
  );
}

function MeasurePanel({
  stone,
  measuring,
  measurement,
  onToggle,
  onClear
}: {
  stone?: StoneListItem;
  measuring: boolean;
  measurement?: MeasurementResult;
  onToggle: () => void;
  onClear: () => void;
}) {
  const dimensions = stone?.metadata?.dimensions;
  const realLong = dimensions ? Math.max(dimensions.width ?? 0, dimensions.height ?? 0, dimensions.thickness ?? 0) : 0;
  const hasRealScale = realLong > 0;

  return (
    <section className="panel-section">
      <div className="section-title">测量</div>
      <div className="measure-row">
        <button className={`segmented-cta${measuring ? " active" : ""}`} onClick={onToggle}>
          <Ruler size={15} />
          <span>{measuring ? "退出测距" : "开启测距"}</span>
        </button>
        {measurement ? (
          <button className="ghost-cta" onClick={onClear} title="清除测量">
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>
      <p className="muted-text measure-hint-text">
        {hasRealScale ? "已按结构化尺寸校准" : "未匹配结构化尺寸，按模型单位显示"}
      </p>
      {measurement ? (
        <dl className="measure-readout">
          <dt>距离</dt>
          <dd>
            {measurement.realDistance !== undefined
              ? `${measurement.realDistance.toFixed(2)} cm`
              : `${measurement.modelDistance.toFixed(3)} 模型单位`}
          </dd>
          {measurement.realDistance !== undefined ? (
            <>
              <dt>模型距离</dt>
              <dd>{measurement.modelDistance.toFixed(3)} 单位</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className="muted-text">{measuring ? "在视图中点击两个点完成一次测量。" : "开启后在模型上拾取两个点。"}</p>
      )}
    </section>
  );
}

function CurrentRecord({ metadata, stone }: { metadata?: StoneMetadata; stone?: StoneListItem }) {
  const dimensions = metadata?.dimensions ?? stone?.metadata?.dimensions;

  return (
    <section className="panel-header record-header">
      <dl className="current-record">
        <dt>当前藏品</dt>
        <dd>{stone?.displayName ?? "正在读取..."}</dd>
        <dt>尺寸</dt>
        <dd>{formatDimensions(dimensions)}</dd>
      </dl>
    </section>
  );
}

function IntroPanel({ metadata }: { metadata?: StoneMetadata }) {
  const content = metadata?.layers.map((layer) => layer.content).filter(Boolean) ?? [];

  return (
    <details className="panel-section intro-panel">
      <summary>
        <span>简介</span>
      </summary>
      {content.length > 0 ? content.map((paragraph, index) => <p key={`${index}-${paragraph.slice(0, 12)}`}>{paragraph}</p>) : <p>暂无简介。</p>}
    </details>
  );
}

function dimensionsFromStone(stone: StoneListItem): AssemblyDimensions | undefined {
  const dimensions = stone.metadata?.dimensions;
  if (!dimensions?.width || !dimensions.height || !dimensions.thickness) {
    return undefined;
  }
  const width = dimensions.width;
  const length = dimensions.height;
  const thickness = dimensions.thickness;
  return {
    width,
    length,
    thickness,
    longEdge: Math.max(width, length, thickness),
    unit: "cm",
    source: "metadata"
  };
}

function coerceTransform(transform: Partial<AssemblyTransform> | undefined, index: number): AssemblyTransform {
  const position = Array.isArray(transform?.position) && transform.position.length === 3 ? transform.position : ([index * 150, 0, 0] as [number, number, number]);
  const quaternion =
    Array.isArray(transform?.quaternion) && transform.quaternion.length === 4 ? transform.quaternion : ([0, 0, 0, 1] as [number, number, number, number]);
  const scale = Number(transform?.scale ?? 1);
  return {
    position: position.map((value) => Number(value) || 0) as [number, number, number],
    quaternion: quaternion.map((value, quaternionIndex) => Number(value) || (quaternionIndex === 3 ? 1 : 0)) as [number, number, number, number],
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1
  };
}

function snapQuaternionToImportantAngles(quaternion: THREE.Quaternion, step: number) {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  const threshold = THREE.MathUtils.degToRad(Math.min(3, Math.max(0.5, step * 0.6)));
  const targets = [Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI];
  let changed = false;

  for (const axis of ["x", "y", "z"] as const) {
    const snapped = targets.find((target) => Math.abs(shortAngleDistance(euler[axis], target)) <= threshold);
    if (snapped !== undefined) {
      euler[axis] = snapped;
      changed = true;
    }
  }

  if (changed) {
    quaternion.setFromEuler(euler).normalize();
  }
}

function shortAngleDistance(a: number, b: number) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function createDefaultPlanName() {
  const now = new Date();
  const date = now.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }).replace(/\//gu, "-");
  const time = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `拼接方案 ${date} ${time}`;
}

function formatExportTimestamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function docBelongsToStone(doc: IimlDocument, stoneId: string): boolean {
  if (doc.documentId === `${stoneId}:iiml` || doc.documentId === stoneId) return true;
  const objectId = (doc.culturalObject as { objectId?: unknown } | undefined)?.objectId;
  return objectId === stoneId;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// 构造 UTF-8 BOM + CRLF 行的 CSV，方便 Excel / Numbers 直接双击打开并识别编码。
function buildAnnotationCsv(doc: IimlDocument): string {
  const header = [
    "id",
    "structuralLevel",
    "label",
    "preIconographic",
    "iconographicMeaning",
    "iconologicalMeaning",
    "terms",
    "inscriptionTranscription",
    "inscriptionTranslation",
    "inscriptionReadingNote",
    "sources",
    "notes"
  ];
  const rows = doc.annotations.map((annotation) => [
    annotation.id,
    annotation.structuralLevel,
    annotation.label ?? "",
    annotation.semantics?.preIconographic ?? "",
    annotation.semantics?.iconographicMeaning ?? "",
    annotation.semantics?.iconologicalMeaning ?? "",
    (annotation.semantics?.terms ?? []).map((term) => term.label).join(" | "),
    annotation.semantics?.inscription?.transcription ?? "",
    annotation.semantics?.inscription?.translation ?? "",
    annotation.semantics?.inscription?.readingNote ?? "",
    (annotation.sources ?? []).map(stringifyCsvSource).join(" | "),
    annotation.notes ?? ""
  ]);
  const escape = (value: string) => (/[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value);
  const lines = [header.join(","), ...rows.map((row) => row.map(escape).join(","))];
  return `\ufeff${lines.join("\r\n")}`;
}

function stringifyCsvSource(source: IimlSource): string {
  switch (source.kind) {
    case "metadata":
      return source.panelIndex !== undefined
        ? `档案 L${source.layerIndex}·P${source.panelIndex + 1}`
        : `档案 L${source.layerIndex}`;
    case "reference":
      return source.title || source.citation || source.uri || "文献";
    case "resource":
      return `资源 ${source.resourceId || ""}`.trim();
    case "other":
      return source.text || "其他";
    default:
      return "";
  }
}

function IconButton({
  title,
  icon,
  active,
  disabled,
  onClick
}: {
  title: string;
  icon: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button className={active ? "rail-button active" : "rail-button"} title={title} disabled={disabled} onClick={onClick}>
      {icon}
    </button>
  );
}

function formatDimensions(dimensions?: { width?: number; height?: number; thickness?: number; raw?: string; unit?: string }) {
  if (!dimensions) {
    return "待补充";
  }
  if (dimensions.height && dimensions.width && dimensions.thickness) {
    return `${dimensions.width} x ${dimensions.height} x ${dimensions.thickness} ${dimensions.unit ?? "cm"}`;
  }
  return dimensions.raw ?? "待补充";
}
