import { useCallback, useState } from "react";
import type { StoneListItem } from "../../api/client";
import { StoneViewer, type ScreenProjection } from "../viewer/StoneViewer";
import { AnnotationCanvas } from "./AnnotationCanvas";
import type { AnnotationTool, IimlAnnotation, IimlDocument, ProjectionContext } from "./types";

type AnnotationWorkspaceProps = {
  stone: StoneListItem;
  background: "black" | "gray" | "white";
  doc?: IimlDocument;
  selectedAnnotationId?: string;
  draftAnnotationId?: string;
  activeTool: AnnotationTool;
  onCreate: (annotation: IimlAnnotation, asDraft?: boolean) => void;
  onUpdate: (id: string, patch: Partial<IimlAnnotation>) => void;
  onDelete: (id: string) => void;
  onSelect: (id?: string) => void;
  onToolChange: (tool: AnnotationTool) => void;
};

export function AnnotationWorkspace({
  stone,
  background,
  doc,
  selectedAnnotationId,
  draftAnnotationId,
  activeTool,
  onCreate,
  onUpdate,
  onDelete,
  onSelect,
  onToolChange
}: AnnotationWorkspaceProps) {
  const [projection, setProjection] = useState<ProjectionContext | undefined>(undefined);
  const resourceId = doc?.resources[0]?.id ?? `${stone.id}:model`;

  const handleProjectionChange = useCallback((next: ScreenProjection | undefined) => {
    if (!next) {
      setProjection(undefined);
      return;
    }
    setProjection({
      canvasWidth: next.canvasWidth,
      canvasHeight: next.canvasHeight,
      corners: next.corners
    });
  }, []);

  return (
    <div className="annotation-workspace">
      <StoneViewer
        background={background}
        cubeView="front"
        measureToken={0}
        measuring={false}
        stone={stone}
        viewMode="2d"
        hideHud
        onCubeViewChange={() => undefined}
        onMeasureChange={() => undefined}
        onScreenProjectionChange={handleProjectionChange}
      />
      <AnnotationCanvas
        activeTool={activeTool}
        annotations={doc?.annotations ?? []}
        draftAnnotationId={draftAnnotationId}
        projection={projection}
        resourceId={resourceId}
        selectedAnnotationId={selectedAnnotationId}
        onCreate={onCreate}
        onDelete={onDelete}
        onSelect={onSelect}
        onToolChange={onToolChange}
        onUpdate={onUpdate}
      />
      <div className="viewer-hud top-left annotation-hint">
        <strong>标注工作区</strong>
        <span>{toolHint(activeTool)}</span>
      </div>
    </div>
  );
}

function toolHint(tool: AnnotationTool) {
  switch (tool) {
    case "rect":
      return "按住左键拖动绘制矩形，松开即完成";
    case "ellipse":
      return "按住左键拖动绘制圆形 / 椭圆，松开即完成";
    case "point":
      return "单击图像放置一个点标注";
    case "pen":
      return "依次点击添加节点，双击或回车闭合多边形";
    case "select":
    default:
      return "选中标注后可拖动整体或四角调整尺寸；按 Delete 删除";
  }
}
