import { useEffect, useMemo, useRef, useState } from "react";
import { Circle, Group, Layer, Line, Rect, Stage, Text } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type Konva from "konva";
import {
  bboxCornersOnScreen,
  bboxFromUV,
  createAnnotationFromGeometry,
  ellipseBoundsToUV,
  ellipsePolygonFromUV,
  geometryCenter,
  mapGeometryUVs,
  pointFromUV,
  polygonFromUVs,
  projectGeometryToScreen,
  resizeBBoxByCorner,
  resizeEllipseByCorner,
  screenToUV,
  translateGeometry,
  uvToScreen,
  type UV
} from "./geometry";
import { applyHomography, buildAlignmentMatrices, solveHomography, transformUv, type AlignmentMatrices } from "./homography";
import { requestSamCandidate, requestSamCandidateWithSource } from "./sam";
import { annotationPalette } from "./store";
import type {
  AnnotationTool,
  IimlAlignment,
  IimlAnnotation,
  IimlAnnotationFrame,
  IimlGeometry,
  ProjectionContext
} from "./types";

// 标定流程视图态：传给画布渲染当前已收集的 4 对点；undefined 表示未在标定中。
export type CalibrationDraftView = {
  modelPoints: Array<[number, number]>;
  imagePoints: Array<[number, number]>;
  phase: "collect" | "review";
};

type AnnotationCanvasProps = {
  resourceId: string;
  annotations: IimlAnnotation[];
  selectedAnnotationId?: string;
  draftAnnotationId?: string;
  activeTool: AnnotationTool;
  projection?: ProjectionContext;
  // 当前底图坐标系：3D 模型 modelBox UV 或高清图自身 UV。
  sourceMode: IimlAnnotationFrame;
  // 可选：modelUv ↔ imageUv 的 4 点单应性标定，用于跨 frame 显示。
  alignment?: IimlAlignment;
  // 标定流程态；activeTool === "calibrate" 时画布按此渲染已收集的对应点。
  calibrationDraft?: CalibrationDraftView;
  onCreate: (annotation: IimlAnnotation, asDraft?: boolean) => void;
  onUpdate: (id: string, patch: Partial<IimlAnnotation>) => void;
  onDelete: (id: string) => void;
  onSelect: (id?: string) => void;
  onToolChange: (tool: AnnotationTool) => void;
  // 标定采点回调；UV 已是当前 sourceMode 坐标系下的归一化点。
  onCalibrationPoint?: (uv: UV) => void;
};

// 视图态：annotation 自身（保留原 frame）+ 当前画布要渲染的 geometry +
// 是否跨 frame（用于 UI 提示与编辑禁用）。
type DisplayAnnotation = {
  source: IimlAnnotation;
  displayGeometry: IimlGeometry;
  isCrossFrame: boolean;
};

const minDragPixels = 4;
const handleSize = 7;

