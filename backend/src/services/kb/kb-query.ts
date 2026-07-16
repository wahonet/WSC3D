/**
 * 知识库查询服务：混合检索、共现派生、字面证据匹配、概念详情、子图。
 *
 * 全部是对 KbData 快照的纯函数计算（无 IO），路由层先 loadKb 再调用；
 * 人工录入规模（千级）下逐条扫描完全够用，不引入索引。
 */

import type {
  KbConcept,
  KbData,
  KbRelation,
  KbSegment,
  KbTerm
} from "./kb-types.js";

// ---------- 混合检索 ----------

export type KbSearchResult =
  | { type: "concept"; id: string; label: string; categoryId: string; subcategoryId?: string; termCount: number; segmentCount: number }
  | { type: "term"; id: string; form: string; conceptId: string; conceptLabel: string }
  | { type: "segment"; id: string; sourceTitle: string; page?: string; snippet: string; mentionCount: number }
  | { type: "source"; id: string; title: string; year?: string; segmentCount: number };

function groupTermsByConcept(terms: KbTerm[]): Map<string, KbTerm[]> {
  const map = new Map<string, KbTerm[]>();
  for (const term of terms) {
    const list = map.get(term.conceptId);
    if (list) list.push(term);
    else map.set(term.conceptId, [term]);
  }
  return map;
}

function countSegmentsByConcept(segments: KbSegment[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const segment of segments) {
    for (const mention of segment.mentions) {
      map.set(mention.conceptId, (map.get(mention.conceptId) ?? 0) + 1);
    }
  }
  return map;
}

export function searchKb(kb: KbData, query: string, categoryId?: string, limit = 60): KbSearchResult[] {
  const q = query.trim().toLowerCase();
  const results: KbSearchResult[] = [];
  const conceptById = new Map(kb.concepts.map((c) => [c.id, c]));
  const termsByConcept = groupTermsByConcept(kb.terms);
  const segmentCountByConcept = countSegmentsByConcept(kb.segments);

  const conceptInCategory = (concept: KbConcept) =>
    !categoryId || concept.categoryId === categoryId || concept.subcategoryId === categoryId;

  for (const concept of kb.concepts) {
    if (!conceptInCategory(concept)) continue;
    if (q && !concept.label.toLowerCase().includes(q) && !(concept.description ?? "").toLowerCase().includes(q)) continue;
    results.push({
      type: "concept",
      id: concept.id,
      label: concept.label,
      categoryId: concept.categoryId,
      subcategoryId: concept.subcategoryId,
      termCount: termsByConcept.get(concept.id)?.length ?? 0,
      segmentCount: segmentCountByConcept.get(concept.id) ?? 0
    });
    if (results.length >= limit) return results;
  }

  if (q) {
    for (const term of kb.terms) {
      const concept = conceptById.get(term.conceptId);
      if (!concept || !conceptInCategory(concept)) continue;
      // 与概念规范名同形的首选词形不重复出现
      if (term.form === concept.label) continue;
      if (!term.form.toLowerCase().includes(q)) continue;
      results.push({ type: "term", id: term.id, form: term.form, conceptId: term.conceptId, conceptLabel: concept.label });
      if (results.length >= limit) return results;
    }

    const sourceById = new Map(kb.sources.map((s) => [s.id, s]));
    for (const segment of kb.segments) {
      const inText = segment.text.toLowerCase().includes(q);
      const source = sourceById.get(segment.sourceId);
      const inSource = (source?.title ?? "").toLowerCase().includes(q);
      if (!inText && !inSource) continue;
      if (categoryId && !segment.mentions.some((m) => conceptInCategory(conceptById.get(m.conceptId) ?? ({} as KbConcept)))) {
        continue;
      }
      results.push({
        type: "segment",
        id: segment.id,
        sourceTitle: source?.title ?? "（未知文献）",
        page: segment.page,
        snippet: makeSnippet(segment.text, q),
        mentionCount: segment.mentions.length
      });
      if (results.length >= limit) return results;
    }

    for (const source of kb.sources) {
      if (!source.title.toLowerCase().includes(q)) continue;
      results.push({
        type: "source",
        id: source.id,
        title: source.title,
        year: source.year,
        segmentCount: kb.segments.filter((s) => s.sourceId === source.id).length
      });
      if (results.length >= limit) return results;
    }
  }

  return results;
}

