/**
 * 标注画布 `AnnotationCanvas`
 *
 * 标注模块的核心交互层，承载所有几何标注的绘制、选取、编辑与 AI 候选交互。
 *
 * 主要职责：
 * - 用 Konva 画 Bounding Box / Polygon / Ellipse / Point / LineString 五种几何
 * - 处理工具栏当前工具（select / rect / ellipse / pen / point / sam / calibrate）
 *   下的鼠标交互，把屏幕坐标转换为对应坐标系的 UV
 * - 跨 frame（model ↔ image）的标注用 4 点单应性矩阵投影显示，未校准时给出
 *   温和的 hint
 * - SAM 多 prompt 浮窗：左键正点、右键负点、Shift+左键拖框，回车提交一次推理
 * - 4 点对齐校准的"乒乓采集 + review"流程
 *
 * 设计要点：
 * - 画布始终绝对定位铺满父容器；通过 `pointer-events` 与 sourceMode 双重控制，
 *   不抢占下层 3D / 高清图视图的相机操作
 * - 坐标系切换：父级 `AnnotationWorkspace` 切换 sourceMode 时，画布按 frame
 *   重新投影所有标注；与父级 `projection` 字段共同决定屏幕 ↔ UV 转换
 * - 跨 frame 标注用稀疏虚线 + 半透明显示（"投影态"），仅可点选不可拖拽
 */

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
import {
  requestSamCandidate,
  requestSamCandidateWithSource,
  type SamPromptDraft
} from "./sam";
import { annotationPalette } from "./store";
import type {
  AnnotationTool,
  IimlAlignment,
  IimlAnnotation,
  IimlAnnotationFrame,
  IimlGeometry,
  IimlProcessingRun,
  IimlRelation,
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
  // 当前画像石 id；SAM 高清图路径用它去 pic/ 找原图。从 resourceId.split(":") 反推
  // 在自定义 resource id（如 `resource-ortho-front-xxx`）下会失效，所以显式传。
  stoneId: string;
  annotations: IimlAnnotation[];
  // B1 引入：显式传 doc.relations，让画布在选中标注时画关联连线。
  // 缺省 [] 等同于无关系，不破坏向后兼容。
  relations?: IimlRelation[];
  selectedAnnotationId?: string;
  draftAnnotationId?: string;
  activeTool: AnnotationTool;
  projection?: ProjectionContext;
  // 当前底图坐标系：3D 模型 modelBox UV 或高清图自身 UV。
  sourceMode: IimlAnnotationFrame;
  // v0.8.0 J：当前底图对应的资源 URI（正射图 / 拓片 / 法线图等）。传了则 SAM
  // 调用会用这个 URI 作为输入图像，而不是 stoneId → pic/ 原图。
  activeImageUri?: string;
  // 当前图片工作面对应的资源 id。A 面为空时不筛；B/C 面用于让图片模式只显示同面标注。
  activeFaceResourceId?: string;
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
  // D3 学术溯源：每次 SAM 调用后追加一条 processingRun（成功 / 失败都报）
  onProcessingRun?: (run: IimlProcessingRun) => void;
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
  stoneId,
  annotations,
  relations = [],
  selectedAnnotationId,
  draftAnnotationId,
  activeTool,
  projection,
  sourceMode,
  activeImageUri,
  activeFaceResourceId,
  alignment,
  calibrationDraft,
  onCreate,
  onUpdate,
  onDelete,
  onSelect,
  onToolChange,
  onCalibrationPoint,
  onProcessingRun
}: AnnotationCanvasProps) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [draftRect, setDraftRect] = useState<DraftRect>(undefined);
  const [penPoints, setPenPoints] = useState<UV[]>([]);
  // SAM 请求期间禁掉画布点击并提示 wait 光标，避免重复点出多个候选。
  const [isSamPending, setIsSamPending] = useState(false);
  // SAM 多 prompt 工作流：用户左键加正点、右键加负点、Shift+左键拖动 box，
  // Enter 提交、Esc 清空。draft 是单一来源，hud 与画布 overlay 都基于它渲染。
  const [samPromptDraft, setSamPromptDraft] = useState<SamPromptDraft>({ points: [] });
  // box 拖动期间的"实时框"：mousedown 记 anchor，mousemove 跟着鼠标变 endUv，
  // mouseup 时距离够大才落到 samPromptDraft.box，否则视为取消（防误触）。
  const [samBoxLive, setSamBoxLive] = useState<{ start: UV; end: UV } | undefined>(undefined);
  const draggingRef = useRef<DraggingState>(undefined);

  useEffect(() => {
    setDraftRect(undefined);
    setPenPoints([]);
    // 切换工具或 projection 失效时清空 SAM 采点态，避免上下文错乱
    setSamPromptDraft({ points: [] });
    setSamBoxLive(undefined);
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
        } else if (activeTool === "sam" && (samPromptDraft.points.length > 0 || samPromptDraft.box || samBoxLive)) {
          resetSamPrompts();
        } else {
          onSelect(undefined);
        }
      } else if (event.key === "Enter") {
        if (activeTool === "pen" && penPoints.length >= 3) {
          finishPenPolygon(penPoints);
        } else if (activeTool === "sam" && (samPromptDraft.points.length > 0 || samPromptDraft.box) && !isSamPending) {
          submitSamPrompts();
        }
      }
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAnnotationId, activeTool, penPoints, samPromptDraft, samBoxLive, isSamPending]);

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
      .filter((annotation) => {
        if (!activeFaceResourceId) {
          return !annotation.resourceId.includes(":original:");
        }
        return annotation.resourceId === activeFaceResourceId;
      })
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
  }, [activeFaceResourceId, alignmentMatrices, annotations, sourceMode]);

  // 跨 frame 但 alignment 还没建立时，统计漏掉的标注数，给画布做一个温和的提示。
  const hiddenCrossFrameCount = useMemo(() => {
    if (alignmentMatrices.modelToImage && alignmentMatrices.imageToModel) {
      return 0;
    }
    return annotations.filter((annotation) => {
      if (!isVisible(annotation) || (annotation.frame ?? "model") === sourceMode) return false;
      if (!activeFaceResourceId) {
        return !annotation.resourceId.includes(":original:");
      }
      return annotation.resourceId === activeFaceResourceId;
    }).length;
  }, [activeFaceResourceId, alignmentMatrices.imageToModel, alignmentMatrices.modelToImage, annotations, sourceMode]);

  const interactive = Boolean(projection);
  const stageWidth = projection?.canvasWidth ?? 1;
  const stageHeight = projection?.canvasHeight ?? 1;

  const pointerScreen = () => {
    const stage = stageRef.current;
    return stage?.getPointerPosition() ?? { x: 0, y: 0 };
  };

  const newColor = () => annotationPalette[annotations.length % annotationPalette.length];

  const finishPenPolygon = (points: UV[]) => {
    if (!projection || points.length < 3) {
      setPenPoints([]);
      return;
    }
    const geometry = polygonFromUVs(points);
    const annotation = createAnnotationFromGeometry({ geometry, resourceId, color: newColor(), frame: sourceMode });
    onCreate(annotation, true);
    onToolChange("select");
    setPenPoints([]);
  };

  // SAM 多 prompt 提交：把当前 draft 一次性发给 SAM，候选返回后落入标注。
  // 优先走高清图路径（pic/ 匹配 stoneId），失败回退到当前视角截图。
  const submitSamPrompts = () => {
    if (!projection || isSamPending) {
      return;
    }
    const draft = samPromptDraft;
    if (draft.points.length === 0 && !draft.box) {
      return;
    }
    setIsSamPending(true);
    // C2：用显式 prop 而非 resourceId.split(":")[0]——后者在自定义资源 id
    // （如 `resource-ortho-front-xxx`）下抽到错误的 stoneId。
    const baseColor = newColor();
    const startedAt = new Date().toISOString();

    // D3 收集本次 prompt 摘要（不存全部坐标，避免 IIML 文档膨胀）
    const promptSummary = {
      positiveCount: draft.points.filter((point) => point.label === 1).length,
      negativeCount: draft.points.filter((point) => point.label === 0).length,
      hasBox: Boolean(draft.box),
      sourceMode
    };

    void (async () => {
      let createdAnnotation: IimlAnnotation | undefined;
      let usedPath: "source" | "screenshot" = "source";
      let lastError: unknown;
      try {
        createdAnnotation = await requestSamCandidateWithSource({
          stoneId,
          imageUri: activeImageUri,
          prompts: draft,
          resourceId,
          color: baseColor,
          frame: sourceMode
        });
        if (createdAnnotation) {
          onCreate(createdAnnotation, false);
          onSelect(createdAnnotation.id);
        }
      } catch (error) {
        console.warn("SAM source path failed, falling back to screenshot:", error);
        lastError = error;
      }

      if (!createdAnnotation) {
        usedPath = "screenshot";
        const stoneCanvas = findStoneCanvas(containerRef.current);
        if (stoneCanvas) {
          try {
            const shot = await requestSamCandidate({
              prompts: draft,
              stoneCanvas,
              projection,
              resourceId,
              color: baseColor,
              frame: sourceMode
            });
            if (shot) {
              createdAnnotation = shot;
              onCreate(shot, false);
              onSelect(shot.id);
            }
          } catch (error) {
            console.error("SAM screenshot path also failed:", error);
            lastError = error;
          }
        }
      }

      // D3 写入 processingRun（成功 / 失败都报）
      if (onProcessingRun) {
        const endedAt = new Date().toISOString();
        const run: IimlProcessingRun = {
          id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          method: "sam",
          model: createdAnnotation?.generation?.model ?? "unknown",
          input: { ...promptSummary, path: usedPath },
          output: {
            ok: Boolean(createdAnnotation),
            polygonCount: createdAnnotation ? 1 : 0
          },
          confidence: createdAnnotation?.generation?.confidence,
          resultAnnotationIds: createdAnnotation ? [createdAnnotation.id] : [],
          resourceId,
          frame: sourceMode,
          startedAt,
          endedAt,
          error: createdAnnotation
            ? undefined
            : lastError instanceof Error
              ? lastError.message
              : lastError !== undefined
                ? String(lastError)
                : "no-candidate"
        };
        onProcessingRun(run);
      }
    })().finally(() => {
      setIsSamPending(false);
      setSamPromptDraft({ points: [] });
      setSamBoxLive(undefined);
      onToolChange("select");
    });
  };

  const resetSamPrompts = () => {
    setSamPromptDraft({ points: [] });
    setSamBoxLive(undefined);
  };

  const undoLastSamPrompt = () => {
    setSamBoxLive(undefined);
    setSamPromptDraft((prev) => {
      // 优先撤销 box（最后加的可能是 box），否则撤销最后一个点
      if (prev.box) {
        return { ...prev, box: undefined };
      }
      if (prev.points.length === 0) {
        return prev;
      }
      return { ...prev, points: prev.points.slice(0, -1) };
    });
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

    // 中键：无论哪个工具都让给底图做平移。
    if (nativeEvent.button === 1) {
      nativeEvent.preventDefault();
      startForwardPan(nativeEvent);
      return;
    }

    // 右键：SAM 工具下用作"加负点"，其它工具下让给底图做平移
    // （OrbitControls 默认 RIGHT=PAN；SourceImageView 自己也接受右键 pan）。
    if (nativeEvent.button === 2) {
      if (activeTool === "sam" && !isSamPending) {
        nativeEvent.preventDefault();
        const point = pointerScreen();
        const uv = screenToUV(point, projection);
        setSamPromptDraft((prev) => ({
          ...prev,
          points: [...prev.points, { uv, label: 0 }]
        }));
        return;
      }
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
      const annotation = createAnnotationFromGeometry({
        geometry: pointFromUV(uv),
        resourceId,
        color: newColor(),
        frame: sourceMode,
        label: "弱标注点",
        annotationQuality: "weak",
        geometryIntent: "semantic_extent"
      });
      onCreate(annotation, true);
      onToolChange("select");
      return;
    }

    if (activeTool === "sam") {
      if (nativeEvent.button !== 0 || isSamPending) {
        return;
      }
      const uv = screenToUV(point, projection);
      // Shift + 左键：开始 box 拖动；普通左键：加正点
      if (nativeEvent.shiftKey) {
        setSamBoxLive({ start: uv, end: uv });
        return;
      }
      setSamPromptDraft((prev) => ({
        ...prev,
        points: [...prev.points, { uv, label: 1 }]
      }));
      return;
    }

    if (activeTool === "pen") {
      if (!stage) {
        return;
      }
      if (penPoints.length >= 3) {
        const first = uvToScreen(penPoints[0], projection);
        const distance = Math.hypot(point.x - first.x, point.y - first.y);
        if (distance <= 8) {
          finishPenPolygon(penPoints);
          return;
        }
      }
      const uv = screenToUV(point, projection);
      setPenPoints((points) => [...points, uv]);
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

    if (samBoxLive) {
      const uv = screenToUV(pointerScreen(), projection);
      setSamBoxLive({ ...samBoxLive, end: uv });
    }
  };

  const handleMouseUp = () => {
    if (draggingRef.current) {
      draggingRef.current = undefined;
      return;
    }

    // SAM box 拖动结束：距离够大才落到 promptDraft.box，否则视为取消（防止 Shift+
    // 单击的误触）。
    if (samBoxLive && projection) {
      const startScreen = uvToScreen(samBoxLive.start, projection);
      const endScreen = uvToScreen(samBoxLive.end, projection);
      const distance = Math.hypot(endScreen.x - startScreen.x, endScreen.y - startScreen.y);
      if (distance >= minDragPixels) {
        setSamPromptDraft((prev) => ({
          ...prev,
          box: { startUv: samBoxLive.start, endUv: samBoxLive.end }
        }));
      }
      setSamBoxLive(undefined);
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
    const annotation = createAnnotationFromGeometry({
      geometry,
      resourceId,
      color: newColor(),
      frame: sourceMode,
      label: activeTool === "rect" ? "弱标注框" : undefined,
      annotationQuality: activeTool === "rect" ? "weak" : undefined,
      geometryIntent: "semantic_extent"
    });
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
    if (samBoxLive) {
      setSamBoxLive(undefined);
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
  const penScreenPoints = projection ? penPoints.map((point) => uvToScreen(point, projection)) : [];

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
          {penScreenPoints.length > 0 ? (
            <Group>
              <Line
                points={penScreenPoints.flatMap((point) => [point.x, point.y])}
                stroke="#f3a712"
                strokeWidth={2}
                dash={[5, 4]}
              />
              {penScreenPoints.map((point, index) => (
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
          {selectedDisplay && projection && relations.length > 0 ? (
            <RelationLines
              selectedDisplay={selectedDisplay}
              displayAnnotations={displayAnnotations}
              relations={relations}
              projection={projection}
            />
          ) : null}
          {activeTool === "sam" && projection ? (
            <SamPromptOverlay
              draft={samPromptDraft}
              live={samBoxLive}
              projection={projection}
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
      {activeTool === "sam" ? (
        <SamPromptHud
          draft={samPromptDraft}
          pending={isSamPending}
          onSubmit={submitSamPrompts}
          onUndoLast={undoLastSamPrompt}
          onReset={resetSamPrompts}
          onCancel={() => {
            resetSamPrompts();
            onToolChange("select");
          }}
        />
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

/**
 * 关系连线（B3）：选中某个标注时，从该标注几何中心画线到所有相关标注的中心。
 *   - 实线：origin = "manual" 的关系
 *   - 虚线：origin = "spatial-auto" / "ai-suggest"（这些当前不入库，但兼容）
 *   - 跨 frame 关系如果对方在 displayAnnotations 里（已校准 + 投影成功）才画线，
 *     否则跳过（避免画到错位的位置）
 *   - listening={false} 不拦截事件
 */
function RelationLines({
  selectedDisplay,
  displayAnnotations,
  relations,
  projection
}: {
  selectedDisplay: DisplayAnnotation;
  displayAnnotations: DisplayAnnotation[];
  relations: IimlRelation[];
  projection: ProjectionContext;
}) {
  const selectedId = selectedDisplay.source.id;
  const center = uvToScreen(geometryCenter(selectedDisplay.displayGeometry), projection);
  const lookup = new Map<string, DisplayAnnotation>();
  for (const entry of displayAnnotations) {
    lookup.set(entry.source.id, entry);
  }

  const involved = relations.filter(
    (relation) => relation.source === selectedId || relation.target === selectedId
  );

  return (
    <Group listening={false}>
      {involved.map((relation) => {
        const otherId = relation.source === selectedId ? relation.target : relation.source;
        const otherDisplay = lookup.get(otherId);
        if (!otherDisplay) {
          // 对方在另一坐标系且未校准（被过滤）或已删除，不画线
          return null;
        }
        const otherCenter = uvToScreen(geometryCenter(otherDisplay.displayGeometry), projection);
        const isAuto = relation.origin !== "manual";
        const stroke = isAuto ? "#2ec4b6" : "#f3a712";
        return (
          <Group key={`relation-line-${relation.id}`}>
            <Line
              points={[center.x, center.y, otherCenter.x, otherCenter.y]}
              stroke={stroke}
              strokeWidth={isAuto ? 1.5 : 2}
              dash={isAuto ? [6, 4] : undefined}
              opacity={0.85}
              listening={false}
            />
            <Circle x={otherCenter.x} y={otherCenter.y} radius={4} fill={stroke} stroke="#1d1a18" strokeWidth={1.5} listening={false} />
          </Group>
        );
      })}
      <Circle x={center.x} y={center.y} radius={5} fill="#f3a712" stroke="#1d1a18" strokeWidth={1.5} listening={false} />
    </Group>
  );
}

/**
 * SAM 多 prompt 画布层：
 *   - 正点：绿色实心圆（label=1）
 *   - 负点：红色实心圆 + 中心 ✕（label=0）
 *   - 已确认 box：黄色虚线矩形
 *   - 拖动中的临时 box：黄色更稀疏虚线（与已确认 box 区分）
 */
function SamPromptOverlay({
  draft,
  live,
  projection
}: {
  draft: SamPromptDraft;
  live: { start: UV; end: UV } | undefined;
  projection: ProjectionContext;
}) {
  const boxStart = draft.box ? draft.box.startUv : undefined;
  const boxEnd = draft.box ? draft.box.endUv : undefined;
  const boxScreen = boxStart && boxEnd
    ? rectScreenFromUVs(boxStart, boxEnd, projection)
    : undefined;
  const liveScreen = live ? rectScreenFromUVs(live.start, live.end, projection) : undefined;

  return (
    <Group listening={false}>
      {boxScreen ? (
        <Rect
          x={boxScreen.x}
          y={boxScreen.y}
          width={boxScreen.width}
          height={boxScreen.height}
          stroke="#f3a712"
          strokeWidth={2}
          dash={[6, 4]}
          listening={false}
        />
      ) : null}
      {liveScreen ? (
        <Rect
          x={liveScreen.x}
          y={liveScreen.y}
          width={liveScreen.width}
          height={liveScreen.height}
          stroke="#f8b834"
          strokeWidth={1.5}
          dash={[3, 4]}
          opacity={0.85}
          listening={false}
        />
      ) : null}
      {draft.points.map((point, index) => {
        const screen = uvToScreen(point.uv, projection);
        return (
          <SamPromptMarker
            key={`sam-prompt-${index}`}
            x={screen.x}
            y={screen.y}
            label={point.label}
          />
        );
      })}
    </Group>
  );
}

function rectScreenFromUVs(a: UV, b: UV, projection: ProjectionContext) {
  const start = uvToScreen(a, projection);
  const end = uvToScreen(b, projection);
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}

function SamPromptMarker({
  x,
  y,
  label
}: {
  x: number;
  y: number;
  label: 0 | 1;
}) {
  const isPositive = label === 1;
  const fill = isPositive ? "#45d483" : "#ff5f57";
  return (
    <Group x={x} y={y} listening={false}>
      <Circle radius={8} fill="#1d1a18" opacity={0.85} />
      <Circle radius={6} fill={fill} stroke="#1d1a18" strokeWidth={1.2} />
      {isPositive ? null : (
        <>
          <Line points={[-3, -3, 3, 3]} stroke="#1d1a18" strokeWidth={1.5} />
          <Line points={[-3, 3, 3, -3]} stroke="#1d1a18" strokeWidth={1.5} />
        </>
      )}
    </Group>
  );
}

/**
 * SAM 多 prompt 浮窗：底部居中，显示当前 prompt 计数 + 操作按钮。
 * 与 calibration-hud 视觉风格一致；不阻塞画布交互（pointer-events 仅作用在按钮上）。
 */
function SamPromptHud({
  draft,
  pending,
  onSubmit,
  onUndoLast,
  onReset,
  onCancel
}: {
  draft: SamPromptDraft;
  pending: boolean;
  onSubmit: () => void;
  onUndoLast: () => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const positive = draft.points.filter((point) => point.label === 1).length;
  const negative = draft.points.filter((point) => point.label === 0).length;
  const hasBox = Boolean(draft.box);
  const total = draft.points.length + (hasBox ? 1 : 0);
  const canSubmit = !pending && total > 0;

  let prompt: React.ReactNode;
  if (pending) {
    prompt = <span>正在请求 SAM…</span>;
  } else if (total === 0) {
    prompt = (
      <span>
        <strong>左键</strong>加正点 · <strong>右键</strong>加负点 · <strong>Shift+左键拖动</strong>出框
        <span className="muted-text"> · 至少 1 个点 / 框</span>
      </span>
    );
  } else {
    prompt = (
      <span>
        当前：<strong>{positive}</strong> 正点
        {negative > 0 ? (
          <>
            {" / "}
            <strong>{negative}</strong> 负点
          </>
        ) : null}
        {hasBox ? (
          <>
            {" / "}
            <strong>1</strong> 框
          </>
        ) : null}
        <span className="muted-text"> · 按 Enter 提交</span>
      </span>
    );
  }

  return (
    <div className="sam-prompt-hud" role="dialog" aria-label="SAM 多点 prompt">
      <div className="sam-prompt-hud-row">
        <span className="sam-prompt-hud-step">{Math.min(total, 9)} prompts</span>
        <div className="sam-prompt-hud-prompt">{prompt}</div>
      </div>
      <div className="sam-prompt-hud-actions">
        <button type="button" className="ghost-cta" onClick={onUndoLast} disabled={pending || total === 0}>
          撤销上一个
        </button>
        <button type="button" className="ghost-cta" onClick={onReset} disabled={pending || total === 0}>
          清空
        </button>
        <button type="button" className="ghost-cta" onClick={onCancel} disabled={pending}>
          取消
        </button>
        <button type="button" className="primary-cta" onClick={onSubmit} disabled={!canSubmit}>
          {pending ? "运行中…" : `提交 SAM（${total}）`}
        </button>
      </div>
    </div>
  );
}
