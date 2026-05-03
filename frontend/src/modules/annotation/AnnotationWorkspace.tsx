import { useCallback, useEffect, useState } from "react";
import type { StoneListItem } from "../../api/client";
import { SourceImageView } from "../viewer/SourceImageView";
import { StoneViewer, type ScreenProjection } from "../viewer/StoneViewer";
import { AnnotationCanvas, type CalibrationDraftView } from "./AnnotationCanvas";
import type { UV } from "./geometry";
import { getAlignment } from "./store";
import type {
  AnnotationTool,
  IimlAlignment,
  IimlAnnotation,
  IimlAnnotationFrame,
  IimlDocument,
  ProjectionContext
} from "./types";

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
};

type CalibrationDraft = {
  modelPoints: Array<[number, number]>;
  imagePoints: Array<[number, number]>;
  phase: "collect" | "review";
};

const emptyDraft: CalibrationDraft = { modelPoints: [], imagePoints: [], phase: "collect" };

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
  onSaveAlignment
}: AnnotationWorkspaceProps) {
  const [projection, setProjection] = useState<ProjectionContext | undefined>(undefined);
  const [calibration, setCalibration] = useState<CalibrationDraft | undefined>(undefined);
  const resourceId = doc?.resources[0]?.id ?? `${stone.id}:model`;
  const alignment = getAlignment(doc);

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
          fitToken={fitToken}
          stoneId={stone.id}
          onScreenProjectionChange={handleProjectionChange}
        />
      )}
      <AnnotationCanvas
        activeTool={activeTool}
        alignment={alignment}
        annotations={doc?.annotations ?? []}
        calibrationDraft={calibrationDraftView}
        draftAnnotationId={draftAnnotationId}
        projection={projection}
        resourceId={resourceId}
        selectedAnnotationId={selectedAnnotationId}
        sourceMode={sourceMode}
        onCalibrationPoint={handleAddCalibrationPoint}
        onCreate={onCreate}
        onDelete={onDelete}
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
      return "在画像石上点击对象，AI 自动框出候选";
    case "calibrate":
      return "在 3D 模型 / 高清图各点 4 对对应点完成对齐";
    case "select":
    default:
      return "选中标注后可拖动整体或四角调整尺寸；按 Delete 删除";
  }
}