function makeSnippet(text: string, q: string, radius = 40): string {
  const index = text.toLowerCase().indexOf(q);
  if (index < 0) return text.slice(0, radius * 2) + (text.length > radius * 2 ? "…" : "");
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + q.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

// ---------- 共现派生 ----------

export type CooccurrenceEdge = {
  aConceptId: string;
  bConceptId: string;
  weight: number;
  segmentIds: string[];
};

/** 同一文段共同提及 → 共现边（无向，a<b 规范化去重） */
export function deriveCooccurrence(segments: KbSegment[], focusConceptId?: string): CooccurrenceEdge[] {
  const edgeMap = new Map<string, CooccurrenceEdge>();
  for (const segment of segments) {
    const ids = [...new Set(segment.mentions.map((m) => m.conceptId))].sort();
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i];
        const b = ids[j];
        if (focusConceptId && a !== focusConceptId && b !== focusConceptId) continue;
        const key = `${a}|${b}`;
        const existing = edgeMap.get(key);
        if (existing) {
          existing.weight += 1;
          existing.segmentIds.push(segment.id);
        } else {
          edgeMap.set(key, { aConceptId: a, bConceptId: b, weight: 1, segmentIds: [segment.id] });
        }
      }
    }
  }
  return [...edgeMap.values()].sort((x, y) => y.weight - x.weight);
}

// ---------- 字面证据匹配 ----------

export type EvidenceSuggestion = {
  segmentId: string;
  sourceTitle: string;
  page?: string;
  matchedForm: string;
  snippet: string;
  /** 已在该文段的 mentions 里登记过该概念 */
  alreadyMentioned: boolean;
  status: "auto_text_match_unconfirmed";
  prov: "auto_exact_term_text_match";
};

/** 给定概念：扫描全部文段原文，任一词形字面命中 → 证据建议 */
export function suggestEvidenceForConcept(kb: KbData, conceptId: string): EvidenceSuggestion[] {
  const forms = kb.terms.filter((t) => t.conceptId === conceptId).map((t) => t.form);
  const concept = kb.concepts.find((c) => c.id === conceptId);
  if (concept && !forms.includes(concept.label)) forms.push(concept.label);
  if (forms.length === 0) return [];
  const sourceById = new Map(kb.sources.map((s) => [s.id, s]));
  const suggestions: EvidenceSuggestion[] = [];
  for (const segment of kb.segments) {
    const matched = forms.find((form) => form && segment.text.includes(form));
    if (!matched) continue;
    suggestions.push({
      segmentId: segment.id,
      sourceTitle: sourceById.get(segment.sourceId)?.title ?? "（未知文献）",
      page: segment.page,
      matchedForm: matched,
      snippet: makeSnippet(segment.text, matched.toLowerCase(), 30),
      alreadyMentioned: segment.mentions.some((m) => m.conceptId === conceptId),
      status: "auto_text_match_unconfirmed",
      prov: "auto_exact_term_text_match"
    });
  }
  return suggestions;
}

export type MentionSuggestion = {
  conceptId: string;
  label: string;
  matchedForm: string;
};

/** 给定文段原文：找出词形字面命中的概念（录入文段时预标提及） */
export function suggestMentionsForText(kb: KbData, text: string): MentionSuggestion[] {
  const conceptById = new Map(kb.concepts.map((c) => [c.id, c]));
  const byConcept = new Map<string, MentionSuggestion>();
  const consider = (conceptId: string, form: string) => {
    if (!form || !text.includes(form)) return;
    const concept = conceptById.get(conceptId);
    if (!concept) return;
    const existing = byConcept.get(conceptId);
    // 命中多个词形时保留更长的（更具体）
    if (!existing || form.length > existing.matchedForm.length) {
      byConcept.set(conceptId, { conceptId, label: concept.label, matchedForm: form });
    }
  };
  for (const term of kb.terms) consider(term.conceptId, term.form);
  for (const concept of kb.concepts) consider(concept.id, concept.label);
  return [...byConcept.values()].sort((a, b) => b.matchedForm.length - a.matchedForm.length);
}

