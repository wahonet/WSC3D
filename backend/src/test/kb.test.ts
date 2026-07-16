/**
 * 知识库（KB）单元测试
 *
 * 覆盖：
 * - kb-store：概念/词形/文献/文段/关系 CRUD、引用完整性、级联删除
 * - kb-query：混合检索、共现派生、字面证据匹配、文段预标建议
 * - kb-vocabulary：旧 /api/terms 词表投影契约（TermPicker 依赖）
 *
 * 全部在临时目录跑（projectRoot = tmpdir），不碰真实 data/。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createConcept,
  createRelation,
  createSegment,
  createSource,
  createTerm,
  deleteConcept,
  deleteTerm,
  loadKb,
  saveCategories,
  updateSegment
} from "../services/kb/kb-store.js";
import {
  deriveCooccurrence,
  searchKb,
  suggestEvidenceForConcept,
  suggestMentionsForText
} from "../services/kb/kb-query.js";
import { projectVocabulary } from "../services/kb/kb-vocabulary.js";

let root: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "wsc3d-kb-"));
  await saveCategories(root, [
    { id: "cat-person", name: "人", order: 0 },
    { id: "cat-person-figure", name: "具体人物", parentId: "cat-person", order: 0 },
    { id: "cat-story", name: "故事、典故与图像题材", order: 1 },
    { id: "cat-story-assassin", name: "刺客故事", parentId: "cat-story", order: 0 }
  ]);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("kb-store — CRUD 与引用完整性", () => {
  it("创建概念时自动登记首选词形；重名拒绝", async () => {
    const concept = await createConcept(root, {
      label: "丁兰",
      categoryId: "cat-person",
      subcategoryId: "cat-person-figure"
    });
    assert.equal(concept.conceptType, "entity");
    const kb = await loadKb(root);
    assert.equal(kb.terms.filter((t) => t.conceptId === concept.id && t.form === "丁兰").length, 1);
    await assert.rejects(
      () => createConcept(root, { label: "丁兰", categoryId: "cat-person" }),
      /concept_label_exists/
    );
  });

  it("分类必须存在且二级分类必须挂在指定一级下", async () => {
    await assert.rejects(
      () => createConcept(root, { label: "无效类", categoryId: "cat-none" }),
      /category_not_found/
    );
    await assert.rejects(
      () => createConcept(root, { label: "错挂", categoryId: "cat-person", subcategoryId: "cat-story-assassin" }),
      /subcategory_not_found/
    );
  });

  it("词形归一：异体词挂到同一概念；最后一个词形不可删", async () => {
    const kb = await loadKb(root);
    const dinglan = kb.concepts.find((c) => c.label === "丁兰")!;
    const variant = await createTerm(root, { form: "丁蘭", conceptId: dinglan.id, script: "traditional" });
    assert.equal(variant.conceptId, dinglan.id);
    await deleteTerm(root, variant.id);
    const primary = (await loadKb(root)).terms.find((t) => t.conceptId === dinglan.id)!;
    await assert.rejects(() => deleteTerm(root, primary.id), /cannot_delete_last_term/);
    // 复原异体词供后续用例使用
    await createTerm(root, { form: "丁蘭", conceptId: dinglan.id, script: "traditional" });
  });

  it("文段：来源必须存在，提及概念必须存在且去重", async () => {
    await assert.rejects(
      () => createSegment(root, { sourceId: "src-none", text: "文字" }),
      /source_not_found/
    );
    const source = await createSource(root, { title: "中国汉画像石全集第1卷", year: "2000" });
    const kb = await loadKb(root);
    const dinglan = kb.concepts.find((c) => c.label === "丁兰")!;
    const segment = await createSegment(root, {
      sourceId: source.id,
      page: "99",
      text: "木像左上端一列，曰：丁兰二亲终殁，立木为父。",
      mentions: [{ conceptId: dinglan.id }, { conceptId: dinglan.id }]
    });
    assert.equal(segment.mentions.length, 1);
    await assert.rejects(
      () =>
        updateSegment(root, segment.id, {
          mentions: [{ conceptId: "concept-none" }]
        }),
      /mention_concept_not_found/
    );
  });

  it("关系：自环与重复拒绝；删除概念级联清理词形/关系/提及", async () => {
    const story = await createConcept(root, {
      label: "丁兰刻木",
      categoryId: "cat-story",
      subcategoryId: "cat-story-assassin",
      conceptType: "theme_or_story"
    });
    const kb1 = await loadKb(root);
    const dinglan = kb1.concepts.find((c) => c.label === "丁兰")!;
    await assert.rejects(
      () => createRelation(root, { kind: "ISA", sourceConceptId: story.id, targetConceptId: story.id }),
      /relation_self_loop/
    );
    await createRelation(root, {
      kind: "HAS_PARTICIPANT",
      sourceConceptId: story.id,
      targetConceptId: dinglan.id,
      confidence: "high"
    });
    await assert.rejects(
      () => createRelation(root, { kind: "HAS_PARTICIPANT", sourceConceptId: story.id, targetConceptId: dinglan.id }),
      /relation_exists/
    );

    // 把故事概念也提及进文段，删除后应从 mentions/relations/terms 全部消失
    const seg = (await loadKb(root)).segments[0];
    await updateSegment(root, seg.id, {
      mentions: [{ conceptId: dinglan.id }, { conceptId: story.id }]
    });
    await deleteConcept(root, story.id);
    const kb2 = await loadKb(root);
    assert.equal(kb2.concepts.some((c) => c.id === story.id), false);
    assert.equal(kb2.terms.some((t) => t.conceptId === story.id), false);
    assert.equal(kb2.relations.some((r) => r.sourceConceptId === story.id || r.targetConceptId === story.id), false);
    assert.equal(kb2.segments.some((s) => s.mentions.some((m) => m.conceptId === story.id)), false);
  });
});

describe("kb-query — 检索 / 共现 / 证据匹配", () => {
  it("混合检索：概念命中 + 异体词形命中 + 文段原文命中", async () => {
    const kb = await loadKb(root);
    const byLabel = searchKb(kb, "丁兰");
    assert.ok(byLabel.some((r) => r.type === "concept"));
    const byVariant = searchKb(kb, "丁蘭");
    assert.ok(byVariant.some((r) => r.type === "term"));
    const byText = searchKb(kb, "立木为父");
    assert.ok(byText.some((r) => r.type === "segment"));
  });

  it("共现派生：同一文段两个提及 → 一条无向边", async () => {
    const source = (await loadKb(root)).sources[0];
    const yuzhe = await createConcept(root, { label: "御者", categoryId: "cat-person", subcategoryId: "cat-person-figure" });
    const kb1 = await loadKb(root);
    const dinglan = kb1.concepts.find((c) => c.label === "丁兰")!;
    await createSegment(root, {
      sourceId: source.id,
      text: "画面左侧为御者执辔，右侧丁兰立木。",
      mentions: [{ conceptId: yuzhe.id }, { conceptId: dinglan.id }]
    });
    const kb2 = await loadKb(root);
    const edges = deriveCooccurrence(kb2.segments);
    const edge = edges.find(
      (e) =>
        (e.aConceptId === yuzhe.id && e.bConceptId === dinglan.id) ||
        (e.aConceptId === dinglan.id && e.bConceptId === yuzhe.id)
    );
    assert.ok(edge);
    assert.equal(edge!.weight, 1);
  });

  it("证据字面匹配：任一词形命中文段原文 → auto_text_match_unconfirmed 建议", async () => {
    const kb = await loadKb(root);
    const dinglan = kb.concepts.find((c) => c.label === "丁兰")!;
    const suggestions = suggestEvidenceForConcept(kb, dinglan.id);
    assert.ok(suggestions.length >= 2);
    assert.equal(suggestions[0].status, "auto_text_match_unconfirmed");
    assert.ok(suggestions.every((s) => s.snippet.length > 0));
  });

  it("文段预标：文本里出现的词形反查概念（长词形优先）", async () => {
    const kb = await loadKb(root);
    const suggestions = suggestMentionsForText(kb, "此石刻丁蘭事，旁有御者一人。");
    const labels = suggestions.map((s) => s.label);
    assert.ok(labels.includes("丁兰"));
    assert.ok(labels.includes("御者"));
    const dinglanHit = suggestions.find((s) => s.label === "丁兰")!;
    assert.equal(dinglanHit.matchedForm, "丁蘭");
  });
});

describe("kb-vocabulary — 旧 /api/terms 投影契约", () => {
  it("category=一级分类；term.id=conceptId；altLabel=异体词形", async () => {
    const kb = await loadKb(root);
    const projected = projectVocabulary(kb);
    const person = projected.categories.find((c) => c.id === "cat-person");
    assert.ok(person);
    assert.ok(person!.terms.includes("丁兰"));
    const dinglanConcept = kb.concepts.find((c) => c.label === "丁兰")!;
    const term = projected.terms.find((t) => t.id === dinglanConcept.id);
    assert.ok(term);
    assert.equal(term!.prefLabel, "丁兰");
    assert.ok(term!.altLabel.includes("丁蘭"));
    assert.equal(term!.broader[0], "cat-person");
  });
});
