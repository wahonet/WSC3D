/**
 * 4 点单应性矩阵求解（backend 版）
 *
 * 与 `frontend/src/modules/annotation/homography.ts` 算法严格对齐 ——
 * SOP §3.4 规定 frame=model 标注必须经此反投影到 frame=image 才能进训练池。
 *
 * 重复实现而非共享：
 *  - frontend 用 `./types` 的 `IimlAlignment`，backend 用 `./iiml.js`，类型来源不同
 *  - backend 不依赖浏览器全局，可以是纯函数；二者一旦升级算法（如改 SVD）必须
 *    一起改（搜索关键字 "DLT 单应性"）
 */
import type { IimlAlignment } from "./iiml.js";

export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];
export type Pt2 = readonly [number, number];

const EPSILON = 1e-12;

export function solveHomography(src: readonly Pt2[], dst: readonly Pt2[]): Mat3 | undefined {
  if (src.length < 4 || dst.length < 4) return undefined;
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear8(A, b);
  if (!h) return undefined;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function solveLinear8(A: number[][], b: number[]): number[] | undefined {
  const n = A.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    let pivotAbs = Math.abs(m[col][col]);
    for (let row = col + 1; row < n; row += 1) {
      const v = Math.abs(m[row][col]);
      if (v > pivotAbs) {
        pivotAbs = v;
        pivot = row;
      }
    }
    if (pivotAbs < EPSILON) return undefined;
    if (pivot !== col) {
      [m[col], m[pivot]] = [m[pivot], m[col]];
    }
    const factor = m[col][col];
    for (let j = col; j <= n; j += 1) m[col][j] /= factor;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const r = m[row][col];
      if (Math.abs(r) < EPSILON) continue;
      for (let j = col; j <= n; j += 1) m[row][j] -= r * m[col][j];
    }
  }
  return m.map((row) => row[n]);
}

export function applyHomography(H: Mat3, point: Pt2): Pt2 {
  const [x, y] = point;
  const w = H[6] * x + H[7] * y + H[8];
  if (Math.abs(w) < EPSILON) return [x, y];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function invertMat3(H: Mat3): Mat3 | undefined {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < EPSILON) return undefined;
  const invDet = 1 / det;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H2 = -(a * f - c * d);
  const I = a * e - b * d;
  return [A * invDet, D * invDet, G * invDet, B * invDet, E * invDet, H2 * invDet, C * invDet, F * invDet, I * invDet];
}

export type AlignmentMatrices = {
  modelToImage?: Mat3;
  imageToModel?: Mat3;
};

export function buildAlignmentMatrices(alignment?: IimlAlignment): AlignmentMatrices {
  if (!alignment || alignment.controlPoints.length < 4) return {};
  const pairs = alignment.controlPoints.slice(0, 4);
  const modelPoints = pairs.map((point) => point.modelUv as Pt2);
  const imagePoints = pairs.map((point) => point.imageUv as Pt2);
  const modelToImage = solveHomography(modelPoints, imagePoints);
  const imageToModel = modelToImage
    ? invertMat3(modelToImage) ?? solveHomography(imagePoints, modelPoints)
    : solveHomography(imagePoints, modelPoints);
  return { modelToImage, imageToModel };
}

export function transformUv(
  uv: Pt2,
  matrices: AlignmentMatrices,
  source: "image" | "model",
  target: "image" | "model"
): Pt2 | undefined {
  if (source === target) return uv;
  const matrix = source === "model" ? matrices.modelToImage : matrices.imageToModel;
  if (!matrix) return undefined;
  return applyHomography(matrix, uv);
}
