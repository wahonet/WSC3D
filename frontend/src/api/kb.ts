/**
 * 知识库（KB）API 封装与类型契约。
 *
 * 与 backend/src/services/kb/kb-types.ts、kb-query.ts 手动同步；
 * 任一端字段调整需要两端同时修改（与 client.ts 的约定一致）。
 */

// ---------- 实体 ----------

export type KbCategory = {
  id: string;
  name: string;
  parentId?: string;
  order?: number;
  description?: string;
};

export type KbConceptType = "entity" | "theme_or_story" | "behavior" | "relation" | "attribute" | "other";

export const KB_CONCEPT_TYPE_LABELS: Record<KbConceptType, string> = {
  entity: "实体概念",
  theme_or_story: "主题 / 故事",
  behavior: "行为",
  relation: "关系",
  attribute: "属性特征",
  other: "其他"
};

export type KbConcept = {
  id: string;
  label: string;
  categoryId: string;
  subcategoryId?: string;
  conceptType: KbConceptType;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type KbTerm = {
  id: string;
  form: string;
  conceptId: string;
  script?: "simplified" | "traditional" | "variant";
  note?: string;
  createdAt: string;
};

export type KbSource = {
  id: string;
  title: string;
  year?: string;
  author?: string;
  type?: string;
  note?: string;
  createdAt: string;
};

export type KbMention = {
  conceptId: string;
  matchedForm?: string;
  auto?: boolean;
};

export type KbSegment = {
  id: string;
  sourceId: string;
  page?: string;
  locator?: string;
  text: string;
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

export const KB_RELATION_KIND_LABELS: Record<KbRelationKind, string> = {
  ISA: "属于（ISA）",
  HAS_PARTICIPANT: "有参与者",
  USES_OBJECT: "使用器物",
  HAS_MORPHOLOGY_FEATURE: "形态特征",
  PART_OF: "部件（PART_OF）",
  DEPICTS: "描绘（DEPICTS）",
  ASSOCIATED_WITH: "相关联"
};

export type KbConfidence = "high" | "medium" | "unspecified";

export const KB_CONFIDENCE_LABELS: Record<KbConfidence, string> = {
  high: "high",
  medium: "medium",
  unspecified: "未定"
};

export type KbRelation = {
  id: string;
  kind: KbRelationKind;
  sourceConceptId: string;
  targetConceptId: string;
  confidence: KbConfidence;
  weight?: number;
  method: "manual" | "auto";
  evidenceSegmentIds?: string[];
  note?: string;
  createdAt: string;
};

export type KbSnapshot = {
  categories: KbCategory[];
  concepts: KbConcept[];
  terms: KbTerm[];
  sources: KbSource[];
  segments: KbSegment[];
  relations: KbRelation[];
};

// ---------- 查询结果 ----------

export type KbSearchResult =
  | { type: "concept"; id: string; label: string; categoryId: string; subcategoryId?: string; termCount: number; segmentCount: number }
  | { type: "term"; id: string; form: string; conceptId: string; conceptLabel: string }
  | { type: "segment"; id: string; sourceTitle: string; page?: string; snippet: string; mentionCount: number }
  | { type: "source"; id: string; title: string; year?: string; segmentCount: number };

export type KbConceptDetail = {
  concept: KbConcept;
  categoryName: string;
  subcategoryName?: string;
  terms: KbTerm[];
  relations: Array<KbRelation & { direction: "out" | "in"; otherConceptId: string; otherLabel: string }>;
  cooccurrence: Array<{ conceptId: string; label: string; weight: number; segmentIds: string[] }>;
  segments: Array<{ id: string; sourceTitle: string; page?: string; text: string }>;
  sourceDistribution: Array<{ sourceId: string; title: string; count: number }>;
};

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

export type KbEvidenceSuggestion = {
  segmentId: string;
  sourceTitle: string;
  page?: string;
  matchedForm: string;
  snippet: string;
  alreadyMentioned: boolean;
  status: "auto_text_match_unconfirmed";
  prov: "auto_exact_term_text_match";
};

export type KbMentionSuggestion = {
  conceptId: string;
  label: string;
  matchedForm: string;
};

// ---------- fetch 封装 ----------

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    let message = `${response.status}`;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      message = body.error ?? body.message ?? message;
    } catch {
      /* keep status */
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body)
});

export async function fetchKbSnapshot(): Promise<KbSnapshot> {
  return requestJson<KbSnapshot>("/api/kb/snapshot");
}

