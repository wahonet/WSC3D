import { useEffect, useMemo, useRef, useState } from "react";
import { Circle, Group, Layer, Line, Rect, Stage } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type Konva from "konva";
import {
  bboxCornersOnScreen,
  bboxFromUV,
  createAnnotationFromGeometry,
  ellipseBoundsToUV,
  ellipsePolygonFromUV,
  geometryCenter,
  pointFromUV,
  polygonFromUVs,
  projectGeometryToScreen,
  resizeBBoxByCorner,
  resizeEllipseByCorner,
  screenToUV,
  translateGeometry,
  uvToScreen,
  type UV
} from "./geometry";
import { annotationPalette } from "./store";
import type { AnnotationTool, IimlAnnotation, ProjectionContext } from "./types";

type AnnotationCanvasProps = {
  resourceId: string;
  annotations: IimlAnnotation[];
  selectedAnnotationId?: string;
  draftAnnotationId?: string;
  activeTool: AnnotationTool;
  projection?: ProjectionContext;
  onCreate: (annotation: IimlAnnotation, asDraft?: boolean) => void;
  onUpdate: (id: string, patch: Partial<IimlAnnotation>) => void;
  onDelete: (id: string) => void;
  onSelect: (id?: string) => void;
  onToolChange: (tool: AnnotationTool) => void;
};

const minDragPixels = 4;
const handleSize = 7;

