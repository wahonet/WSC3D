import type { IimlAlignment } from "./types";
import type { UV } from "./geometry";

// 3×3 行优先矩阵：[m00, m01, m02, m10, m11, m12, m20, m21, m22]
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export type Pt2 = readonly [number, number];

const epsilon = 1e-12;

/**
 * 4 点对应的 DLT 单应性求解。给定 src/dst 各 4 个点（同序），返回 3×3 矩阵 H：
 *   dst ≈ H · src   （在齐次坐标下，dst.w 归一化到 1）
 *
 * 求解思路：每对点构造 2 个线性方程（消掉 dst.w），堆成 8×9 矩阵 A，
 * 解 A · h = 0。固定 h[8] = 1 后退化为 8×8 线性方程组，用高斯消元求解。
 *
 * 这里用 8 元（h[8]=1）而非 SVD，是因为：
 *   1. 我们标定的是大致正向、不退化的画像石矩形 → 不会出现 h[8] 退化为 0
 *   2. 浏览器里写一个稳定 SVD 成本太高，标定 4 角的精度纯高斯消元就够
 *
 * 输入 4 对点共线 / 退化时返回 undefined，调用方应回退到"恒等映射"。
 */
export function solveHomography(src: readonly Pt2[], dst: readonly Pt2[]): Mat3 | undefined {
  if (src.length < 4 || dst.length < 4) {
    return undefined;
  }
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    // 第 1 行：x·h0 + y·h1 + h2 + 0·h3 + 0·h4 + 0·h5 - u·x·h6 - u·y·h7 = u
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    // 第 2 行：0·h0 + 0·h1 + 0·h2 + x·h3 + y·h4 + h5 - v·x·h6 - v·y·h7 = v
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear8(A, b);
  if (!h) {
    return undefined;
  }
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * 8×8 高斯消元求解 A·x = b。带部分主元（partial pivoting）保证数值稳定性。
 * 若主元接近 0（共线退化）返回 undefined。
 */
function solveLinear8(A: number[][], b: number[]): number[] | undefined {
  const n = A.length;
  // 拼成 8×9 增广矩阵
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
    if (pivotAbs < epsilon) {
      return undefined;
    }
    if (pivot !== col) {
      [m[col], m[pivot]] = [m[pivot], m[col]];
    }
    const factor = m[col][col];
    for (let j = col; j <= n; j += 1) {
      m[col][j] /= factor;
    }
    for (let row = 0; row < n; row += 1) {
      if (row === col) {
        continue;
      }
      const r = m[row][col];
      if (Math.abs(r) < epsilon) {
        continue;
      }
      for (let j = col; j <= n; j += 1) {
        m[row][j] -= r * m[col][j];
      }
    }
  }
  return m.map((row) => row[n]);
}

/**
 * 把齐次坐标点 (x, y, 1) 投影到 H 后归一化为 (x', y')。
 * w 接近 0 表示在像平面无穷远（异常情况），原样返回输入。
 */
export function applyHomography(H: Mat3, point: Pt2): Pt2 {
  const [x, y] = point;
  const w = H[6] * x + H[7] * y + H[8];
  if (Math.abs(w) < epsilon) {
    return [x, y];
  }
  return [
    (H[0] * x + H[1] * y + H[2]) / w,
    (H[3] * x + H[4] * y + H[5]) / w
  ];
}

/**
 * 3×3 矩阵求逆（cramer + adjugate），失败（det≈0）返回 undefined。
 */
export function invertMat3(H: Mat3): Mat3 | undefined {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < epsilon) {
    return undefined;
  }
  const invDet = 1 / det;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H2 = -(a * f - c * d);
  const I = a * e - b * d;
  return [
    A * invDet, D * invDet, G * invDet,
    B * invDet, E * invDet, H2 * invDet,
    C * invDet, F * invDet, I * invDet
  ];
}

/**
 * 通用工具：把 alignment 解成两个方向的矩阵。
 *   modelToImage：把 model 坐标系 UV 映射成 image 坐标系 UV
 *   imageToModel：反之
 * 任一方向求解失败时该方向为 undefined，渲染层应直接跳过跨 frame 显示。
 */
export type AlignmentMatrices = {
  modelToImage?: Mat3;
  imageToModel?: Mat3;
};

export function buildAlignmentMatrices(alignment?: IimlAlignment): AlignmentMatrices {
  if (!alignment || alignment.controlPoints.length < 4) {
    return {};
  }
  // 取前 4 对（多于 4 对用 SVD 才有意义；当前流程严格 4 对）
  const pairs = alignment.controlPoints.slice(0, 4);
  const modelPoints = pairs.map((point) => point.modelUv as Pt2);
  const imagePoints = pairs.map((point) => point.imageUv as Pt2);

  const modelToImage = solveHomography(modelPoints, imagePoints);
  const imageToModel = modelToImage
    ? invertMat3(modelToImage) ?? solveHomography(imagePoints, modelPoints)
    : solveHomography(imagePoints, modelPoints);

  return { modelToImage, imageToModel };
}

/**
 * 把单个 UV 从 source frame 映射到 target frame。同 frame 直接返回原值。
 */
export function transformUv(
  uv: UV,
  matrices: AlignmentMatrices,
  source: "image" | "model",
  target: "image" | "model"
): UV | undefined {
  if (source === target) {
    return uv;
  }
  const matrix = source === "model" ? matrices.modelToImage : matrices.imageToModel;
  if (!matrix) {
    return undefined;
  }
  const [u, v] = applyHomography(matrix, [uv.u, uv.v]);
  return { u, v };
}
