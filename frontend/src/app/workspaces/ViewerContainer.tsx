import { Ruler, Trash2 } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { StoneListItem } from "../../api/client";
import { useStoneSelection } from "../contexts/StoneSelectionContext";
import { useViewport } from "../contexts/ViewportContext";
import { useWorkspaceMode } from "../contexts/WorkspaceModeContext";
import { backgroundLabels, formatDimensions, panelRect, viewerModeLabels } from "../utils";
import { PanelLayoutProvider, PanelHost } from "../../ui/floating/PanelHost";
import { PanelMenu } from "../../ui/floating/PanelMenu";
import type { PanelDefinition } from "../../ui/floating/types";
import { Button } from "../../ui/Button";
import { Field, Select } from "../../ui/Field";
import { Section } from "../../ui/Section";
import type { MeasurementResult, ViewerMode } from "../../modules/viewer/StoneViewer";
import type { ViewCubeView } from "../../modules/shared/ViewCube";

const StoneViewer = lazy(() =>
  import("../../modules/viewer/StoneViewer").then((m) => ({ default: m.StoneViewer }))
);

const VIEWER_PANELS: PanelDefinition[] = [
  {
    id: "view",
    title: "视图与背景",
    defaultRect: panelRect(16, 56, 280, 160),
    defaultOpen: true
  },
  {
    id: "measure",
    title: "测距",
    defaultRect: panelRect(16, 228, 280, 200),
    defaultOpen: true
  },
  {
    id: "record",
    title: "档案信息",
    defaultRect: panelRect(16, 440, 280, 220),
    defaultOpen: true
  }
];

export function ViewerContainer() {
  const { workspaceMode } = useWorkspaceMode();
  const { selectedStone, metadata } = useStoneSelection();
  const { background, setBackground, resetToken } = useViewport();
  const [viewMode, setViewMode] = useState<ViewerMode>("3d");
  const [viewerCubeView, setViewerCubeView] = useState<ViewCubeView>("front");
  const [measuring, setMeasuring] = useState(false);
  const [measureClearToken, setMeasureClearToken] = useState(0);
  const [measurement, setMeasurement] = useState<MeasurementResult>();

  if (workspaceMode !== "viewer" || !selectedStone) {
    return null;
  }

  return (
    <PanelLayoutProvider workspace="viewer" definitions={VIEWER_PANELS}>
      <div className="wsc-stage__layer is-active">
        <Suspense fallback={<div className="wsc-empty">正在加载浏览模块…</div>}>
          <StoneViewer
            key={`${selectedStone.id}-${resetToken}`}
            stone={selectedStone}
            viewMode={viewMode}
            background={background}
            measuring={measuring}
            measureToken={measureClearToken}
            cubeView={viewerCubeView}
            onCubeViewChange={setViewerCubeView}
            onMeasureChange={setMeasurement}
          />
        </Suspense>
      </div>
      <div className="wsc-workspace-panel-menu">
        <PanelMenu definitions={VIEWER_PANELS} />
      </div>
      <PanelHost
        definitions={VIEWER_PANELS}
        renderPanel={(id) => {
          if (id === "view") {
            return (
              <div className="wsc-panel-content">
                <Section title="视图模式">
                  <div className="wsc-segmented">
                    {(Object.keys(viewerModeLabels) as ViewerMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={viewMode === mode ? "is-active" : ""}
                        onClick={() => setViewMode(mode)}
                      >
                        {viewerModeLabels[mode]}
                      </button>
                    ))}
                  </div>
                </Section>
                <Field label="背景">
                  <Select value={background} onChange={(e) => setBackground(e.target.value as typeof background)}>
                    {Object.entries(backgroundLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            );
          }
          if (id === "measure") {
            return (
              <MeasurePanelContent
                stone={selectedStone}
                measuring={measuring}
                measurement={measurement}
                onToggle={() => {
                  setMeasuring((v) => !v);
                  setMeasurement(undefined);
                }}
                onClear={() => {
                  setMeasurement(undefined);
                  setMeasureClearToken((v) => v + 1);
                }}
              />
            );
          }
          if (id === "record") {
            const dims = metadata?.dimensions ?? selectedStone.metadata?.dimensions;
            const layers = metadata?.layers ?? [];
            return (
              <div className="wsc-panel-content">
                <dl className="wsc-record">
                  <dt>藏品</dt>
                  <dd>{selectedStone.displayName}</dd>
                  <dt>编号</dt>
                  <dd>{selectedStone.id}</dd>
                  <dt>尺寸</dt>
                  <dd>{formatDimensions(dims)}</dd>
                </dl>
                {layers.length > 0 ? (
                  <Section title="简介">
                    {layers.map((layer, i) => (
                      <p key={i} className="ui-muted">
                        {layer.content}
                      </p>
                    ))}
                  </Section>
                ) : (
                  <p className="ui-muted">暂无结构化档案简介。可通过 import-md 导入。</p>
                )}
              </div>
            );
          }
          return null;
        }}
      />
    </PanelLayoutProvider>
  );
}

function MeasurePanelContent({
  stone,
  measuring,
  measurement,
  onToggle,
  onClear
}: {
  stone?: StoneListItem;
  measuring: boolean;
  measurement?: MeasurementResult;
  onToggle: () => void;
  onClear: () => void;
}) {
  const dimensions = stone?.metadata?.dimensions;
  const realLong = dimensions ? Math.max(dimensions.width ?? 0, dimensions.height ?? 0, dimensions.thickness ?? 0) : 0;
  const hasRealScale = realLong > 0;

  return (
    <div className="wsc-panel-content">
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Button variant={measuring ? "primary" : "ghost"} onClick={onToggle}>
          <Ruler size={14} />
          {measuring ? "退出测距" : "开启测距"}
        </Button>
        {measurement ? (
          <Button variant="ghost" compact onClick={onClear} title="清除">
            <Trash2 size={14} />
          </Button>
        ) : null}
      </div>
      <p className="ui-muted">{hasRealScale ? "已按档案尺寸校准" : "未匹配尺寸，显示模型单位"}</p>
      {measurement ? (
        <dl className="wsc-measure-readout">
          <dt>距离</dt>
          <dd>
            {measurement.realDistance !== undefined
              ? `${measurement.realDistance.toFixed(2)} cm`
              : `${measurement.modelDistance.toFixed(3)} 模型单位`}
          </dd>
          {measurement.realDistance !== undefined ? (
            <>
              <dt>模型距离</dt>
              <dd>{measurement.modelDistance.toFixed(3)}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className="ui-muted">{measuring ? "在视图中点击两个点。" : "开启后在模型上拾取两点。"}</p>
      )}
    </div>
  );
}