type DraftRect = { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;

type DraggingState =
  | { kind: "move"; id: string; lastUV: UV; original: IimlAnnotation }
  | { kind: "corner"; id: string; cornerIndex: 0 | 1 | 2 | 3; original: IimlAnnotation }
  | undefined;

function isLocked(annotation: IimlAnnotation) {
  return annotation.locked === true;
}

function isVisible(annotation: IimlAnnotation) {
  return annotation.visible !== false;
}

function annotationColor(annotation: IimlAnnotation, fallbackIndex = 0) {
  return annotation.color ?? annotationPalette[fallbackIndex % annotationPalette.length];
}

export function AnnotationCanvas({
  resourceId,
  annotations,
  selectedAnnotationId,
  draftAnnotationId,
  activeTool,
  projection,
  onCreate,
  onUpdate,
  onDelete,
  onSelect,
  onToolChange
}: AnnotationCanvasProps) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [draftRect, setDraftRect] = useState<DraftRect>(undefined);
  const [penPoints, setPenPoints] = useState<Array<{ x: number; y: number }>>([]);
  const draggingRef = useRef<DraggingState>(undefined);

  useEffect(() => {
    setDraftRect(undefined);
    setPenPoints([]);
  }, [activeTool, projection?.canvasWidth, projection?.canvasHeight]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedAnnotationId) {
          event.preventDefault();
          onDelete(selectedAnnotationId);
        }
      } else if (event.key === "Escape") {
        if (penPoints.length > 0) {
          setPenPoints([]);
        } else {
          onSelect(undefined);
        }
      } else if (event.key === "Enter" && activeTool === "pen" && penPoints.length >= 3) {
        finishPenPolygon(penPoints);
      }
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAnnotationId, activeTool, penPoints]);

  const visibleAnnotations = useMemo(() => annotations.filter(isVisible), [annotations]);

  const interactive = Boolean(projection);
  const stageWidth = projection?.canvasWidth ?? 1;
  const stageHeight = projection?.canvasHeight ?? 1;

  const pointerScreen = () => {
    const stage = stageRef.current;
    return stage?.getPointerPosition() ?? { x: 0, y: 0 };
  };

  const newColor = () => annotationPalette[annotations.length % annotationPalette.length];

  const finishPenPolygon = (points: Array<{ x: number; y: number }>) => {
    if (!projection || points.length < 3) {
      setPenPoints([]);
      return;
    }
    const uvs = points.map((point) => screenToUV(point, projection));
    const geometry = polygonFromUVs(uvs);
    const annotation = createAnnotationFromGeometry({ geometry, resourceId, color: newColor() });
    onCreate(annotation, true);
    onToolChange("select");
    setPenPoints([]);
  };

  const handleMouseDown = (event: KonvaEventObject<MouseEvent>) => {
    if (!projection) {
      return;
    }
    if (draggingRef.current) {
      return;
    }
    const point = pointerScreen();

    if (activeTool === "select") {
      if (event.target === event.target.getStage()) {
        onSelect(undefined);
      }
      return;
    }

    if (activeTool === "rect" || activeTool === "ellipse") {
      setDraftRect({ start: point, end: point });
      return;
    }

    if (activeTool === "point") {
      const uv = screenToUV(point, projection);
      const annotation = createAnnotationFromGeometry({ geometry: pointFromUV(uv), resourceId, color: newColor() });
      onCreate(annotation, true);
      onToolChange("select");
      return;
    }

    if (activeTool === "pen") {
      const stage = event.target.getStage();
      if (!stage) {
        return;
      }
      if (penPoints.length >= 3) {
        const first = penPoints[0];
        const distance = Math.hypot(point.x - first.x, point.y - first.y);
        if (distance <= 8) {
          finishPenPolygon(penPoints);
          return;
        }
      }
      setPenPoints((points) => [...points, point]);
    }
  };

  const handleMouseMove = () => {
    if (!projection) {
      return;
    }

    const dragging = draggingRef.current;
    if (dragging) {
      const point = pointerScreen();
      const uv = screenToUV(point, projection);
      if (dragging.kind === "move") {
        const du = uv.u - dragging.lastUV.u;
        const dv = uv.v - dragging.lastUV.v;
        const next = translateGeometry(dragging.original.target, du, dv);
        draggingRef.current = { ...dragging, original: { ...dragging.original, target: next }, lastUV: uv };
        onUpdate(dragging.id, { target: next });
      } else if (dragging.kind === "corner") {
        const target = dragging.original.target;
        if (target.type === "BBox") {
          const next = resizeBBoxByCorner(target, dragging.cornerIndex, uv);
          draggingRef.current = { ...dragging, original: { ...dragging.original, target: next } };
          onUpdate(dragging.id, { target: next });
        } else if (target.type === "Polygon") {
          const next = resizeEllipseByCorner(target, dragging.cornerIndex, uv);
          if (next) {
            draggingRef.current = { ...dragging, original: { ...dragging.original, target: next } };
            onUpdate(dragging.id, { target: next });
          }
        }
      }
      return;
    }

    if (draftRect) {
      setDraftRect({ ...draftRect, end: pointerScreen() });
    }
  };

  const handleMouseUp = () => {
    if (draggingRef.current) {
      draggingRef.current = undefined;
      return;
    }
    if (!draftRect || !projection) {
      return;
    }
    const distance = Math.hypot(draftRect.end.x - draftRect.start.x, draftRect.end.y - draftRect.start.y);
    if (distance < minDragPixels) {
      setDraftRect(undefined);
      return;
    }
    const startUV = screenToUV(draftRect.start, projection);
    const endUV = screenToUV(draftRect.end, projection);
    const geometry = activeTool === "ellipse" ? ellipsePolygonFromUV(startUV, endUV) : bboxFromUV(startUV, endUV);
    const annotation = createAnnotationFromGeometry({ geometry, resourceId, color: newColor() });
    setDraftRect(undefined);
    onCreate(annotation, true);
    onToolChange("select");
  };

  const handleDoubleClick = () => {
    if (activeTool === "pen" && penPoints.length >= 3) {
      finishPenPolygon(penPoints);
    }
  };

  const handleStageLeave = () => {
    if (draggingRef.current) {
      draggingRef.current = undefined;
    }
    if (draftRect) {
      setDraftRect(undefined);
    }
  };

  const beginShapeDrag = (annotation: IimlAnnotation) => {
    if (!projection || isLocked(annotation)) {
      return;
    }
    const point = pointerScreen();
    const uv = screenToUV(point, projection);
    draggingRef.current = { kind: "move", id: annotation.id, lastUV: uv, original: annotation };
  };

  const beginCornerDrag = (annotation: IimlAnnotation, cornerIndex: 0 | 1 | 2 | 3) => {
    if (isLocked(annotation)) {
      return;
    }
    draggingRef.current = { kind: "corner", id: annotation.id, cornerIndex, original: annotation };
  };

  const selectedAnnotation = selectedAnnotationId ? annotations.find((annotation) => annotation.id === selectedAnnotationId) : undefined;
  const showSelectionHandles = Boolean(
    selectedAnnotation && projection && isVisible(selectedAnnotation) && !isLocked(selectedAnnotation)
  );

  return (
    <div
      ref={containerRef}
      className={interactive ? "annotation-canvas-host active" : "annotation-canvas-host"}
      tabIndex={0}
    >
      <Stage
        className={interactive ? "annotation-canvas active" : "annotation-canvas"}
        ref={stageRef}
        width={stageWidth}
        height={stageHeight}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleStageLeave}
        onDblClick={handleDoubleClick}
        onContextMenu={(event) => event.evt.preventDefault()}
      >
        <Layer>
          {visibleAnnotations.map((annotation, index) => (
            <AnnotationShape
              activeTool={activeTool}
              annotation={annotation}
              key={annotation.id}
              color={annotationColor(annotation, index)}
              isSelected={annotation.id === selectedAnnotationId}
              isDraft={annotation.id === draftAnnotationId}
              locked={isLocked(annotation)}
              projection={projection}
              onSelect={() => onSelect(annotation.id)}
              onBeginDrag={() => beginShapeDrag(annotation)}
            />
          ))}
          {showSelectionHandles && selectedAnnotation && projection ? (
            <SelectionHandles
              annotation={selectedAnnotation}
              projection={projection}
              onBeginCornerDrag={(cornerIndex) => beginCornerDrag(selectedAnnotation, cornerIndex)}
            />
          ) : null}
          {draftRect && projection ? (
            activeTool === "ellipse" ? (
              <DraftEllipse start={draftRect.start} end={draftRect.end} />
            ) : (
              <DraftRect start={draftRect.start} end={draftRect.end} />
            )
          ) : null}
          {penPoints.length > 0 ? (
            <Group>
              <Line
                points={penPoints.flatMap((point) => [point.x, point.y])}
                stroke="#f3a712"
                strokeWidth={2}
                dash={[5, 4]}
              />
              {penPoints.map((point, index) => (
                <Circle
                  fill="#f3a712"
                  key={`pen-${index}`}
                  radius={index === 0 ? 5 : 3}
                  stroke="#1d1a18"
                  strokeWidth={1}
                  x={point.x}
                  y={point.y}
                />
              ))}
            </Group>
          ) : null}
        </Layer>
      </Stage>
      {!projection ? (
        <div className="annotation-canvas-placeholder">
          <span>正在等待模型投影就绪...</span>
        </div>
      ) : null}
    </div>
  );
}

