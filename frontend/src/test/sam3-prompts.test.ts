/**
 * sam3-prompts 纯函数测试
 *
 * 锁住中文概念词 → 英文 SAM3 提示词的映射。这是 App.tsx 抽出 sam3-prompts.ts
 * 后补的测试，确保扩充词典时映射规则不回退。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatSam3Error, sam3PromptCandidates, uniqueSam3Prompts } from "../modules/annotation/sam3-prompts";

describe("uniqueSam3Prompts", () => {
  it("去重 + trim + 大小写无关", () => {
    assert.deepEqual(uniqueSam3Prompts(["Horse", " horse ", "HORSE", "bird"]), ["Horse", "bird"]);
  });
  it("丢空串", () => {
    assert.deepEqual(uniqueSam3Prompts(["", "  ", "figure"]), ["figure"]);
  });
});

describe("sam3PromptCandidates", () => {
  it("人物 → human figure 同义词扩展", () => {
    const out = sam3PromptCandidates("人物");
    assert.ok(out[0] === "人物");
    assert.ok(out.includes("human figure"));
    assert.ok(out.includes("figure"));
  });

  it("马 → horse + animal", () => {
    const out = sam3PromptCandidates("马");
    assert.ok(out.includes("horse"));
    assert.ok(out.includes("animal"));
  });

  it("英文 horse 也命中", () => {
    const out = sam3PromptCandidates("horse");
    assert.ok(out.includes("horse"));
    assert.ok(out.includes("horse figure"));
  });

  it("最多 6 个候选", () => {
    const out = sam3PromptCandidates("骑");
    assert.ok(out.length <= 6);
  });

  it("未知概念 → 仅原词", () => {
    assert.deepEqual(sam3PromptCandidates("xyz未知"), ["xyz未知"]);
  });
});

describe("formatSam3Error", () => {
  it("gated 权重错误 → 中文处置建议", () => {
    const msg = formatSam3Error("sam3-unavailable", "LocalEntryNotFoundError: ... facebook/sam3 ...");
    assert.ok(msg.includes("SAM3 权重尚未就绪"));
    assert.ok(msg.includes("sam3.pt"));
  });

  it("超时错误 → 代理/镜像建议", () => {
    const msg = formatSam3Error("sam3-unavailable", "WinError 10060 timed out");
    assert.ok(msg.includes("超时"));
  });

  it("其它错误 → 原文", () => {
    const msg = formatSam3Error("some-error", "detail-here");
    assert.ok(msg.includes("some-error"));
  });

  it("空 → 默认提示", () => {
    assert.ok(formatSam3Error().includes("SAM3"));
  });
});
