import { runSamSegmentation, runSamSegmentationBySource } from "../../api/client";
import { createAnnotationFromGeometry, polygonFromUVs, screenToUV, type UV } from "./geometry";
import type { IimlAnnotation, IimlAnnotationFrame, ProjectionContext } from "./types";

// F3：基于已有 BBox 标注（如 YOLO 候选）自动跑 SAM 精修，把粗 bbox 升级成
// 精确 polygon。返回值是新 polygon UV 数组与 SAM 模型 / 置信度信息；调用方
// 决定是替换原 annotation 还是建一条新的。
export type SamRefineResult = {
  polygon: UV[];
  model: string;
  confidence: number;
  sourceImage?: string | null;
};

/**
 * 把已有 annotation（要求 BBox 几何 + image frame）作为 box prompt 喂给 SAM，
 * 让它在 bbox 范围内输出精确 polygon。这是"YOLO 粗 bbox → SAM 精 polygon"的
 * 关键链路：YOLO 找候选位置（recall 高），SAM 给精确轮廓（precision 高）。
 *
 * 失败返回 undefined（前端 status 提示，原 annotation 保持不变）。
 */
export async function refineBBoxWithSam(
  annotation: IimlAnnotation,
  stoneId: string,
  imageUri?: string
): Promise<SamRefineResult | undefined> {
  if (annotation.target.type !== "BBox") {
    return undefined;
  }
  const [u1, v1, u2, v2] = annotation.target.coordinates;
  const minU = Math.min(u1, u2);
  const maxU = Math.max(u1, u2);
  const minV = Math.min(v1, v2);
  const maxV = Math.max(v1, v2);
  if (maxU - minU < 0.005 || maxV - minV < 0.005) {
    // bbox 太小（< 千分之 5 的图像宽 / 高），SAM 在这种小区域上几乎一定输出整张图，
    // 直接放弃避免污染候选。
    return undefined;
  }
  const response = await runSamSegmentationBySource({
    stoneId: imageUri ? undefined : stoneId,
    imageUri,
    prompts: [{ type: "box_uv", bbox_uv: [minU, minV, maxU, maxV] }]
  });
  if (response.error || !response.polygons?.length) {
    return undefined;
  }
  const polygon: UV[] = response.polygons[0]
    .map((point) => ({
      u: Number(point[0] ?? 0),
      v: Number(point[1] ?? 0)
    }))
    .filter((uv) => Number.isFinite(uv.u) && Number.isFinite(uv.v));
  if (polygon.length < 3) {
    return undefined;
  }
  return {
    polygon,
    model: response.model,
    confidence: response.confidence,
    sourceImage: response.sourceImage ?? null
  };
}

// 单条 SAM prompt：UV 是当前画布坐标系（model 模式 = modelBox UV，image 模式 = 高清图归一化）。
// label=1 正点（要这里）；label=0 负点（不要这里）。
export type SamPromptPoint = {
  uv: UV;
  label: 0 | 1;
};

// box prompt：两个对角点（顺序无关，最终归一化为 [minU, minV, maxU, maxV]）。
export type SamPromptBox = {
  startUv: UV;
  endUv: UV;
};

// 一次提交里收集的全部 prompt：≥ 1 个点 或 1 个 box（可两者都给）。
export type SamPromptDraft = {
  points: SamPromptPoint[];
  box?: SamPromptBox;
};

// 提交给 SAM 的入参（截图路径）。
export type SamCandidateInput = {
  prompts: SamPromptDraft;
  stoneCanvas: HTMLCanvasElement;
  projection: ProjectionContext;
  resourceId: string;
  color: string;
  frame: IimlAnnotationFrame;
};

/**
 * 把 SamPromptDraft 转成接口要的"截图路径"prompts 数组（图像像素坐标）。
 *
 * 两套像素尺寸（HiDPI）：
 *   - stoneCanvas.width / height：canvas 内部像素，toDataURL 输出图像就是这个尺寸
 *   - projection.canvasWidth / Height：CSS 显示尺寸；UV ↔ CSS 转换在 geometry.ts
 *
 * 关键：UV → 图像像素 = UV * canvasInternalPixel；不是 CSS 像素，否则 HiDPI 屏每个
 * point 只命中图像左上角 1/4。
 */