function AnnotationShape({
  activeTool,
  annotation,
  color,
  isSelected,
  isDraft,
  locked,
  projection,
  onSelect,
  onBeginDrag
}: {
  activeTool: AnnotationTool;
  annotation: IimlAnnotation;
  color: string;
  isSelected: boolean;
  isDraft: boolean;
  locked: boolean;
  projection?: ProjectionContext;
  onSelect: () => void;
  onBeginDrag: () => void;
}) {
  if (!projection) {
    return null;
  }
  const interactive = activeTool === "select" && !locked;
  const stroke = isSelected ? "#f3a712" : color;
  const dash = isDraft ? [6, 4] : locked ? [3, 3] : undefined;
  const strokeWidth = isSelected ? 2.4 : 1.6;
  const onMouseDown = (event: KonvaEventObject<MouseEvent>) => {
    if (!interactive) {
      return;
    }
    event.cancelBubble = true;
    onSelect();
    onBeginDrag();
  };
  const onClick = (event: KonvaEventObject<MouseEvent>) => {
    if (activeTool !== "select") {
      return;
    }
    event.cancelBubble = true;
    onSelect();
  };

  if (annotation.target.type === "BBox") {
    const screen = bboxCornersOnScreen(annotation.target, projection);
    if (screen.length < 4) {
      return null;
    }
    const left = Math.min(screen[0].x, screen[2].x);
    const right = Math.max(screen[0].x, screen[2].x);
    const top = Math.min(screen[0].y, screen[2].y);
    const bottom = Math.max(screen[0].y, screen[2].y);
    return (
      <Rect
        x={left}
        y={top}
        width={right - left}
        height={bottom - top}
        stroke={stroke}
        strokeWidth={strokeWidth}
        dash={dash}
        fill="rgba(243, 167, 18, 0.06)"
        onMouseDown={onMouseDown}
        onClick={onClick}
      />
    );
  }

  if (annotation.target.type === "Point") {
    const center = uvToScreen({ u: Number(annotation.target.coordinates[0] ?? 0), v: Number(annotation.target.coordinates[1] ?? 0) }, projection);
    return (
      <Circle
        x={center.x}
        y={center.y}
        radius={isSelected ? 7 : 5}
        fill={stroke}
        stroke="#1d1a18"
        strokeWidth={1.5}
        onMouseDown={onMouseDown}
        onClick={onClick}
      />
    );
  }

  const points = projectGeometryToScreen(annotation.target, projection).flatMap((point) => [point.x, point.y]);
  return (
    <Line
      points={points}
      closed={annotation.target.type === "Polygon" || annotation.target.type === "MultiPolygon"}
      stroke={stroke}
      strokeWidth={strokeWidth}
      dash={dash}
      fill="rgba(46, 196, 182, 0.06)"
      onMouseDown={onMouseDown}
      onClick={onClick}
    />
  );
}