type DraftRect = { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;

type DraggingState =
  | { kind: "move"; id: string; lastUV: UV; original: IimlAnnotation }
  | { kind: "corner"; id: string; cornerIndex: 0 | 1 | 2 | 3; original: IimlAnnotation }
  | undefined;

function isLocked(annotation: IimlAnnotation) {
  return annotation.locked === true;
}

function isVisible(annotation: IimlAnnotation) {
  return annotation.visible !== false;
}

function annotationColor(annotation: IimlAnnotation, fallbackIndex = 0) {
  return annotation.color ?? annotationPalette[fallbackIndex % annotationPalette.length];
}

// 默认填充透明度；annotation.opacity 未设时使用。
const defaultAnnotationAlpha = 0.15;

// 把 #rrggbb 形式的 hex 转为 rgba(r,g,b,alpha)，用于 Rect/Polygon 填充；
// 非法输入回退到项目默认橙色，避免渲染时出现空字符串。
function hexToRgba(hex: string, alpha: number): string {
  const match = /^#?([0-9a-f]{6})$/iu.exec(hex);
  if (!match) {
    return `rgba(243, 167, 18, ${alpha})`;
  }
  const raw = match[1];
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 找到同一个 .annotation-workspace 里的"底图交互目标"。
// - 3D 模型模式：Three.js 的 canvas，事件交给 OrbitControls 处理 pan/zoom
// - 高清图模式：.source-image-stage 容器，事件交给 SourceImageView 自带的 pan/zoom 处理
// 两者对外行为一致（滚轮缩放、中键/右键 pan），AnnotationCanvas 不需要区分。
function findViewportTarget(host: HTMLElement | null): HTMLElement | null {
  if (!host) return null;
  const workspace = host.closest(".annotation-workspace");
  if (!workspace) return null;
  const threeCanvas = workspace.querySelector(".three-stage canvas") as HTMLCanvasElement | null;
  if (threeCanvas) return threeCanvas;
  const sourceStage = workspace.querySelector(".source-image-stage") as HTMLElement | null;
  return sourceStage;
}

// SAM 截图回退只在 3D 模型模式下走得通（要用 canvas.toDataURL 取图），
// 单独一个 helper 避免与通用 viewport 转发目标混淆。
function findStoneCanvas(host: HTMLElement | null): HTMLCanvasElement | null {
  if (!host) return null;
  const workspace = host.closest(".annotation-workspace");
  return (workspace?.querySelector(".three-stage canvas") as HTMLCanvasElement | null) ?? null;
}

export function AnnotationCanvas({
  resourceId,
  annotations,
  selectedAnnotationId,
  draftAnnotationId,
  activeTool,
  projection,
  sourceMode,
  alignment,
  calibrationDraft,
  onCreate,
  onUpdate,
  onDelete,
  onSelect,
  onToolChange,
  onCalibrationPoint
}: AnnotationCanvasProps) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [draftRect, setDraftRect] = useState<DraftRect>(undefined);
  const [penPoints, setPenPoints] = useState<Array<{ x: number; y: number }>>([]);
  // SAM 请求期间禁掉画布点击并提示 wait 光标，避免重复点出多个候选。
  const [isSamPending, setIsSamPending] = useState(false);
  const draggingRef = useRef<DraggingState>(undefined);

  useEffect(() => {
    setDraftRect(undefined);
    setPenPoints([]);
  }, [activeTool, projection?.canvasWidth, projection?.canvasHeight]);

  // 滚轮转发：标注层在最上面，用户滚轮时要把事件交给下面的底图（3D canvas 或高清图容器）
  // 自己处理缩放。preventDefault 避免页面跟着滚动。
  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }
    const forwardWheel = (event: WheelEvent) => {
      const target = findViewportTarget(host);
      if (!target) {
        return;
      }
      event.preventDefault();
      target.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: false,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaZ: event.deltaZ,
          deltaMode: event.deltaMode,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey
        })
      );
    };
    host.addEventListener("wheel", forwardWheel, { passive: false });
    return () => host.removeEventListener("wheel", forwardWheel);
  }, []);

  // 把 pointerdown 事件切到下面的底图，由它的 pan 控制器接管。
  // 期间临时把 host 设为 pointer-events: none，后续 pointermove/pointerup
  // 会穿透到底图（OrbitControls 在 document 上也有监听；SourceImageView 用 setPointerCapture）。
  // 松开时若未移动（< 4px），当成空白单击，可选 onTap（比如 deselect）。
  const startForwardPan = (nativeEvent: MouseEvent, onTap?: () => void) => {
    const host = containerRef.current;
    const target = findViewportTarget(host);
    if (!host || !target) {
      return;
    }
    host.style.pointerEvents = "none";
    const pointerId =
      "pointerId" in nativeEvent && typeof (nativeEvent as PointerEvent).pointerId === "number"
        ? (nativeEvent as PointerEvent).pointerId
        : 1;
    target.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: nativeEvent.clientX,
        clientY: nativeEvent.clientY,
        button: nativeEvent.button,
        buttons: nativeEvent.buttons || 1,
        pointerType: "mouse",
        pointerId,
        isPrimary: true
      })
    );

    const startX = nativeEvent.clientX;
    const startY = nativeEvent.clientY;
    const release = (upEvent?: PointerEvent) => {
      host.style.pointerEvents = "";
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
      if (upEvent && onTap) {
        const distance = Math.hypot(upEvent.clientX - startX, upEvent.clientY - startY);
        if (distance < 4) {
          onTap();
        }
      }
    };
    const handleUp = (event: PointerEvent) => release(event);
    const handleCancel = () => release();
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
  };

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedAnnotationId) {
          event.preventDefault();
          onDelete(selectedAnnotationId);
        }
      } else if (event.key === "Escape") {
        if (penPoints.length > 0) {
          setPenPoints([]);
        } else {
          onSelect(undefined);
        }
      } else if (event.key === "Enter" && activeTool === "pen" && penPoints.length >= 3) {
        finishPenPolygon(penPoints);
      }
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAnnotationId, activeTool, penPoints]);

  // 4 点对齐矩阵（modelToImage / imageToModel），无 alignment 或解算失败时为空对象。
  const alignmentMatrices = useMemo<AlignmentMatrices>(
    () => buildAlignmentMatrices(alignment),
    [alignment]
  );

  // 把 store 中的 annotation 投影到当前画布坐标系：
  // - 同 frame：直接用原 geometry
  // - 跨 frame + 已校准：按 H 变换 geometry，标记 isCrossFrame
  // - 跨 frame + 未校准：跳过（避免错位误导用户）
  const displayAnnotations = useMemo<DisplayAnnotation[]>(() => {
    return annotations
      .filter(isVisible)
      .map((annotation): DisplayAnnotation | undefined => {
        const annotationFrame: IimlAnnotationFrame = annotation.frame ?? "model";
        if (annotationFrame === sourceMode) {
          return { source: annotation, displayGeometry: annotation.target, isCrossFrame: false };
        }
        const transformed = mapGeometryUVs(annotation.target, (uv) =>
          transformUv(uv, alignmentMatrices, annotationFrame, sourceMode)
        );
        if (!transformed) {
          return undefined;
        }
        return { source: annotation, displayGeometry: transformed, isCrossFrame: true };
      })
      .filter((entry): entry is DisplayAnnotation => Boolean(entry));
  }, [alignmentMatrices, annotations, sourceMode]);

  // 跨 frame 但 alignment 还没建立时，统计漏掉的标注数，给画布做一个温和的提示。
  const hiddenCrossFrameCount = useMemo(() => {
    if (alignmentMatrices.modelToImage && alignmentMatrices.imageToModel) {
      return 0;
    }
    return annotations.filter((annotation) => isVisible(annotation) && (annotation.frame ?? "model") !== sourceMode).length;
  }, [alignmentMatrices.imageToModel, alignmentMatrices.modelToImage, annotations, sourceMode]);

  const interactive = Boolean(projection);
  const stageWidth = projection?.canvasWidth ?? 1;
  const stageHeight = projection?.canvasHeight ?? 1;

  const pointerScreen = () => {
    const stage = stageRef.current;
    return stage?.getPointerPosition() ?? { x: 0, y: 0 };
  };

  const newColor = () => annotationPalette[annotations.length % annotationPalette.length];

  const finishPenPolygon = (points: Array<{ x: number; y: number }>) => {
    if (!projection || points.length < 3) {
      setPenPoints([]);
      return;
    }
    const uvs = points.map((point) => screenToUV(point, projection));
    const geometry = polygonFromUVs(uvs);
    const annotation = createAnnotationFromGeometry({ geometry, resourceId, color: newColor(), frame: sourceMode });
    onCreate(annotation, true);
    onToolChange("select");
    setPenPoints([]);
  };

  const handleMouseDown = (event: KonvaEventObject<MouseEvent>) => {
    if (!projection) {
      return;
    }
    if (draggingRef.current) {
      return;
    }
    const nativeEvent = event.evt;
    const stage = event.target.getStage();
    const isEmptyTarget = stage !== null && event.target === stage;

    // 中键 / 右键按下：无论哪个工具都让给底图做 pan。
    // 中键：通用平移；右键：与多数 3D 软件惯例一致（OrbitControls 默认 RIGHT=PAN）。
    if (nativeEvent.button === 1 || nativeEvent.button === 2) {
      nativeEvent.preventDefault();
      startForwardPan(nativeEvent);
      return;
    }

    const point = pointerScreen();

    if (activeTool === "select") {
      // 左键点在空白区域：转 pan。未拖动（< 4px）松开时当作 deselect。
      if (isEmptyTarget && nativeEvent.button === 0) {
        startForwardPan(nativeEvent, () => onSelect(undefined));
      }
      return;
    }

    if (activeTool === "calibrate") {
      // 标定模式：左键采点；非左键 / review 阶段忽略，让用户用浮窗按钮操作。
      if (nativeEvent.button !== 0 || !calibrationDraft || calibrationDraft.phase !== "collect") {
        return;
      }
      const uv = screenToUV(point, projection);
      onCalibrationPoint?.(uv);
      return;
    }

    if (activeTool === "rect" || activeTool === "ellipse") {
      setDraftRect({ start: point, end: point });
      return;
    }

    if (activeTool === "point") {
      const uv = screenToUV(point, projection);
      const annotation = createAnnotationFromGeometry({ geometry: pointFromUV(uv), resourceId, color: newColor(), frame: sourceMode });
      onCreate(annotation, true);
      onToolChange("select");
      return;
    }

    if (activeTool === "sam") {
      if (nativeEvent.button !== 0 || isSamPending) {
        return;
      }
      setIsSamPending(true);
      // resourceId 形如 "asset-29:model"，前缀就是 stoneId。
      const stoneId = resourceId.split(":")[0] ?? resourceId;
      const baseColor = newColor();

      void (async () => {
        // 1) 先尝试高清图路径（pic/ 目录匹配 stoneId）。识别率明显更高。
        try {
          const highRes = await requestSamCandidateWithSource({
            stoneId,
            screenPoint: point,
            projection,
            resourceId,
            color: baseColor,
            frame: sourceMode
          });
          if (highRes) {
            onCreate(highRes, false);
            onSelect(highRes.id);
            return;
          }
        } catch (error) {
          // 网络抖动或后端 500 时打印，下面照常 fallback。
          console.warn("SAM source path failed, falling back to screenshot:", error);
        }

        // 2) 回退到当前视角截图（旧路径），保证没配高清图的画像石也能用。
        const stoneCanvas = findStoneCanvas(containerRef.current);
        if (!stoneCanvas) {
          return;
        }
        try {
          const shot = await requestSamCandidate({
            screenPoint: point,
            stoneCanvas,
            projection,
            resourceId,
            color: baseColor,
            frame: sourceMode
          });
          if (shot) {
            onCreate(shot, false);
            onSelect(shot.id);
          }
        } catch (error) {
          console.error("SAM screenshot path also failed:", error);
        }
      })().finally(() => {
        setIsSamPending(false);
        onToolChange("select");
      });
      return;
    }

    if (activeTool === "pen") {
      if (!stage) {
        return;
      }
      if (penPoints.length >= 3) {
        const first = penPoints[0];
        const distance = Math.hypot(point.x - first.x, point.y - first.y);
        if (distance <= 8) {
          finishPenPolygon(penPoints);
          return;
        }
      }
      setPenPoints((points) => [...points, point]);
    }
  };

  const handleMouseMove = () => {
    if (!projection) {
      return;
    }

    const dragging = draggingRef.current;
    if (dragging) {
      const point = pointerScreen();
      const uv = screenToUV(point, projection);
      if (dragging.kind === "move") {
        const du = uv.u - dragging.lastUV.u;
        const dv = uv.v - dragging.lastUV.v;
        const next = translateGeometry(dragging.original.target, du, dv);
        draggingRef.current = { ...dragging, original: { ...dragging.original, target: next }, lastUV: uv };
        onUpdate(dragging.id, { target: next });
      } else if (dragging.kind === "corner") {
        const target = dragging.original.target;
        if (target.type === "BBox") {
          const next = resizeBBoxByCorner(target, dragging.cornerIndex, uv);
          draggingRef.current = { ...dragging, original: { ...dragging.original, target: next } };
          onUpdate(dragging.id, { target: next });
        } else if (target.type === "Polygon") {
          const next = resizeEllipseByCorner(target, dragging.cornerIndex, uv);
          if (next) {
            draggingRef.current = { ...dragging, original: { ...dragging.original, target: next } };
            onUpdate(dragging.id, { target: next });
          }
        }
      }
      return;
    }

    if (draftRect) {
      setDraftRect({ ...draftRect, end: pointerScreen() });
    }
  };

  const handleMouseUp = () => {
    if (draggingRef.current) {
      draggingRef.current = undefined;
      return;
    }
    if (!draftRect || !projection) {
      return;
    }
    const distance = Math.hypot(draftRect.end.x - draftRect.start.x, draftRect.end.y - draftRect.start.y);
    if (distance < minDragPixels) {
      setDraftRect(undefined);
      return;
    }
    const startUV = screenToUV(draftRect.start, projection);
    const endUV = screenToUV(draftRect.end, projection);
    const geometry = activeTool === "ellipse" ? ellipsePolygonFromUV(startUV, endUV) : bboxFromUV(startUV, endUV);
    const annotation = createAnnotationFromGeometry({ geometry, resourceId, color: newColor(), frame: sourceMode });
    setDraftRect(undefined);
    onCreate(annotation, true);
    onToolChange("select");
  };

  const handleDoubleClick = () => {
    if (activeTool === "pen" && penPoints.length >= 3) {
      finishPenPolygon(penPoints);
    }
  };

  const handleStageLeave = () => {
    if (draggingRef.current) {
      draggingRef.current = undefined;
    }
    if (draftRect) {
      setDraftRect(undefined);
    }
  };

  const beginShapeDrag = (annotation: IimlAnnotation) => {
    if (!projection || isLocked(annotation)) {
      return;
    }
    const point = pointerScreen();
    const uv = screenToUV(point, projection);
    draggingRef.current = { kind: "move", id: annotation.id, lastUV: uv, original: annotation };
  };

  const beginCornerDrag = (annotation: IimlAnnotation, cornerIndex: 0 | 1 | 2 | 3) => {
    if (isLocked(annotation)) {
      return;
    }
    draggingRef.current = { kind: "corner", id: annotation.id, cornerIndex, original: annotation };
  };

  const selectedDisplay = useMemo(() => {
    if (!selectedAnnotationId) {
      return undefined;
    }
    return displayAnnotations.find((entry) => entry.source.id === selectedAnnotationId);
  }, [displayAnnotations, selectedAnnotationId]);
  const selectedAnnotation = selectedDisplay?.source;
  // 跨 frame 标注暂不支持就地拖拽 / 改尺寸：避免在变换后画布上推算反向坐标的复杂度；
  // 用户需要切到原 frame 后再编辑。
  const showSelectionHandles = Boolean(
    selectedDisplay && projection && !isLocked(selectedDisplay.source) && !selectedDisplay.isCrossFrame
  );

  return (
    <div
      ref={containerRef}
      className={[
        "annotation-canvas-host",
        interactive ? "active" : "",
        isSamPending ? "sam-pending" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      tabIndex={0}
    >
      <Stage
        className={interactive ? "annotation-canvas active" : "annotation-canvas"}
        ref={stageRef}
        width={stageWidth}
        height={stageHeight}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleStageLeave}
        onDblClick={handleDoubleClick}
        onContextMenu={(event) => event.evt.preventDefault()}
      >
        <Layer>
          {displayAnnotations.map(({ source, displayGeometry, isCrossFrame }, index) => (
            <AnnotationShape
              activeTool={activeTool}
              annotation={source}
              displayGeometry={displayGeometry}
              isCrossFrame={isCrossFrame}
              key={source.id}
              color={annotationColor(source, index)}
              isSelected={source.id === selectedAnnotationId}
              isDraft={source.id === draftAnnotationId}
              locked={isLocked(source)}
              projection={projection}
              onSelect={() => onSelect(source.id)}
              onBeginDrag={() => beginShapeDrag(source)}
            />
          ))}
          {showSelectionHandles && selectedDisplay && projection ? (
            <SelectionHandles
              geometry={selectedDisplay.displayGeometry}
              projection={projection}
              onBeginCornerDrag={(cornerIndex) => beginCornerDrag(selectedDisplay.source, cornerIndex)}
            />
          ) : null}
          {draftRect && projection ? (
            activeTool === "ellipse" ? (
              <DraftEllipse start={draftRect.start} end={draftRect.end} />
            ) : (
              <DraftRect start={draftRect.start} end={draftRect.end} />
            )
          ) : null}
          {penPoints.length > 0 ? (
            <Group>
              <Line
                points={penPoints.flatMap((point) => [point.x, point.y])}
                stroke="#f3a712"
                strokeWidth={2}
                dash={[5, 4]}
              />
              {penPoints.map((point, index) => (
                <Circle
                  fill="#f3a712"
                  key={`pen-${index}`}
                  radius={index === 0 ? 5 : 3}
                  stroke="#1d1a18"
                  strokeWidth={1}
                  x={point.x}
                  y={point.y}
                />
              ))}
            </Group>
          ) : null}
          {calibrationDraft && projection ? (
            <CalibrationOverlay
              draft={calibrationDraft}
              projection={projection}
              sourceMode={sourceMode}
              alignmentMatrices={alignmentMatrices}
            />
          ) : null}
        </Layer>
      </Stage>
      {!projection ? (
        <div className="annotation-canvas-placeholder">
          <span>正在等待模型投影就绪...</span>
        </div>
      ) : null}
      {hiddenCrossFrameCount > 0 ? (
        <div className="annotation-cross-frame-hint">
          有 {hiddenCrossFrameCount} 个标注在另一坐标系中，<strong>请先完成"对齐校准"</strong>才能在当前底图上看到。
        </div>
      ) : null}
    </div>
  );
}

