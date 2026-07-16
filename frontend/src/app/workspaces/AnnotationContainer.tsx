import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { computeAlignmentError } from "../../modules/annotation/homography";
import { useAnnotationLogic } from "../annotation/useAnnotationLogic";
import { useStoneSelection } from "../contexts/StoneSelectionContext";
import { useViewport } from "../contexts/ViewportContext";
import { useWorkspaceMode } from "../contexts/WorkspaceModeContext";

const AnnotationWorkspace = lazy(() =>
  import("../../modules/annotation/AnnotationWorkspace").then((m) => ({ default: m.AnnotationWorkspace }))
);
const IimlPanel = lazy(() =>
  import("../../modules/annotation/IimlPanel").then((m) => ({ default: m.IimlPanel }))
);
const AnnotationToolbar = lazy(() =>
  import("../../modules/annotation/AnnotationToolbar").then((m) => ({ default: m.AnnotationToolbar }))
);

const DOCK_WIDTH_KEY = "wsc3d-ann-dock-w";
const DOCK_MIN = 460;
const DOCK_MAX = 960;

function clampDockWidth(value: number): number {
  const viewportMax = typeof window !== "undefined" ? Math.round(window.innerWidth * 0.62) : DOCK_MAX;
  return Math.min(Math.min(DOCK_MAX, viewportMax), Math.max(DOCK_MIN, Math.round(value)));
}

function readDockWidth(): number {
  if (typeof window === "undefined") return 600;
  const stored = Number(window.localStorage.getItem(DOCK_WIDTH_KEY));
  if (Number.isFinite(stored) && stored > 0) return clampDockWidth(stored);
  // 标注为主、图为参考：默认给标注面板约 42% 屏宽
  return clampDockWidth(window.innerWidth * 0.42);
}

type AnnotationContainerProps = {
  layerClassName: string;
};