function SelectionHandles({
  annotation,
  projection,
  onBeginCornerDrag
}: {
  annotation: IimlAnnotation;
  projection: ProjectionContext;
  onBeginCornerDrag: (cornerIndex: 0 | 1 | 2 | 3) => void;
}) {
  let bounds: { min: UV; max: UV } | undefined;
  if (annotation.target.type === "BBox") {
    const [minU, minV, maxU, maxV] = annotation.target.coordinates;
    bounds = { min: { u: minU, v: minV }, max: { u: maxU, v: maxV } };
  } else if (annotation.target.type === "Polygon") {
    bounds = ellipseBoundsToUV(annotation.target);
  }
  if (!bounds) {
    return null;
  }
  const corners: Array<{ uv: UV; index: 0 | 1 | 2 | 3 }> = [
    { uv: { u: bounds.min.u, v: bounds.max.v }, index: 0 },
    { uv: { u: bounds.max.u, v: bounds.max.v }, index: 1 },
    { uv: { u: bounds.max.u, v: bounds.min.v }, index: 2 },
    { uv: { u: bounds.min.u, v: bounds.min.v }, index: 3 }
  ];
  const center = uvToScreen(geometryCenter(annotation.target), projection);
  return (
    <Group>
      <Circle x={center.x} y={center.y} radius={3} fill="#f3a712" opacity={0.6} listening={false} />
      {corners.map(({ uv, index }) => {
        const screen = uvToScreen(uv, projection);
        return (
          <Rect
            key={`handle-${index}`}
            x={screen.x - handleSize / 2}
            y={screen.y - handleSize / 2}
            width={handleSize}
            height={handleSize}
            fill="#f3a712"
            stroke="#1d1a18"
            strokeWidth={1.2}
            onMouseDown={(event) => {
              event.cancelBubble = true;
              onBeginCornerDrag(index);
            }}
          />
        );
      })}
    </Group>
  );
}

function DraftRect({ start, end }: { start: { x: number; y: number }; end: { x: number; y: number } }) {
  return (
    <Rect
      dash={[6, 4]}
      height={Math.abs(end.y - start.y)}
      stroke="#f3a712"
      strokeWidth={2}
      width={Math.abs(end.x - start.x)}
      x={Math.min(start.x, end.x)}
      y={Math.min(start.y, end.y)}
    />
  );
}

function DraftEllipse({ start, end }: { start: { x: number; y: number }; end: { x: number; y: number } }) {
  const centerX = (start.x + end.x) / 2;
  const centerY = (start.y + end.y) / 2;
  const radiusX = Math.abs(end.x - start.x) / 2;
  const radiusY = Math.abs(end.y - start.y) / 2;
  const samples = 48;
  const points: number[] = [];
  for (let index = 0; index <= samples; index += 1) {
    const angle = (index / samples) * Math.PI * 2;
    points.push(centerX + Math.cos(angle) * radiusX, centerY + Math.sin(angle) * radiusY);
  }
  return <Line closed dash={[6, 4]} points={points} stroke="#f3a712" strokeWidth={2} />;
}