function AnnotationShape({
  activeTool,
  annotation,
  displayGeometry,
  isCrossFrame,
  color,
  isSelected,
  isDraft,
  locked,
  projection,
  onSelect,
  onBeginDrag
}: {
  activeTool: AnnotationTool;
  annotation: IimlAnnotation;
  // 当前画布坐标系下的几何（同 frame 时即 annotation.target，跨 frame 时是变换后的副本）
  displayGeometry: IimlGeometry;
  // 该标注是否处于"另一坐标系"中（被 H 矩阵投影到当前画布）
  isCrossFrame: boolean;
  color: string;
  isSelected: boolean;
  isDraft: boolean;
  locked: boolean;
  projection?: ProjectionContext;
  onSelect: () => void;
  onBeginDrag: () => void;
}) {
  if (!projection) {
    return null;
  }
  // 跨 frame 时禁用编辑：避免把变换后的位移再反向算回原 frame，且能让用户直观知道
  // "这个标注属于另一坐标系，要先切回去再修改"。
  const interactive = activeTool === "select" && !locked && !isCrossFrame;
  const isCandidate = annotation.reviewStatus === "candidate";
  const stroke = isSelected ? "#f3a712" : color;
  // 虚线：草稿（人工新建）和候选（AI 未审）都用虚线；locked 稀疏虚线；
  // 跨 frame 也用稀疏虚线表达"投影态"；否则实线。
  const dash = isDraft || isCandidate
    ? [6, 4]
    : isCrossFrame
      ? [4, 4]
      : locked
        ? [3, 3]
        : undefined;
  const strokeWidth = isSelected ? 2.4 : isCandidate ? 2 : 1.6;
  // 填充：候选未指定透明度时用 0.25 更醒目；跨 frame 整体减半透明度强调"非活动 frame"；
  // 其余走用户设置或默认 0.15。
  const fallbackAlpha = isCandidate ? 0.25 : defaultAnnotationAlpha;
  let fillAlpha = Math.min(1, Math.max(0, annotation.opacity ?? fallbackAlpha));
  if (isCrossFrame) {
    fillAlpha *= 0.5;
  }
  const baseColor = isSelected ? "#f3a712" : color;
  const fillColor = hexToRgba(baseColor, fillAlpha);
  const opacity = isCrossFrame ? 0.7 : 1;
  const onMouseDown = (event: KonvaEventObject<MouseEvent>) => {
    if (!interactive) {
      return;
    }
    event.cancelBubble = true;
    onSelect();
    onBeginDrag();
  };
  const onClick = (event: KonvaEventObject<MouseEvent>) => {
    if (activeTool !== "select") {
      return;
    }
    event.cancelBubble = true;
    onSelect();
  };

  if (displayGeometry.type === "BBox") {
    const screen = bboxCornersOnScreen(displayGeometry, projection);
    if (screen.length < 4) {
      return null;
    }
    const left = Math.min(screen[0].x, screen[2].x);
    const right = Math.max(screen[0].x, screen[2].x);
    const top = Math.min(screen[0].y, screen[2].y);
    const bottom = Math.max(screen[0].y, screen[2].y);
    return (
      <Rect
        x={left}
        y={top}
        width={right - left}
        height={bottom - top}
        stroke={stroke}
        strokeWidth={strokeWidth}
        dash={dash}
        fill={fillColor}
        opacity={opacity}
        onMouseDown={onMouseDown}
        onClick={onClick}
      />
    );
  }

  if (displayGeometry.type === "Point") {
    const center = uvToScreen({ u: Number(displayGeometry.coordinates[0] ?? 0), v: Number(displayGeometry.coordinates[1] ?? 0) }, projection);
    return (
      <Circle
        x={center.x}
        y={center.y}
        radius={isSelected ? 7 : 5}
        fill={stroke}
        stroke="#1d1a18"
        strokeWidth={1.5}
        opacity={opacity}
        onMouseDown={onMouseDown}
        onClick={onClick}
      />
    );
  }

  const points = projectGeometryToScreen(displayGeometry, projection).flatMap((point) => [point.x, point.y]);
  const isClosed = displayGeometry.type === "Polygon" || displayGeometry.type === "MultiPolygon";
  return (
    <Line
      points={points}
      closed={isClosed}
      stroke={stroke}
      strokeWidth={strokeWidth}
      dash={dash}
      fill={isClosed ? fillColor : undefined}
      opacity={opacity}
      onMouseDown={onMouseDown}
      onClick={onClick}
    />
  );
}

