import { useEffect, useRef, useState } from "react";
import type { StoneListItem } from "../../api/client";
import { runCannyLine, runSamSegmentation, runYoloDetection } from "../../api/client";
import { StoneViewer } from "../viewer/StoneViewer";
import { AnnotationCanvas } from "./AnnotationCanvas";
import { bboxGeometry, createAnnotationFromGeometry, polygonGeometry } from "./geometry";
import type { AnnotationTool, IimlAnnotation, IimlDocument } from "./types";

type AnnotationWorkspaceProps = {
  stone: StoneListItem;
  background: "black" | "gray" | "white";
  doc?: IimlDocument;
  selectedAnnotationId?: string;
  activeTool: AnnotationTool;
  aiAvailable: boolean;
  aiRequest?: "yolo" | "canny";
  onAiRequestHandled: () => void;
  onCreate: (annotation: IimlAnnotation) => void;
  onCreateMany: (annotations: IimlAnnotation[]) => void;
  onUpdate: (id: string, patch: Partial<IimlAnnotation>) => void;
  onSelect: (id?: string) => void;
  onAddResource: (resource: IimlDocument["resources"][number], processingRun?: Record<string, unknown>) => void;
  onStatus: (status?: string) => void;
  onAiBusy: (busy?: "sam" | "yolo" | "canny") => void;
};

export function AnnotationWorkspace({
  stone,
  background,
  doc,
  selectedAnnotationId,
  activeTool,
  aiAvailable,
  aiRequest,
  onAiRequestHandled,
  onCreate,
  onCreateMany,
  onUpdate,
  onSelect,
  onAddResource,
  onStatus,
  onAiBusy
}: AnnotationWorkspaceProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [, setProjectionReady] = useState(false);
  const resourceId = doc?.resources[0]?.id ?? `${stone.id}:model`;

  useEffect(() => {
    const element = shellRef.current;
    if (!element) {
      return;
    }
    const resize = () => {
      setSize({ width: element.clientWidth || 1, height: element.clientHeight || 1 });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!aiRequest) {
      return;
    }
    const run = aiRequest === "yolo" ? runYolo : runCanny;
    run().finally(onAiRequestHandled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiRequest]);

  const captureImage = () => {
    const canvas = shellRef.current?.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("当前视图尚未准备好截图");
    }
    return canvas.toDataURL("image/png");
  };

  const handleSamPoint = async (point: { x: number; y: number }) => {
    if (!aiAvailable) {
      onStatus("AI 服务未连接，无法使用 SAM。");
      return;
    }
    onAiBusy("sam");
    onStatus("SAM 正在生成候选轮廓...");
    try {
      const result = await runSamSegmentation({
        imageBase64: captureImage(),
        prompts: [{ type: "point", x: point.x, y: point.y, label: 1 }]
      });
      const annotations = result.polygons.map((polygon) =>
        createAnnotationFromGeometry({
          geometry: polygonGeometry(
            polygon.map((item) => ({ x: Number(item[0]) * size.width, y: Number(item[1]) * size.height })),
            size.width,
            size.height
          ),
          resourceId,
          label: "SAM 候选区域",
          structuralLevel: "unknown",
          reviewStatus: "candidate",
          generation: {
            method: "sam",
            model: result.model,
            modelVersion: "local",
            confidence: result.confidence,
            reviewStatus: "candidate",
            prompt: { point }
          }
        })
      );
      onCreateMany(annotations);
      onStatus(`SAM 已生成 ${annotations.length} 条候选标注。`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "SAM 标注失败");
    } finally {
      onAiBusy(undefined);
    }
  };

  const runYolo = async () => {
    if (!aiAvailable) {
      onStatus("AI 服务未连接，无法使用 YOLO。");
      return;
    }
    onAiBusy("yolo");
    onStatus("YOLO 正在扫描当前视图...");
    try {
      const result = await runYoloDetection({ imageBase64: captureImage() });
      const annotations = result.detections.map((detection) =>
        createAnnotationFromGeometry({
          geometry: bboxGeometry({ x: detection.bbox[0], y: detection.bbox[1] }, { x: detection.bbox[2], y: detection.bbox[3] }, size.width, size.height),
          resourceId,
          label: detection.label,
          structuralLevel: "figure",
          reviewStatus: "candidate",
          generation: {
            method: "model-assisted",
            model: result.model,
            confidence: detection.confidence,
            reviewStatus: "candidate"
          }
        })
      );
      onCreateMany(annotations);
      onStatus(`YOLO 已生成 ${annotations.length} 条候选框。`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "YOLO 检测失败");
    } finally {
      onAiBusy(undefined);
    }
  };

  const runCanny = async () => {
    if (!aiAvailable) {
      onStatus("AI 服务未连接，无法生成线图。");
      return;
    }
    onAiBusy("canny");
    onStatus("正在生成快速线图...");
    try {
      const result = await runCannyLine({ imageBase64: captureImage(), low: 60, high: 140 });
      const resourceIdFromAi = result.resourceId || `${stone.id}:line:${Date.now()}`;
      onAddResource(
        {
          id: resourceIdFromAi,
          type: "LineDrawing",
          uri: result.imageBase64,
          name: "OpenCV 快速线图",
          format: "image/png",
          derivedFrom: [resourceId],
          metadata: { generatedBy: result.model }
        },
        {
          id: `run-${Date.now()}`,
          method: "line-extraction",
          software: result.model,
          parameters: { low: 60, high: 140 },
          inputResourceIds: [resourceId],
          outputResourceIds: [resourceIdFromAi],
          createdAt: new Date().toISOString(),
          createdBy: "ai-service"
        }
      );
      onStatus("快速线图已作为 LineDrawing 资源写入 IIML。");
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "线图生成失败");
    } finally {
      onAiBusy(undefined);
    }
  };

  return (
    <div className="annotation-workspace" ref={shellRef}>
      <StoneViewer
        background={background}
        cubeView="front"
        measureToken={0}
        measuring={false}
        stone={stone}
        viewMode="2d"
        annotations={doc?.annotations ?? []}
        hideHud
        onCubeViewChange={() => undefined}
        onMeasureChange={() => undefined}
        onProjectionReady={() => setProjectionReady(true)}
      />
      <AnnotationCanvas
        activeTool={activeTool}
        annotations={doc?.annotations ?? []}
        height={size.height}
        onCreate={onCreate}
        onSamPoint={handleSamPoint}
        onSelect={onSelect}
        onUpdate={onUpdate}
        resourceId={resourceId}
        selectedAnnotationId={selectedAnnotationId}
        width={size.width}
      />
      <div className="viewer-hud top-left">
        <strong>标注工作区</strong>
        <span>{activeTool === "sam" ? "点击模型生成 SAM 候选区域" : "2D 正投影上创建结构化标注"}</span>
      </div>
    </div>
  );
}
