/**
 * 高清图视图 `SourceImageView`
 *
 * 标注模块"高清图"模式下的底图组件，渲染来自 ai-service 的高清原图（pic/ 目录）
 * 或任意被覆写的资源 URI（正射 / 拓片 / 法线图等）。
 *
 * 主要功能：
 * - 自带 pan / zoom：滚轮缩放围绕光标，中键 / 右键拖动平移；touch-action: none
 *   接管浏览器原生触控，避免手势冲突
 * - **图层叠加**：原图基础上可半透明叠加 AI 线图（白线 + alpha 渐变），共用同
 *   一个 transform 保证像素对齐
 * - **屏幕投影回传**：把图像 4 角的屏幕坐标算出来，供 `AnnotationCanvas` 把
 *   UV 标注精准投影到屏幕
 * - **fitToken**：父级递增时自动 fit 到容器（用于"重置视角"）
 *
 * 设计要点：
 * - 不引入额外的画布库；直接用 `<img>` + CSS transform 完成 pan/zoom，依赖浏览器
 *   原生 GPU 合成，渲染最快
 * - `imageUrl` 覆写时仅替换底图，不影响坐标系（图像 UV 仍是图自身归一化）；
 *   Canny 线图基于 pic/ 原图生成，资源覆写时父级会强制关闭 +线图 防止错位
 * - 视图状态（offsetX / offsetY / scale）由本组件内部维护，父级仅触发 fit
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getLineartUrl, getSourceImageUrl, type LineartMethod } from "../../api/client";
import type { ScreenProjection } from "./StoneViewer";

// 高清图模式可叠加的图像层。"source" 仅显示原图；"canny" 在原图之上叠半透明
// 线图（共用 transform，避免对齐问题），便于辨识浅浮雕轮廓。
// 历史命名"canny"保留，是为了与原 segmented 切换 UI 兼容；但 method 已经
// 扩展到 5 种（canny / canny-plus / sobel / scharr / morph）。
export type SourceImageLayer = "source" | "canny";

export type CannyOptions = {
  // 双阈值 0-255。低阈值越大边越少；高阈值越大主干线越突出。
  // morph 方法时 low 当 blockSize 用（11~31 推荐，强制奇数）。
  low: number;
  high: number;
  // 线图叠加在原图之上的不透明度 0..1。
  opacity: number;
  // F2 阶段：线图算法选择。默认 canny-plus（汉画像石残损浮雕推荐）。
  method?: LineartMethod;
};

const defaultCanny: CannyOptions = { low: 60, high: 140, opacity: 0.85, method: "canny-plus" };

type SourceImageViewProps = {
  // 父级以 CSS 隐藏时传 false；图片自身没有 render loop，关掉只是省一点 ResizeObserver 工作。
  active?: boolean;
  stoneId: string;
  background?: "black" | "gray" | "white";
  // 父级递增 fitToken（如工具栏"重置视角"按钮）触发 fit 到容器。
  fitToken?: number;
  // 显示哪一层：原图 / 原图 + 半透明 Canny 线图。layer 切换不影响坐标系，
  // 因为 Canny PNG 与原 PNG 像素一一对应。
  layer?: SourceImageLayer;
  // Canny 线图选项；layer === "canny" 时才生效。
  cannyOptions?: CannyOptions;
  // I1 v0.8.0：可覆写底图 URL。默认走 /ai/source-image/{stoneId}（pic/ 原图），
  // 传了就用它（正射图 / 拓片扫描 / 任意 doc.resources 里的 image 类资源）。
  // Canny 线图仍然基于 pic/ 原图生成，所以 layer === "canny" 叠加在正射 / 拓片
  // 上会错位；当 imageUrl 被覆写时前端 UI 会自动关掉 +线图 开关防止错位。
  imageUrl?: string;
  // 与 StoneViewer 一致的 projection 回调，AnnotationCanvas 不感知底图来源。
  onScreenProjectionChange?: (projection: ScreenProjection | undefined) => void;
};

const backgroundColors: Record<NonNullable<SourceImageViewProps["background"]>, string> = {
  black: "#141312",
  gray: "#6f6a62",
  white: "#f2eee8"
};

// 用户手动缩放的范围（在 fit 之外）：上限够看清细节，下限够快速找回画像石。
const minZoomMultiplier = 0.5;
const maxZoomMultiplier = 30;
// 单次滚轮的变化量。WheelEvent.deltaY 在不同设备幅度差很大，统一归一到 step。
const wheelZoomStep = 1.18;

type ViewState = {
  // img 在容器内的左上 x / y 偏移（CSS px）
  offsetX: number;
  offsetY: number;
  // 应用到 img naturalSize 上的缩放倍率
  scale: number;
};

/**
 * 标注模式"高清图"视图：把后端 /ai/source-image/{stoneId} 转码出来的 PNG 当底图渲染。
 *
 * 自带 pan + zoom：
 *   - 滚轮：以光标为中心缩放（与 OrbitControls 缩放体感对齐）
 *   - 中键 / 右键拖动：平移
 *   - 父级 fitToken 递增：重置到 contain-fit 状态
 *
 * 标注画布从 onScreenProjectionChange 拿到的 4 角始终是当前 transform 后的真实显示矩形，
 * UV 坐标系就是这张图自身的归一化坐标，因此 SAM 候选与画布显示天然在同一坐标系。
 */
