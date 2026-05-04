/**
 * 拼接模块右侧面板 `AssemblyPanel`
 *
 * 拼接模式的侧栏，展示当前拼接列表 + 方案管理。
 *
 * 主要功能：
 * - **加块**：从全部画像石（含模型）下拉里选并加进当前拼接（最多 10 块）
 * - **拼接列表卡片**：每条 `AssemblyItem` 显示缩略图 + 名称 + 锁定 / 删除
 *   按钮；点击切换"当前选中"
 * - **长边输入**：选中某块后输入"长边目标 cm"自动等比缩放；底部 readout
 *   显示当前 transform
 * - **方案管理**：保存 / 重命名 / 加载已存方案；保存后回填 currentPlanId
 *   便于"覆盖保存"
 *
 * 设计要点：
 * - 此组件纯展示与回调；所有状态由 `App.tsx` 持有，编辑动作通过 props 上抛
 * - "加块"按钮下方提示已加载数量与上限；超过 10 时按钮禁用
 * - 选中态优先看 `selectedItemId`；点击空白处由父级清空
 */

import { FolderOpen, Lock, Plus, Save, Trash2, Unlock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AssemblyPlanRecord, StoneListItem } from "../../api/client";
import type { AssemblyDimensions, AssemblyItem } from "./types";

type AssemblyPanelProps = {
  stones: StoneListItem[];
  items: AssemblyItem[];
  addStoneId: string;
  selectedItemId: string;
  planName: string;
  saveStatus?: string;
  savedPlans: AssemblyPlanRecord[];
  selectedPlanId: string;
  canSave: boolean;
  canLoadPlan: boolean;
  onAddStoneIdChange: (id: string) => void;
  onAddStone: () => void;
  onSelectItem: (instanceId: string) => void;
  onRemove: (instanceId: string) => void;
  onToggleLock: (instanceId: string) => void;
  onScaleLongEdge: (instanceId: string, targetLongEdge: number) => void;
  onPlanNameChange: (name: string) => void;
  onSavePlan: () => void;
  onSelectedPlanChange: (id: string) => void;
  onLoadPlan: () => void;
};

export function AssemblyPanel({
  stones,
  items,
  addStoneId,
  selectedItemId,
  planName,
  saveStatus,
  savedPlans,
  selectedPlanId,
  canSave,
  canLoadPlan,
  onAddStoneIdChange,
  onAddStone,
  onSelectItem,
  onRemove,
  onToggleLock,
  onScaleLongEdge,
  onPlanNameChange,
  onSavePlan,
  onSelectedPlanChange,
  onLoadPlan
}: AssemblyPanelProps) {
  const modelStones = stones.filter((stone) => stone.hasModel);
  const selectedItem = items.find((item) => item.instanceId === selectedItemId);

  return (
    <>
      <section className="panel-section">
        <div className="section-title">添加画像石</div>
        <div className="add-row">
          <select value={addStoneId} onChange={(event) => onAddStoneIdChange(event.target.value)}>
            {modelStones.map((stone) => (
              <option value={stone.id} key={stone.id}>
                {stone.id.replace("asset-", "#")} {stone.displayName}
              </option>
            ))}
          </select>
          <button className="icon-action" title="添加画像石" onClick={onAddStone} disabled={items.length >= 10 || !addStoneId}>
            <Plus size={17} />
          </button>
        </div>
      </section>

      <section className="panel-section">
        <div className="section-title">已加载</div>
        <div className="assembly-list">
          {items.map((item, index) => (
            <article
              className={["assembly-card", item.locked ? "locked" : "", selectedItemId === item.instanceId ? "selected" : ""]
                .filter(Boolean)
                .join(" ")}
              key={item.instanceId}
              onClick={() => onSelectItem(item.instanceId)}
            >
              {item.stone.thumbnailUrl ? <img src={item.stone.thumbnailUrl} alt="" /> : <span className="stone-thumb-fallback">{index + 1}</span>}
              <div className="assembly-card-main">
                <strong>{item.stone.displayName}</strong>
                <small>{item.locked ? "已锁定" : "可移动"}</small>
              </div>
              <div className="assembly-card-actions">
                <button
                  className="mini-icon"
                  title={item.locked ? "解锁" : "锁定"}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleLock(item.instanceId);
                  }}
                >
                  {item.locked ? <Lock size={14} /> : <Unlock size={14} />}
                </button>
                <button
                  className="mini-icon danger"
                  title="移除"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemove(item.instanceId);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </article>
          ))}
          {items.length === 0 ? <p className="muted-text">尚未加载画像石。</p> : null}
        </div>
      </section>

      <section className="panel-section selected-transform">
        <div className="section-title">当前石块</div>
        <SelectedTransform item={selectedItem} onScaleLongEdge={onScaleLongEdge} />
      </section>

      <section className="panel-section save-panel">
        <div className="section-title">保存方案</div>
        <div className="save-stack">
          <input
            className="text-input"
            value={planName}
            placeholder="拼接方案名称"
            onChange={(event) => onPlanNameChange(event.target.value)}
          />
          <button className="primary-action save-action" disabled={!canSave} onClick={onSavePlan}>
            <Save size={16} />
            保存
          </button>
          {savedPlans.length > 0 ? (
            <div className="plan-select-row">
              <select value={selectedPlanId} onChange={(event) => onSelectedPlanChange(event.target.value)}>
                <option value="">最近方案</option>
                {savedPlans.map((plan) => (
                  <option value={plan.id} key={plan.id}>
                    {plan.name}
                  </option>
                ))}
              </select>
              <button className="secondary-action" disabled={!canLoadPlan} onClick={onLoadPlan} title="加载方案">
                <FolderOpen size={15} />
              </button>
            </div>
          ) : null}
          {saveStatus ? <p className="save-status">{saveStatus}</p> : null}
        </div>
      </section>
    </>
  );
}

