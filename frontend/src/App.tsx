import { Camera, MousePointer2, Ruler, RotateCcw, SquareDashedMousePointer, Trash2 } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import * as THREE from "three";
import {
  fetchAiHealth,
  fetchAlignmentStatuses,
  fetchAssemblyPlan,
  fetchAssemblyPlans,
  fetchIimlDocument,
  fetchStoneMetadata,
  fetchStones,
  fetchTerms,
  runYoloDetection,
  saveAssemblyPlan,
  saveIimlDocument,
  type AssemblyPlanRecord,
  type IimlDocument,
  type IimlSource,
  type SamStatus,
  type StoneListItem,
  type StoneListResponse,
  type StoneMetadata,
  type VocabularyCategory,
  type VocabularyTerm
} from "./api/client";
import { exportToCoco, exportToHpsml, exportToIiifAnnotationPage, downloadJson } from "./modules/annotation/exporters";
import { createAnnotationFromGeometry, polygonFromUVs } from "./modules/annotation/geometry";
import { describeMergeFailure, mergePolygonAnnotations } from "./modules/annotation/merge";
import { refineBBoxWithSam } from "./modules/annotation/sam";
import { TaskProgressPanel, type TaskProgress } from "./modules/annotation/TaskProgressPanel";
import { annotationPalette, annotationReducer, getProcessingRuns, getRelations, initialAnnotationState } from "./modules/annotation/store";
import { deriveSpatialRelations } from "./modules/annotation/spatial";
import type { AnnotationSourceMode } from "./modules/annotation/AnnotationWorkspace";
import type { YoloScanOptions } from "./modules/annotation/YoloScanDialog";
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