export async function searchKb(query: string, categoryId?: string): Promise<KbSearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (categoryId) params.set("category", categoryId);
  const data = await requestJson<{ results: KbSearchResult[] }>(`/api/kb/search?${params.toString()}`);
  return data.results;
}

export async function fetchConceptDetail(conceptId: string): Promise<KbConceptDetail> {
  return requestJson<KbConceptDetail>(`/api/kb/concepts/${encodeURIComponent(conceptId)}/detail`);
}

export async function fetchConceptGraph(conceptId: string): Promise<KbGraph> {
  return requestJson<KbGraph>(`/api/kb/concepts/${encodeURIComponent(conceptId)}/graph`);
}

export async function fetchOverviewGraph(): Promise<KbGraph> {
  return requestJson<KbGraph>("/api/kb/graph/overview");
}

export async function suggestEvidence(conceptId: string): Promise<KbEvidenceSuggestion[]> {
  const data = await requestJson<{ suggestions: KbEvidenceSuggestion[] }>(
    `/api/kb/evidence/suggest?conceptId=${encodeURIComponent(conceptId)}`
  );
  return data.suggestions;
}

export async function suggestMentions(text: string): Promise<KbMentionSuggestion[]> {
  const data = await requestJson<{ suggestions: KbMentionSuggestion[] }>(
    "/api/kb/mentions/suggest",
    jsonInit("POST", { text })
  );
  return data.suggestions;
}

// ---------- CRUD ----------

export type KbConceptInput = {
  label: string;
  categoryId: string;
  subcategoryId?: string;
  conceptType?: KbConceptType;
  description?: string;
};

export async function createKbConcept(input: KbConceptInput): Promise<KbConcept> {
  return requestJson<KbConcept>("/api/kb/concepts", jsonInit("POST", input));
}

export async function updateKbConcept(id: string, patch: Partial<KbConceptInput>): Promise<KbConcept> {
  return requestJson<KbConcept>(`/api/kb/concepts/${encodeURIComponent(id)}`, jsonInit("PUT", patch));
}

export async function deleteKbConcept(id: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`/api/kb/concepts/${encodeURIComponent(id)}`, jsonInit("DELETE"));
}

export async function createKbTerm(input: {
  form: string;
  conceptId: string;
  script?: KbTerm["script"];
  note?: string;
}): Promise<KbTerm> {
  return requestJson<KbTerm>("/api/kb/terms", jsonInit("POST", input));
}

export async function deleteKbTerm(id: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`/api/kb/terms/${encodeURIComponent(id)}`, jsonInit("DELETE"));
}

export async function createKbSource(input: {
  title: string;
  year?: string;
  author?: string;
  type?: string;
  note?: string;
}): Promise<KbSource> {
  return requestJson<KbSource>("/api/kb/sources", jsonInit("POST", input));
}

export async function updateKbSource(id: string, patch: Partial<Omit<KbSource, "id" | "createdAt">>): Promise<KbSource> {
  return requestJson<KbSource>(`/api/kb/sources/${encodeURIComponent(id)}`, jsonInit("PUT", patch));
}

export async function deleteKbSource(id: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`/api/kb/sources/${encodeURIComponent(id)}`, jsonInit("DELETE"));
}

export type KbSegmentInput = {
  sourceId: string;
  page?: string;
  locator?: string;
  text: string;
  mentions?: KbMention[];
  note?: string;
};

export async function createKbSegment(input: KbSegmentInput): Promise<KbSegment> {
  return requestJson<KbSegment>("/api/kb/segments", jsonInit("POST", input));
}

export async function updateKbSegment(id: string, patch: Partial<KbSegmentInput>): Promise<KbSegment> {
  return requestJson<KbSegment>(`/api/kb/segments/${encodeURIComponent(id)}`, jsonInit("PUT", patch));
}

export async function deleteKbSegment(id: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`/api/kb/segments/${encodeURIComponent(id)}`, jsonInit("DELETE"));
}

export async function createKbRelation(input: {
  kind: KbRelationKind;
  sourceConceptId: string;
  targetConceptId: string;
  confidence?: KbConfidence;
  weight?: number;
  evidenceSegmentIds?: string[];
  note?: string;
}): Promise<KbRelation> {
  return requestJson<KbRelation>("/api/kb/relations", jsonInit("POST", input));
}

export async function deleteKbRelation(id: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`/api/kb/relations/${encodeURIComponent(id)}`, jsonInit("DELETE"));
}