// ---------- 概念详情 ----------

export type ConceptDetail = {
  concept: KbConcept;
  categoryName: string;
  subcategoryName?: string;
  terms: KbTerm[];
  /** 语义关系（双向），带对端概念名 */
  relations: Array<KbRelation & { direction: "out" | "in"; otherConceptId: string; otherLabel: string }>;
  cooccurrence: Array<{ conceptId: string; label: string; weight: number; segmentIds: string[] }>;
  /** 提及该概念的文段 */
  segments: Array<{ id: string; sourceTitle: string; page?: string; text: string }>;
  /** 来源分布：文献 × 文段数 */
  sourceDistribution: Array<{ sourceId: string; title: string; count: number }>;
};

export function buildConceptDetail(kb: KbData, conceptId: string): ConceptDetail | undefined {
  const concept = kb.concepts.find((c) => c.id === conceptId);
  if (!concept) return undefined;
  const categoryName = kb.categories.find((c) => c.id === concept.categoryId)?.name ?? concept.categoryId;
  const subcategoryName = concept.subcategoryId
    ? kb.categories.find((c) => c.id === concept.subcategoryId)?.name
    : undefined;
  const conceptById = new Map(kb.concepts.map((c) => [c.id, c]));
  const sourceById = new Map(kb.sources.map((s) => [s.id, s]));

  const relations = kb.relations
    .filter((r) => r.sourceConceptId === conceptId || r.targetConceptId === conceptId)
    .map((r) => {
      const direction: "out" | "in" = r.sourceConceptId === conceptId ? "out" : "in";
      const otherConceptId = direction === "out" ? r.targetConceptId : r.sourceConceptId;
      return { ...r, direction, otherConceptId, otherLabel: conceptById.get(otherConceptId)?.label ?? otherConceptId };
    });

  const cooccurrence = deriveCooccurrence(kb.segments, conceptId).map((edge) => {
    const otherId = edge.aConceptId === conceptId ? edge.bConceptId : edge.aConceptId;
    return {
      conceptId: otherId,
      label: conceptById.get(otherId)?.label ?? otherId,
      weight: edge.weight,
      segmentIds: edge.segmentIds
    };
  });

  const mentioning = kb.segments.filter((s) => s.mentions.some((m) => m.conceptId === conceptId));
  const segments = mentioning.map((s) => ({
    id: s.id,
    sourceTitle: sourceById.get(s.sourceId)?.title ?? "（未知文献）",
    page: s.page,
    text: s.text
  }));

  const distribution = new Map<string, number>();
  for (const s of mentioning) {
    distribution.set(s.sourceId, (distribution.get(s.sourceId) ?? 0) + 1);
  }
  const sourceDistribution = [...distribution.entries()]
    .map(([sourceId, count]) => ({ sourceId, title: sourceById.get(sourceId)?.title ?? sourceId, count }))
    .sort((a, b) => b.count - a.count);

  return {
    concept,
    categoryName,
    subcategoryName,
    terms: kb.terms.filter((t) => t.conceptId === conceptId),
    relations,
    cooccurrence,
    segments,
    sourceDistribution
  };
}

// ---------- 子图 ----------

export type KbGraphNode = {
  id: string;
  kind: "concept" | "term" | "segment" | "source" | "category";
  label: string;
  categoryId?: string;
};

export type KbGraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: string;
  weight?: number;
  confidence?: string;
  method?: string;
};

export type KbGraph = { nodes: KbGraphNode[]; edges: KbGraphEdge[] };