export function SourceImageView({
  active = true,
  stoneId,
  background = "black",
  fitToken,
  layer = "source",
  cannyOptions,
  imageUrl,
  onScreenProjectionChange
}: SourceImageViewProps) {
  const canny = cannyOptions ?? defaultCanny;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const onProjectionChangeRef = useRef(onScreenProjectionChange);
  const activeRef = useRef(active);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [viewState, setViewState] = useState<ViewState | undefined>(undefined);
  const viewStateRef = useRef<ViewState | undefined>(undefined);
  const fitScaleRef = useRef<number>(1);

  // 拖动期间的状态：refs 而非 state，避免在 pointermove 高频触发 re-render。
  // 不绑 pointerId：上层 AnnotationCanvas 转发的 pointerdown 是合成 PointerEvent，
  // 后续真实 pointermove 的 pointerId 可能与合成事件不一致；这里只看 active 标记。
  const panRef = useRef<{ active: boolean; lastX: number; lastY: number }>({
    active: false,
    lastX: 0,
    lastY: 0
  });

  useEffect(() => {
    onProjectionChangeRef.current = onScreenProjectionChange;
  }, [onScreenProjectionChange]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    viewStateRef.current = viewState;
  }, [viewState]);

  const url = imageUrl ?? getSourceImageUrl(stoneId);

  const emitProjection = useCallback((next: ViewState | undefined) => {
    const callback = onProjectionChangeRef.current;
    const container = containerRef.current;
    const img = imgRef.current;
    if (!callback) {
      return;
    }
    if (!next || !container || !img || !img.naturalWidth || !img.naturalHeight) {
      callback(undefined);
      return;
    }
    const canvasWidth = container.clientWidth;
    const canvasHeight = container.clientHeight;
    if (canvasWidth <= 0 || canvasHeight <= 0) {
      callback(undefined);
      return;
    }
    const dispW = img.naturalWidth * next.scale;
    const dispH = img.naturalHeight * next.scale;
    const left = next.offsetX;
    const top = next.offsetY;
    const right = left + dispW;
    const bottom = top + dispH;
    // corners 顺序与 StoneViewer 保持一致：[左下, 右下, 右上, 左上]
    callback({
      canvasWidth,
      canvasHeight,
      corners: [
        { x: left, y: bottom },
        { x: right, y: bottom },
        { x: right, y: top },
        { x: left, y: top }
      ]
    });
  }, []);

  // 把 viewState reset 为"图等比 contain 居中"，记录 fit 时的 scale 作为 zoom 基准。
  const resetToFit = useCallback(() => {
    const container = containerRef.current;
    const img = imgRef.current;
    if (!container || !img || !img.naturalWidth || !img.naturalHeight) {
      return;
    }
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;
    if (containerW <= 0 || containerH <= 0) {
      return;
    }
    const fitScale = Math.min(containerW / img.naturalWidth, containerH / img.naturalHeight);
    fitScaleRef.current = fitScale;
    const next: ViewState = {
      scale: fitScale,
      offsetX: (containerW - img.naturalWidth * fitScale) / 2,
      offsetY: (containerH - img.naturalHeight * fitScale) / 2
    };
    setViewState(next);
    viewStateRef.current = next;
    emitProjection(next);
  }, [emitProjection]);

  useEffect(() => {
    setStatus("loading");
    setViewState(undefined);
    viewStateRef.current = undefined;
    onProjectionChangeRef.current?.(undefined);
    // stoneId / imageUrl 任一变化都重置视图（切画像石 / 切资源）
  }, [stoneId, imageUrl]);

  // 容器 resize 时：如果 viewState 还没初始化（图未加载或刚切 stone），保持 undefined 等 onLoad；
  // 如果已经在用户态了，**不**重置 viewState，仅同步 corners（offset 是绝对像素，scale 是绝对值，
  // 容器变小时图可能溢出，由用户用工具栏"重置视角"或滚轮自行调整）。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (!activeRef.current) {
        return;
      }
      const current = viewStateRef.current;
      if (!current) {
        // 还没初始化（可能 onLoad 比 ResizeObserver 先到也行，这里只是兜底）
        resetToFit();
      } else {
        emitProjection(current);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [emitProjection, resetToFit]);

  // 父级 fitToken 变化（如工具栏"重置视角"）→ 重新 fit。
  useEffect(() => {
    if (fitToken === undefined) {
      return;
    }
    if (status !== "ready") {
      return;
    }
    resetToFit();
  }, [fitToken, resetToFit, status]);

  // 滚轮 / 中键 / 右键事件：用 native addEventListener 绑定，方便 passive: false 阻止默认行为。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      const current = viewStateRef.current;
      const img = imgRef.current;
      if (!current || !img || !img.naturalWidth) {
        return;
      }
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;

      const factor = event.deltaY < 0 ? wheelZoomStep : 1 / wheelZoomStep;
      const fitScale = fitScaleRef.current || current.scale;
      const minScale = fitScale * minZoomMultiplier;
      const maxScale = fitScale * maxZoomMultiplier;
      const nextScale = Math.min(maxScale, Math.max(minScale, current.scale * factor));
      const ratio = nextScale / current.scale;
      const next: ViewState = {
        scale: nextScale,
        offsetX: cursorX - (cursorX - current.offsetX) * ratio,
        offsetY: cursorY - (cursorY - current.offsetY) * ratio
      };
      setViewState(next);
      viewStateRef.current = next;
      emitProjection(next);
    };

    const handleWindowMove = (event: PointerEvent) => {
      const state = panRef.current;
      if (!state.active) {
        return;
      }
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      panRef.current = { ...state, lastX: event.clientX, lastY: event.clientY };
      const current = viewStateRef.current;
      if (!current) {
        return;
      }
      const next: ViewState = {
        ...current,
        offsetX: current.offsetX + dx,
        offsetY: current.offsetY + dy
      };
      setViewState(next);
      viewStateRef.current = next;
      emitProjection(next);
    };

    const handleWindowUp = () => {
      if (!panRef.current.active) {
        return;
      }
      panRef.current = { active: false, lastX: 0, lastY: 0 };
      window.removeEventListener("pointermove", handleWindowMove);
      window.removeEventListener("pointerup", handleWindowUp);
      window.removeEventListener("pointercancel", handleWindowUp);
    };

    const handlePointerDown = (event: PointerEvent) => {
      // 只接管中键 / 右键 pan；左键留给上层标注工具。
      if (event.button !== 1 && event.button !== 2) {
        return;
      }
      event.preventDefault();
      panRef.current = {
        active: true,
        lastX: event.clientX,
        lastY: event.clientY
      };
      // 在 window 上监听后续 move/up：兼容合成 PointerEvent + 鼠标移出容器的情况。
      window.addEventListener("pointermove", handleWindowMove);
      window.addEventListener("pointerup", handleWindowUp);
      window.addEventListener("pointercancel", handleWindowUp);
    };

    const handleContextMenu = (event: MouseEvent) => {
      // 阻止右键默认菜单弹出，否则右键拖动会被打断。
      event.preventDefault();
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    container.addEventListener("pointerdown", handlePointerDown);
    container.addEventListener("contextmenu", handleContextMenu);
    return () => {
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("pointerdown", handlePointerDown);
      container.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("pointermove", handleWindowMove);
      window.removeEventListener("pointerup", handleWindowUp);
      window.removeEventListener("pointercancel", handleWindowUp);
    };
  }, [emitProjection]);

  useEffect(() => {
    return () => {
      onProjectionChangeRef.current?.(undefined);
    };
  }, []);

  const baseStyle = viewState
    ? {
        transform: `translate(${viewState.offsetX}px, ${viewState.offsetY}px) scale(${viewState.scale})`,
        transformOrigin: "0 0",
        width: imgRef.current?.naturalWidth || "auto",
        height: imgRef.current?.naturalHeight || "auto"
      }
    : { opacity: 0 };

  // 线图叠加：与原图共享同一 transform，alpha 由 cannyOptions.opacity 控制。
  // layer === "canny" 时才请求线图 PNG，避免无谓加载。method 由 cannyOptions.method 决定。
  const cannyUrl = layer === "canny"
    ? getLineartUrl(stoneId, {
        method: canny.method ?? "canny-plus",
        low: canny.low,
        high: canny.high
      })
    : undefined;
  const cannyStyle = viewState
    ? {
        ...baseStyle,
        opacity: canny.opacity,
        // 让 Canny 线图与原图严格对齐：用与 baseStyle 同一组 transform；
        // mix-blend-mode 在白线 + 暗背景上视觉效果最清晰。
        mixBlendMode: "screen" as const
      }
    : { opacity: 0 };

  return (
    <div
      ref={containerRef}
      className="source-image-stage"
      style={{ background: backgroundColors[background] }}
    >
      <img
        ref={imgRef}
        src={url}
        alt=""
        draggable={false}
        style={baseStyle}
        onLoad={() => {
          setStatus("ready");
          // 等下一帧再 fit，确保 imgRef.current.naturalSize 已经可读。
          requestAnimationFrame(() => resetToFit());
        }}
        onError={() => {
          setStatus("error");
          onProjectionChangeRef.current?.(undefined);
        }}
      />
      {cannyUrl ? (
        <img
          src={cannyUrl}
          alt=""
          draggable={false}
          className="source-image-stage-overlay"
          style={cannyStyle}
        />
      ) : null}
      {status === "loading" ? (
        <div className="load-panel">
          <span>正在加载高清图</span>
        </div>
      ) : null}
      {status === "error" ? (
        <div className="load-panel error">
          <span>未找到该画像石的高清原图</span>
          <small>请确认 pic/ 目录里有以编号开头的图像文件，且 ai-service 在运行</small>
        </div>
      ) : null}
    </div>
  );
}
