import { Circle, MousePointer2, PenLine, Redo2, Square, Trash2, Undo2, Waypoints } from "lucide-react";
import type React from "react";
import type { AnnotationTool } from "./types";

type AnnotationToolbarProps = {
  activeTool: AnnotationTool;
  canUndo: boolean;
  canRedo: boolean;
  canDelete: boolean;
  onToolChange: (tool: AnnotationTool) => void;
  onUndo: () => void;
  onRedo: () => void;
  onDeleteSelected: () => void;
};

const tools: Array<{ id: AnnotationTool; title: string; icon: React.ReactNode }> = [
  { id: "select", title: "选择 / 移动", icon: <MousePointer2 size={18} /> },
  { id: "rect", title: "矩形标注（按住拖动）", icon: <Square size={18} /> },
  { id: "ellipse", title: "圆形 / 椭圆标注（按住拖动）", icon: <Circle size={18} /> },
  { id: "point", title: "点标注", icon: <Waypoints size={18} /> },
  { id: "pen", title: "钢笔（多边形，双击闭合）", icon: <PenLine size={18} /> }
];

export function AnnotationToolbar({
  activeTool,
  canUndo,
  canRedo,
  canDelete,
  onToolChange,
  onUndo,
  onRedo,
  onDeleteSelected
}: AnnotationToolbarProps) {
  return (
    <>
      {tools.map((tool) => (
        <button
          className={activeTool === tool.id ? "rail-button active" : "rail-button"}
          key={tool.id}
          title={tool.title}
          onClick={() => onToolChange(tool.id)}
        >
          {tool.icon}
        </button>
      ))}
      <div className="rail-divider" aria-hidden />
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