export function AnnotationContainer({ layerClassName }: AnnotationContainerProps) {
  const { metadata, selectedStone } = useStoneSelection();
  const { background, resetToken, bumpReset } = useViewport();
  const { hasEnteredAnnotation, isAnnotationActive } = useWorkspaceMode();
  const logic = useAnnotationLogic();

  const [dockWidth, setDockWidth] = useState(readDockWidth);
  const [dragging, setDragging] = useState(false);
  const dragStateRef = useRef<{ pointerId: number } | null>(null);

  const onDividerPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = { pointerId: event.pointerId };
    setDragging(true);
  }, []);

  const onDividerPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current) return;
    setDockWidth(clampDockWidth(window.innerWidth - event.clientX));
  }, []);

  const onDividerPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStateRef.current) return;
      dragStateRef.current = null;
      setDragging(false);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      window.localStorage.setItem(DOCK_WIDTH_KEY, String(dockWidth));
    },
    [dockWidth]
  );

  if (!hasEnteredAnnotation || !selectedStone) {
    return null;
  }

  return (
    <div className={`${layerClassName} ann-shell`}>
      <div className="ann-canvas">
        <Suspense fallback={<div className="wsc-empty">正在加载标注模块…</div>}>
          <AnnotationWorkspace
            active={isAnnotationActive}
            activeTool={logic.annotationState.activeTool}
            background={background}
            doc={logic.annotationState.doc}
            draftAnnotationId={logic.annotationState.draftAnnotationId}
            fitToken={resetToken}
            selectedAnnotationId={logic.annotationState.selectedAnnotationId}
            sourceMode={logic.annotationSourceMode}
            stone={selectedStone}
            onActiveImageResourceChange={logic.setActiveImageResource}
            onCreate={(annotation, asDraft) =>
              logic.dispatchAnnotation({ type: "add-annotation", annotation, asDraft })
            }
            onDelete={(id) => logic.dispatchAnnotation({ type: "delete-annotation", id })}
            onSaveAlignment={(alignment) => {
              logic.dispatchAnnotation({ type: "set-alignment", alignment });
              const report = computeAlignmentError(alignment);
              if (report) {
                const px = report.meanError * 1500;
                logic.dispatchAnnotation({
                  type: "set-status",
                  status: report.ready
                    ? `对齐已保存（${report.pointCount} 点，重投影误差 ${report.meanError.toFixed(4)} UV ≈ ${px.toFixed(0)} px）`
                    : `对齐已保存，但重投影误差偏大（${report.meanError.toFixed(4)} UV ≈ ${px.toFixed(0)} px），建议复查控制点`
                });
              }
            }}
            onSelect={(id) => logic.dispatchAnnotation({ type: "select", id })}
            onSourceModeChange={logic.setAnnotationSourceMode}
            onStatusMessage={(status) => logic.dispatchAnnotation({ type: "set-status", status })}
            onToolChange={(tool) => logic.dispatchAnnotation({ type: "set-tool", tool })}
            onUpdate={(id, patch) => logic.dispatchAnnotation({ type: "update-annotation", id, patch })}
          />
        </Suspense>
        <div className="ann-toolbar-dock" aria-label="标注工具">
          <Suspense fallback={null}>
            <AnnotationToolbar
              activeTool={logic.annotationState.activeTool}
              calibrating={logic.isCalibrating}
              canDelete={Boolean(logic.annotationState.selectedAnnotationId)}
              canRedo={logic.annotationState.redoStack.length > 0}
              canUndo={logic.annotationState.undoStack.length > 0}
              hasAlignment={logic.hasAlignment}
              maskEditAvailable={logic.maskEditAvailable}
              sam3Scanning={logic.sam3Scanning}
              sam3Status={logic.sam3Status}
              onCancelCalibration={() => logic.dispatchAnnotation({ type: "set-tool", tool: "select" })}
              onDeleteSelected={logic.deleteSelectedAnnotation}
              onRedo={() => logic.dispatchAnnotation({ type: "redo" })}
              onResetView={bumpReset}
              onStartCalibration={() => logic.dispatchAnnotation({ type: "set-tool", tool: "calibrate" })}
              onStartSam3={logic.handleStartSam3}
              onToolChange={(tool) => logic.dispatchAnnotation({ type: "set-tool", tool })}
              onUndo={() => logic.dispatchAnnotation({ type: "undo" })}
            />
          </Suspense>
        </div>
      </div>
      <div
        className={`ann-divider${dragging ? " is-dragging" : ""}`}
        role="separator"
        aria-orientation="vertical"
        title="拖动调整标注面板宽度"
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={onDividerPointerUp}
      />
      <aside className="ann-dock" style={{ width: dockWidth }}>
        <Suspense fallback={<p className="ui-muted">正在加载标注面板…</p>}>
          <IimlPanel
            doc={logic.annotationState.doc}
            stone={selectedStone}
            metadata={metadata}
            selectedAnnotationId={logic.annotationState.selectedAnnotationId}
            draftAnnotationId={logic.annotationState.draftAnnotationId}
            saveState={logic.annotationSaveState}
            statusMessage={logic.annotationState.status}
            spatialCandidates={logic.spatialRelationCandidates}
            vocabularyCategories={logic.vocabularyCategories}
            vocabularyTerms={logic.vocabularyTerms}
            trainingDatasetLocation={logic.trainingDatasetLocation}
            dispatch={logic.dispatchAnnotation}
            onManualSave={() => void logic.saveAnnotationDocumentNow()}
            onMergeCandidates={logic.handleMergeCandidates}
            onExportIiml={logic.handleExportIiml}
            onExportCsv={logic.handleExportCsv}
            onExportCoco={logic.handleExportCoco}
            onExportIiif={logic.handleExportIiif}
            onExportHpsml={logic.handleExportHpsml}
            onImportHpsml={logic.handleImportHpsml}
            onExportTraining={() => void logic.handleExportTraining()}
            onRevealTrainingDataset={() => void logic.handleRevealTrainingDataset()}
            onPreflight={() => void logic.handlePreflight()}
            onStatusMessage={(status) => logic.dispatchAnnotation({ type: "set-status", status })}
          />
        </Suspense>
      </aside>
    </div>
  );
}
