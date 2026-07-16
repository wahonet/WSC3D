/**
 * 全局知识库（Knowledge Base）数据模型。
 *
 * 参照"汉画术语概念知识图谱"系统的四元链：
 *   Source（文献）→ Segment（文段，带出处/页码/原文）
 *   Term（术语词形，异体归一）→ Concept（概念，挂两级分类树）
 * 概念间语义关系（KbRelation）带溯源：kind / confidence / method / 证据文段。
 * 共现关系 CO_OCCURS_IN_SEGMENT 不落盘，由 segment.mentions 派生（kb-cooccurrence）。
 *
 * 与单石 IIML 文档的关系：annotation.conceptRef 指向 KbConcept.id，
 * annotation.claim.evidence[].segmentId 指向 KbSegment.id（Phase 4）。
 */

export type KbCategory = {
  id: string;
  name: string;
  /** 二级分类通过 parentId 指向一级分类；一级分类无 parentId */
  parentId?: string;
  order?: number;
  description?: string;
};

export type KbConceptType = "entity" | "theme_or_story" | "behavior" | "relation" | "attribute" | "other";

export type KbConcept = {
  id: string;
  /** 规范名（首选词形） */
  label: string;
  /** 一级分类 id */
  categoryId: string;
  /** 二级分类 id（可选） */
  subcategoryId?: string;
  conceptType: KbConceptType;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type KbTerm = {
  id: string;
  /** 词形本体，如 丁蘭 / 丁兰刻木 */
  form: string;
  /** 归一到的概念 */
  conceptId: string;
  /** 简体 / 繁体 / 异写；不填视作未区分 */
  script?: "simplified" | "traditional" | "variant";
  note?: string;
  createdAt: string;
};

export type KbSource = {
  id: string;
  title: string;
  year?: string;
  author?: string;
  /** 图录 / 论著 / 报告 / 其他 */
  type?: string;
  note?: string;
  createdAt: string;
};

export type KbMention = {
  conceptId: string;
  /** 命中的字面词形（自动预标时记录；人工添加可空） */
  matchedForm?: string;
  /** true = 字面匹配自动预标；false/缺省 = 人工确认 */
  auto?: boolean;
};

export type KbSegment = {
  id: string;
  sourceId: string;
  /** 页码或图版号，自由文本 */
  page?: string;
  /** 更细的位置说明（如"第 3 层右起第 2 幅"） */
  locator?: string;
  /** 文段原文全文 */
  text: string;
  /** 提及的概念（含自动预标 + 人工确认） */
  mentions: KbMention[];
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export const KB_RELATION_KINDS = [
  "ISA",
  "HAS_PARTICIPANT",
  "USES_OBJECT",
  "HAS_MORPHOLOGY_FEATURE",
  "PART_OF",
  "DEPICTS",
  "ASSOCIATED_WITH"
] as const;

export type KbRelationKind = (typeof KB_RELATION_KINDS)[number];

export type KbConfidence = "high" | "medium" | "unspecified";

export type KbRelation = {
  id: string;
  kind: KbRelationKind;
  /** 关系主体概念（如 荆轲刺秦王 HAS_PARTICIPANT 荆轲：source=故事概念） */
  sourceConceptId: string;
  targetConceptId: string;
  confidence: KbConfidence;
  weight?: number;
  /** 溯源：manual 人工创建；auto-* 为将来挖掘管线预留 */
  method: "manual" | "auto";
  /** 证据文段 */
  evidenceSegmentIds?: string[];
  note?: string;
  createdAt: string;
};

export type KbData = {
  categories: KbCategory[];
  concepts: KbConcept[];
  terms: KbTerm[];
  sources: KbSource[];
  segments: KbSegment[];
  relations: KbRelation[];
};

export function newKbId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
