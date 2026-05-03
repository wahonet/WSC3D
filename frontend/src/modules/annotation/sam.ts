import { runSamSegmentation, runSamSegmentationBySource } from "../../api/client";
import { createAnnotationFromGeometry, polygonFromUVs, screenToUV, type UV } from "./geometry";
import type { IimlAnnotation, IimlAnnotationFrame, ProjectionContext } from "./types";

export type SamCandidateInput = {
  // 画布像素坐标（相当于 three-stage canvas 的左上原点）
  screenPoint: { x: number; y: number };
  stoneCanvas: HTMLCanvasElement;
  projection: ProjectionContext;
  resourceId: string;
  color: string;
  // 当前底图坐标系，标注落库时记下来；切到另一底图能跨 frame 渲染。
  frame: IimlAnnotationFrame;
};

/**
 * 以当前 Three.js canvas 截图作为图像，向 /ai/sam 发起单点 prompt 请求，
 * 把返回的归一化多边形转换到 WSC3D modelBox 坐标系，构造成 candidate annotation。
 *
 * 坐标系说明（HiDPI 屏下两套尺寸必须对齐）：
 *   - stoneCanvas.width / height        ：canvas 内部像素（受 renderer pixelRatio 放大），
 *                                         toDataURL 输出图像就是这个尺寸
 *   - projection.canvasWidth / Height   ：CSS 显示尺寸，Konva 事件的坐标系
 *   - screenPoint                       ：用户在 Konva 里点击的 CSS 像素
 *
 * Prompt 发给 SAM 时必须把 CSS 坐标换算成"图像像素坐标"——否则 HiDPI 屏上
 * 每个 point 只命中图像左上 1/4 区域，SAM 完全点不到用户想分割的对象。
 *
 * 坐标链：
 *   CSS [x, y] → 图像像素 [x * scaleX, y * scaleY] → SAM point prompt
 *   image-normalized [u, v] (SAM 输出)
 *     → CSS 像素 [u * canvasWidth, v * canvasHeight]
 *     → modelBox 归一化 [u', v'] via screenToUV
 */
export async function requestSamCandidate({
  screenPoint,
  stoneCanvas,
  projection,
  resourceId,
  color,
  frame
}: SamCandidateInput): Promise<IimlAnnotation | undefined> {
  const imageBase64 = stoneCanvas.toDataURL("image/png");

  // 换算 CSS → 图像像素。高 DPI 屏下 scale 通常是 2，低 DPI 屏是 1。
  const scaleX = stoneCanvas.width / Math.max(projection.canvasWidth, 1);
  const scaleY = stoneCanvas.height / Math.max(projection.canvasHeight, 1);
  const promptX = screenPoint.x * scaleX;
  const promptY = screenPoint.y * scaleY;

  const response = await runSamSegmentation({
    imageBase64,
    prompts: [{ type: "point", x: promptX, y: promptY, label: 1 }]
  });

  const imagePolygon = response.polygons?.[0];
  if (!imagePolygon || imagePolygon.length < 3) {
    return undefined;
  }

  // SAM 返回的坐标是图像归一化（0..1），两套像素尺寸在这里是等价的——
  // 乘以 CSS 尺寸直接得到 Konva 坐标系下的像素坐标。
  const uvs: UV[] = imagePolygon.map((point) => {
    const ui = Number(point[0] ?? 0);
    const vi = Number(point[1] ?? 0);
    const px = ui * projection.canvasWidth;
    const py = vi * projection.canvasHeight;
    return screenToUV({ x: px, y: py }, projection);
  });

  const geometry = polygonFromUVs(uvs);
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
        points: [[screenPoint.x, screenPoint.y]],
        labels: [1]
      }
    }
  });
}

// --------------------------------------------------------------
// 高清图路径：用 pic/ 目录里的原图作为 SAM 输入
// --------------------------------------------------------------

export type SamSourceInput = {
  stoneId: string;
  screenPoint: { x: number; y: number };
  projection: ProjectionContext;
  resourceId: string;
  color: string;
  frame: IimlAnnotationFrame;
};

/**
 * 告诉后端"用该画像石的高清原图跑 SAM"：
 * 前端把用户点击点换算到 modelBox UV（v 向下，与屏幕一致）作为 prompt；
 * 后端读 pic/ 文件、算像素、跑 SAM，输出 polygon 也用同一套 UV，前端直接渲染即可。
 *
 * 返回 undefined 有三种情况：
 *  1. pic/ 里没有对应 stoneId 的文件（source-image-not-found）
 *  2. 预测出的 mask 太碎或为空
 *  3. 权重未就绪 + fallback 也失败
 *
 * 调用方收到 undefined 时可以 fallback 到 requestSamCandidate（当前视角截图）。
 */
export async function requestSamCandidateWithSource({
  stoneId,
  screenPoint,
  projection,
  resourceId,
  color,
  frame
}: SamSourceInput): Promise<IimlAnnotation | undefined> {
  const clickUv = screenToUV(screenPoint, projection);

  const response = await runSamSegmentationBySource({
    stoneId,
    prompts: [{ type: "point_uv", u: clickUv.u, v: clickUv.v, label: 1 }]
  });

  if (response.error || !response.polygons?.length) {
    return undefined;
  }

  // 后端输出的 polygon 已经是 modelBox UV (v 向下，与屏幕坐标一致)，直接当 UV 用。
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
        points: [[clickUv.u, clickUv.v]],
        labels: [1],
        source: response.sourceImage ?? null
      }
    }
  });
}
