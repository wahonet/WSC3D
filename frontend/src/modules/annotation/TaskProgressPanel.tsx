import { CheckCircle2, Loader2, X, XCircle } from "lucide-react";

// G3：批量任务进度面板（右下角浮窗）
//
// 当前用 useReducer 管理任务时显得过重；统一用一个简单的 TaskProgressState 类型
// + 父组件持有 state 即可。任务支持：
//   - status: pending / running / done / failed / cancelled
//   - progress: 0..1
//   - message: 当前正在做什么的描述（"SAM 批量精修 [3/12] 青龙…"）
//   - cancellable: 是否允许中途取消（默认 true）
//
// 当 onCancel 被调用时，父组件应该把 cancelRequested 标记 true，循环里检查
// 该标记并提前 return；面板只负责显示 + 触发回调。

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