function SelectedTransform({
  item,
  onScaleLongEdge
}: {
  item?: AssemblyItem;
  onScaleLongEdge: (instanceId: string, targetLongEdge: number) => void;
}) {
  if (!item) {
    return <p className="muted-text">点击画像石后显示调整参数。</p>;
  }

  const [x, y, z] = item.transform.position;
  const scale = item.transform.scale ?? 1;

  return (
    <>
      <dl className="transform-readout">
        <dt>石块</dt>
        <dd>{item.stone.displayName}</dd>
        <dt>状态</dt>
        <dd>{item.locked ? "已锁定" : "可微调"}</dd>
        <dt>位置</dt>
        <dd>
          X {x.toFixed(1)} / Y {y.toFixed(1)} / Z {z.toFixed(1)}
        </dd>
        <dt>缩放</dt>
        <dd>{(scale * 100).toFixed(0)}%</dd>
      </dl>
      <ScaleInput item={item} onScaleLongEdge={onScaleLongEdge} />
    </>
  );
}

function ScaleInput({
  item,
  onScaleLongEdge
}: {
  item: AssemblyItem;
  onScaleLongEdge: (instanceId: string, targetLongEdge: number) => void;
}) {
  const dimensions = item.baseDimensions;
  const currentLongEdge = useMemo(() => (dimensions ? dimensions.longEdge * (item.transform.scale ?? 1) : undefined), [dimensions, item.transform.scale]);
  const [draft, setDraft] = useState(currentLongEdge ? formatNumber(currentLongEdge) : "");

  useEffect(() => {
    setDraft(currentLongEdge ? formatNumber(currentLongEdge) : "");
  }, [currentLongEdge, item.instanceId]);

  const commit = () => {
    if (!dimensions) {
      return;
    }
    const value = Number(draft);
    if (Number.isFinite(value) && value > 0) {
      onScaleLongEdge(item.instanceId, value);
      return;
    }
    setDraft(formatNumber(currentLongEdge ?? dimensions.longEdge));
  };

  return (
    <label className="scale-control">
      <span>长边</span>
      <div className="scale-input-row">
        <input
          type="number"
          min="0.1"
          step="0.1"
          inputMode="decimal"
          value={draft}
          placeholder={dimensions ? undefined : "尺寸读取中"}
          disabled={!dimensions || item.locked}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
        />
        <span>{dimensions?.unit === "cm" ? "cm" : "模型单位"}</span>
      </div>
      {dimensions ? <small>{formatBaseDimensions(dimensions)}</small> : null}
    </label>
  );
}

function formatBaseDimensions(dimensions: AssemblyDimensions) {
  const unit = dimensions.unit === "cm" ? "cm" : "模型单位";
  return `${formatNumber(dimensions.width)} x ${formatNumber(dimensions.length)} x ${formatNumber(dimensions.thickness)} ${unit}`;
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