function buildScreenshotPrompts(
  draft: SamPromptDraft,
  stoneCanvas: HTMLCanvasElement
): Array<
  | { type: "point"; x: number; y: number; label: 0 | 1 }
  | { type: "box"; bbox: [number, number, number, number] }
> {
  const W = stoneCanvas.width;
  const H = stoneCanvas.height;
  const out: Array<
    | { type: "point"; x: number; y: number; label: 0 | 1 }
    | { type: "box"; bbox: [number, number, number, number] }
  > = [];
  for (const point of draft.points) {
    out.push({
      type: "point",
      x: clamp(point.uv.u * W, 0, W - 1),
      y: clamp(point.uv.v * H, 0, H - 1),
      label: point.label
    });
  }
  if (draft.box) {
    const u1 = Math.min(draft.box.startUv.u, draft.box.endUv.u);
    const u2 = Math.max(draft.box.startUv.u, draft.box.endUv.u);
    const v1 = Math.min(draft.box.startUv.v, draft.box.endUv.v);
    const v2 = Math.max(draft.box.startUv.v, draft.box.endUv.v);
    out.push({
      type: "box",
      bbox: [clamp(u1 * W, 0, W - 1), clamp(v1 * H, 0, H - 1), clamp(u2 * W, 0, W - 1), clamp(v2 * H, 0, H - 1)]
    });
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function summarizePrompts(draft: SamPromptDraft) {
  return {
    positiveCount: draft.points.filter((point) => point.label === 1).length,
    negativeCount: draft.points.filter((point) => point.label === 0).length,
    box: draft.box ? 1 : 0
  };
}

function promptDraftToGeneration(draft: SamPromptDraft) {
  const points: number[][] = draft.points.map((point) => [point.uv.u, point.uv.v]);
  const labels: number[] = draft.points.map((point) => point.label);
  const box = draft.box
    ? [
        Math.min(draft.box.startUv.u, draft.box.endUv.u),
        Math.min(draft.box.startUv.v, draft.box.endUv.v),
        Math.max(draft.box.startUv.u, draft.box.endUv.u),
        Math.max(draft.box.startUv.v, draft.box.endUv.v)
      ]
    : undefined;
  return { points, labels, box };
}

/**
 * 截图路径：把当前 Three.js canvas 截图作为 SAM 输入。
 *
 * 当 sourceMode === "model" 时使用——3D viewport 的内容直接送进去；
 * 当 sourceMode === "image" 时优先走 requestSamCandidateWithSource 的高清图路径，
 * 这条路径只在没匹配到 pic 文件时作为 fallback。
 */
export async function requestSamCandidate({
  prompts,
  stoneCanvas,
  projection,
  resourceId,
  color,
  frame
}: SamCandidateInput): Promise<IimlAnnotation | undefined> {
  if (prompts.points.length === 0 && !prompts.box) {
    return undefined;
  }
  const imageBase64 = stoneCanvas.toDataURL("image/png");
  const apiPrompts = buildScreenshotPrompts(prompts, stoneCanvas);
  const response = await runSamSegmentation({ imageBase64, prompts: apiPrompts });

  const imagePolygon = response.polygons?.[0];
  if (!imagePolygon || imagePolygon.length < 3) {
    return undefined;
  }

  // SAM 返回的 polygon 是图像归一化坐标 [u, v]（截图路径下截图就是 canvas 自身内容，
  // 等价于 projection 的画布坐标）。这里乘 CSS 尺寸再走 screenToUV，把图像归一化
  // 转换到 modelBox UV（仅 model 模式下需要；image 模式下两者本来就一致）。
  const uvs: UV[] = imagePolygon.map((point) => {
    const ui = Number(point[0] ?? 0);
    const vi = Number(point[1] ?? 0);
    const px = ui * projection.canvasWidth;
    const py = vi * projection.canvasHeight;
    return screenToUV({ x: px, y: py }, projection);
  });

  const geometry = polygonFromUVs(uvs);
  const summary = summarizePrompts(prompts);
  return createAnnotationFromGeometry({
    geometry,
    resourceId,
    color,
    frame,
    label: "SAM 候选",
    // 候选统一归到 figure，用户接受后再改层级；等 M3 关系图可做自动推断。
    structuralLevel: "figure",
    reviewStatus: "candidate",
    generation: {
      method: "sam",
      model: response.model,
      confidence: response.confidence,
      prompt: {
        ...promptDraftToGeneration(prompts),
        ...summary
      }
    }
  });
}

// --------------------------------------------------------------
// 高清图路径：用 pic/ 目录里的原图作为 SAM 输入
// --------------------------------------------------------------

export type SamSourceInput = {
  stoneId: string;
  prompts: SamPromptDraft;
  resourceId: string;
  color: string;
  frame: IimlAnnotationFrame;
  // v0.8.0 J：任意资源 URI（正射图 / 拓片 / 法线图 …）。传了就走 imageUri
  // 分支；不传则 fallback 到 stoneId → pic/ 原图。
  imageUri?: string;
};

/**
 * 高清图路径：让后端用 pic/ 下的原图跑 SAM。
 *
 * 前端把 prompt 按 modelBox UV（v 向下，与屏幕一致）发送，后端在它自己的图像
 * 像素空间里推理；输出 polygon 也回 modelBox UV，前端直接渲染。
 *
 * 返回 undefined 的三种情况：
 *  1. pic/ 没匹配 stoneId 的文件（source-image-not-found）
 *  2. mask 太碎或为空
 *  3. 权重未就绪 + fallback 也失败
 *
 * 调用方收到 undefined 时可以 fallback 到 requestSamCandidate（当前视角截图）。
 */
export async function requestSamCandidateWithSource({
  stoneId,
  imageUri,
  prompts,
  resourceId,
  color,
  frame
}: SamSourceInput): Promise<IimlAnnotation | undefined> {
  if (prompts.points.length === 0 && !prompts.box) {
    return undefined;
  }
  const apiPrompts: Array<
    | { type: "point_uv"; u: number; v: number; label: 0 | 1 }
    | { type: "box_uv"; bbox_uv: [number, number, number, number] }
  > = [];
  for (const point of prompts.points) {
    apiPrompts.push({
      type: "point_uv",
      u: point.uv.u,
      v: point.uv.v,
      label: point.label
    });
  }
  if (prompts.box) {
    const u1 = Math.min(prompts.box.startUv.u, prompts.box.endUv.u);
    const u2 = Math.max(prompts.box.startUv.u, prompts.box.endUv.u);
    const v1 = Math.min(prompts.box.startUv.v, prompts.box.endUv.v);
    const v2 = Math.max(prompts.box.startUv.v, prompts.box.endUv.v);
    apiPrompts.push({ type: "box_uv", bbox_uv: [u1, v1, u2, v2] });
  }

  const response = await runSamSegmentationBySource({
    // imageUri 优先（任意资源底图）；否则 stoneId 走 pic/ 原图
    stoneId: imageUri ? undefined : stoneId,
    imageUri,
    prompts: apiPrompts
  });
  if (response.error || !response.polygons?.length) {
    return undefined;
  }

  // 后端输出已经是 modelBox UV（v 向下，与屏幕一致），直接当 UV 用。
  const uvs: UV[] = response.polygons[0]
    .map((point) => ({
      u: Number(point[0] ?? 0),
      v: Number(point[1] ?? 0)
    }))
    .filter((uv) => Number.isFinite(uv.u) && Number.isFinite(uv.v));
  if (uvs.length < 3) {
    return undefined;
  }

  const geometry = polygonFromUVs(uvs);
  const summary = summarizePrompts(prompts);
  return createAnnotationFromGeometry({
    geometry,
    resourceId,
    color,
    frame,
    label: "SAM 候选（高清）",
    structuralLevel: "figure",
    reviewStatus: "candidate",
    generation: {
      method: "sam",
      model: response.model,
      confidence: response.confidence,
      prompt: {
        ...promptDraftToGeneration(prompts),
        ...summary,
        source: response.sourceImage ?? null
      }
    }
  });
}