type WorkspaceMode = "viewer" | "assembly" | "annotation";
type BackgroundMode = "black" | "gray" | "white";

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
  // 标注底图来源：默认 3D 模型，可切到高清原图（来自 ai-service /ai/source-image）。
  // 切到高清图后 SAM 候选与画布显示在同一坐标系，对齐天然准确。
  const [annotationSourceMode, setAnnotationSourceMode] = useState<AnnotationSourceMode>("model");
  // 当前是否处于"对齐校准"流程；只是把 activeTool 同步给 toolbar 显示用。
  const isCalibrating = annotationState.activeTool === "calibrate";
  const hasAlignment = Boolean(
    annotationState.doc?.culturalObject &&
      (annotationState.doc.culturalObject as { alignment?: unknown }).alignment
  );
  // YOLO 批量扫描：dialog 状态 + 推理进行中标记
  const [yoloDialogOpen, setYoloDialogOpen] = useState(false);
  const [yoloScanning, setYoloScanning] = useState(false);
  // C5' 头部画像石下拉：每块石头是否已做 4 点对齐校准
  const [alignmentStatuses, setAlignmentStatuses] = useState<Record<string, boolean>>({});
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
  // AI 服务健康状态；/ai/health 轮询到 sam.ready 就停止，断连则持续重试。
  const [samStatus, setSamStatus] = useState<SamStatus | undefined>(undefined);
  // 一旦进入过拼接/标注模式，保持组件 mount，用 CSS 切换可见性，
  // 避免重建 Three.js / Konva 场景导致 gizmo、相机、TransformControls 链路失效。
  const [hasEnteredAssembly, setHasEnteredAssembly] = useState(false);
  const [hasEnteredAnnotation, setHasEnteredAnnotation] = useState(false);
  const isAssemblyActive = workspaceMode === "assembly";
  const isAnnotationActive = workspaceMode === "annotation";

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
    let alive = true;
    let timer: number | undefined;
    // 指数退避：10s → 20s → 40s，上限 60s；sam.ready 或 error 时直接停止。
    // 避免 SAM 模型下载慢时前端每 5 秒刷屏 /ai/health。
    let delay = 10_000;
    const tick = async () => {
      try {
        const health = await fetchAiHealth();
        if (!alive) {
          return;
        }
        setSamStatus(health.sam);
        // ready / error 都是终态，不再轮询；error 需要用户介入（装依赖或手放权重）。
        if (!health.sam || health.sam.ready || health.sam.status === "error") {
          return;
        }
        timer = window.setTimeout(tick, delay);
        delay = Math.min(delay * 2, 60_000);
      } catch {
        if (!alive) {
          return;
        }
        setSamStatus(undefined);
        timer = window.setTimeout(tick, delay);
        delay = Math.min(delay * 2, 60_000);
      }
    };
    tick();
    return () => {
      alive = false;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    fetchAssemblyPlans()
      .then((plans) => {
        setSavedPlans(plans);
        setSelectedPlanId((value) => value || plans[0]?.id || "");
      })
      .catch(() => setSavedPlans([]));
  }, []);

  // 启动时一次性拉所有画像石的 alignment 状态，供下拉显示 ✓ / 未校准提示。
  // 当前 doc 改动（保存对齐 / 清除）时本地直接维护 map，避免重复请求 backend。
  useEffect(() => {
    fetchAlignmentStatuses().then(setAlignmentStatuses).catch(() => undefined);
  }, []);

  // 当本地 alignment 改动（dispatchAnnotation 'set-alignment' 后），同步本地 map
  // 让下拉立即反映 —— autosave 写盘后下次刷新也能持久。
  useEffect(() => {
    if (!selectedId) return;
    setAlignmentStatuses((prev) => {
      const next = { ...prev };
      next[selectedId] = hasAlignment;
      return next;
    });
  }, [hasAlignment, selectedId]);

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
          // n = poiNt（s 给 SAM 占用了）
          event.preventDefault();
          dispatchAnnotation({ type: "set-tool", tool: "point" });
          return;
        }
        if (key === "s") {
          // SAM 未就绪时静默忽略
          if (samStatus?.ready) {
            event.preventDefault();
            dispatchAnnotation({ type: "set-tool", tool: "sam" });
          }
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
  }, [annotationState.activeTool, isAnnotationActive, samStatus?.ready]);

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
    fetchIimlDocument(selectedId)
      .then((doc) => {
        dispatchAnnotation({ type: "set-doc", doc });
      })
      .catch(() => undefined);
  }, [selectedId]);

  useEffect(() => {
    if (workspaceMode !== "annotation" || !selectedId || !annotationState.doc) {
      return;
    }
    const timer = window.setTimeout(() => {
      saveIimlDocument(selectedId, annotationState.doc!)
        .then(() => {
          dispatchAnnotation({ type: "set-status", status: "已自动保存" });
        })
        .catch((err: Error) => dispatchAnnotation({ type: "set-status", status: err.message }));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [annotationState.doc, selectedId, workspaceMode]);

  const selectedStone = useMemo(() => catalog?.stones.find((stone) => stone.id === selectedId), [catalog?.stones, selectedId]);
  const selectedAnnotation = useMemo(
    () => annotationState.doc?.annotations.find((annotation) => annotation.id === annotationState.selectedAnnotationId),
    [annotationState.doc?.annotations, annotationState.selectedAnnotationId]
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

  // SAM 候选审核：接受 = 标记 approved；拒绝 = 直接删除；重试 = 删除后切回 SAM 工具让用户重点。
  const handleAcceptCandidate = useCallback((id: string) => {
    dispatchAnnotation({ type: "update-annotation", id, patch: { reviewStatus: "approved" } });
  }, []);

  const handleRejectCandidate = useCallback((id: string) => {
    dispatchAnnotation({ type: "delete-annotation", id });
  }, []);

  const handleRetryCandidate = useCallback((id: string) => {
    dispatchAnnotation({ type: "delete-annotation", id });
    dispatchAnnotation({ type: "set-tool", tool: "sam" });
  }, []);

  // F3：SAM 自动 prompt — 把 YOLO bbox 候选喂给 SAM 跑精修，输出 polygon 替换原 bbox。
  // 失败时保持原 bbox 不动，status 给提示。也写一条 SAM run 进 processingRuns。
  const handleRefineWithSam = useCallback(
    async (id: string) => {
      const doc = annotationState.doc;
      const stoneId = selectedStone?.id;
      if (!doc || !stoneId) return;
      const annotation = doc.annotations.find((a) => a.id === id);
      if (!annotation) return;
      if (annotation.target.type !== "BBox") {
        dispatchAnnotation({
          type: "set-status",
          status: "SAM 精修需要 BBox 几何（YOLO 候选 / 矩形标注）"
        });
        return;
      }
      const startedAt = new Date().toISOString();
      dispatchAnnotation({ type: "set-status", status: "SAM 精修中…" });
      let runError: string | undefined;
      let runWarning: string | undefined;
      let runModel = "mobile-sam-vit-t";
      let resultId: string | undefined;
      try {
        const result = await refineBBoxWithSam(annotation, stoneId);
        if (!result) {
          runWarning = "no-polygon";
          dispatchAnnotation({
            type: "set-status",
            status: "SAM 精修失败：未输出 polygon。bbox 太小或权重未就绪？"
          });
          return;
        }
        runModel = result.model;
        const target = polygonFromUVs(result.polygon);
        // 直接 patch 原 annotation：保留 label / structuralLevel / 颜色等用户已设字段，
        // 仅替换几何 + 来源元数据（method 改为 sam，但保留 yolo 相关 prompt 信息作为
        // upstream 链路）
        const originalBox = annotation.target.type === "BBox"
          ? [...annotation.target.coordinates]
          : [];
        dispatchAnnotation({
          type: "update-annotation",
          id,
          patch: {
            target,
            generation: {
              ...annotation.generation,
              method: "sam",
              model: result.model,
              confidence: result.confidence,
              prompt: {
                ...annotation.generation?.prompt,
                refinedFrom: "yolo-bbox",
                originalMethod: annotation.generation?.method ?? null,
                box: originalBox,
                source: result.sourceImage ?? null
              }
            }
          }
        });
        resultId = id;
        dispatchAnnotation({
          type: "set-status",
          status: `SAM 精修完成：bbox → polygon（confidence=${result.confidence.toFixed(2)}, model=${result.model}）`
        });
      } catch (error) {
        runError = error instanceof Error ? error.message : String(error);
        dispatchAnnotation({ type: "set-status", status: `SAM 精修出错：${runError}` });
      } finally {
        dispatchAnnotation({
          type: "add-processing-run",
          run: {
            id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            method: "sam-refine",
            model: runModel,
            input: {
              upstreamAnnotationId: id,
              upstreamMethod: annotation.generation?.method ?? null,
              upstreamLabel: annotation.label ?? null,
              stoneId
            },
            output: { ok: !!resultId },
            resultAnnotationIds: resultId ? [resultId] : [],
            resourceId: annotation.resourceId,
            frame: annotation.frame ?? "image",
            startedAt,
            endedAt: new Date().toISOString(),
            warning: runWarning,
            error: runError
          }
        });
      }
    },
    [annotationState.doc, selectedStone]
  );

  // 批量 SAM 精修：所有 YOLO 候选（reviewStatus=candidate + generation.method=yolo）一键升级
  // 使用 G3 任务进度面板 + cancelRequested 标记支持中途取消
  const handleBulkRefineYoloWithSam = useCallback(async () => {
    const doc = annotationState.doc;
    if (!doc || !selectedStone) return;
    const targets = doc.annotations.filter(
      (a) =>
        a.reviewStatus === "candidate" &&
        a.generation?.method === "yolo" &&
        a.target.type === "BBox"
    );
    if (targets.length === 0) {
      dispatchAnnotation({
        type: "set-status",
        status: "没有可精修的 YOLO 候选（需 reviewStatus=candidate + method=yolo + BBox）"
      });
      return;
    }
    const taskId = `task-${Date.now()}-sam-bulk-${Math.random().toString(36).slice(2, 6)}`;
    cancelRequestedRef.current.delete(taskId);
    upsertTask({
      id: taskId,
      title: `SAM 批量精修 ${targets.length} 个 YOLO 候选`,
      status: "running",
      progress: 0,
      message: "准备中…",
      cancellable: true
    });
    let ok = 0;
    let failed = 0;
    let cancelled = false;
    for (let i = 0; i < targets.length; i++) {
      if (cancelRequestedRef.current.has(taskId)) {
        cancelled = true;
        break;
      }
      const t = targets[i];
      upsertTask({
        id: taskId,
        title: `SAM 批量精修 ${targets.length} 个 YOLO 候选`,
        status: "running",
        progress: i / targets.length,
        message: `[${i + 1}/${targets.length}] ${t.label ?? "未命名"}`,
        cancellable: true
      });
      try {
        await handleRefineWithSam(t.id);
        ok++;
      } catch {
        failed++;
      }
    }
    upsertTask({
      id: taskId,
      title: `SAM 批量精修 ${targets.length} 个 YOLO 候选`,
      status: cancelled ? "cancelled" : failed > 0 ? "failed" : "done",
      progress: 1,
      message: cancelled
        ? `已取消：成功 ${ok} / 失败 ${failed} / 跳过 ${targets.length - ok - failed}`
        : `成功 ${ok} / 失败 ${failed} / 共 ${targets.length}`
    });
    dispatchAnnotation({
      type: "set-status",
      status: cancelled
        ? `SAM 批量精修已取消（已处理 ${ok + failed}/${targets.length}）`
        : `SAM 批量精修完成：成功 ${ok} / 失败 ${failed} / 共 ${targets.length}`
    });
  }, [annotationState.doc, selectedStone, handleRefineWithSam, upsertTask]);

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

  // 把选中的候选做几何并集（mergePolygonAnnotations），生成新的合并候选并替换原条目。
  // 失败原因（少于 2 个 / 跨 frame / 几何不可并集）翻成中文写入 status 提示用户。
  const handleMergeCandidates = useCallback(
    (ids: string[]) => {
      const doc = annotationState.doc;
      if (!doc || ids.length < 2) {
        return;
      }
      const targets = doc.annotations.filter((annotation) => ids.includes(annotation.id));
      if (targets.length < 2) {
        return;
      }
      const result = mergePolygonAnnotations(targets);
      if (!result.ok) {
        dispatchAnnotation({ type: "set-status", status: describeMergeFailure(result.reason) });
        return;
      }
      ids.forEach((id) => dispatchAnnotation({ type: "delete-annotation", id }));
      dispatchAnnotation({ type: "add-annotation", annotation: result.annotation });
      dispatchAnnotation({ type: "select", id: result.annotation.id });
      dispatchAnnotation({ type: "set-status", status: `已合并 ${targets.length} 个候选` });
    },
    [annotationState.doc]
  );

  // YOLO 批量扫描：调 /ai/yolo 后把每个 bbox 转为 candidate IimlAnnotation 落入 store。
  // 走高清图路径（stoneId）；当前不做截图回退，因为 3D viewport 截图分辨率太低
  // 出来的 bbox 用处有限，等用户反馈再补。
  const handleStartYoloScan = useCallback(() => {
    setYoloDialogOpen(true);
  }, []);

  const handleCancelYoloScan = useCallback(() => {
    if (yoloScanning) {
      return;
    }
    setYoloDialogOpen(false);
  }, [yoloScanning]);

  const handleSubmitYoloScan = useCallback(
    async (options: YoloScanOptions) => {
      if (!selectedStone) {
        return;
      }
      const doc = annotationState.doc;
      const resourceId = doc?.resources[0]?.id ?? `${selectedStone.id}:model`;
      setYoloScanning(true);
      dispatchAnnotation({ type: "set-status", status: "YOLO 扫描中…" });
      const startedAt = new Date().toISOString();
      const createdIds: string[] = [];
      let runModel = "yolov8n";
      let runError: string | undefined;
      let runWarning: string | undefined;
      try {
        const response = await runYoloDetection({
          stoneId: selectedStone.id,
          classFilter: options.classFilter,
          confThreshold: options.confThreshold,
          maxDetections: options.maxDetections
        });
        runModel = response.model;
        if (response.error) {
          runError = response.error;
          dispatchAnnotation({ type: "set-status", status: `YOLO 扫描失败：${response.error}` });
          return;
        }
        const detections = response.detections ?? [];
        if (detections.length === 0) {
          runWarning = "no-detection";
          // 用 debug 字段给出具体原因，让用户知道是"模型真没扫到"还是"扫到但被阈值/类别过滤"
          const debug = response.debug;
          let reason = "YOLO 没找到任何候选，可降低阈值或换张更清晰的高清原图再试";
          if (debug) {
            if (debug.rawDetections === 0) {
              reason = `YOLO 扫描完毕，模型对该图无响应（rawDetections=0）。汉画像石灰度浮雕在 COCO 通用模型上识别困难，建议：① 用 SAM 框选 + 点选手动标注 ② 等汉画像石专用微调模型`;
            } else if (debug.filteredByClass > 0 && debug.filteredByConf === 0) {
              const top = Object.entries(debug.classDistribution)
                .slice(0, 5)
                .map(([k, v]) => `${k}×${v}`)
                .join(" ");
              reason = `YOLO 扫到 ${debug.rawDetections} 个对象但都不在你勾选的类别里。模型实际输出：${top}。打开 dialog 取消"类别过滤"试试`;
            } else if (debug.filteredByConf > 0) {
              reason = `YOLO 扫到 ${debug.rawDetections} 个但置信度全都低于阈值 ${debug.appliedConfThreshold.toFixed(2)}（被过滤 ${debug.filteredByConf} 个）。把阈值滑杆拉到 0.05 再试`;
            }
          }
          dispatchAnnotation({ type: "set-status", status: reason });
          return;
        }
        // 把每个 bbox 转成 candidate annotation。frame 跟随当前 sourceMode；
        // bbox_uv 已经是 image-normalized（v 向下），与前端 UV 约定一致，直接用。
        const baseColorIndex = doc?.annotations.length ?? 0;
        detections.forEach((detection, index) => {
          // 后端总是输出 bbox_uv（image-normalized 与前端 UV 一致）。pixel bbox 仅作为
          // 旧接口兼容，新代码这里只信任 bbox_uv，缺失就跳过。
          const uv = detection.bbox_uv;
          if (!uv) {
            return;
          }
          const annotation = createAnnotationFromGeometry({
            geometry: { type: "BBox", coordinates: uv },
            resourceId,
            color: annotationPalette[(baseColorIndex + index) % annotationPalette.length],
            frame: annotationSourceMode,
            label: `YOLO 候选：${detection.label}`,
            structuralLevel: "figure",
            reviewStatus: "candidate",
            generation: {
              method: "yolo",
              model: response.model,
              confidence: detection.confidence,
              prompt: {
                stoneId: selectedStone.id,
                classFilter: options.classFilter ?? null,
                confThreshold: options.confThreshold,
                maxDetections: options.maxDetections,
                label: detection.label
              }
            }
          });
          dispatchAnnotation({ type: "add-annotation", annotation });
          createdIds.push(annotation.id);
        });
        const debugTail = response.debug
          ? `（原始 ${response.debug.rawDetections}，按类过滤 ${response.debug.filteredByClass}，按阈值过滤 ${response.debug.filteredByConf}）`
          : "";
        dispatchAnnotation({
          type: "set-status",
          status: `YOLO 扫描完成，落入 ${createdIds.length} 个候选（model=${response.model}）${debugTail}`
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runError = message;
        dispatchAnnotation({ type: "set-status", status: `YOLO 扫描出错：${message}` });
      } finally {
        // D3 写入 processingRun（成功 / 失败都报）
        dispatchAnnotation({
          type: "add-processing-run",
          run: {
            id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            method: "yolo",
            model: runModel,
            input: {
              stoneId: selectedStone.id,
              classFilter: options.classFilter ?? null,
              confThreshold: options.confThreshold,
              maxDetections: options.maxDetections,
              sourceMode: annotationSourceMode
            },
            output: {
              ok: createdIds.length > 0,
              detectionsCount: createdIds.length
            },
            resultAnnotationIds: createdIds,
            resourceId,
            frame: annotationSourceMode,
            startedAt,
            endedAt: new Date().toISOString(),
            warning: runWarning,
            error: runError
          }
        });
        setYoloScanning(false);
        setYoloDialogOpen(false);
      }
    },
    [annotationSourceMode, annotationState.doc, selectedStone]
  );

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
        </nav>

        <label className="stone-select">
          <span>画像石</span>
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
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

      <div className="workspace-grid">
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
                samStatus={samStatus}
                yoloScanning={yoloScanning}
                onCancelCalibration={() => dispatchAnnotation({ type: "set-tool", tool: "select" })}
                onDeleteSelected={deleteSelectedAnnotation}
                onRedo={() => dispatchAnnotation({ type: "redo" })}
                onResetView={() => setResetToken((value) => value + 1)}
                onStartCalibration={() => dispatchAnnotation({ type: "set-tool", tool: "calibrate" })}
                onStartYoloScan={handleStartYoloScan}
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
                  yoloDialogOpen={yoloDialogOpen}
                  yoloScanning={yoloScanning}
                  onCreate={(annotation, asDraft) => dispatchAnnotation({ type: "add-annotation", annotation, asDraft })}
                  onDelete={(id) => dispatchAnnotation({ type: "delete-annotation", id })}
                  onProcessingRun={(run) => dispatchAnnotation({ type: "add-processing-run", run })}
                  onSaveAlignment={(alignment) => dispatchAnnotation({ type: "set-alignment", alignment })}
                  onSelect={(id) => dispatchAnnotation({ type: "select", id })}
                  onSourceModeChange={setAnnotationSourceMode}
                  onToolChange={(tool) => dispatchAnnotation({ type: "set-tool", tool })}
                  onUpdate={(id, patch) => dispatchAnnotation({ type: "update-annotation", id, patch })}
                  onYoloCancel={handleCancelYoloScan}
                  onYoloSubmit={handleSubmitYoloScan}
                />
              </div>
            </Suspense>
          ) : null}
        </main>

        <aside className="side-panel">
          {workspaceMode === "annotation" ? (
            <Suspense fallback={<section className="panel-section"><p className="muted-text">正在加载标注面板...</p></section>}>
              <AnnotationPanel
                doc={annotationState.doc}
                draftAnnotationId={annotationState.draftAnnotationId}
                metadata={metadata}
                selectedAnnotation={selectedAnnotation}
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
                onAddResource={(resource) => dispatchAnnotation({ type: "add-resource", resource })}
                onUpdateResource={(id, patch) => dispatchAnnotation({ type: "update-resource", id, patch })}
                onDeleteResource={(id) => dispatchAnnotation({ type: "delete-resource", id })}
                onMergeCandidates={handleMergeCandidates}
                onRejectCandidate={handleRejectCandidate}
                onRetryCandidate={handleRetryCandidate}
                onRefineWithSam={handleRefineWithSam}
                onBulkRefineYoloWithSam={handleBulkRefineYoloWithSam}
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
