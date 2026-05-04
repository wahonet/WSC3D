/**
 * 受控术语共现推荐
 *
 * 当用户在 `TermPicker` 编辑某条标注时，根据已有标注里的 `terms` 共现频次给
 * 出"语义相邻"的候选术语，把传统的"先选词表、再人工筛选"提升为"输入即推荐"。
 *
 * 算法（最简单的"基于上下文的协同过滤推荐"）：
 * 1. 扫所有 `annotation.semantics.terms[].id`：对每对 `(a, b)` 同时出现则
 *    `counts[a][b] += 1`（对称）
 * 2. 给定当前 annotation 已有 `termIds = T`：
 *    `candidateScore[t] = sum_{a ∈ T} counts[a][t]   for t ∉ T`
 * 3. 按 score 降序取 top N
 *
 * 数据稀疏时（含 terms 的标注数 < 5）返回空数组，避免噪声推荐。
 *
 * 性能：O(M × K²)，M = 标注数，K = 平均术语数。在 M < 200, K < 10 时几毫秒级。
 */

import type { IimlAnnotation, VocabularyTerm } from "../../api/client";

export type CooccurrenceOptions = {
  topN: number;
  // 至少要有 N 个含 terms 的 annotation 才出推荐，少于此返回空
  minAnnotationSamples: number;
};

const defaults: CooccurrenceOptions = { topN: 5, minAnnotationSamples: 5 };

export function recommendCooccurringTerms(
  annotations: IimlAnnotation[],
  currentAnnotationTermIds: string[],
  vocabularyTerms: VocabularyTerm[],
  options: Partial<CooccurrenceOptions> = {}
): VocabularyTerm[] {
  const config = { ...defaults, ...options };

  // 收集所有 annotation 的 termIds 集合
  const allTermSets: string[][] = [];
  for (const annotation of annotations) {
    const termIds = annotation.semantics?.terms?.map((term) => term.id) ?? [];
    if (termIds.length === 0) continue;
    allTermSets.push(termIds);
  }
  if (allTermSets.length < config.minAnnotationSamples) {
    return [];
  }
  if (currentAnnotationTermIds.length === 0) {
    // 没有 seed 时，按"全局出现频次"推荐 top N
    const freq = new Map<string, number>();
    for (const set of allTermSets) {
      for (const id of set) {
        freq.set(id, (freq.get(id) ?? 0) + 1);
      }
    }
    return topByFreq(freq, vocabularyTerms, config.topN, new Set());
  }

  // 共现矩阵
  const cooc = new Map<string, Map<string, number>>();
  const ensure = (id: string) => {
    let row = cooc.get(id);
    if (!row) {
      row = new Map();
      cooc.set(id, row);
    }
    return row;
  };
  for (const set of allTermSets) {
    for (let i = 0; i < set.length; i += 1) {
      const a = set[i];
      const rowA = ensure(a);
      for (let j = i + 1; j < set.length; j += 1) {
        const b = set[j];
        rowA.set(b, (rowA.get(b) ?? 0) + 1);
        const rowB = ensure(b);
        rowB.set(a, (rowB.get(a) ?? 0) + 1);
      }
    }
  }

  const seedSet = new Set(currentAnnotationTermIds);
  const score = new Map<string, number>();
  for (const seed of currentAnnotationTermIds) {
    const row = cooc.get(seed);
    if (!row) continue;
    for (const [other, count] of row) {
      if (seedSet.has(other)) continue;
      score.set(other, (score.get(other) ?? 0) + count);
    }
  }

  return topByFreq(score, vocabularyTerms, config.topN, seedSet);
}

function topByFreq(
  freq: Map<string, number>,
  vocabulary: VocabularyTerm[],
  topN: number,
  exclude: Set<string>
): VocabularyTerm[] {
  if (freq.size === 0) return [];
  const vocabById = new Map(vocabulary.map((term) => [term.id, term]));
  return Array.from(freq.entries())
    .filter(([id]) => !exclude.has(id) && vocabById.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([id]) => vocabById.get(id)!);
}
