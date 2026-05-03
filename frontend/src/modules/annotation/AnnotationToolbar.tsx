import {
  Circle,
  Crosshair,
  MousePointer2,
  PenLine,
  Radar,
  Redo2,
  RotateCcw,
  Square,
  Trash2,
  Undo2,
  Wand2,
  Waypoints
} from "lucide-react";
import type React from "react";
import type { AnnotationTool } from "./types";
import type { SamStatus } from "../../api/client";

type AnnotationToolbarProps = {
  activeTool: AnnotationTool;
  canUndo: boolean;
  canRedo: boolean;
  canDelete: boolean;
  // AI 服务状态；未获取到 / sam 未就绪时，SAM 按钮置灰并在 tooltip 里说明原因。
  samStatus?: SamStatus;
  // 是否已配置 4 点标定，标定按钮 tooltip 会反映"已校准 / 未校准"。
  hasAlignment?: boolean;
  // 当前是否处于标定流程中（采点 / review）。
  calibrating?: boolean;
  // YOLO 扫描进行中：按钮显示 spinner，避免重复触发。
  yoloScanning?: boolean;
  onToolChange: (tool: AnnotationTool) => void;
  onUndo: () => void;
  onRedo: () => void;
  onDeleteSelected: () => void;
  // 复位视角到"画像石 fit 整个画面"，给 SAM 提供最稳的输入。
  onResetView: () => void;
  // 启动 / 停止 4 点标定流程。
  onStartCalibration: () => void;
  onCancelCalibration: () => void;
  // 启动 YOLO 批量扫描（弹设置浮窗）。
  onStartYoloScan: () => void;
};

const tools: Array<{ id: AnnotationTool; title: string; icon: React.ReactNode }> = [
  { id: "select", title: "选择 / 移动", icon: <MousePointer2 size={18} /> },
  { id: "rect", title: "矩形标注（按住拖动）", icon: <Square size={18} /> },
  { id: "ellipse", title: "圆形 / 椭圆标注（按住拖动）", icon: <Circle size={18} /> },
  { id: "point", title: "点标注", icon: <Waypoints size={18} /> },
  { id: "pen", title: "钢笔（多边形，双击闭合）", icon: <PenLine size={18} /> }
];

// 根据 SAM 加载状态给出更具体的 tooltip 与按钮 disabled 状态。
function describeSam(status?: SamStatus): { disabled: boolean; title: string } {
  if (!status) {
    return { disabled: true, title: "SAM（AI 服务未启动）" };
  }
  switch (status.status) {
    case "ready":
      return {
        disabled: false,
        title: `SAM 智能分割（${status.model}）· 左键正点 / 右键负点 / Shift+左键拖框 / Enter 提交`
      };
    case "downloading":
      return { disabled: true, title: "SAM 模型下载中…" };
    case "loading":
      return { disabled: true, title: "SAM 模型加载中…" };
    case "error":
      return { disabled: true, title: `SAM 加载失败：${status.detail}` };
    case "pending":
    default:
      return { disabled: true, title: "SAM 模型准备中…" };
  }
}

export function AnnotationToolbar({
  activeTool,
  canUndo,
  canRedo,
  canDelete,
  samStatus,
  hasAlignment,
  calibrating,
  yoloScanning,
  onToolChange,
  onUndo,
  onRedo,
  onDeleteSelected,
  onResetView,
  onStartCalibration,
  onCancelCalibration,
  onStartYoloScan
}: AnnotationToolbarProps) {
  const sam = describeSam(samStatus);
  const calibrationTitle = calibrating
    ? "退出对齐校准"
    : hasAlignment
      ? "对齐已校准 · 重新校准（4 点）"
      : "对齐校准：在 3D 模型 / 高清图各点 4 对对应点";
  return (
    <>
      {tools.map((tool) => (
        <button
          className={activeTool === tool.id ? "rail-button active" : "rail-button"}
          key={tool.id}
          title={tool.title}
          disabled={calibrating}
          onClick={() => onToolChange(tool.id)}
        >
          {tool.icon}
        </button>
      ))}
      <button
        className={activeTool === "sam" ? "rail-button active" : "rail-button"}
        disabled={sam.disabled || calibrating}
        title={sam.title}
        onClick={() => onToolChange("sam")}
      >
        <Wand2 size={18} />
      </button>
      <button
        className={`rail-button${yoloScanning ? " active" : ""}`}
        disabled={calibrating || yoloScanning}
        title={
          yoloScanning
            ? "YOLO 扫描中…"
            : "YOLO 批量扫描（通用模型，给候选 tab 喂一批 bbox 后用 SAM 二次精修）"
        }
        onClick={onStartYoloScan}
      >
        <Radar size={18} />
      </button>
      <div className="rail-divider" aria-hidden />
      <button
        className={`rail-button${calibrating ? " active" : ""}${hasAlignment ? " has-alignment" : ""}`}
        title={calibrationTitle}
        onClick={() => (calibrating ? onCancelCalibration() : onStartCalibration())}
      >
        <Crosshair size={18} />
      </button>
      <button
        className="rail-button"
        title="重置视角：复位到画像石 fit 整个画面（SAM 识别前建议执行）"
        onClick={onResetView}
        disabled={calibrating}
      >
        <RotateCcw size={18} />
      </button>
      <button className="rail-button" disabled={!canUndo} title="撤销" onClick={onUndo}>
        <Undo2 size={18} />
      </button>
      <button className="rail-button" disabled={!canRedo} title="重做" onClick={onRedo}>
        <Redo2 size={18} />
      </button>
      <button className="rail-button danger" disabled={!canDelete} title="删除选中标注" onClick={onDeleteSelected}>
        <Trash2 size={18} />
      </button>
    </>
  );
}
