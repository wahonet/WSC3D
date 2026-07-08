/**
 * 标注画布 `AnnotationCanvas`
 *
 * 标注模块的核心交互层，承载所有几何标注的绘制、选取与编辑。
 *
 * 主要职责：
 * - 用 Konva 画 Bounding Box / Polygon / Ellipse / Point / LineString 五种几何
 * - 处理工具栏当前工具（select / rect / ellipse / pen / point / calibrate）
 *   下的鼠标交互，把屏幕坐标转换为对应坐标系的 UV
 * - 跨 frame（model ↔ image）的标注用 4 点单应性矩阵投影显示，未校准时给出
 *   温和的 hint
 * - 4 点对齐校准的"乒乓采集 + review"流程
 *
 * 坐标架构（P1 修复标注漂移后）：
 * - **高清图模式（internal viewport）**：底图 `KonvaImage` 与标注层放进同一个
 *   Stage transform（x / y / scale）。标注顶点以"图像像素"为局部坐标绘制，
 *   底图怎么平移缩放，标注都跟着同一个矩阵走——漂移在数学上不可能发生。
 *   pan / zoom 由本组件直接处理（滚轮缩放围绕光标、中/右键拖动平移）。
 * - **3D 模型模式（external viewport）**：Three.js canvas 无法进 Konva，维持
 *   "投影四角 + 屏幕坐标"的旧方案；滚轮 / 平移事件转发给底层 OrbitControls。
 *
 * 设计要点：
 * - AI 候选生成唯一入口是工具栏的 SAM3 概念分割（App 层处理），画布只负责
 *   人工几何工具与结果展示
 * - 画布始终绝对定位铺满父容器；通过 `pointer-events` 与 sourceMode 双重控制
 * - 内部视口下所有描边 `strokeScaleEnabled=false`、控制点尺寸按 1/scale 反缩，
 *   保证任意缩放级别下线宽与手柄的屏幕尺寸恒定
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Circle, Group, Image as KonvaImage, Layer, Line, Rect, Shape, Stage, Text } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type Konva from "konva";
import type { Context as KonvaContext } from "konva/lib/Context";
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
import { annotationPalette } from "./store";
import type {
  AnnotationTool,
  IimlAlignment,
  IimlAnnotation,
  IimlAnnotationFrame,
  IimlGeometry,
  IimlRelation,
  ProjectionContext
} from "./types";

// 标定流程视图态：传给画布渲染当前已收集的 4 对点；undefined 表示未在标定中。
export type CalibrationDraftView = {
  modelPoints: Array<[number, number]>;
  imagePoints: Array<[number, number]>;
  phase: "collect" | "review";
};

// P1：高清图模式的底图配置。传了就启用"内部视口"——底图与标注同 Stage。
export type CanvasBaseImage = {
  url: string;
  // 线图叠加层（半透明白线）；与底图共享同一 transform，天然像素对齐。
  overlayUrl?: string;
  overlayOpacity?: number;
  // 视口背景色（与全局背景切换联动）
  background?: string;
  // 父级递增触发 fit 到容器（工具栏"重置视角"）
  fitToken?: number;
};

// P2：mask 编辑笔画（画布视图态）。UV 折线 + 底图像素笔宽。
export type MaskStrokeDraft = {
  mode: "add" | "erase";
  pointsUv: Array<[number, number]>;
  widthPx: number;
};

// 内部视口变换：offset 是 Stage 平移（CSS px），scale 应用于图像像素坐标系。
type ImageViewport = {
  scale: number;
  tx: number;
  ty: number;
};

// 用户手动缩放的范围（相对 fit 比例）与单次滚轮步长；与旧 SourceImageView 一致。
const minZoomMultiplier = 0.5;
const maxZoomMultiplier = 30;
const wheelZoomStep = 1.18;

type AnnotationCanvasProps = {
  resourceId: string;
  annotations: IimlAnnotation[];
  // B1 引入：显式传 doc.relations，让画布在选中标注时画关联连线。
  // 缺省 [] 等同于无关系，不破坏向后兼容。
  relations?: IimlRelation[];
  selectedAnnotationId?: string;
  draftAnnotationId?: string;
  activeTool: AnnotationTool;
  // 3D 模型模式（external viewport）下的投影四角；高清图模式传 undefined。
  projection?: ProjectionContext;
  // 当前底图坐标系：3D 模型 modelBox UV 或高清图自身 UV。
  sourceMode: IimlAnnotationFrame;
  // P1：高清图底图。传了就启用内部视口（底图与标注同 Stage transform）。
  baseImage?: CanvasBaseImage;
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
  // P2 mask 编辑：已提交的笔画（用于回显）+ 当前笔宽 + 笔画完成回调。
  maskStrokes?: MaskStrokeDraft[];
  maskStrokeWidthPx?: number;
  onMaskStroke?: (stroke: MaskStrokeDraft) => void;
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

// 3D 模型模式下的"底图交互目标"：Three.js 的 canvas，事件交给 OrbitControls
// 处理 pan/zoom。高清图模式（内部视口）不再需要事件转发。
function findViewportTarget(host: HTMLElement | null): HTMLElement | null {
  if (!host) return null;
  const workspace = host.closest(".annotation-workspace");
  if (!workspace) return null;
  return (workspace.querySelector(".three-stage canvas") as HTMLCanvasElement | null) ?? null;
}

export function AnnotationCanvas({
  resourceId,
  annotations,
  relations = [],
  selectedAnnotationId,
  draftAnnotationId,
  activeTool,
  projection: externalProjection,
  sourceMode,
  baseImage,
  activeFaceResourceId,
  alignment,
  calibrationDraft,
  onCreate,
  onUpdate,
  onDelete,
  onSelect,
  onToolChange,
  onCalibrationPoint,
  maskStrokes = [],
  maskStrokeWidthPx = 12,
  onMaskStroke
}: AnnotationCanvasProps) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [draftRect, setDraftRect] = useState<DraftRect>(undefined);
  const [penPoints, setPenPoints] = useState<UV[]>([]);
  // P2：正在绘制中的笔画（UV 折线）；mouseup 时通过 onMaskStroke 提交给父级。
  const [liveStroke, setLiveStroke] = useState<UV[] | undefined>(undefined);
  const draggingRef = useRef<DraggingState>(undefined);

  // ---------------- P1 内部视口（高清图模式） ----------------
  const isInternalViewport = Boolean(baseImage);
  const internalRef = useRef(isInternalViewport);
  useEffect(() => {
    internalRef.current = isInternalViewport;
  }, [isInternalViewport]);

  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | undefined>(undefined);
  const [imageEl, setImageEl] = useState<HTMLImageElement | undefined>(undefined);
  const [imageStatus, setImageStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [overlayEl, setOverlayEl] = useState<HTMLImageElement | undefined>(undefined);
  const [viewport, setViewport] = useState<ImageViewport | undefined>(undefined);
  const viewportRef = useRef<ImageViewport | undefined>(undefined);
  const fitScaleRef = useRef(1);

  const applyViewport = useCallback((next: ImageViewport) => {
    viewportRef.current = next;
    setViewport(next);
  }, []);

  // 底图加载：url 变化（切画像石 / 切资源 / 切面）重置视口等待重新 fit。
  useEffect(() => {
    if (!baseImage?.url) {
      setImageEl(undefined);
      setImageStatus("idle");
      viewportRef.current = undefined;
      setViewport(undefined);
      return;
    }
    let cancelled = false;
    setImageStatus("loading");
    setImageEl(undefined);
    viewportRef.current = undefined;
    setViewport(undefined);
    const img = new window.Image();
    img.onload = () => {
      if (cancelled) return;
      setImageEl(img);
      setImageStatus("ready");
    };
    img.onerror = () => {
      if (cancelled) return;
      setImageStatus("error");
    };
    img.src = baseImage.url;
    return () => {
      cancelled = true;
    };
  }, [baseImage?.url]);

  // 线图叠加层加载：独立于底图，失败静默（叠加层是可选视觉辅助）。
  useEffect(() => {
    if (!baseImage?.overlayUrl) {
      setOverlayEl(undefined);
      return;
    }
    let cancelled = false;
    const img = new window.Image();
    img.onload = () => {
      if (!cancelled) setOverlayEl(img);
    };
    img.onerror = () => {
      if (!cancelled) setOverlayEl(undefined);
    };
    img.src = baseImage.overlayUrl;
    return () => {
      cancelled = true;
    };
  }, [baseImage?.overlayUrl]);

  // 容器尺寸跟踪：Stage 元素始终等于容器大小；resize 不重置用户视口。
  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }
    const update = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width > 0 && height > 0) {
        setContainerSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const fitViewport = useCallback(() => {
    const img = imageEl;
    const size = containerSize;
    if (!img || !size || !img.naturalWidth || !img.naturalHeight) {
      return;
    }
    const fitScale = Math.min(size.width / img.naturalWidth, size.height / img.naturalHeight);
    if (!Number.isFinite(fitScale) || fitScale <= 0) {
      return;
    }
    fitScaleRef.current = fitScale;
    applyViewport({
      scale: fitScale,
      tx: (size.width - img.naturalWidth * fitScale) / 2,
      ty: (size.height - img.naturalHeight * fitScale) / 2
    });
  }, [applyViewport, containerSize, imageEl]);
  const fitViewportRef = useRef(fitViewport);
  useEffect(() => {
    fitViewportRef.current = fitViewport;
  }, [fitViewport]);

  // 图片就绪且尚无视口（首次加载 / 切资源）→ 自动 fit 居中。
  useEffect(() => {
    if (isInternalViewport && imageEl && containerSize && !viewport) {
      fitViewport();
    }
  }, [containerSize, fitViewport, imageEl, isInternalViewport, viewport]);

  // 父级 fitToken 递增（工具栏"重置视角"）→ 重新 fit。仅依赖 token，避免
  // resize / 换图触发意外重置。
  useEffect(() => {
    if (!isInternalViewport || baseImage?.fitToken === undefined) {
      return;
    }
    fitViewportRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseImage?.fitToken]);

  // 内部视口的投影上下文是"常量图像矩形"：UV ↔ 图像像素的换算不随视口变化，
  // 平移缩放全部交给 Stage transform。这正是漂移不可能发生的原因。
  const internalProjection = useMemo<ProjectionContext | undefined>(() => {
    if (!isInternalViewport || !imageEl || !imageEl.naturalWidth || !imageEl.naturalHeight) {
      return undefined;
    }
    const width = imageEl.naturalWidth;
    const height = imageEl.naturalHeight;
    return {
      canvasWidth: width,
      canvasHeight: height,
      // 顺序与 StoneViewer 保持一致：[左下, 右下, 右上, 左上]
      corners: [
        { x: 0, y: height },
        { x: width, y: height },
        { x: width, y: 0 },
        { x: 0, y: 0 }
      ]
    };
  }, [imageEl, isInternalViewport]);

  // 下游所有几何换算走同一个 projection：内部视口用常量图像矩形，
  // 3D 模型模式用外部投影四角。
  const projection = isInternalViewport ? internalProjection : externalProjection;

  // 当前"图像像素 → 屏幕像素"的比例：内部视口取 Stage scale；外部恒 1。
  // 用于把命中阈值、控制点尺寸、描边宽度换算成恒定的屏幕尺寸。
  const viewScale = isInternalViewport ? viewport?.scale ?? 1 : 1;

  useEffect(() => {
    setDraftRect(undefined);
    setPenPoints([]);
    setLiveStroke(undefined);
  }, [activeTool, projection?.canvasWidth, projection?.canvasHeight]);

  // 滚轮：内部视口自己缩放（围绕光标）；3D 模型模式转发给底层 OrbitControls。
  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }
    const forwardWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (internalRef.current) {
        const current = viewportRef.current;
        if (!current) {
          return;
        }
        const rect = host.getBoundingClientRect();
        const cursorX = event.clientX - rect.left;
        const cursorY = event.clientY - rect.top;
        const factor = event.deltaY < 0 ? wheelZoomStep : 1 / wheelZoomStep;
        const fitScale = fitScaleRef.current || current.scale;
        const minScale = fitScale * minZoomMultiplier;
        const maxScale = fitScale * maxZoomMultiplier;
        const nextScale = Math.min(maxScale, Math.max(minScale, current.scale * factor));
        const ratio = nextScale / current.scale;
        viewportRef.current = {
          scale: nextScale,
          tx: cursorX - (cursorX - current.tx) * ratio,
          ty: cursorY - (cursorY - current.ty) * ratio
        };
        setViewport(viewportRef.current);
        return;
      }
      const target = findViewportTarget(host);
      if (!target) {
        return;
      }
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

  // 内部视口的平移：直接更新 Stage transform；不再有跨组件事件转发。
  const startInternalPan = (nativeEvent: MouseEvent, onTap?: () => void) => {
    const startX = nativeEvent.clientX;
    const startY = nativeEvent.clientY;
    let lastX = startX;
    let lastY = startY;
    const handleMove = (event: PointerEvent) => {
      const current = viewportRef.current;
      if (!current) {
        return;
      }
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      viewportRef.current = { ...current, tx: current.tx + dx, ty: current.ty + dy };
      setViewport(viewportRef.current);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
    };
    const handleUp = (event: PointerEvent) => {
      cleanup();
      if (onTap) {
        const distance = Math.hypot(event.clientX - startX, event.clientY - startY);
        if (distance < 4) {
          onTap();
        }
      }
    };
    const handleCancel = () => cleanup();
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
  };

  // 3D 模型模式：把 pointerdown 事件切到底层 Three.js canvas，由 OrbitControls 接管。
  // 期间临时把 host 设为 pointer-events: none，后续 pointermove/pointerup 穿透。
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

  // 统一的"让底图接管平移"入口：内部视口自己动，外部转发。
  const beginPan = (nativeEvent: MouseEvent, onTap?: () => void) => {
    if (isInternalViewport) {
      startInternalPan(nativeEvent, onTap);
    } else {
      startForwardPan(nativeEvent, onTap);
    }
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
      } else if (event.key === "Enter") {
        if (activeTool === "pen" && penPoints.length >= 3) {
          finishPenPolygon(penPoints);
        }
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

  const interactive = Boolean(projection) && (!isInternalViewport || Boolean(viewport));
  const stageWidth = isInternalViewport ? containerSize?.width ?? 1 : externalProjection?.canvasWidth ?? 1;
  const stageHeight = isInternalViewport ? containerSize?.height ?? 1 : externalProjection?.canvasHeight ?? 1;

  // 指针位置：内部视口返回 Stage 局部坐标（= 图像像素），外部返回屏幕像素。
  // 两者都与当前 projection 的坐标空间一致，供 screenToUV 直接换算。
  const pointerScreen = () => {
    const stage = stageRef.current;
    if (!stage) {
      return { x: 0, y: 0 };
    }
    const pos = stage.getPointerPosition() ?? { x: 0, y: 0 };
    if (!isInternalViewport) {
      return pos;
    }
    const transform = stage.getAbsoluteTransform().copy();
    transform.invert();
    return transform.point(pos);
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
      beginPan(nativeEvent);
      return;
    }

    // 右键：让给底图做平移
    // （OrbitControls 默认 RIGHT=PAN；内部视口自己处理）。
    if (nativeEvent.button === 2) {
      nativeEvent.preventDefault();
      beginPan(nativeEvent);
      return;
    }

    const point = pointerScreen();

    if (activeTool === "select") {
      // 左键点在空白区域：转 pan。未拖动（< 4px）松开时当作 deselect。
      if (isEmptyTarget && nativeEvent.button === 0) {
        beginPan(nativeEvent, () => onSelect(undefined));
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

    if (activeTool === "brush" || activeTool === "erase") {
      // 没有提交回调（未选中标注 / 非高清图模式）时不开始笔画
      if (nativeEvent.button !== 0 || !onMaskStroke) {
        return;
      }
      const uv = screenToUV(point, projection);
      setLiveStroke([uv]);
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

    if (activeTool === "pen") {
      if (!stage) {
        return;
      }
      if (penPoints.length >= 3) {
        const first = uvToScreen(penPoints[0], projection);
        // 阈值以屏幕像素衡量：内部视口的局部距离要乘 viewScale 才是屏幕距离。
        const distance = Math.hypot(point.x - first.x, point.y - first.y) * viewScale;
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

    if (liveStroke) {
      const point = pointerScreen();
      const uv = screenToUV(point, projection);
      setLiveStroke((prev) => {
        if (!prev || prev.length === 0) {
          return [uv];
        }
        const last = prev[prev.length - 1];
        // 采样密度：局部（图像像素）距离 ≥ 2px 才追加，避免点数爆炸
        const lastScreen = uvToScreen(last, projection);
        if (Math.hypot(point.x - lastScreen.x, point.y - lastScreen.y) < 2) {
          return prev;
        }
        return [...prev, uv];
      });
    }
  };

  const handleMouseUp = () => {
    if (draggingRef.current) {
      draggingRef.current = undefined;
      return;
    }

    if (liveStroke && projection) {
      if (liveStroke.length > 0 && onMaskStroke) {
        onMaskStroke({
          mode: activeTool === "erase" ? "erase" : "add",
          pointsUv: liveStroke.map((uv) => [uv.u, uv.v] as [number, number]),
          widthPx: maskStrokeWidthPx
        });
      }
      setLiveStroke(undefined);
      return;
    }

    if (!draftRect || !projection) {
      return;
    }
    const distance =
      Math.hypot(draftRect.end.x - draftRect.start.x, draftRect.end.y - draftRect.start.y) * viewScale;
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
    if (liveStroke && liveStroke.length > 1 && onMaskStroke && projection) {
      // 移出画布视为完成一笔，避免笔画悬空丢失
      onMaskStroke({
        mode: activeTool === "erase" ? "erase" : "add",
        pointsUv: liveStroke.map((uv) => [uv.u, uv.v] as [number, number]),
        widthPx: maskStrokeWidthPx
      });
    }
    setLiveStroke(undefined);
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
  // 跨 frame 标注暂不支持就地拖拽 / 改尺寸：避免在变换后画布上推算反向坐标的复杂度；
  // 用户需要切到原 frame 后再编辑。
  const showSelectionHandles = Boolean(
    selectedDisplay && projection && !isLocked(selectedDisplay.source) && !selectedDisplay.isCrossFrame
  );
  const penScreenPoints = projection ? penPoints.map((point) => uvToScreen(point, projection)) : [];

  return (
    <div
      ref={containerRef}
      className={["annotation-canvas-host", interactive ? "active" : ""].filter(Boolean).join(" ")}
      style={isInternalViewport && baseImage?.background ? { background: baseImage.background } : undefined}
      tabIndex={0}
    >
      <Stage
        className={interactive ? "annotation-canvas active" : "annotation-canvas"}
        ref={stageRef}
        width={stageWidth}
        height={stageHeight}
        x={isInternalViewport ? viewport?.tx ?? 0 : 0}
        y={isInternalViewport ? viewport?.ty ?? 0 : 0}
        scaleX={isInternalViewport ? viewport?.scale ?? 1 : 1}
        scaleY={isInternalViewport ? viewport?.scale ?? 1 : 1}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleStageLeave}
        onDblClick={handleDoubleClick}
        onContextMenu={(event) => event.evt.preventDefault()}
      >
        {isInternalViewport && imageEl ? (
          <Layer listening={false}>
            <KonvaImage
              image={imageEl}
              width={imageEl.naturalWidth}
              height={imageEl.naturalHeight}
              listening={false}
            />
            {overlayEl ? (
              <KonvaImage
                image={overlayEl}
                width={imageEl.naturalWidth}
                height={imageEl.naturalHeight}
                opacity={baseImage?.overlayOpacity ?? 0.85}
                globalCompositeOperation="screen"
                listening={false}
              />
            ) : null}
          </Layer>
        ) : null}
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
              viewScale={viewScale}
              onSelect={() => onSelect(source.id)}
              onBeginDrag={() => beginShapeDrag(source)}
            />
          ))}
          {showSelectionHandles && selectedDisplay && projection ? (
            <SelectionHandles
              geometry={selectedDisplay.displayGeometry}
              projection={projection}
              viewScale={viewScale}
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
                strokeScaleEnabled={false}
                dash={[5, 4]}
              />
              {penScreenPoints.map((point, index) => (
                <Circle
                  fill="#f3a712"
                  key={`pen-${index}`}
                  radius={(index === 0 ? 5 : 3) / viewScale}
                  stroke="#1d1a18"
                  strokeWidth={1}
                  strokeScaleEnabled={false}
                  x={point.x}
                  y={point.y}
                />
              ))}
            </Group>
          ) : null}
          {projection && (maskStrokes.length > 0 || liveStroke) ? (
            <Group listening={false}>
              {maskStrokes.map((stroke, index) => (
                <MaskStrokeLine key={`mask-stroke-${index}`} stroke={stroke} projection={projection} />
              ))}
              {liveStroke && liveStroke.length > 0 ? (
                <MaskStrokeLine
                  stroke={{
                    mode: activeTool === "erase" ? "erase" : "add",
                    pointsUv: liveStroke.map((uv) => [uv.u, uv.v] as [number, number]),
                    widthPx: maskStrokeWidthPx
                  }}
                  projection={projection}
                  live
                />
              ) : null}
            </Group>
          ) : null}
          {calibrationDraft && projection ? (
            <CalibrationOverlay
              draft={calibrationDraft}
              projection={projection}
              sourceMode={sourceMode}
              viewScale={viewScale}
              alignmentMatrices={alignmentMatrices}
            />
          ) : null}
          {selectedDisplay && projection && relations.length > 0 ? (
            <RelationLines
              selectedDisplay={selectedDisplay}
              displayAnnotations={displayAnnotations}
              relations={relations}
              projection={projection}
              viewScale={viewScale}
            />
          ) : null}
        </Layer>
      </Stage>
      {!projection && !isInternalViewport ? (
        <div className="annotation-canvas-placeholder">
          <span>正在等待模型投影就绪...</span>
        </div>
      ) : null}
      {isInternalViewport && imageStatus === "loading" ? (
        <div className="load-panel">
          <span>正在加载高清图</span>
        </div>
      ) : null}
      {isInternalViewport && imageStatus === "error" ? (
        <div className="load-panel error">
          <span>未找到该画像石的高清原图</span>
          <small>请确认 pic/ 目录里有以编号开头的图像文件，且 ai-service 在运行</small>
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
  viewScale,
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
  // 图像像素 → 屏幕像素比例；内部视口下用于反缩控制点等固定尺寸元素。
  viewScale: number;
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
    // 只有左键才是"选中 + 拖动标注"；中键 / 右键放行给 Stage 做底图平移。
    if (!interactive || event.evt.button !== 0) {
      return;
    }
    event.cancelBubble = true;
    onSelect();
    onBeginDrag();
  };
  const onClick = (event: KonvaEventObject<MouseEvent>) => {
    if (activeTool !== "select" || event.evt.button !== 0) {
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
        strokeScaleEnabled={false}
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
        radius={(isSelected ? 7 : 5) / viewScale}
        fill={stroke}
        stroke="#1d1a18"
        strokeWidth={1.5}
        strokeScaleEnabled={false}
        opacity={opacity}
        onMouseDown={onMouseDown}
        onClick={onClick}
      />
    );
  }

  // P2：Polygon / MultiPolygon 用 sceneFunc + evenodd 渲染，正确显示洞
  // （mask 级合并的输出常带洞；旧 Line flatten 渲染会把洞画成连线瑕疵）。
  if (displayGeometry.type === "Polygon" || displayGeometry.type === "MultiPolygon") {
    const polygons: Array<Array<Array<{ x: number; y: number }>>> =
      displayGeometry.type === "Polygon"
        ? [displayGeometry.coordinates.map((ring) => ring.map((point) => uvToScreen({ u: Number(point[0] ?? 0), v: Number(point[1] ?? 0) }, projection)))]
        : displayGeometry.coordinates.map((polygon) =>
            polygon.map((ring) => ring.map((point) => uvToScreen({ u: Number(point[0] ?? 0), v: Number(point[1] ?? 0) }, projection)))
          );
    const drawPath = (context: KonvaContext) => {
      context.beginPath();
      for (const rings of polygons) {
        for (const ring of rings) {
          if (ring.length < 3) continue;
          ring.forEach((point, index) => {
            if (index === 0) {
              context.moveTo(point.x, point.y);
            } else {
              context.lineTo(point.x, point.y);
            }
          });
          context.closePath();
        }
      }
    };
    return (
      <Shape
        sceneFunc={(context, shape) => {
          drawPath(context);
          context.fillStrokeShape(shape);
        }}
        fillRule="evenodd"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeScaleEnabled={false}
        dash={dash}
        fill={fillColor}
        opacity={opacity}
        onMouseDown={onMouseDown}
        onClick={onClick}
      />
    );
  }

  const points = projectGeometryToScreen(displayGeometry, projection).flatMap((point) => [point.x, point.y]);
  return (
    <Line
      points={points}
      closed={false}
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeScaleEnabled={false}
      dash={dash}
      opacity={opacity}
      onMouseDown={onMouseDown}
      onClick={onClick}
    />
  );
}

/**
 * P2 mask 编辑笔画：宽度以图像像素表示（随缩放同步缩放，与最终栅格化一致）。
 * add=绿色半透明；erase=红色半透明；live（正在画）透明度略低。
 */
