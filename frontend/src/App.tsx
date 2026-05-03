import { Camera, MousePointer2, Ruler, RotateCcw, SquareDashedMousePointer, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import * as THREE from "three";
import {
  fetchAssemblyPlan,
  fetchAssemblyPlans,
  fetchIimlDocument,
  fetchStoneMetadata,
  fetchStones,
  saveAssemblyPlan,
  saveIimlDocument,
  type AssemblyPlanRecord,
  type StoneListItem,
  type StoneListResponse,
  type StoneMetadata
} from "./api/client";
import { AnnotationPanel } from "./modules/annotation/AnnotationPanel";
import { AnnotationToolbar } from "./modules/annotation/AnnotationToolbar";
import { AnnotationWorkspace } from "./modules/annotation/AnnotationWorkspace";
import { annotationReducer, initialAnnotationState } from "./modules/annotation/store";
import { AssemblyPanel } from "./modules/assembly/AssemblyPanel";
import { AssemblyWorkspace, type AssemblyCameraState } from "./modules/assembly/AssemblyWorkspace";
import type { AdjustmentAxis, AdjustmentMode } from "./modules/assembly/AssemblyAdjustControls";
import type { AssemblyDimensions, AssemblyItem, AssemblyTransform } from "./modules/assembly/types";
import { StoneViewer, type MeasurementResult, type ViewerMode } from "./modules/viewer/StoneViewer";
import type { ViewCubeView } from "./modules/shared/ViewCube";

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
    fetchAssemblyPlans()
      .then((plans) => {
        setSavedPlans(plans);
        setSelectedPlanId((value) => value || plans[0]?.id || "");
      })
      .catch(() => setSavedPlans([]));
  }, []);

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

  useEffect(() => {
    if (workspaceMode === "assembly" && !planName) {
      setPlanName(createDefaultPlanName());
    }
  }, [planName, workspaceMode]);

  useEffect(() => {
    if (workspaceMode === "assembly" && assemblyItems.length === 0 && selectedStone?.hasModel) {
      addAssemblyStone(selectedStone);
    }
  }, [assemblyItems.length, selectedStone, workspaceMode]);

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
      const offset = assemblyItems.length * 150;
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
    [assemblyItems.length]
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
            {catalog?.stones.map((stone) => (
              <option value={stone.id} key={stone.id}>
                {stone.id.replace("asset-", "#")} {stone.displayName}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="workspace-grid">
        <aside className="tool-rail" aria-label="工具栏">
          {workspaceMode === "annotation" ? (
            <AnnotationToolbar
              activeTool={annotationState.activeTool}
              canDelete={Boolean(annotationState.selectedAnnotationId)}
              canRedo={annotationState.redoStack.length > 0}
              canUndo={annotationState.undoStack.length > 0}
              onDeleteSelected={deleteSelectedAnnotation}
              onRedo={() => dispatchAnnotation({ type: "redo" })}
              onToolChange={(tool) => dispatchAnnotation({ type: "set-tool", tool })}
              onUndo={() => dispatchAnnotation({ type: "undo" })}
            />
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
          ) : null}
          {workspaceMode === "assembly" ? (
            <AssemblyWorkspace
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
          ) : null}
          {workspaceMode === "annotation" && selectedStone ? (
            <AnnotationWorkspace
              activeTool={annotationState.activeTool}
              background={background}
              doc={annotationState.doc}
              draftAnnotationId={annotationState.draftAnnotationId}
              selectedAnnotationId={annotationState.selectedAnnotationId}
              stone={selectedStone}
              onCreate={(annotation, asDraft) => dispatchAnnotation({ type: "add-annotation", annotation, asDraft })}
              onDelete={(id) => dispatchAnnotation({ type: "delete-annotation", id })}
              onSelect={(id) => dispatchAnnotation({ type: "select", id })}
              onToolChange={(tool) => dispatchAnnotation({ type: "set-tool", tool })}
              onUpdate={(id, patch) => dispatchAnnotation({ type: "update-annotation", id, patch })}
            />
          ) : null}
        </main>

        <aside className="side-panel">
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
          ) : workspaceMode === "annotation" ? (
            <AnnotationPanel
              doc={annotationState.doc}
              draftAnnotationId={annotationState.draftAnnotationId}
              selectedAnnotation={selectedAnnotation}
              status={annotationState.status}
              onConfirmDraft={() => {
                dispatchAnnotation({ type: "set-draft", id: undefined });
                dispatchAnnotation({ type: "set-status", status: "标注已完成" });
              }}
              onDeleteAnnotation={(id) => dispatchAnnotation({ type: "delete-annotation", id })}
              onSelectAnnotation={(id) => dispatchAnnotation({ type: "select", id })}
              onUpdateAnnotation={(id, patch) => dispatchAnnotation({ type: "update-annotation", id, patch })}
            />
          ) : (
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
          )}
        </aside>
      </div>
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
