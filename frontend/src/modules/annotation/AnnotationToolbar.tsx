/**
 * 标注模块左侧工具栏 `AnnotationToolbar`
 *
 * 标注模式 52 px 宽的左侧导轨，按以下顺序排列：
 * 1. 选择 / 移动（V）
 * 2. 矩形（R）
 * 3. 椭圆（E）
 * 4. 钢笔多边形（P）
 * 5. 点（N）
 * 6. SAM 智能分割（S，sam.ready 时可用）
 * 7. YOLO 批量扫描（弹 dialog）
 * 8. 4 点对齐校准（已校准时按钮右下角青色圆点）
 * --- 分隔 ---
 * 9. 撤销 / 重做（Ctrl+Z / Ctrl+Y）
 * 10. 删除当前选中
 * 11. 重置视角（F）
 *
 * 设计要点：
 * - 全部按钮纯回调；状态由父级（App）持有
 * - SAM 按钮在 `samStatus` 未就绪时置灰，tooltip 反馈"加载中" / "失败"
 * - 标定按钮在 `calibrating` 时高亮 + 改 tooltip "取消校准"
 * - YOLO 扫描中显示 spinner，避免重复触发
 */

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
import { useState } from "react";
import type React from "react";
import type { AnnotationTool } from "./types";
import type { SamStatus } from "../../api/client";

export type Sam3ConceptInput = {
  prompt: string;
  label: string;
  threshold: number;
  maxResults: number;
  autoExpand: boolean;
};

type AnnotationToolbarProps = {
  activeTool: AnnotationTool;
  canUndo: boolean;
  canRedo: boolean;
  canDelete: boolean;
  // AI 服务状态；未获取到 / sam 未就绪时，SAM 按钮置灰并在 tooltip 里说明原因。
  samStatus?: SamStatus;
  // SAM3 概念分割状态；pending 表示可点击后懒加载。
  sam3Status?: SamStatus;
  // 是否已配置 4 点标定，标定按钮 tooltip 会反映"已校准 / 未校准"。
  hasAlignment?: boolean;
  // 当前是否处于标定流程中（采点 / review）。
  calibrating?: boolean;
  // YOLO 扫描进行中：按钮显示 spinner，避免重复触发。
  yoloScanning?: boolean;
  sam3Scanning?: boolean;
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
  // 启动 SAM3 文本概念分割。
  onStartSam3: (input: Sam3ConceptInput) => void;
};

const sam3ConceptPresets: Array<{ label: string; prompt: string }> = [
  { label: "人物", prompt: "human figure" },
  { label: "马", prompt: "horse" },
  { label: "鸟", prompt: "bird" },
  { label: "兽", prompt: "animal" },
  { label: "车", prompt: "chariot" },
  { label: "纹饰", prompt: "decorative pattern" }
];

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

function describeSam3(status?: SamStatus): { disabled: boolean; title: string } {
  if (!status) {
    return { disabled: true, title: "SAM3（AI 服务未启动）" };
  }
  switch (status.status) {
    case "loading":
      return { disabled: true, title: "SAM3 模型加载中…" };
    case "ready":
      return { disabled: false, title: `SAM3 概念分割（${status.model}）· 点击输入概念词` };
    case "error":
      return { disabled: false, title: `SAM3 上次加载失败：${status.detail} · 点击重试` };
    case "pending":
    case "downloading":
    default:
      return { disabled: false, title: "SAM3 概念分割 · 点击输入概念词并懒加载模型" };
  }
}

export function AnnotationToolbar({
  activeTool,
  canUndo,
  canRedo,
  canDelete,
  samStatus,
  sam3Status,
  hasAlignment,
  calibrating,
  yoloScanning,
  sam3Scanning,
  onToolChange,
  onUndo,
  onRedo,
  onDeleteSelected,
  onResetView,
  onStartCalibration,
  onCancelCalibration,
  onStartYoloScan,
  onStartSam3
}: AnnotationToolbarProps) {
  const sam = describeSam(samStatus);
  const sam3 = describeSam3(sam3Status);
  const [sam3PanelOpen, setSam3PanelOpen] = useState(false);
  const [sam3CustomPrompt, setSam3CustomPrompt] = useState("");
  const [sam3Threshold, setSam3Threshold] = useState(0.5);
  const [sam3MaxResults, setSam3MaxResults] = useState(20);
  const [sam3AutoExpand, setSam3AutoExpand] = useState(true);
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
      <div className="sam3-launcher">
        <button
          className={`rail-button sam3-button${sam3Scanning || sam3PanelOpen ? " active" : ""}`}
          disabled={sam3.disabled || calibrating || sam3Scanning}
          title={sam3Scanning ? "SAM3 概念分割中…" : sam3.title}
          onClick={() => setSam3PanelOpen((open) => !open)}
          type="button"
        >
          <span className="sam3-icon-stack" aria-hidden>
            <Wand2 size={19} />
            <span className="sam3-plus sam3-plus-a">+</span>
            <span className="sam3-plus sam3-plus-b">+</span>
          </span>
        </button>
        {sam3PanelOpen && (
          <aside className="sam3-popover" aria-label="SAM3 概念分割">
            <div className="sam3-popover-head">
              <strong>SAM3</strong>
              <button className="sam3-close" type="button" onClick={() => setSam3PanelOpen(false)}>
                ×
              </button>
            </div>
            <div className="sam3-chip-grid">
              {sam3ConceptPresets.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    onStartSam3({
                      ...preset,
                      threshold: sam3Threshold,
                      maxResults: sam3MaxResults,
                      autoExpand: sam3AutoExpand
                    });
                    setSam3PanelOpen(false);
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <label className="sam3-field">
              <span>自定义</span>
              <div className="sam3-custom-row">
                <input
                  value={sam3CustomPrompt}
                  placeholder="如 human figure"
                  onChange={(event) => setSam3CustomPrompt(event.target.value)}
                />
                <button
                  type="button"
                  disabled={!sam3CustomPrompt.trim()}
                  onClick={() => {
                    const prompt = sam3CustomPrompt.trim();
                    if (!prompt) return;
                    onStartSam3({
                      prompt,
                      label: prompt,
                      threshold: sam3Threshold,
                      maxResults: sam3MaxResults,
                      autoExpand: sam3AutoExpand
                    });
                    setSam3PanelOpen(false);
                  }}
                >
                  运行
                </button>
              </div>
            </label>
            <label className="sam3-field">
              <span>阈值 {sam3Threshold.toFixed(2)}</span>
              <input
                min={0.1}
                max={0.8}
                step={0.05}
                type="range"
                value={sam3Threshold}
                onChange={(event) => setSam3Threshold(Number(event.target.value))}
              />
            </label>
            <label className="sam3-field">
              <span>最大候选</span>
              <select value={sam3MaxResults} onChange={(event) => setSam3MaxResults(Number(event.target.value))}>
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={30}>30</option>
              </select>
            </label>
            <label className="sam3-check">
              <input
                checked={sam3AutoExpand}
                type="checkbox"
                onChange={(event) => setSam3AutoExpand(event.target.checked)}
              />
              <span>自动同义词与低阈值重试</span>
            </label>
          </aside>
        )}
      </div>
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