function SelectionHandles({
  geometry,
  projection,
  onBeginCornerDrag
}: {
  geometry: IimlGeometry;
  projection: ProjectionContext;
  onBeginCornerDrag: (cornerIndex: 0 | 1 | 2 | 3) => void;
}) {
  let bounds: { min: UV; max: UV } | undefined;
  if (geometry.type === "BBox") {
    const [minU, minV, maxU, maxV] = geometry.coordinates;
    bounds = { min: { u: minU, v: minV }, max: { u: maxU, v: maxV } };
  } else if (geometry.type === "Polygon") {
    bounds = ellipseBoundsToUV(geometry);
  }
  if (!bounds) {
    return null;
  }
  const corners: Array<{ uv: UV; index: 0 | 1 | 2 | 3 }> = [
    { uv: { u: bounds.min.u, v: bounds.max.v }, index: 0 },
    { uv: { u: bounds.max.u, v: bounds.max.v }, index: 1 },
    { uv: { u: bounds.max.u, v: bounds.min.v }, index: 2 },
    { uv: { u: bounds.min.u, v: bounds.min.v }, index: 3 }
  ];
  const center = uvToScreen(geometryCenter(geometry), projection);
  return (
    <Group>
      <Circle x={center.x} y={center.y} radius={3} fill="#f3a712" opacity={0.6} listening={false} />
      {corners.map(({ uv, index }) => {
        const screen = uvToScreen(uv, projection);
        return (
          <Rect
            key={`handle-${index}`}
            x={screen.x - handleSize / 2}
            y={screen.y - handleSize / 2}
            width={handleSize}
            height={handleSize}
            fill="#f3a712"
            stroke="#1d1a18"
            strokeWidth={1.2}
            onMouseDown={(event) => {
              event.cancelBubble = true;
              onBeginCornerDrag(index);
            }}
          />
        );
      })}
    </Group>
  );
}

