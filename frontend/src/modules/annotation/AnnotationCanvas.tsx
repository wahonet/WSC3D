import { useEffect, useMemo, useRef, useState } from "react";
import { Circle, Layer, Line, Rect, Stage, Text } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { bboxGeometry, createAnnotationFromGeometry, ellipsePolygon, geometryCenter, lineStringGeometry, pointGeometry, polygonGeometry, screenPoints } from "./geometry";
import type { AnnotationTool, IimlAnnotation, IimlGeometry } from "./types";

type AnnotationCanvasProps = {
  width: number;
  height: number;
  resourceId: string;
  annotations: IimlAnnotation[];
  selectedAnnotationId?: string;
  activeTool: AnnotationTool;
  onCreate: (annotation: IimlAnnotation) => void;
  onUpdate: (id: string, patch: Partial<IimlAnnotation>) => void;
  onSelect: (id?: string) => void;
  onSamPoint: (point: { x: number; y: number }) => void;
};

const statusColors = {
  candidate: "#f3a712",
  reviewed: "#2ec4b6",
  approved: "#45d483",
  rejected: "#ff5f57"
};

export function AnnotationCanvas({ width, height, resourceId, annotations, selectedAnnotationId, activeTool, onCreate, onUpdate, onSelect, onSamPoint }: AnnotationCanvasProps) {
  const [draft, setDraft] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } }>();
  const [penPoints, setPenPoints] = useState<Array<{ x: number; y: number }>>([]);
  const stageRef = useRef<import("konva/lib/Stage").Stage | null>(null);
  const interactive = activeTool !== "select" || selectedAnnotationId;

  useEffect(() => {
    setDraft(undefined);
    setPenPoints([]);
  }, [activeTool]);

  const selected = useMemo(() => annotations.find((annotation) => annotation.id === selectedAnnotationId), [annotations, selectedAnnotationId]);

  const pointer = () => {
    const stage = stageRef.current;
    return stage?.getPointerPosition() ?? { x: 0, y: 0 };
  };

  const handlePointerDown = (event: KonvaEventObject<PointerEvent>) => {
    const point = pointer();
    if (activeTool === "select") {
      if (event.target === event.target.getStage()) {
        onSelect(undefined);
      }
      return;
    }
    if (activeTool === "sam") {
      onSamPoint(point);
      return;
    }
    if (activeTool === "point") {
      onCreate(createAnnotationFromGeometry({ geometry: pointGeometry(point, width, height), resourceId }));
      return;
    }
    if (activeTool === "pen" || activeTool === "polyline") {
      setPenPoints((points) => [...points, point]);
      return;
    }
    if (activeTool === "rect" || activeTool === "ellipse") {
      setDraft({ start: point, end: point });
    }
  };

  const handlePointerMove = () => {
    if (!draft) {
      return;
    }
    setDraft({ ...draft, end: pointer() });
  };

  const handlePointerUp = () => {
    if (!draft) {
      return;
    }
    const geometry = activeTool === "ellipse" ? ellipsePolygon(draft.start, draft.end, width, height) : bboxGeometry(draft.start, draft.end, width, height);
    setDraft(undefined);
    onCreate(createAnnotationFromGeometry({ geometry, resourceId }));
  };

  const finishPen = () => {
    if (penPoints.length < 2) {
      return;
    }
    const geometry = activeTool === "polyline" ? lineStringGeometry(penPoints, width, height) : polygonGeometry(penPoints, width, height);
    onCreate(createAnnotationFromGeometry({ geometry, resourceId }));
    setPenPoints([]);
  };

  const updateByDrag = (annotation: IimlAnnotation, deltaX: number, deltaY: number) => {
    const dx = deltaX / Math.max(width, 1);
    const dy = deltaY / Math.max(height, 1);
    const target = translateGeometry(annotation.target, dx, dy);
    onUpdate(annotation.id, { target });
  };

  return (
    <Stage
      className={interactive ? "annotation-canvas active" : "annotation-canvas"}
      height={height}
      onDblClick={finishPen}
      onMouseDown={handlePointerDown}
      onMouseMove={handlePointerMove}
      onMouseUp={handlePointerUp}
      ref={stageRef}
      width={width}
    >
      <Layer>
        {annotations.map((annotation) => (
          <AnnotationShape
            annotation={annotation}
            height={height}
            isSelected={annotation.id === selectedAnnotationId}
            key={annotation.id}
            width={width}
            onDragEnd={updateByDrag}
            onSelect={() => (activeTool === "eraser" ? onUpdate(annotation.id, { reviewStatus: "rejected" }) : onSelect(annotation.id))}
          />
        ))}
        {draft ? (
          activeTool === "ellipse" ? (
            <Line
              closed
              dash={[6, 4]}
              points={screenPoints(ellipsePolygon(draft.start, draft.end, width, height), width, height).flatMap((point) => [point.x, point.y])}
              stroke="#f3a712"
              strokeWidth={2}
            />
          ) : (
            <Rect
              dash={[6, 4]}
              height={Math.abs(draft.end.y - draft.start.y)}
              stroke="#f3a712"
              strokeWidth={2}
              width={Math.abs(draft.end.x - draft.start.x)}
              x={Math.min(draft.start.x, draft.end.x)}
              y={Math.min(draft.start.y, draft.end.y)}
            />
          )
        ) : null}
        {penPoints.length > 0 ? (
          <Line dash={[5, 4]} points={penPoints.flatMap((point) => [point.x, point.y])} stroke="#f3a712" strokeWidth={2} />
        ) : null}
        {selected ? <SelectedLabel annotation={selected} height={height} width={width} /> : null}
      </Layer>
    </Stage>
  );
}

