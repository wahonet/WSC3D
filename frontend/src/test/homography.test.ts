/**
 * homography 单元测试 — 4 点单应性求解 / 应用 / 求逆
 *
 * 这是 3D 模型 ↔ 高清图坐标互投影的数学核心，标注跨 frame 显示与训练池
 * frame=model 反投影都依赖它。roundtrip 误差应 < 1e-9（矩阵本身精度，
 * 实际标定误差来自用户点选）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyHomography,
  buildAlignmentMatrices,
  computeAlignmentError,
  invertMat3,
  solveHomography,
  transformUv,
  type Mat3
} from "../modules/annotation/homography";

function approx(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) < eps, `${actual} ≈ ${expected} (eps ${eps})`);
}

function matEqual(a: Mat3, b: Mat3, eps = 1e-9): void {
  for (let i = 0; i < 9; i += 1) approx(a[i], b[i], eps);
}

describe("solveHomography — 恒等映射", () => {
  it("src === dst → H ≈ 单位矩阵", () => {
    const pts = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1]
    ] as const;
    const H = solveHomography(pts, pts);
    assert.ok(H);
    const identity: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    matEqual(H as Mat3, identity);
  });
});

describe("solveHomography — 已知仿射变换", () => {
  it("scale 2× + translate (0.1, 0.2) 可被还原", () => {
    const src = [
      [0, 0],
      [0.5, 0],
      [0.5, 0.5],
      [0, 0.5]
    ] as const;
    // dst = 2 * src + (0.1, 0.2)
    const dst = src.map(([x, y]) => [2 * x + 0.1, 2 * y + 0.2] as const);
    const H = solveHomography(src, dst);
    assert.ok(H);
    // 任意源点投到 dst 应等于 2*x+0.1, 2*y+0.2
    for (const [x, y] of [
      [0.25, 0.1],
      [0.4, 0.45],
      [0.1, 0.3]
    ]) {
      const [u, v] = applyHomography(H as Mat3, [x, y]);
      approx(u, 2 * x + 0.1);
      approx(v, 2 * y + 0.2);
    }
  });
});

describe("solveHomography — 退化返回 undefined", () => {
  it("4 点共线 → undefined", () => {
    const collinear = [
      [0, 0],
      [0.25, 0],
      [0.5, 0],
      [0.75, 0]
    ] as const;
    const H = solveHomography(collinear, [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1]
    ]);
    assert.equal(H, undefined);
  });

  it("少于 4 对点 → undefined", () => {
    const H = solveHomography(
      [
        [0, 0],
        [1, 0],
        [1, 1]
      ],
      [
        [0, 0],
        [1, 0],
        [1, 1]
      ]
    );
    assert.equal(H, undefined);
  });
});

describe("invertMat3", () => {
  it("H · H⁻¹ ≈ 单位矩阵", () => {
    const src = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1]
    ] as const;
    const dst = [
      [0.1, 0.2],
      [0.9, 0.15],
      [0.95, 0.85],
      [0.05, 0.9]
    ] as const;
    const H = solveHomography(src, dst);
    assert.ok(H);
    const Hinv = invertMat3(H as Mat3);
    assert.ok(Hinv);
    // 用 roundtrip 验证：dst 经 Hinv 回到 src
    for (let i = 0; i < 4; i += 1) {
      const [u, v] = applyHomography(Hinv as Mat3, dst[i]);
      approx(u, src[i][0]);
      approx(v, src[i][1]);
    }
  });
});

describe("buildAlignmentMatrices — 双向 roundtrip", () => {
  it("model→image→model 回到原点", () => {
    const controlPoints: { modelUv: [number, number]; imageUv: [number, number] }[] = [
      { modelUv: [0, 0], imageUv: [0.05, 0.1] },
      { modelUv: [1, 0], imageUv: [0.95, 0.08] },
      { modelUv: [1, 1], imageUv: [0.97, 0.92] },
      { modelUv: [0, 1], imageUv: [0.03, 0.95] }
    ];
    const alignment = {
      version: 1 as const,
      calibratedAt: "2026-01-01",
      controlPoints
    };
    const matrices = buildAlignmentMatrices(alignment);
    assert.ok(matrices.modelToImage);
    assert.ok(matrices.imageToModel);
    for (const { modelUv, imageUv } of alignment.controlPoints) {
      const toImage = transformUv({ u: modelUv[0], v: modelUv[1] }, matrices, "model", "image");
      assert.ok(toImage);
      approx(toImage.u, imageUv[0]);
      approx(toImage.v, imageUv[1]);
      const back = transformUv(toImage, matrices, "image", "model");
      assert.ok(back);
      approx(back.u, modelUv[0]);
      approx(back.v, modelUv[1]);
    }
  });

  it("不足 4 控制点 → 空矩阵", () => {
    const m = buildAlignmentMatrices({
      version: 1,
      calibratedAt: "x",
      controlPoints: [{ modelUv: [0, 0], imageUv: [0, 0] }]
    });
    assert.deepEqual(m, {});
  });
});

describe("transformUv — 同 frame 直返", () => {
  it("source === target → 原值", () => {
    const uv = { u: 0.3, v: 0.7 };
    assert.equal(transformUv(uv, {}, "model", "model"), uv);
    assert.equal(transformUv(uv, {}, "image", "image"), uv);
  });
});

describe("computeAlignmentError", () => {
  it("不足 4 控制点 → undefined", () => {
    assert.equal(
      computeAlignmentError({ version: 1, calibratedAt: "x", controlPoints: [] }),
      undefined
    );
  });

  it("4 点（精确解）重投影误差 ≈ 数值噪声（< 1e-6）", () => {
    const controlPoints: { modelUv: [number, number]; imageUv: [number, number] }[] = [
      { modelUv: [0, 0], imageUv: [0.05, 0.1] },
      { modelUv: [1, 0], imageUv: [0.95, 0.08] },
      { modelUv: [1, 1], imageUv: [0.97, 0.92] },
      { modelUv: [0, 1], imageUv: [0.03, 0.95] }
    ];
    const report = computeAlignmentError({ version: 1, calibratedAt: "x", controlPoints });
    assert.ok(report);
    assert.ok(report!.meanError < 1e-6, `4 点误差应≈0，实际 ${report!.meanError}`);
    assert.equal(report!.ready, true);
    assert.equal(report!.pointCount, 4);
  });

  it("5 点且第 5 点偏离 → meanError 明显 > 0 且 ready=false", () => {
    const controlPoints: { modelUv: [number, number]; imageUv: [number, number] }[] = [
      { modelUv: [0, 0], imageUv: [0.05, 0.1] },
      { modelUv: [1, 0], imageUv: [0.95, 0.08] },
      { modelUv: [1, 1], imageUv: [0.97, 0.92] },
      { modelUv: [0, 1], imageUv: [0.03, 0.95] },
      // 第 5 点故意偏离 0.1 UV
      { modelUv: [0.5, 0.5], imageUv: [0.6, 0.6] }
    ];
    const report = computeAlignmentError({ version: 1, calibratedAt: "x", controlPoints });
    assert.ok(report);
    // 4 点精确通过（误差 0），第 5 点偏离拉高 meanError ≈ 0.027（>ready 阈值 0.02）
    assert.ok(report!.meanError > 0.02, `含偏离点 meanError 应 >0.02，实际 ${report!.meanError}`);
    assert.equal(report!.ready, false);
  });
});
