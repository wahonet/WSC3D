/**
 * 拼接微调悬浮面板 `AssemblyAdjustControls`
 *
 * 拼接模式的底部居中浮窗，让用户在选中某块画像石后做精细的轴向位移与
 * 旋转：
 *
 * - **translate / rotate 模式切换**：与 TransformControls 联动
 * - **离散步长**：translate 1 / 5 / 10 cm；rotate 5° / 自定义角度
 * - **轴向 nudge**：按 X / Y / Z 各自 ± 方向
 * - **复位 / 落地**：恢复初始 transform 或贴到地面
 *
 * 设计要点：
 * - 此组件纯展示与回调；选中态由父级（`AssemblyWorkspace`）持有
 * - 锁定的 item 不显示按钮（disabled）
 * - 自定义角度输入框接受 0.1° 级数字，便于精细对齐
 */

import { ArrowDownToLine, Minus, Move3D, Plus, RotateCw, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import type { AssemblyItem } from "./types";

export type AdjustmentAxis = "x" | "y" | "z";
export type AdjustmentMode = "translate" | "rotate";

type AssemblyAdjustControlsProps = {
  item?: AssemblyItem;
  step: number;
  rotationStep: number;
  gizmoMode: AdjustmentMode;
  onGizmoModeChange: (mode: AdjustmentMode) => void;
  onStepChange: (step: number) => void;
  onRotationStepChange: (step: number) => void;
  onAdjust: (mode: AdjustmentMode, axis: AdjustmentAxis, direction: -1 | 1) => void;
  onReset: () => void;
  onGroundSelected: () => void;
};

const axes: AdjustmentAxis[] = ["x", "y", "z"];

export function AssemblyAdjustControls({
  item,
  step,
  rotationStep,
  gizmoMode,
  onGizmoModeChange,
  onStepChange,
  onRotationStepChange,
  onAdjust,
  onReset,
  onGroundSelected
}: AssemblyAdjustControlsProps) {
  if (!item) {
    return null;
  }

  const disabled = item.locked;

  return (
    <div className="adjust-overlay">
      <div className="adjust-title">
        <Move3D size={16} />
        <strong>{item.stone.displayName}</strong>
      </div>

      <div className="gizmo-mode-switch" aria-label="操作模式">
        <ModeButton active={gizmoMode === "translate"} title="移动" onClick={() => onGizmoModeChange("translate")}>
          <Move3D size={15} />
        </ModeButton>
        <ModeButton active={gizmoMode === "rotate"} title="旋转" onClick={() => onGizmoModeChange("rotate")}>
          <RotateCw size={15} />
        </ModeButton>
      </div>

      {gizmoMode === "translate" ? (
        <div className="adjust-steps" aria-label="平移步长">
          {[1, 5, 10].map((value) => (
            <button className={step === value ? "active" : ""} key={value} onClick={() => onStepChange(value)}>
              {value}cm
            </button>
          ))}
        </div>
      ) : (
        <label className="rotation-step-input">
          <span>角度</span>
          <input
            type="number"
            min="0.1"
            max="90"
            step="0.1"
            value={rotationStep}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value) && value > 0) {
                onRotationStepChange(value);
              }
            }}
          />
          <em>°</em>
        </label>
      )}

      <div className="axis-nudge-grid">
        {axes.map((axis) => (
          <div className={`axis-nudge axis-${axis}`} key={axis}>
            <span>{axis.toUpperCase()}</span>
            <button title={`${axis.toUpperCase()} -`} disabled={disabled} onClick={() => onAdjust(gizmoMode, axis, -1)}>
              <Minus size={14} />
            </button>
            <button title={`${axis.toUpperCase()} +`} disabled={disabled} onClick={() => onAdjust(gizmoMode, axis, 1)}>
              <Plus size={14} />
            </button>
          </div>
        ))}
      </div>

      {gizmoMode === "translate" ? (
        <button className="ground-button" disabled={disabled} onClick={onGroundSelected} title="贴地">
          <ArrowDownToLine size={15} />
          <span>贴地</span>
        </button>
      ) : null}

      <button className="adjust-reset" disabled={disabled} onClick={onReset} title="复位">
        <Undo2 size={15} />
      </button>
    </div>
  );
}

function ModeButton({
  active,
  title,
  children,
  onClick
}: {
  active: boolean;
  title: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className={active ? "active" : ""} title={title} onClick={onClick}>
      {children}
    </button>
  );
}
