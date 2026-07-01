/**
 * import-md 链路 + COCO split 划分测试
 *
 * - `parseMarkdownMetadata`：锁住结构化档案 .md 的解析契约（import-md 修复后
 *   依赖它，parser 本身也可能对真实档案 stale，这里用合成 md 固定格式）
 * - `djb2Hash01` / `bucketForStoneId`：锁住 70/15/15 划分的**确定性 + 防泄漏**
 *   不变量（同一 stoneId 恒定映射到同一桶，是训练池不串集合的根基）
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseMarkdownMetadata } from "../parsers/markdownParser.js";
import { bucketForStoneId, djb2Hash01 } from "../services/training-export.js";

let workDir: string;

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "wsc3d-md-"));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("parseMarkdownMetadata — 结构化档案解析契约", () => {
  it("解析层级 / 尺寸 / 题名 / 来源", async () => {
    const filePath = path.join(workDir, "29东汉武氏祠左石室.md");
    await writeFile(
      filePath,
      [
        "# 29东汉武氏祠左石室后壁小龛西侧画像石",
        "",
        "**尺寸（厘米）**：高 110、宽 84、厚 16",
        "**尺寸说明**：高边稍残",
        "",
        "### 第一层：青龙",
        "**对应来源**：图录第 X 页",
        "",
        "描绘青龙升腾之状。",
        "",
        "### 第二层：白虎",
        "**对应来源**：图录第 Y 页",
        "",
        "描绘白虎奔走之状。"
      ].join("\n"),
      "utf8"
    );

    const meta = await parseMarkdownMetadata(filePath);
    assert.equal(meta.stone_id, "29");
    assert.equal(meta.name, "29东汉武氏祠左石室后壁小龛西侧画像石");
    assert.equal(meta.dimensions.height, 110);
    assert.equal(meta.dimensions.width, 84);
    assert.equal(meta.dimensions.thickness, 16);
    assert.equal(meta.dimension_note, "高边稍残");
    assert.equal(meta.layers.length, 2);
    assert.equal(meta.layers[0].title, "第一层：青龙");
    assert.equal(meta.layers[0].source, "图录第 X 页");
    assert.ok(meta.layers[0].content.includes("青龙"));
    assert.equal(meta.layers[1].title, "第二层：白虎");
  });

  it("无层级标题 → layers 为空（import-md 会据此抛 metadata_not_found，不再静默）", async () => {
    const filePath = path.join(workDir, "30无层级.md");
    await writeFile(filePath, "# 30某画像石\n\n只有简介，没有 ### 层级。\n", "utf8");
    const meta = await parseMarkdownMetadata(filePath);
    assert.equal(meta.layers.length, 0);
  });

  it("stone_id 从文件名数字前缀补 0", async () => {
    const filePath = path.join(workDir, "5某画像石.md");
    await writeFile(filePath, "# 5某画像石\n\n### 一层\n内容\n", "utf8");
    const meta = await parseMarkdownMetadata(filePath);
    assert.equal(meta.stone_id, "05");
  });
});

describe("djb2Hash01 — 确定性 + 值域", () => {
  it("结果落在 [0, 1)", () => {
    for (const s of ["01", "29", "asset-32", "stone-7-east", "abc", ""])
      assert.ok(djb2Hash01(s) >= 0 && djb2Hash01(s) < 1, `${s} -> ${djb2Hash01(s)}`);
  });

  it("同一输入恒定可重现", () => {
    assert.equal(djb2Hash01("29"), djb2Hash01("29"));
    assert.equal(djb2Hash01("asset-32"), djb2Hash01("asset-32"));
  });

  it("不同输入产生分布（不全部撞同一个桶）", () => {
    const ids = Array.from({ length: 50 }, (_, i) => String(i + 1).padStart(2, "0"));
    const buckets = new Set(ids.map((id) => bucketForStoneId(id)));
    // 50 个 stoneId 至少应覆盖 2 个桶（防止哈希退化导致全 train）
    assert.ok(buckets.size >= 2, `bucket 退化: ${[...buckets].join(",")}`);
  });
});

describe("bucketForStoneId — 防泄漏不变量", () => {
  it("同一 stoneId 恒定映射到同一桶", () => {
    for (const id of ["01", "29", "07", "asset-32"]) {
      const a = bucketForStoneId(id);
      const b = bucketForStoneId(id);
      assert.equal(a, b);
    }
  });

  it("阈值与哈希一致：<0.7 train、<0.85 val、其余 test", () => {
    for (const id of ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]) {
      const h = djb2Hash01(id);
      const bucket = bucketForStoneId(id);
      const expected = h < 0.7 ? "train" : h < 0.85 ? "val" : "test";
      assert.equal(bucket, expected, `id=${id} h=${h}`);
    }
  });

  it("返回值只能是三个桶之一", () => {
    for (const id of ["01", "29", "xyz", "99", "100"])
      assert.ok(["train", "val", "test"].includes(bucketForStoneId(id)));
  });
});
