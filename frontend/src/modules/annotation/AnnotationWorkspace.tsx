/**
 * 标注工作区 `AnnotationWorkspace`
 *
 * 标注模式的容器组件，负责把"底图（3D 模型 / 高清图 / 多种用户资源）+
 * 标注画布"组合成一个统一的工作区，并向下分发交互回调。
 *
 * 主要职责：
 * - 维护当前底图来源（3D 模型 / 高清图）与高清图模式下的资源切换（pic 原图 /
 *   生成的正射图 / 拓片 / 法线图等 8 类资源）
 * - 提供 4 点对齐校准的状态机（idle / collect / review / done）
 * - 接管 SAM / YOLO 的入口与 AI 线图叠加图层
 * - 把当前底图资源回传父级（App 层据此决定 YOLO / SAM 应该跑哪个 imageUri）
 *
 * 视觉布局：
 * ```
 * .annotation-workspace
 *   ├─ StoneViewer           （3D 模式时可见）
 *   ├─ SourceImageView       （高清图模式时可见，带 pan / zoom）
 *   ├─ AnnotationCanvas      （绝对定位铺满，pointer-events 受工具状态控制）
 *   ├─ source-switch         （右上：3D / 高清）
 *   ├─ resource-switch       （右上：底图资源切换）
 *   ├─ layer-switch          （右上：原图 / +线图）
 *   └─ calibration-hud / sam-prompt-hud / yolo-dialog（按需弹）
 * ```
 *
 * 设计要点：
 * - 父级把 `active` 设为 false 时只是 CSS 隐藏，组件仍然 mount，避免 Three.js
 *   场景 / Konva 舞台被销毁重建造成 gizmo 丢状态
 * - 资源切换不进 IIML 持久化，仅是临时视图状态，刷新会回到默认 pic/ 原图
 * - 等价正射图（view=front + frustumScale=1.0）下画布按 model 坐标系处理，
 *   与 3D 模型视图标注双向同步
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { StoneListItem } from "../../api/client";
import { lineartMethodOptions, type LineartMethod } from "../../api/client";
import { SourceImageView, type CannyOptions, type SourceImageLayer } from "../viewer/SourceImageView";
import { StoneViewer, type ScreenProjection } from "../viewer/StoneViewer";
import { AnnotationCanvas, type CalibrationDraftView } from "./AnnotationCanvas";
import type { UV } from "./geometry";
import { getAlignment, getRelations } from "./store";
import type {
  AnnotationTool,
  IimlAlignment,
  IimlAnnotation,
  IimlAnnotationFrame,
  IimlDocument,
  IimlProcessingRun,
  ProjectionContext
} from "./types";
import { YoloScanDialog, type YoloScanOptions } from "./YoloScanDialog";

// 标注底图来源：默认 3D 模型（modelBox UV 坐标），也可切到高清图原图（图自身归一化）。
// 高清图模式下 SAM 候选与显示天然在同一坐标系下。
export type AnnotationSourceMode = IimlAnnotationFrame;

type AnnotationWorkspaceProps = {
  // 父级以 CSS 隐藏时传 false，向下传递给 StoneViewer 暂停 Three.js render loop。
  active?: boolean;
  stone: StoneListItem;
  background: "black" | "gray" | "white";
  doc?: IimlDocument;
  selectedAnnotationId?: string;
  draftAnnotationId?: string;
  activeTool: AnnotationTool;
  sourceMode: AnnotationSourceMode;
  // 值变化时 StoneViewer 会 fit 回正面视角，用于 SAM 之前的视角复位。
  fitToken?: number;
  onCreate: (annotation: IimlAnnotation, asDraft?: boolean) => void;
  onUpdate: (id: string, patch: Partial<IimlAnnotation>) => void;
  onDelete: (id: string) => void;
  onSelect: (id?: string) => void;
  onToolChange: (tool: AnnotationTool) => void;
  onSourceModeChange: (mode: AnnotationSourceMode) => void;
  // 4 点对齐校准结果保存到 IIML doc.culturalObject.alignment。
  onSaveAlignment: (alignment: IimlAlignment | undefined) => void;
  // YOLO 扫描 dialog：状态由 App 层持有（与 SAM 候选审定相邻），结果通过回调返回。
  yoloDialogOpen?: boolean;
  yoloScanning?: boolean;
  onYoloSubmit?: (options: YoloScanOptions) => void;
  onYoloCancel?: () => void;
  // D3 学术溯源：每次 SAM 调用追加一条 processingRun
  onProcessingRun?: (run: IimlProcessingRun) => void;
  // J v0.8.0：活动底图资源变化时通知父级。父级据此让 YOLO 批量扫描 / SAM 精修
  // 走正确的 imageUri（而不是默认 pic/ 原图），并决定候选标注的 frame /
  // resourceId 绑定。undefined = 默认 pic/ 原图。
  onActiveImageResourceChange?: (info: ActiveImageResourceInfo | undefined) => void;
};

export type ActiveImageResourceInfo = {
  id: string;
  uri: string;
  type: string;
  equivalentToModel: boolean;
};

type CalibrationDraft = {
  modelPoints: Array<[number, number]>;
  imagePoints: Array<[number, number]>;
  phase: "collect" | "review";
};

const emptyDraft: CalibrationDraft = { modelPoints: [], imagePoints: [], phase: "collect" };

// 给"资源切换"chip 生成简短 label（优先用 resource.description 前缀，退化到 type）
function buildResourceLabel(resource: Record<string, unknown>): string {
  const type = String(resource.type ?? "资源");
  const typeLabels: Record<string, string> = {
    Orthophoto: "正射",
    Rubbing: "拓片",
    NormalMap: "法线",
    LineDrawing: "线图",
    OriginalImage: "原图",
    RTI: "RTI",
    Other: "其他"
  };
  const typeLabel = typeLabels[type] ?? type;
  const id = String(resource.id ?? "");
  // id 里若含方向信息（如 resource-ortho-front-xxx）提取成后缀
  const directionMatch = id.match(/ortho-(front|back|top|bottom)/);
  if (directionMatch) {
    const dir = { front: "正", back: "背", top: "顶", bottom: "底" }[directionMatch[1] as "front" | "back" | "top" | "bottom"];
    return `${typeLabel}·${dir}`;
  }
  return typeLabel;
}

export function AnnotationWorkspace({
  active = true,
  stone,
  background,
  doc,
  selectedAnnotationId,
  draftAnnotationId,
  activeTool,
  sourceMode,
  fitToken,
  onCreate,
  onUpdate,
  onDelete,
  onSelect,
  onToolChange,
  onSourceModeChange,
  onSaveAlignment,
  yoloDialogOpen = false,
  yoloScanning = false,
  onYoloSubmit,
  onYoloCancel,
  onProcessingRun,
  onActiveImageResourceChange
}: AnnotationWorkspaceProps) {
  const [projection, setProjection] = useState<ProjectionContext | undefined>(undefined);
  const [calibration, setCalibration] = useState<CalibrationDraft | undefined>(undefined);
  // 高清图模式下的图层切换：原图 / 原图 + 半透明 Canny 线图。
  // 不影响标注坐标系（线图与原图同尺寸），仅是视觉辅助。
  const [imageLayer, setImageLayer] = useState<SourceImageLayer>("source");
  // F2 阶段：线图算法可切换 + 阈值调节。method 默认 canny-plus（汉画像石残损浮雕推荐）
  const [lineartMethod, setLineartMethod] = useState<LineartMethod>("canny-plus");
  const [lineartLow, setLineartLow] = useState<number>(60);
  const [lineartHigh, setLineartHigh] = useState<number>(140);
  const [lineartOpacity, setLineartOpacity] = useState<number>(0.85);
  const cannyOptions = useMemo<CannyOptions>(
    () => ({ method: lineartMethod, low: lineartLow, high: lineartHigh, opacity: lineartOpacity }),
    [lineartMethod, lineartLow, lineartHigh, lineartOpacity]
  );

  // I1 v0.8.0 多资源画布切换：高清图模式下选哪张图作为底图。
  // - undefined（默认）= pic/ 原图（走 /ai/source-image/{stoneId}）
  // - resource.id = doc.resources 里的 image 类资源（如生成的正射图 / 拓片）
  // 切换资源时 SourceImageView 会重置 fit；Canny 线图只能叠加在 pic/ 原图上
  // （后端 canny 管线只处理 pic/ 原图），所以切到非默认资源时强制关掉线图。
  const [activeImageResourceId, setActiveImageResourceId] = useState<string | undefined>(undefined);
  // doc.resources 里可以作为底图的 image 类资源（有 URI 的 Orthophoto / Rubbing /
  // NormalMap / LineDrawing / OriginalImage / RTI）
  const imageLikeResources = useMemo(() => {
    if (!doc?.resources) return [] as Array<{ id: string; label: string; uri: string; type: string }>;
    const imageTypes = new Set([
      "Orthophoto",
      "Rubbing",
      "NormalMap",
      "LineDrawing",
      "OriginalImage",
      "RTI",
      "Other"
    ]);
    return (doc.resources as Array<Record<string, unknown>>)
      .filter((r) => typeof r.uri === "string" && (typeof r.type !== "string" || imageTypes.has(r.type as string)))
      .map((r, idx) => ({
        id: String(r.id ?? `resource-${idx}`),
        type: String(r.type ?? "Other"),
        uri: String(r.uri),
        label: buildResourceLabel(r)
      }));
  }, [doc?.resources]);

  // 切换 stone 或资源列表变动时，清掉无效的 activeImageResourceId
  useEffect(() => {
    if (!activeImageResourceId) return;
    if (!imageLikeResources.some((r) => r.id === activeImageResourceId)) {
      setActiveImageResourceId(undefined);
    }
  }, [imageLikeResources, activeImageResourceId]);

  // 若切到非 pic/ 资源，强制关掉 Canny 叠加避免错位
  useEffect(() => {
    if (activeImageResourceId && imageLayer === "canny") {
      setImageLayer("source");
    }
  }, [activeImageResourceId, imageLayer]);

  const activeImageUrl = useMemo(() => {
    if (!activeImageResourceId) return undefined;
    return imageLikeResources.find((r) => r.id === activeImageResourceId)?.uri;
  }, [activeImageResourceId, imageLikeResources]);

  // I4 v0.8.0 J：当前底图资源是否"与 3D 模型 UV 等价"——典型场景是 view=front +
  // frustumScale=1.0 的正射图，它的图像归一化坐标与 modelBox UV 完全 1:1 对应。
  // 等价时：
  //   - 画布坐标系视作 model（即使 sourceMode === "image"）
  //   - 在正射图上新建的标注 frame 记为 "model"，3D 模型视图上自动能看到
  //   - model frame 的历史标注也直接显示在正射图上（同一坐标系）
  // 不等价时：后续可走 homography / affine / orthographic 反推（v0.9.0 TODO），
  // 目前保留原 image frame 行为，用户可走 4 点标定做跨 frame 投影。
  const activeResourceEquivalentToModel = useMemo(() => {
    if (!activeImageResourceId) return false;
    const raw = (doc?.resources ?? []).find(
      (r) => typeof (r as Record<string, unknown>).id === "string" && String((r as Record<string, unknown>).id) === activeImageResourceId
    ) as Record<string, unknown> | undefined;
    if (!raw) return false;
    const transform = raw.transform as Record<string, unknown> | undefined;
    if (!transform) return false;
    if (transform.kind !== "orthographic-from-model") return false;
    // 显式标记（新生成的正射图）优先
    if (transform.equivalentToModel === true) return true;
    // 老数据兜底：view=front 且 frustumScale ~ 1.0 也视作等价
    const view = transform.view;
    const frustumScale = typeof transform.frustumScale === "number" ? transform.frustumScale : 1.05;
    return view === "front" && Math.abs(frustumScale - 1.0) < 1e-3;
  }, [activeImageResourceId, doc?.resources]);

  // 传给 AnnotationCanvas 的"实际画布坐标系"。image 模式 + 等价资源 → model。
  const effectiveSourceMode: AnnotationSourceMode =
    sourceMode === "image" && activeResourceEquivalentToModel ? "model" : sourceMode;

  // 高清图模式没有显式选资源时，自动落到 OriginalImage（pic/ 高清图）资源 id，
  // 让 annotation.resourceId 与实际坐标系名实相符（避免历史 "${stoneId}:model" 误导）。
  // model 模式仍走 :model；image 模式但没有 OriginalImage（如老 doc 未迁移）则
  // 兜底到第 0 个 image-like 资源；都没有再退回 :model。
  const defaultImageResource = useMemo(
    () => imageLikeResources.find((r) => r.type === "OriginalImage") ?? imageLikeResources[0],
    [imageLikeResources]
  );
  const resourceId =
    activeImageResourceId ??
    (sourceMode === "image" ? defaultImageResource?.id : undefined) ??
    doc?.resources[0]?.id ??
    `${stone.id}:model`;
  const alignment = getAlignment(doc);

  // 把"当前底图资源"告诉父级（App.tsx），让 YOLO 批量扫描 / SAM 精修能自动
  // 走正确的 imageUri + 候选 frame。sourceMode=model 时资源是 3D，父级应收到
  // undefined（走默认 stoneId → pic/ 原图路径仍然是最佳的，因为 SAM 需要 2D
  // 图像，不能直接喂 3D 模型）。
  useEffect(() => {
    if (!onActiveImageResourceChange) return;
    if (sourceMode === "model" || !activeImageResourceId || !activeImageUrl) {
      onActiveImageResourceChange(undefined);
      return;
    }
    const raw = imageLikeResources.find((r) => r.id === activeImageResourceId);
    onActiveImageResourceChange({
      id: activeImageResourceId,
      uri: activeImageUrl,
      type: raw?.type ?? "Other",
      equivalentToModel: activeResourceEquivalentToModel
    });
  }, [
    sourceMode,
    activeImageResourceId,
    activeImageUrl,
    activeResourceEquivalentToModel,
    imageLikeResources,
    onActiveImageResourceChange
  ]);
  // B3 关系连线需要的 relations 列表（与 RelationsEditor 用同一份 store 读出）
  const relations = useMemo(() => getRelations(doc), [doc]);

  const handleProjectionChange = useCallback((next: ScreenProjection | undefined) => {
    if (!next) {
      setProjection(undefined);
      return;
    }
    setProjection({
      canvasWidth: next.canvasWidth,
      canvasHeight: next.canvasHeight,
      corners: next.corners
    });
  }, []);

  // 工具切换到/离开 calibrate 时同步标定 draft 生命周期。
  // 从工具栏点 calibrate 按钮就走这条路径：先切 tool → 这里启动 draft → 自动把
  // sourceMode 切回 model（标定从 3D 模型开始，让用户先把 mesh 锚定为基准）。
  useEffect(() => {
    if (activeTool === "calibrate" && !calibration) {
      setCalibration({ ...emptyDraft });
      onSourceModeChange("model");
    } else if (activeTool !== "calibrate" && calibration) {
      setCalibration(undefined);
    }
    // sourceMode 不放依赖：避免标定中切换底图触发"重置 sourceMode 到 model"循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, calibration]);

  // 切换标注 doc（换画像石）时，立刻退出标定流程，避免坐标对错块。
  useEffect(() => {
    if (calibration) {
      setCalibration(undefined);
      if (activeTool === "calibrate") {
        onToolChange("select");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.documentId, stone.id]);

  const handleAddCalibrationPoint = useCallback(
    (uv: UV) => {
      setCalibration((prev) => {
        if (!prev || prev.phase !== "collect") {
          return prev;
        }
        const next: CalibrationDraft = {
          modelPoints: [...prev.modelPoints],
          imagePoints: [...prev.imagePoints],
          phase: prev.phase
        };
        const target = sourceMode === "model" ? "modelPoints" : "imagePoints";
        if (next[target].length >= 4) {
          return prev;
        }
        next[target] = [...next[target], [uv.u, uv.v]];

        const modelDone = next.modelPoints.length >= 4;
        const imageDone = next.imagePoints.length >= 4;
        if (modelDone && imageDone) {
          next.phase = "review";
        } else if (sourceMode === "model" && modelDone) {
          // model 收满 → 自动切到 image 接着采点
          onSourceModeChange("image");
        } else if (sourceMode === "image" && imageDone) {
          onSourceModeChange("model");
        }
        return next;
      });
    },
    [onSourceModeChange, sourceMode]
  );

  const handleCancelCalibration = useCallback(() => {
    setCalibration(undefined);
    onToolChange("select");
  }, [onToolChange]);

  const handleResetCalibration = useCallback(() => {
    setCalibration({ ...emptyDraft });
    if (sourceMode !== "model") {
      onSourceModeChange("model");
    }
  }, [onSourceModeChange, sourceMode]);

  const handleUndoLastPoint = useCallback(() => {
    setCalibration((prev) => {
      if (!prev) {
        return prev;
      }
      // review 阶段撤销 → 回到 collect 并删掉最后一个点（按 image → model 顺序拆）
      if (prev.phase === "review") {
        if (prev.imagePoints.length > 0) {
          return {
            modelPoints: prev.modelPoints,
            imagePoints: prev.imagePoints.slice(0, -1),
            phase: "collect"
          };
        }
        if (prev.modelPoints.length > 0) {
          return {
            modelPoints: prev.modelPoints.slice(0, -1),
            imagePoints: prev.imagePoints,
            phase: "collect"
          };
        }
        return prev;
      }
      // collect 阶段：先尝试撤销当前 frame 的最后一点；若当前 frame 一个点都没（刚切过来）
      // 则跨 frame 撤销并把 sourceMode 切回去。
      const current = sourceMode === "model" ? "modelPoints" : "imagePoints";
      const other = sourceMode === "model" ? "imagePoints" : "modelPoints";
      if (prev[current].length > 0) {
        return { ...prev, [current]: prev[current].slice(0, -1) };
      }
      if (prev[other].length > 0) {
        onSourceModeChange(sourceMode === "model" ? "image" : "model");
        return { ...prev, [other]: prev[other].slice(0, -1) };
      }
      return prev;
    });
  }, [onSourceModeChange, sourceMode]);

  const handleSaveCalibration = useCallback(() => {
    if (!calibration || calibration.modelPoints.length !== 4 || calibration.imagePoints.length !== 4) {
      return;
    }
    const next: IimlAlignment = {
      version: 1,
      calibratedAt: new Date().toISOString(),
      calibratedBy: "local-user",
      controlPoints: calibration.modelPoints.map((modelUv, index) => ({
        modelUv,
        imageUv: calibration.imagePoints[index]
      }))
    };
    onSaveAlignment(next);
    setCalibration(undefined);
    onToolChange("select");
  }, [calibration, onSaveAlignment, onToolChange]);

  const calibrationDraftView: CalibrationDraftView | undefined = calibration
    ? {
        modelPoints: calibration.modelPoints,
        imagePoints: calibration.imagePoints,
        phase: calibration.phase
      }
    : undefined;

  return (
    <div className="annotation-workspace">
      {sourceMode === "model" ? (
        <StoneViewer
          active={active}
          background={background}
          cubeView="front"
          fitToken={fitToken}
          measureToken={0}
          measuring={false}
          stone={stone}
          viewMode="2d"
          hideHud
          onCubeViewChange={() => undefined}
          onMeasureChange={() => undefined}
          onScreenProjectionChange={handleProjectionChange}
        />
      ) : (
        <SourceImageView
          active={active}
          background={background}
          cannyOptions={cannyOptions}
          fitToken={fitToken}
          imageUrl={activeImageUrl}
          layer={imageLayer}
          stoneId={stone.id}
          onScreenProjectionChange={handleProjectionChange}
        />
      )}
      <AnnotationCanvas
        activeTool={activeTool}
        activeImageUri={activeImageUrl}
        alignment={alignment}
        annotations={doc?.annotations ?? []}
        calibrationDraft={calibrationDraftView}
        draftAnnotationId={draftAnnotationId}
        projection={projection}
        relations={relations}
        resourceId={resourceId}
        stoneId={stone.id}
        selectedAnnotationId={selectedAnnotationId}
        sourceMode={effectiveSourceMode}
        onCalibrationPoint={handleAddCalibrationPoint}
        onCreate={onCreate}
        onDelete={onDelete}
        onProcessingRun={onProcessingRun}
        onSelect={onSelect}
        onToolChange={onToolChange}
        onUpdate={onUpdate}
      />
      <div className="viewer-hud top-left annotation-hint">
        <strong>标注工作区</strong>
        <span>{toolHint(activeTool)}</span>
      </div>
      <div className="annotation-source-switch" role="group" aria-label="底图来源">
        <button
          type="button"
          className={sourceMode === "model" ? "active" : ""}
          onClick={() => onSourceModeChange("model")}
        >
          3D 模型
        </button>
        <button
          type="button"
          className={sourceMode === "image" ? "active" : ""}
          onClick={() => onSourceModeChange("image")}
        >
          高清图
        </button>
      </div>
      {sourceMode === "image" ? (
        <>
          {imageLikeResources.length > 0 ? (
            <div
              className="annotation-resource-switch"
              role="group"
              aria-label="底图资源"
              title="I1 v0.8.0：多资源画布切换。在 pic/ 原图与 doc.resources 里注册的正射 / 拓片 / 法线图间切换"
            >
              <span className="annotation-resource-switch-label">底图</span>
              <button
                type="button"
                className={!activeImageResourceId ? "active" : ""}
                onClick={() => setActiveImageResourceId(undefined)}
                title="默认 pic/ 原图（后端 tif → PNG 转码缓存）"
              >
                原图
              </button>
              {imageLikeResources.map((resource) => (
                <button
                  key={resource.id}
                  type="button"
                  className={activeImageResourceId === resource.id ? "active" : ""}
                  onClick={() => setActiveImageResourceId(resource.id)}
                  title={`${resource.type} · ${resource.uri}`}
                >
                  {resource.label}
                </button>
              ))}
            </div>
          ) : null}
          {activeResourceEquivalentToModel ? (
            <div
              className="annotation-resource-aligned-hint"
              role="note"
              title="I4 v0.8.0 J：该正射图 frustum 严格对齐 3D 模型 AABB，图像 UV 与 modelBox UV 1:1 对应"
            >
              <span className="aligned-dot" aria-hidden />
              此图与 3D 模型坐标系已对齐 · 标注自动双向同步
            </div>
          ) : null}
          <div className="annotation-layer-switch" role="group" aria-label="图层">
            <button
              type="button"
              className={imageLayer === "source" ? "active" : ""}
              onClick={() => setImageLayer("source")}
              title="只显示原图"
            >
              原图
            </button>
            <button
              type="button"
              className={imageLayer === "canny" ? "active" : ""}
              onClick={() => setImageLayer("canny")}
              disabled={Boolean(activeImageResourceId)}
              title={
                activeImageResourceId
                  ? "切到 pic/ 原图底图才能叠线图（Canny 基于 pic/ 原图生成）"
                  : "原图 + 半透明线图叠加，辅助辨识浅浮雕轮廓"
              }
            >
              +线图
            </button>
          </div>
          {imageLayer === "canny" ? (
            <div className="annotation-lineart-panel" role="group" aria-label="线图参数">
              <div className="annotation-lineart-row">
                <span className="annotation-lineart-label">算法</span>
                <div className="annotation-lineart-chips">
                  {lineartMethodOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={
                        lineartMethod === option.id
                          ? "annotation-lineart-chip is-on"
                          : "annotation-lineart-chip"
                      }
                      onClick={() => setLineartMethod(option.id)}
                      title={option.hint}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="annotation-lineart-row">
                <span className="annotation-lineart-label">
                  {lineartMethod === "morph" ? "blockSize" : "low"}
                </span>
                <input
                  type="range"
                  min={lineartMethod === "morph" ? 5 : 0}
                  max={lineartMethod === "morph" ? 51 : 254}
                  step={lineartMethod === "morph" ? 2 : 5}
                  value={lineartLow}
                  onChange={(event) => setLineartLow(Number(event.target.value))}
                />
                <span className="annotation-lineart-value">{lineartLow}</span>
              </div>
              {lineartMethod === "canny" || lineartMethod === "canny-plus" ? (
                <div className="annotation-lineart-row">
                  <span className="annotation-lineart-label">high</span>
                  <input
                    type="range"
                    min={lineartLow + 5}
                    max={255}
                    step={5}
                    value={lineartHigh}
                    onChange={(event) => setLineartHigh(Number(event.target.value))}
                  />
                  <span className="annotation-lineart-value">{lineartHigh}</span>
                </div>
              ) : null}
              <div className="annotation-lineart-row">
                <span className="annotation-lineart-label">透明度</span>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={lineartOpacity}
                  onChange={(event) => setLineartOpacity(Number(event.target.value))}
                />
                <span className="annotation-lineart-value">{Math.round(lineartOpacity * 100)}%</span>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {calibration ? (
        <CalibrationHud
          draft={calibration}
          sourceMode={sourceMode}
          onCancel={handleCancelCalibration}
          onReset={handleResetCalibration}
          onSave={handleSaveCalibration}
          onUndo={handleUndoLastPoint}
          onSourceModeChange={onSourceModeChange}
        />
      ) : null}
      <YoloScanDialog
        open={yoloDialogOpen}
        scanning={yoloScanning}
        onSubmit={(options) => onYoloSubmit?.(options)}
        onCancel={() => onYoloCancel?.()}
      />
    </div>
  );
}

function CalibrationHud({
  draft,
  sourceMode,
  onCancel,
  onReset,
  onSave,
  onUndo,
  onSourceModeChange
}: {
  draft: CalibrationDraft;
  sourceMode: AnnotationSourceMode;
  onCancel: () => void;
  onReset: () => void;
  onSave: () => void;
  onUndo: () => void;
  onSourceModeChange: (mode: AnnotationSourceMode) => void;
}) {
  const totalPoints = draft.modelPoints.length + draft.imagePoints.length;
  const ownLength = sourceMode === "model" ? draft.modelPoints.length : draft.imagePoints.length;
  const otherLength = sourceMode === "model" ? draft.imagePoints.length : draft.modelPoints.length;
  const otherFrameLabel = sourceMode === "model" ? "高清图" : "3D 模型";
  const ownFrameLabel = sourceMode === "model" ? "3D 模型" : "高清图";

  let prompt: React.ReactNode;
  if (draft.phase === "review") {
    prompt = (
      <span>
        4 对点已采集 <strong>(8/8)</strong>。可在 <em>3D 模型</em> 与 <em>高清图</em> 之间切换检查
        <span className="muted-text"> · 青色编号是另一坐标系投影过来的对照点</span>
      </span>
    );
  } else if (ownLength >= 4) {
    prompt = (
      <span>
        【{ownFrameLabel}】4 个点已采集，请在 <strong>{otherFrameLabel}</strong> 上点对应位置（{otherLength + 1}/4）
      </span>
    );
  } else {
    prompt = (
      <span>
        在 <strong>{ownFrameLabel}</strong> 上点第 <strong>{ownLength + 1}/4</strong> 个特征点
        <span className="muted-text"> · 建议分布在画像石的左下、右下、右上、左上四个区域附近</span>
      </span>
    );
  }

  const canSave = draft.phase === "review";
  const showSwap = draft.phase === "review" || ownLength >= 4;

  return (
    <div className="calibration-hud" role="dialog" aria-label="对齐校准">
      <div className="calibration-hud-row">
        <span className="calibration-hud-step">{Math.min(totalPoints, 8)} / 8</span>
        <div className="calibration-hud-prompt">{prompt}</div>
      </div>
      <div className="calibration-hud-actions">
        {showSwap ? (
          <button
            type="button"
            className="ghost-cta"
            onClick={() => onSourceModeChange(sourceMode === "model" ? "image" : "model")}
          >
            切到{otherFrameLabel}
          </button>
        ) : null}
        <button type="button" className="ghost-cta" onClick={onUndo} disabled={totalPoints === 0}>
          撤销上一点
        </button>
        <button type="button" className="ghost-cta" onClick={onReset} disabled={totalPoints === 0}>
          重新采集
        </button>
        <button type="button" className="ghost-cta" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="primary-cta" onClick={onSave} disabled={!canSave}>
          保存对齐
        </button>
      </div>
    </div>
  );
}

function toolHint(tool: AnnotationTool) {
  switch (tool) {
    case "rect":
      return "按住左键拖动绘制矩形，松开即完成";
    case "ellipse":
      return "按住左键拖动绘制圆形 / 椭圆，松开即完成";
    case "point":
      return "单击图像放置一个点标注";
    case "pen":
      return "依次点击添加节点，双击或回车闭合多边形";
    case "sam":
      return "左键正点 / 右键负点 / Shift+左键拖动出框 → Enter 提交，AI 一次返回精修候选";
    case "calibrate":
      return "在 3D 模型 / 高清图各点 4 对对应点完成对齐";
    case "select":
    default:
      return "选中标注后可拖动整体或四角调整尺寸；按 Delete 删除";
  }
}
