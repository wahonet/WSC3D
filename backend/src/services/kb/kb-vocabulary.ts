/**
 * 旧 `/api/terms` 词表契约的兼容投影。
 *
 * 前端 TermPicker / 训练准入（no-terms 规则）依赖旧结构
 * `{ categories: VocabularyCategory[], terms: VocabularyTerm[] }`。
 * 知识库建立后由概念库投影生成：
 * - category = 知识库一级分类（terms 数组为该类概念规范名）
 * - term = 概念（id 直接用 conceptId → 旧标注选词即自然挂到概念上）
 *   altLabel = 该概念的其它词形，broader = [一级分类, 二级分类?]
 * 概念库为空时回退读旧 data/terms.json（loadVocabulary），平台冷启动不受影响。
 */

import type { VocabularyCategory, VocabularyTerm } from "../iiml.js";
import type { KbData } from "./kb-types.js";

export function projectVocabulary(kb: KbData): { categories: VocabularyCategory[]; terms: VocabularyTerm[] } {
  const topCategories = kb.categories.filter((c) => !c.parentId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const categories: VocabularyCategory[] = topCategories.map((category) => ({
    id: category.id,
    name: category.name,
    terms: kb.concepts.filter((c) => c.categoryId === category.id).map((c) => c.label)
  }));
  const terms: VocabularyTerm[] = kb.concepts.map((concept) => ({
    id: concept.id,
    prefLabel: concept.label,
    altLabel: kb.terms
      .filter((t) => t.conceptId === concept.id && t.form !== concept.label)
      .map((t) => t.form),
    scheme: "WSC3D-KB",
    broader: concept.subcategoryId ? [concept.categoryId, concept.subcategoryId] : [concept.categoryId]
  }));
  return { categories, terms };
}
