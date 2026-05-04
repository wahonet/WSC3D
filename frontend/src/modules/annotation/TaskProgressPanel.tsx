/**
 * 批量任务进度面板 `TaskProgressPanel`（右下角浮窗）
 *
 * 长任务（SAM 批量精修 / 多石头 YOLO / 多步导出）的统一进度展示：
 * - 每条任务显示：标题 / 状态图标 / 进度条 / 当前消息 / 取消或关闭按钮
 * - 状态：running / done / failed / cancelled
 * - progress 0..1；undefined 时显示不确定 spinner 而非进度条
 * - cancellable 为 true 时允许中途取消
 *
 * 配合机制：
 * - 父组件用一个 `Set<string>` 记录被请求取消的任务 id
 * - 任务循环里每步检查 `cancelRequestedRef.current.has(taskId)`，命中则提前 return
 * - 面板本身只负责显示与触发回调，不持有任何业务逻辑
 *
 * 设计要点：
 * - 最多同时显示 6 条；超过部分被父级裁剪（先入先出）
 * - done / failed / cancelled 的任务保留若干秒方便用户确认，再由用户点关闭按钮 dismiss
 */

import { CheckCircle2, Loader2, X, XCircle } from "lucide-react";

export type TaskProgress = {
  id: string;
  title: string;
  // 0..1；undefined 表示不确定（spinner 而不是进度条）
  progress?: number;
  message?: string;
  status: "running" | "done" | "failed" | "cancelled";
  cancellable?: boolean;
};

export type TaskProgressPanelProps = {
  tasks: TaskProgress[];
  onCancel?: (id: string) => void;
  onDismiss?: (id: string) => void;
};

const statusLabels: Record<TaskProgress["status"], string> = {
  running: "进行中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

export function TaskProgressPanel({ tasks, onCancel, onDismiss }: TaskProgressPanelProps) {
  if (tasks.length === 0) return null;
  return (
    <aside className="task-progress-panel" role="status" aria-live="polite">
      <header className="task-progress-head">
        <span className="task-progress-head-title">任务进度</span>
        <span className="task-progress-head-count">{tasks.length}</span>
      </header>
      <ul className="task-progress-list">
        {tasks.map((task) => {
          const pct = typeof task.progress === "number" ? Math.max(0, Math.min(1, task.progress)) : undefined;
          return (
            <li key={task.id} className={`task-progress-item is-${task.status}`}>
              <div className="task-progress-item-head">
                <span className="task-progress-item-icon" aria-hidden>
                  {task.status === "running" ? (
                    <Loader2 size={14} className="task-progress-spinner" />
                  ) : task.status === "done" ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <XCircle size={14} />
                  )}
                </span>
                <span className="task-progress-item-title" title={task.title}>
                  {task.title}
                </span>
                <span className="task-progress-item-status">{statusLabels[task.status]}</span>
                {task.status === "running" && task.cancellable && onCancel ? (
                  <button
                    type="button"
                    className="task-progress-item-action"
                    onClick={() => onCancel(task.id)}
                    title="请求取消该任务（当前小步完成后停止）"
                  >
                    取消
                  </button>
                ) : null}
                {task.status !== "running" && onDismiss ? (
                  <button
                    type="button"
                    className="task-progress-item-action"
                    onClick={() => onDismiss(task.id)}
                    title="从列表里移除"
                    aria-label="dismiss"
                  >
                    <X size={11} />
                  </button>
                ) : null}
              </div>
              {task.message ? (
                <div className="task-progress-item-message">{task.message}</div>
              ) : null}
              {pct !== undefined ? (
                <div className="task-progress-item-bar" aria-hidden>
                  <span
                    className="task-progress-item-bar-fill"
                    style={{ width: `${(pct * 100).toFixed(0)}%` }}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