function AnnotationShape({
  annotation,
  width,
  height,
  isSelected,
  onSelect,
  onDragEnd
}: {
  annotation: IimlAnnotation;
  width: number;
  height: number;
  isSelected: boolean;
  onSelect: () => void;
  onDragEnd: (annotation: IimlAnnotation, deltaX: number, deltaY: number) => void;
}) {
  const color = statusColors[annotation.reviewStatus ?? "reviewed"];
  const common = {
    draggable: true,
    stroke: color,
    strokeWidth: isSelected ? 3 : 2,
    dash: annotation.reviewStatus === "candidate" || annotation.reviewStatus === "rejected" ? [8, 5] : undefined,
    opacity: annotation.reviewStatus === "rejected" ? 0.45 : 1,
    onClick: (event: KonvaEventObject<MouseEvent>) => {
      event.cancelBubble = true;
      onSelect();
    },
    onDragEnd: (event: KonvaEventObject<DragEvent>) => {
      onDragEnd(annotation, event.target.x(), event.target.y());
      event.target.position({ x: 0, y: 0 });
    }
  };

  if (annotation.target.type === "BBox") {
    const [minX, minY, maxX, maxY] = annotation.target.coordinates;
    return <Rect {...common} fill="rgba(243, 167, 18, 0.08)" height={(maxY - minY) * height} width={(maxX - minX) * width} x={minX * width} y={minY * height} />;
  }
  if (annotation.target.type === "Point") {
    const [x, y] = annotation.target.coordinates;
    return <Circle {...common} fill={color} radius={isSelected ? 7 : 5} x={Number(x) * width} y={Number(y) * height} />;
  }
  const points = screenPoints(annotation.target, width, height).flatMap((point) => [point.x, point.y]);
  return <Line {...common} closed={annotation.target.type === "Polygon" || annotation.target.type === "MultiPolygon"} fill="rgba(46, 196, 182, 0.08)" points={points} />;
}

function SelectedLabel({ annotation, width, height }: { annotation: IimlAnnotation; width: number; height: number }) {
  const center = geometryCenter(annotation.target, width, height);
  return <Text fill="#f3a712" fontSize={13} fontStyle="bold" text={annotation.label ?? annotation.id} x={center.x + 8} y={center.y - 22} />;
}

function translateGeometry(geometry: IimlGeometry, dx: number, dy: number): IimlGeometry {
  const movePoint = (point: number[]) => [clamp((point[0] ?? 0) + dx), clamp((point[1] ?? 0) + dy), point[2] ?? 0] as [number, number, number];
  if (geometry.type === "BBox") {
    const [minX, minY, maxX, maxY] = geometry.coordinates;
    return { type: "BBox", coordinates: [clamp(minX + dx), clamp(minY + dy), clamp(maxX + dx), clamp(maxY + dy)] };
  }
  if (geometry.type === "Point") {
    return { type: "Point", coordinates: movePoint(geometry.coordinates) };
  }
  if (geometry.type === "LineString") {
    return { type: "LineString", coordinates: geometry.coordinates.map(movePoint) };
  }
  if (geometry.type === "Polygon") {
    return { type: "Polygon", coordinates: geometry.coordinates.map((ring) => ring.map(movePoint)) };
  }
  return { type: "MultiPolygon", coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(movePoint))) };
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