function DraftRect({ start, end }: { start: { x: number; y: number }; end: { x: number; y: number } }) {
  return (
    <Rect
      dash={[6, 4]}
      height={Math.abs(end.y - start.y)}
      stroke="#f3a712"
      strokeWidth={2}
      width={Math.abs(end.x - start.x)}
      x={Math.min(start.x, end.x)}
      y={Math.min(start.y, end.y)}
    />
  );
}

function DraftEllipse({ start, end }: { start: { x: number; y: number }; end: { x: number; y: number } }) {
  const centerX = (start.x + end.x) / 2;
  const centerY = (start.y + end.y) / 2;
  const radiusX = Math.abs(end.x - start.x) / 2;
  const radiusY = Math.abs(end.y - start.y) / 2;
  const samples = 48;
  const points: number[] = [];
  for (let index = 0; index <= samples; index += 1) {
    const angle = (index / samples) * Math.PI * 2;
    points.push(centerX + Math.cos(angle) * radiusX, centerY + Math.sin(angle) * radiusY);
  }
  return <Line closed dash={[6, 4]} points={points} stroke="#f3a712" strokeWidth={2} />;
}

/**
 * 标定流程画布层：当前 sourceMode 已收集的点用实色编号显示；
 * review 阶段还会把"另一 frame"的 4 个点通过现场解算的 H 矩阵投影过来，
 * 用淡色虚化显示，便于在切换底图时直观比对配对偏差。
 */