/** 选中概念的局部图：Concept–Term–Segment–Source 星型 + 语义关系与共现邻居 */
export function buildLocalGraph(kb: KbData, conceptId: string): KbGraph {
  const detail = buildConceptDetail(kb, conceptId);
  if (!detail) return { nodes: [], edges: [] };
  const nodes = new Map<string, KbGraphNode>();
  const edges: KbGraphEdge[] = [];
  const addNode = (node: KbGraphNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };

  const center = detail.concept;
  addNode({ id: center.id, kind: "concept", label: center.label, categoryId: center.categoryId });

  const category = kb.categories.find((c) => c.id === center.categoryId);
  if (category) {
    addNode({ id: category.id, kind: "category", label: category.name });
    edges.push({ id: `isa-${center.id}`, source: center.id, target: category.id, kind: "IN_CATEGORY" });
  }

  for (const term of detail.terms) {
    if (term.form === center.label) continue;
    addNode({ id: term.id, kind: "term", label: term.form });
    edges.push({ id: `lex-${term.id}`, source: term.id, target: center.id, kind: "LEXICAL_FORM_OF" });
  }

  const sourceIds = new Set<string>();
  for (const segment of detail.segments.slice(0, 12)) {
    addNode({ id: segment.id, kind: "segment", label: segmentLabel(kb, segment.id) });
    edges.push({ id: `mention-${segment.id}-${center.id}`, source: segment.id, target: center.id, kind: "MENTIONS" });
    const raw = kb.segments.find((s) => s.id === segment.id);
    if (raw) sourceIds.add(raw.sourceId);
  }
  for (const sourceId of sourceIds) {
    const source = kb.sources.find((s) => s.id === sourceId);
    if (!source) continue;
    addNode({ id: source.id, kind: "source", label: source.year ? `${source.title}, ${source.year}` : source.title });
    for (const segment of kb.segments.filter((s) => s.sourceId === sourceId)) {
      if (nodes.has(segment.id)) {
        edges.push({ id: `extract-${segment.id}`, source: segment.id, target: source.id, kind: "EXTRACT_FROM" });
      }
    }
  }

  for (const relation of detail.relations) {
    const other = kb.concepts.find((c) => c.id === relation.otherConceptId);
    if (!other) continue;
    addNode({ id: other.id, kind: "concept", label: other.label, categoryId: other.categoryId });
    edges.push({
      id: relation.id,
      source: relation.direction === "out" ? center.id : other.id,
      target: relation.direction === "out" ? other.id : center.id,
      kind: relation.kind,
      confidence: relation.confidence,
      method: relation.method
    });
  }

  for (const edge of detail.cooccurrence.slice(0, 15)) {
    const other = kb.concepts.find((c) => c.id === edge.conceptId);
    if (!other) continue;
    addNode({ id: other.id, kind: "concept", label: other.label, categoryId: other.categoryId });
    edges.push({
      id: `cooc-${center.id}-${other.id}`,
      source: center.id,
      target: other.id,
      kind: "CO_OCCURS_IN_SEGMENT",
      weight: edge.weight,
      method: "auto"
    });
  }

  return { nodes: [...nodes.values()], edges };
}

/** 总览图：分类 hub + 概念叶（概念多时前端自行做聚合/裁剪） */
export function buildOverviewGraph(kb: KbData): KbGraph {
  const nodes: KbGraphNode[] = [];
  const edges: KbGraphEdge[] = [];
  for (const category of kb.categories.filter((c) => !c.parentId)) {
    nodes.push({ id: category.id, kind: "category", label: category.name });
  }
  for (const category of kb.categories.filter((c) => c.parentId)) {
    nodes.push({ id: category.id, kind: "category", label: category.name, categoryId: category.parentId });
    edges.push({ id: `cat-${category.id}`, source: category.id, target: category.parentId as string, kind: "SUBCATEGORY_OF" });
  }
  for (const concept of kb.concepts) {
    nodes.push({ id: concept.id, kind: "concept", label: concept.label, categoryId: concept.categoryId });
    const parent = concept.subcategoryId ?? concept.categoryId;
    edges.push({ id: `in-${concept.id}`, source: concept.id, target: parent, kind: "IN_CATEGORY" });
  }
  return { nodes, edges };
}

function segmentLabel(kb: KbData, segmentId: string): string {
  const segment = kb.segments.find((s) => s.id === segmentId);
  if (!segment) return segmentId;
  const source = kb.sources.find((s) => s.id === segment.sourceId);
  const prefix = source?.title?.slice(0, 8) ?? "文段";
  return segment.page ? `${prefix}·${segment.page}` : `${prefix}·${segment.id.slice(-4)}`;
}
