export type ViewCubeView = "front" | "back" | "left" | "right" | "top" | "bottom";

export const viewCubeViews: ViewCubeView[] = ["front", "back", "left", "right", "top", "bottom"];

export const viewCubeLabels: Record<ViewCubeView, string> = {
  front: "正",
  back: "背",
  left: "左",
  right: "右",
  top: "上",
  bottom: "下"
};

const viewCubeTransforms: Record<ViewCubeView, string> = {
  front: "rotateX(-22deg) rotateY(34deg)",
  back: "rotateX(-22deg) rotateY(214deg)",
  left: "rotateX(-22deg) rotateY(124deg)",
  right: "rotateX(-22deg) rotateY(-56deg)",
  top: "rotateX(-64deg) rotateY(34deg)",
  bottom: "rotateX(48deg) rotateY(34deg)"
};

type ViewCubeProps = {
  activeView: ViewCubeView;
  onSelect: (view: ViewCubeView) => void;
};

export function ViewCube({ activeView, onSelect }: ViewCubeProps) {
  return (
    <div className="view-cube" aria-label="立面视角">
      <div className="view-cube-inner" style={{ transform: viewCubeTransforms[activeView] }}>
        {viewCubeViews.map((view) => (
          <button
            className={view === activeView ? `cube-face cube-face-${view} active` : `cube-face cube-face-${view}`}
            key={view}
            title={`${viewCubeLabels[view]}面`}
            onClick={() => onSelect(view)}
          >
            {viewCubeLabels[view]}
          </button>
        ))}
      </div>
    </div>
  );
}
