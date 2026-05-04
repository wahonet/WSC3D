/**
 * 视角骰子 `ViewCube`
 *
 * 浏览模块 / 拼接模块右上角的小立方体导航控件。展示 6 个面（正 / 背 / 左 /
 * 右 / 上 / 下），点击任一面把相机切到对应正交视角。
 *
 * 设计要点：
 * - 纯 CSS 3D transform 实现，不依赖 Three.js；点击触发回调由父级把相机重新
 *   定位
 * - 当前 view 持续高亮，悬浮高亮反馈
 * - 与 `StoneViewer` / `AssemblyWorkspace` 共享同一份 view 类型，避免业务层
 *   各写各的"front"字符串
 */

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