function MaskStrokeLine({
  stroke,
  projection,
  live
}: {
  stroke: MaskStrokeDraft;
  projection: ProjectionContext;
  live?: boolean;
}) {
  const screenPoints = stroke.pointsUv.map(([u, v]) => uvToScreen({ u, v }, projection));
  const color = stroke.mode === "erase" ? "#ff5f57" : "#45d483";
  if (screenPoints.length === 1) {
    return (
      <Circle
        x={screenPoints[0].x}
        y={screenPoints[0].y}
        radius={Math.max(0.5, stroke.widthPx / 2)}
        fill={color}
        opacity={live ? 0.4 : 0.5}
        listening={false}
      />
    );
  }
  return (
    <Line
      points={screenPoints.flatMap((point) => [point.x, point.y])}
      stroke={color}
      strokeWidth={Math.max(1, stroke.widthPx)}
      lineCap="round"
      lineJoin="round"
      opacity={live ? 0.4 : 0.5}
      listening={false}
    />
  );
}

function SelectionHandles({
  geometry,
  projection,
  viewScale,
  onBeginCornerDrag
}: {
  geometry: IimlGeometry;
  projection: ProjectionContext;
  viewScale: number;
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
  const scaledHandle = handleSize / viewScale;
  return (
    <Group>
      <Circle x={center.x} y={center.y} radius={3 / viewScale} fill="#f3a712" opacity={0.6} listening={false} />
      {corners.map(({ uv, index }) => {
        const screen = uvToScreen(uv, projection);
        return (
          <Rect
            key={`handle-${index}`}
            x={screen.x - scaledHandle / 2}
            y={screen.y - scaledHandle / 2}
            width={scaledHandle}
            height={scaledHandle}
            fill="#f3a712"
            stroke="#1d1a18"
            strokeWidth={1.2}
            strokeScaleEnabled={false}
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
      strokeScaleEnabled={false}
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
  return <Line closed dash={[6, 4]} points={points} stroke="#f3a712" strokeWidth={2} strokeScaleEnabled={false} />;
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
  viewScale,
  alignmentMatrices: _matrices
}: {
  draft: CalibrationDraftView;
  projection: ProjectionContext;
  sourceMode: IimlAnnotationFrame;
  viewScale: number;
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
        return (
          <CalibrationMarker
            key={`own-${index}`}
            x={screen.x}
            y={screen.y}
            index={index + 1}
            color="#f3a712"
            viewScale={viewScale}
          />
        );
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
            viewScale={viewScale}
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
  viewScale,
  ghost
}: {
  x: number;
  y: number;
  index: number;
  color: string;
  viewScale: number;
  ghost?: boolean;
}) {
  const radius = 7;
  // 用 1/viewScale 反缩整个 marker：内部视口任何缩放级别下屏幕尺寸恒定。
  const inverse = 1 / viewScale;
  return (
    <Group x={x} y={y} scaleX={inverse} scaleY={inverse} opacity={ghost ? 0.65 : 1}>
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
  projection,
  viewScale
}: {
  selectedDisplay: DisplayAnnotation;
  displayAnnotations: DisplayAnnotation[];
  relations: IimlRelation[];
  projection: ProjectionContext;
  viewScale: number;
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
              strokeScaleEnabled={false}
              dash={isAuto ? [6, 4] : undefined}
              opacity={0.85}
              listening={false}
            />
            <Circle
              x={otherCenter.x}
              y={otherCenter.y}
              radius={4 / viewScale}
              fill={stroke}
              stroke="#1d1a18"
              strokeWidth={1.5}
              strokeScaleEnabled={false}
              listening={false}
            />
          </Group>
        );
      })}
      <Circle
        x={center.x}
        y={center.y}
        radius={5 / viewScale}
        fill="#f3a712"
        stroke="#1d1a18"
        strokeWidth={1.5}
        strokeScaleEnabled={false}
        listening={false}
      />
    </Group>
  );
}
