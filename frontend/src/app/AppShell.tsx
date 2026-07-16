import { useMemo } from "react";
import type { StoneListItem } from "../api/client";
import { TaskProgressPanel } from "../modules/annotation/TaskProgressPanel";
import { useAlignmentStatuses } from "../modules/annotation/useAlignmentStatuses";
import { useAnnotationStatus, type AnnotationSaveState } from "./contexts/AnnotationStatusContext";
import { useStoneSelection } from "./contexts/StoneSelectionContext";
import { useTasks } from "./contexts/TasksContext";
import { useWorkspaceMode, type WorkspaceMode } from "./contexts/WorkspaceModeContext";
import { AnnotationContainer } from "./workspaces/AnnotationContainer";
import { ViewerContainer } from "./workspaces/ViewerContainer";
import { Select } from "../ui/Field";

const MODE_LABELS: Record<WorkspaceMode, string> = {
  viewer: "浏览",
  annotation: "标注"
};

function formatSaveStatus(state: AnnotationSaveState, message?: string): string {
  if (message?.trim()) return message;
  switch (state.phase) {
    case "dirty":
      return "有未保存改动";
    case "saving":
      return "保存中…";
    case "saved":
      return state.savedAt
        ? `已保存 ${new Date(state.savedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
        : "已保存";
    case "error":
      return state.error ?? "保存失败";
    default:
      return "";
  }
}

function saveStatusClass(state: AnnotationSaveState): string {
  if (state.phase === "dirty") return "is-dirty";
  if (state.phase === "error") return "is-error";
  if (state.phase === "saving") return "is-saving";
  return "";
}

export function AppShell() {
  const { workspaceMode, setWorkspaceMode, isAnnotationActive } = useWorkspaceMode();
  const { catalog, error, selectedId, selectedStone, requestSelectStone } = useStoneSelection();
  const { saveState, statusMessage, hasAlignment } = useAnnotationStatus();
  const { tasks, requestCancelTask, dismissTask } = useTasks();
  const alignmentStatuses = useAlignmentStatuses(selectedId, hasAlignment);

  const statusText = useMemo(
    () => (workspaceMode === "annotation" ? formatSaveStatus(saveState, statusMessage) : ""),
    [workspaceMode, saveState, statusMessage]
  );

  const enterAnnotationMode = () => {
    setWorkspaceMode("annotation");
  };

  const annotationLayer = isAnnotationActive ? "wsc-stage__layer is-active" : "wsc-stage__layer is-hidden";

  return (
    <div className="wsc-shell">
      <header className="wsc-topbar">
        <div className="wsc-topbar__brand">
          <img className="wsc-topbar__logo" src="/嘉logo.png" alt="" />
          <div className="wsc-topbar__title">
            <strong>汉画像石数字化研究平台</strong>
            <small>工作台</small>
          </div>
        </div>

        <nav className="wsc-topbar__modes" aria-label="工作模式">
          {(Object.keys(MODE_LABELS) as WorkspaceMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`wsc-topbar__mode${workspaceMode === mode ? " is-active" : ""}`}
              disabled={mode === "annotation" && !selectedStone?.hasModel}
              onClick={() => (mode === "annotation" ? enterAnnotationMode() : setWorkspaceMode(mode))}
            >
              {MODE_LABELS[mode]}
            </button>
          ))}
        </nav>

        <div className="wsc-topbar__spacer" />

        {statusText ? (
          <span className={`wsc-topbar__status ${saveStatusClass(saveState)}`} title={statusText}>
            {statusText}
          </span>
        ) : null}

        <label className="wsc-topbar__stone">
          <span>画像石</span>
          <Select value={selectedId} onChange={(e) => requestSelectStone(e.target.value)}>
            {catalog?.stones.map((stone: StoneListItem) => {
              const aligned = alignmentStatuses[stone.id];
              const prefix = aligned ? "✓ " : "  ";
              return (
                <option value={stone.id} key={stone.id}>
                  {prefix}
                  {stone.id.replace("asset-", "#")} {stone.displayName}
                </option>
              );
            })}
          </Select>
        </label>
      </header>

      <div className="wsc-stage">
        {error ? <div className="wsc-empty">{error}</div> : null}
        <ViewerContainer />
        <AnnotationContainer layerClassName={annotationLayer} />
      </div>

      <TaskProgressPanel tasks={tasks} onCancel={requestCancelTask} onDismiss={dismissTask} />
    </div>
  );
}
