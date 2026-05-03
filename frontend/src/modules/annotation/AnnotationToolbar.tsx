import { Bot, Circle, Eraser, MousePointer2, PenLine, Pentagon, Redo2, ScanSearch, Square, Trash2, Undo2, Waypoints } from "lucide-react";
import type React from "react";
import type { AnnotationTool } from "./types";

type AnnotationToolbarProps = {
  activeTool: AnnotationTool;
  canUndo: boolean;
  canRedo: boolean;
  aiAvailable: boolean;
  onToolChange: (tool: AnnotationTool) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClearSelected: () => void;
};

const tools: Array<{ id: AnnotationTool; title: string; icon: React.ReactNode; ai?: boolean }> = [
  { id: "select", title: "选择 / 移动", icon: <MousePointer2 size={18} /> },
  { id: "rect", title: "矩形标注", icon: <Square size={18} /> },
  { id: "ellipse", title: "椭圆标注", icon: <Circle size={18} /> },
  { id: "pen", title: "钢笔多边形", icon: <Pentagon size={18} /> },
  { id: "polyline", title: "折线标注", icon: <PenLine size={18} /> },
  { id: "point", title: "点标注", icon: <Waypoints size={18} /> },
  { id: "eraser", title: "橡皮 / 删除", icon: <Eraser size={18} /> },
  { id: "sam", title: "SAM 智能标注", icon: <Bot size={18} />, ai: true },
  { id: "yolo", title: "YOLO 全图扫描", icon: <ScanSearch size={18} />, ai: true }
];

export function AnnotationToolbar({ activeTool, canUndo, canRedo, aiAvailable, onToolChange, onUndo, onRedo, onClearSelected }: AnnotationToolbarProps) {
  return (
    <>
      {tools.map((tool) => (
        <button
          className={activeTool === tool.id ? "rail-button active" : "rail-button"}
          disabled={Boolean(tool.ai && !aiAvailable)}
          key={tool.id}
          title={tool.ai && !aiAvailable ? `${tool.title}（AI 服务未连接）` : tool.title}
          onClick={() => onToolChange(tool.id)}
        >
          {tool.icon}
        </button>
      ))}
      <button className="rail-button" disabled={!canUndo} title="撤销" onClick={onUndo}>
        <Undo2 size={18} />
      </button>
      <button className="rail-button" disabled={!canRedo} title="重做" onClick={onRedo}>
        <Redo2 size={18} />
      </button>
      <button className="rail-button danger" title="删除选中标注" onClick={onClearSelected}>
        <Trash2 size={18} />
      </button>
    </>
  );
}
