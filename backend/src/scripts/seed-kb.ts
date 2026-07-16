/**
 * 一次性知识库种子脚本
 *
 * 对外命令：`npm run seed:kb`
 *
 * 做两件事（幂等，已有数据时跳过对应部分，`--force` 覆盖分类树）：
 * 1. 写入参照"汉画术语概念知识图谱"的两级分类树（11 个一级类目 + 二级分类）
 * 2. 把旧 `data/terms.json`（5 类 30 词）迁移为概念 + 首选词形
 *
 * 分类树是"种子"而非"锁死"——后续可通过 API / 直接编辑 categories.json 调整。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadKb, saveCategories, createConcept } from "../services/kb/kb-store.js";
import type { KbCategory, KbConceptType } from "../services/kb/kb-types.js";

const rootDir = process.env.WSC3D_ROOT ? path.resolve(process.env.WSC3D_ROOT) : process.cwd();
const force = process.argv.includes("--force");

// ---------- 两级分类树（参照系统类目） ----------

type SeedCategory = { id: string; name: string; children?: Array<{ id: string; name: string }> };

const SEED_TREE: SeedCategory[] = [
  {
    id: "cat-person",
    name: "人",
    children: [
      { id: "cat-person-figure", name: "具体人物" },
      { id: "cat-person-role", name: "社会身份" },
      { id: "cat-person-body", name: "身体与形态" },
      { id: "cat-person-kinship", name: "亲属称谓" }
    ]
  },
  {
    id: "cat-nature",
    name: "天然",
    children: [
      { id: "cat-nature-animal", name: "动物" },
      { id: "cat-nature-plant", name: "植物" },
      { id: "cat-nature-sky", name: "天象与气象" },
      { id: "cat-nature-terrain", name: "山川地物" }
    ]
  },
  {
    id: "cat-artifact",
    name: "人造",
    children: [
      { id: "cat-artifact-weapon", name: "兵器武备" },
      { id: "cat-artifact-vehicle", name: "车与舟船" },
      { id: "cat-artifact-architecture", name: "建筑与构件" },
      { id: "cat-artifact-furniture", name: "家具陈设" },
      { id: "cat-artifact-daily", name: "日常用品" },
      { id: "cat-artifact-clothing", name: "服饰冠带" },
      { id: "cat-artifact-tool", name: "生产工具" },
      { id: "cat-artifact-ritual", name: "礼仪器物" },
      { id: "cat-artifact-other", name: "其他人造物" }
    ]
  },
  {
    id: "cat-imagination",
    name: "想象",
    children: [
      { id: "cat-imagination-deity", name: "神祇仙人" },
      { id: "cat-imagination-beast", name: "神兽瑞兽" },
      { id: "cat-imagination-realm", name: "仙境异域" },
      { id: "cat-imagination-other", name: "其他想象" }
    ]
  },
  {
    id: "cat-pattern",
    name: "纹样",
    children: [
      { id: "cat-pattern-geometric", name: "几何纹样" },
      { id: "cat-pattern-cloud", name: "云气纹样" },
      { id: "cat-pattern-biotic", name: "动植物纹样" },
      { id: "cat-pattern-other", name: "其他纹样" }
    ]
  },
  {
    id: "cat-story",
    name: "故事、典故与图像题材",
    children: [
      { id: "cat-story-assassin", name: "刺客故事" },
      { id: "cat-story-filial", name: "孝子故事" },
      { id: "cat-story-women", name: "列女故事" },
      { id: "cat-story-ruler", name: "帝王圣贤" },
      { id: "cat-story-loyal", name: "忠臣义士" },
      { id: "cat-story-theme", name: "图像主题" },
      { id: "cat-story-other", name: "其他故事" }
    ]
  },
  {
    id: "cat-inscription",
    name: "题刻",
    children: [
      { id: "cat-inscription-bangti", name: "榜题" },
      { id: "cat-inscription-jinian", name: "纪年题记" },
      { id: "cat-inscription-songming", name: "颂铭" },
      { id: "cat-inscription-other", name: "其他题刻" }
    ]
  },
  {
    id: "cat-morphology",
    name: "形态特征",
    children: [
      { id: "cat-morphology-whole", name: "整体形态" },
      { id: "cat-morphology-part", name: "局部形态" },
      { id: "cat-morphology-appearance", name: "外观特征" },
      { id: "cat-morphology-expression", name: "表达形式" },
      { id: "cat-morphology-appendage", name: "附加形态" }
    ]
  },
  {
    id: "cat-behavior",
    name: "行为",
    children: [
      { id: "cat-behavior-ritual", name: "仪式行为" },
      { id: "cat-behavior-travel", name: "出行行为" },
      { id: "cat-behavior-combat", name: "战斗行为" },
      { id: "cat-behavior-labor", name: "劳作行为" },
      { id: "cat-behavior-daily", name: "日常行为" }
    ]
  },
  {
    id: "cat-relation",
    name: "人物间关系",
    children: [
      { id: "cat-relation-kinship", name: "亲属关系" },
      { id: "cat-relation-social", name: "君臣宾主" },
      { id: "cat-relation-other", name: "其他关系" }
    ]
  },
  { id: "cat-composite", name: "复合要素", children: [{ id: "cat-composite-expression", name: "复合表达" }] }
];

// ---------- 旧 terms.json → 概念库映射 ----------

const LEGACY_CATEGORY_MAP: Record<string, { categoryId: string; subcategoryId?: string; conceptType: KbConceptType }> = {
  person: { categoryId: "cat-person", subcategoryId: "cat-person-figure", conceptType: "entity" },
  animal: { categoryId: "cat-nature", subcategoryId: "cat-nature-animal", conceptType: "entity" },
  object: { categoryId: "cat-artifact", conceptType: "entity" },
  scene: { categoryId: "cat-story", subcategoryId: "cat-story-theme", conceptType: "theme_or_story" },
  pattern: { categoryId: "cat-pattern", conceptType: "entity" }
};

// 旧词表里明显属于"想象"的词，比机械按旧分类映射更贴近参照系统的树
const IMAGINATION_OVERRIDES = new Set(["西王母", "东王公", "羽人", "龙", "凤", "朱雀", "玄武", "白虎", "青龙"]);

async function main(): Promise<void> {
  const kb = await loadKb(rootDir);

  if (kb.categories.length === 0 || force) {
    const categories: KbCategory[] = [];
    SEED_TREE.forEach((top, index) => {
      categories.push({ id: top.id, name: top.name, order: index });
      top.children?.forEach((child, childIndex) => {
        categories.push({ id: child.id, name: child.name, parentId: top.id, order: childIndex });
      });
    });
    await saveCategories(rootDir, categories);
    console.log(`[seed-kb] 写入分类树：${SEED_TREE.length} 个一级类目 / ${categories.length - SEED_TREE.length} 个二级分类`);
  } else {
    console.log(`[seed-kb] 分类树已存在（${kb.categories.length} 条），跳过（--force 可覆盖）`);
  }

  if (kb.concepts.length > 0) {
    console.log(`[seed-kb] 概念库已有 ${kb.concepts.length} 个概念，跳过旧词表迁移`);
    return;
  }

  let legacy: { categories?: Array<{ id: string; name: string; terms: string[] }> };
  try {
    legacy = JSON.parse(await readFile(path.join(rootDir, "data", "terms.json"), "utf8"));
  } catch {
    console.log("[seed-kb] 未找到旧 data/terms.json，跳过迁移");
    return;
  }

  let migrated = 0;
  for (const category of legacy.categories ?? []) {
    const mapping = LEGACY_CATEGORY_MAP[category.id];
    if (!mapping) continue;
    for (const label of category.terms) {
      const target = IMAGINATION_OVERRIDES.has(label)
        ? {
            categoryId: "cat-imagination",
            subcategoryId: category.id === "person" ? "cat-imagination-deity" : "cat-imagination-beast",
            conceptType: "entity" as KbConceptType
          }
        : mapping;
      try {
        await createConcept(rootDir, {
          label,
          categoryId: target.categoryId,
          subcategoryId: target.subcategoryId,
          conceptType: target.conceptType
        });
        migrated += 1;
      } catch (error) {
        console.warn(`[seed-kb] 迁移 "${label}" 失败：${(error as Error).message}`);
      }
    }
  }
  console.log(`[seed-kb] 旧词表迁移完成：${migrated} 个概念（含首选词形）`);
}

await main();