function CalibrationOverlay({
  draft,
  projection,
  sourceMode,
  alignmentMatrices: _matrices
}: {
  draft: CalibrationDraftView;
  projection: ProjectionContext;
  sourceMode: IimlAnnotationFrame;
  alignmentMatrices: AlignmentMatrices;
}) {
  const ownPoints = sourceMode === "model" ? draft.modelPoints : draft.imagePoints;
  const otherPoints = sourceMode === "model" ? draft.imagePoints : draft.modelPoints;

  // review 阶段两边都收齐了 4 对点：现场解 H 把另一 frame 的点投到当前 frame，叠加显示。
  const projectedOther = (() => {
    if (draft.phase !== "review" || draft.modelPoints.length !== 4 || draft.imagePoints.length !== 4) {
      return [] as Array<[number, number]>;
    }
    const matrix = sourceMode === "model"
      ? solveHomography(draft.imagePoints, draft.modelPoints)
      : solveHomography(draft.modelPoints, draft.imagePoints);
    if (!matrix) {
      return [] as Array<[number, number]>;
    }
    return otherPoints.map((point) => applyHomography(matrix, point));
  })();

  return (
    <Group listening={false}>
      {ownPoints.map((uv, index) => {
        const screen = uvToScreen({ u: uv[0], v: uv[1] }, projection);
        return <CalibrationMarker key={`own-${index}`} x={screen.x} y={screen.y} index={index + 1} color="#f3a712" />;
      })}
      {projectedOther.map((uv, index) => {
        const screen = uvToScreen({ u: uv[0], v: uv[1] }, projection);
        return (
          <CalibrationMarker
            key={`other-${index}`}
            x={screen.x}
            y={screen.y}
            index={index + 1}
            color="#2ec4b6"
            ghost
          />
        );
      })}
    </Group>
  );
}

function CalibrationMarker({
  x,
  y,
  index,
  color,
  ghost
}: {
  x: number;
  y: number;
  index: number;
  color: string;
  ghost?: boolean;
}) {
  const radius = 7;
  return (
    <Group x={x} y={y} opacity={ghost ? 0.65 : 1}>
      <Circle radius={radius + 2} fill="#1d1a18" opacity={0.9} />
      <Circle
        radius={radius}
        fill={color}
        stroke="#1d1a18"
        strokeWidth={1.5}
        dash={ghost ? [3, 2] : undefined}
      />
      <Text
        text={String(index)}
        x={-4}
        y={-5}
        fontSize={10}
        fontStyle="bold"
        fill="#1d1a18"
        listening={false}
      />
    </Group>
  );
}
